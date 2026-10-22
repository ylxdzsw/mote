import type { JSONContent } from '@tiptap/core'
import { defaultTheme, paragraph, supportsCaption, type FloatingObject, type MoteDocument, type PaletteEntry } from './model'
import { initializeDocument } from './initialize'
import { validateDocument } from './validate'
import { collectNodeIds, collectObjectNodeIds, freshNode, mergePalette, objectPaletteReferences, remapObjectPalette, remapPaletteContent, validateGeometry } from './segment'
import { neutralIds } from '../theme/palette'
import type { Anchor, Geometries } from '../canvas/floatingGeometry'
import { insertDocumentObjects, placementAtPoint } from './flow'

export const FLOATING_MIME = 'application/x-mote-floating+json'
export interface FloatingClipboard {
  version: 'V0'
  type: 'floating'
  floating: FloatingObject[]
  content: JSONContent[]
  palette: PaletteEntry[]
  geometry: Geometries
}

export function floatingCopyIds(objects: FloatingObject[], selected: string[]) {
  const ids = new Set(selected)
  const anchors = new Set(objects.filter(object => ids.has(object.id) && object.placement === 'flow').map(object => object.anchorId))
  for (const object of objects) if (object.anchorId !== null && anchors.has(object.anchorId)) ids.add(object.id)
  return ids
}

export function copyFloating(doc: MoteDocument, ids: Set<string>, geometry: Geometries): FloatingClipboard {
  ids = floatingCopyIds(doc.floating, [...ids])
  const content = structuredClone((doc.content.content ?? []).filter(block => block.type === 'flow' && ids.has(block.attrs?.objectId)))
  const flowAnchors = new Set(content.map(block => block.attrs?.id))
  const floating = doc.floating.filter(object => ids.has(object.id)).map(original => {
    const object = structuredClone(original), box = geometry[object.id]
    if (object.placement !== 'flow' && !flowAnchors.has(object.anchorId)) Object.assign(object, { x: box.x, y: Math.max(0, box.y), anchorId: null })
    return object
  })
  const references = new Set<string>()
  for (const object of floating) objectPaletteReferences(object, references)
  return { version: 'V0', type: 'floating', floating, content,
    palette: structuredClone(doc.theme.palette.filter(entry => references.has(entry.id) || references.has(`${entry.id}:soft`))),
    geometry: structuredClone(Object.fromEntries(floating.map(object => [object.id, geometry[object.id]]))) }
}

export function parseFloating(json: string): FloatingClipboard {
  const payload = JSON.parse(json) as FloatingClipboard
  if (!payload || payload.version !== 'V0' || payload.type !== 'floating' || !Array.isArray(payload.floating) || !payload.floating.length || !Array.isArray(payload.palette) || !Array.isArray(payload.content) || payload.content.some(block => block.type !== 'flow')) throw new Error('Invalid Mote floating elements.')
  validateGeometry(payload.geometry)
  if (new Set(payload.palette.map(entry => entry.id)).size !== payload.palette.length) throw new Error('Duplicate floating clipboard palette IDs.')
  const palette = new Map(defaultTheme.palette.filter(entry => (neutralIds as readonly string[]).includes(entry.id)).map(entry => [entry.id, entry]))
  for (const entry of payload.palette) palette.set(entry.id, entry)
  const candidate: MoteDocument = { version: 'V0', id: 'clipboard', width: 960, margins: { top: 0, right: 0, bottom: 0, left: 0 },
    theme: { ...defaultTheme, palette: [...palette.values()] }, content: { type: 'doc', content: payload.content.length ? payload.content : [paragraph('')] }, floating: payload.floating }
  validateDocument(candidate)
  initializeDocument(candidate)
  for (const object of payload.floating) if (object.anchorId !== null && !payload.content.some(block => block.attrs?.id === object.anchorId) || !payload.geometry[object.id]) throw new Error('Invalid floating clipboard geometry.')
  return payload
}

export function importFloating(doc: MoteDocument, payload: FloatingClipboard, anchors: Anchor[]) {
  const { palette, remap } = mergePalette(doc, payload)
  const used = new Set(doc.floating.map(object => object.id))
  collectNodeIds(doc.content, used)
  for (const object of doc.floating) collectObjectNodeIds(object, used)
  const mapping = new Map(payload.floating.map(object => [object.id, crypto.randomUUID()]))
  for (const id of mapping.values()) used.add(id)
  const anchorsMap = new Map<string, string>()
  const content = payload.content.map(block => {
    const next = freshNode(block, used, true)
    anchorsMap.set(block.attrs!.id, next.attrs!.id)
    next.attrs!.objectId = mapping.get(block.attrs!.objectId)!
    return next
  })
  const ordinaryAnchors = anchors.filter(anchor => !(doc.content.content ?? []).some(block => block.type === 'flow' && block.attrs?.id === anchor.id))
  const floating = payload.floating.map(original => {
    const object = structuredClone(original)
    object.id = mapping.get(original.id)!
    const anchorId = original.anchorId && anchorsMap.get(original.anchorId)
    if (anchorId) object.anchorId = anchorId
    else {
      const point = payload.geometry[original.id]
      const anchor = ordinaryAnchors.findLast(anchor => anchor.top <= point.y)
      Object.assign(object, placementAtPoint(doc, point, anchor?.id ?? null, { anchors }))
    }
    if ('content' in object) object.content = remapPaletteContent(freshNode(object.content, used), remap)
    if (supportsCaption(object) && object.caption) object.caption = freshNode(object.caption, used)
    remapObjectPalette(object, remap)
    return object
  })
  return { floating, palette, content }
}

export function pasteFloating(doc: MoteDocument, payload: FloatingClipboard, anchors: Anchor[], index?: number): MoteDocument {
  const imported = importFloating(doc, payload, anchors)
  const next = insertDocumentObjects(doc, imported.floating, index, imported.content)
  return { ...next, theme: { ...next.theme, palette: imported.palette } }
}

export function floatingText(payload: FloatingClipboard) {
  const text = (node: JSONContent): string => node.text ?? (node.type === 'hardBreak' ? '\n' : node.content?.map(text).join(node.type === 'tableRow' ? '\t' : node.type === 'doc' || node.type === 'table' ? '\n' : '') ?? '')
  return payload.floating.map(object => [
    'content' in object ? text(object.content) : object.kind === 'drawing' ? object.labels.map(label => label.text).join('\n') || '[drawing]' : object.kind === 'code' ? object.source : object.kind === 'katex' ? object.latex : object.kind === 'image' ? object.alt : `[${object.kind}]`,
    supportsCaption(object) && object.caption ? text(object.caption) : '',
  ].filter(Boolean).join('\n')).join('\n')
}

export function floatingClipboardJSON(data: DataTransfer) {
  const native = data.getData(FLOATING_MIME)
  if (native) return native
  const html = data.getData('text/html')
  return html.includes('data-mote-floating') ? new DOMParser().parseFromString(html, 'text/html').querySelector('[data-mote-floating]')?.getAttribute('data-mote-floating') ?? '' : ''
}
