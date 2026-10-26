import { patchObject, objectAnchorId } from './model'
import type { JSONContent } from '@tiptap/core'
import { supportsCaption, type FloatingObject, type MoteDocument } from './model'
import { validateComposition } from '../../shared/document.mjs'
import { collectNodeIds, collectObjectNodeIds, freshNode, validateGeometry } from './segment'
import type { Anchor, Geometries } from '../canvas/floatingGeometry'
import { insertDocumentObjects, placementAtPoint } from './flow'

export const FLOATING_MIME = 'application/x-mote-floating+json'
export interface FloatingClipboard {
  version: 1
  type: 'objects'
  objects: FloatingObject[]
  content: JSONContent[]
  geometry: Geometries
}

export function floatingCopyIds(objects: FloatingObject[], selected: string[], content: JSONContent) {
  const ids = new Set(selected)
  const anchors = new Set(objects.filter(object => ids.has(object.id) && object.layout.placement.type === 'flow').map(object => objectAnchorId(object, content)))
  for (const object of objects) if (objectAnchorId(object) !== null && anchors.has(objectAnchorId(object))) ids.add(object.id)
  return ids
}

export function copyFloating(doc: MoteDocument, ids: Set<string>, geometry: Geometries): FloatingClipboard {
  ids = floatingCopyIds(doc.objects, [...ids], doc.content)
  const content = structuredClone((doc.content.content ?? []).filter(block => block.type === 'flow' && ids.has(block.attrs?.objectId)))
  const flowAnchors = new Set(content.map(block => block.attrs?.id))
  const objects = doc.objects.filter(object => ids.has(object.id)).map(original => {
    const object = structuredClone(original), box = geometry[object.id]
    if (object.layout.placement.type !== 'flow' && !flowAnchors.has(objectAnchorId(object))) return patchObject(object, { x: box.x, y: Math.max(0, box.y), anchorId: null })
    return object
  })
  return { version: 1, type: 'objects', objects, content,
    geometry: structuredClone(Object.fromEntries(objects.map(object => [object.id, geometry[object.id]]))) }
}

export function parseFloating(json: string): FloatingClipboard {
  const payload = JSON.parse(json) as FloatingClipboard
  if (!payload || payload.version !== 1 || payload.type !== 'objects' || !Array.isArray(payload.objects) || !payload.objects.length || Object.keys(payload).some(key => !['version', 'type', 'objects', 'content', 'geometry'].includes(key)) || !Array.isArray(payload.content) || payload.content.some(block => block.type !== 'flow')) throw new Error('Invalid Mote objects.')
  validateGeometry(payload.geometry)
  validateComposition(payload.content, payload.objects, { allowEmpty: true })
  for (const object of payload.objects) if (objectAnchorId(object) !== null && !payload.content.some(block => block.attrs?.id === objectAnchorId(object)) || !payload.geometry[object.id]) throw new Error('Invalid objects clipboard geometry.')
  return payload
}

export function importFloating(doc: MoteDocument, payload: FloatingClipboard, anchors: Anchor[]) {
  const used = new Set(doc.objects.map(object => object.id))
  collectNodeIds(doc.content, used)
  for (const object of doc.objects) collectObjectNodeIds(object, used)
  const mapping = new Map(payload.objects.map(object => [object.id, crypto.randomUUID()]))
  for (const id of mapping.values()) used.add(id)
  const anchorsMap = new Map<string, string>()
  const content = payload.content.map(block => {
    const next = freshNode(block, used, true)
    anchorsMap.set(block.attrs!.id, next.attrs!.id)
    next.attrs!.objectId = mapping.get(block.attrs!.objectId)!
    return next
  })
  const ordinaryAnchors = anchors.filter(anchor => !(doc.content.content ?? []).some(block => block.type === 'flow' && block.attrs?.id === anchor.id))
  const objects = payload.objects.map(original => {
    let object = structuredClone(original)
    object.id = mapping.get(original.id)!
    if (object.layout.placement.type === 'float') {
      const sourceAnchor = objectAnchorId(original)
      const anchorId = sourceAnchor && anchorsMap.get(sourceAnchor)
      if (anchorId) object = patchObject(object, { anchorId })
      else {
        const point = payload.geometry[original.id]
        const anchor = ordinaryAnchors.findLast(anchor => anchor.top <= point.y)
        object = patchObject(object, placementAtPoint(doc, point, anchor?.id ?? null, { anchors }))
      }
    }
    if ('content' in object) object.content = freshNode(object.content, used)
    if (supportsCaption(object) && object.caption) object.caption = { ...object.caption, content: freshNode(object.caption.content, used) }
    return object
  })
  return { objects, content }
}

export function pasteFloating(doc: MoteDocument, payload: FloatingClipboard, anchors: Anchor[], index?: number): MoteDocument {
  const imported = importFloating(doc, payload, anchors)
  return insertDocumentObjects(doc, imported.objects, index, imported.content)
}

export function floatingText(payload: FloatingClipboard) {
  const text = (node: JSONContent): string => node.text ?? (node.type === 'hardBreak' ? '\n' : node.content?.map(text).join(node.type === 'tableRow' ? '\t' : node.type === 'doc' || node.type === 'table' ? '\n' : '') ?? '')
  return payload.objects.map(object => [
    'content' in object ? text(object.content) : object.kind === 'drawing' ? object.labels.map(label => label.text).join('\n') || '[drawing]' : object.kind === 'code' ? object.source : object.kind === 'formula' ? object.latex : object.kind === 'image' ? object.alt : `[${object.kind}]`,
    supportsCaption(object) && object.caption ? text(object.caption.content) : '',
  ].filter(Boolean).join('\n')).join('\n')
}

export function floatingClipboardJSON(data: DataTransfer) {
  const native = data.getData(FLOATING_MIME)
  if (native) return native
  const html = data.getData('text/html')
  return html.includes('data-mote-floating') ? new DOMParser().parseFromString(html, 'text/html').querySelector('[data-mote-floating]')?.getAttribute('data-mote-floating') ?? '' : ''
}
