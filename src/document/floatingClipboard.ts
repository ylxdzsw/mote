import type { JSONContent } from '@tiptap/core'
import { defaultTheme, paragraph, type FloatingObject, type LineEnd, type MoteDocument, type PaletteEntry } from './model'
import { initializeDocument } from './initialize'
import { validateDocument } from './validate'
import { collectNodeIds, freshNode, mergePalette, objectPaletteReferences, remapPaletteContent, validateGeometry } from './segment'
import { neutralIds } from '../theme/palette'
import { anchorPoint, type Anchor, type Geometries, type Point } from '../canvas/floatingGeometry'

export const FLOATING_MIME = 'application/x-mote-floating+json'
export interface FloatingClipboard {
  version: 'V0'
  type: 'floating'
  floating: FloatingObject[]
  palette: PaletteEntry[]
  geometry: Geometries
}

export function floatingCopyIds(objects: FloatingObject[], selected: string[]) {
  const ids = new Set(selected)
  for (const object of objects) if (object.kind === 'label' && object.attachment && ids.has(object.attachment.targetId)) ids.add(object.id)
  return ids
}

export function copyFloating(doc: MoteDocument, ids: Set<string>, geometry: Geometries): FloatingClipboard {
  const floating = doc.floating.filter(object => ids.has(object.id)).map(original => {
    const object = structuredClone(original), box = geometry[object.id]
    Object.assign(object, { x: box.x, y: Math.max(0, box.y), anchorId: null })
    if (object.kind === 'line') {
      const endpoint = (end: LineEnd, point: Point): LineEnd => ({ ...anchorPoint(point, []),
        ...(end.connection && ids.has(end.connection.targetId) ? { connection: end.connection } : {}) })
      object.start = endpoint(object.start, box.path![0])
      object.end = endpoint(object.end, box.path!.at(-1)!)
    } else if (object.kind === 'label' && object.attachment && !ids.has(object.attachment.targetId)) object.attachment = null
    return object
  })
  const references = new Set<string>()
  for (const object of floating) objectPaletteReferences(object, references)
  return { version: 'V0', type: 'floating', floating,
    palette: structuredClone(doc.theme.palette.filter(entry => references.has(entry.id) || references.has(`${entry.id}:soft`))),
    geometry: structuredClone(Object.fromEntries(floating.map(object => [object.id, geometry[object.id]]))) }
}

export function parseFloating(json: string): FloatingClipboard {
  const payload = JSON.parse(json) as FloatingClipboard
  if (!payload || payload.version !== 'V0' || payload.type !== 'floating' || !Array.isArray(payload.floating) || !payload.floating.length || !Array.isArray(payload.palette)) throw new Error('Invalid Mote floating elements.')
  validateGeometry(payload.geometry)
  if (new Set(payload.palette.map(entry => entry.id)).size !== payload.palette.length) throw new Error('Duplicate floating clipboard palette IDs.')
  const palette = new Map(defaultTheme.palette.filter(entry => (neutralIds as readonly string[]).includes(entry.id)).map(entry => [entry.id, entry]))
  for (const entry of payload.palette) palette.set(entry.id, entry)
  const candidate: MoteDocument = { version: 'V0', id: 'clipboard', width: 960, margins: { top: 0, right: 0, bottom: 0, left: 0 },
    theme: { ...defaultTheme, palette: [...palette.values()] }, content: { type: 'doc', content: [paragraph('')] }, floating: payload.floating }
  validateDocument(candidate)
  initializeDocument(candidate)
  const ids = new Set(payload.floating.map(object => object.id))
  for (const object of payload.floating) {
    if (object.anchorId !== null || !payload.geometry[object.id]) throw new Error('Invalid floating clipboard geometry.')
    if (object.kind === 'line') {
      if ((payload.geometry[object.id].path?.length ?? 0) < 2) throw new Error('Invalid floating clipboard line.')
      for (const end of [object.start, object.end]) if (end.anchorId !== null || end.connection && !ids.has(end.connection.targetId)) throw new Error('Invalid floating clipboard connection.')
    } else if (object.kind === 'label' && object.attachment && !ids.has(object.attachment.targetId)) throw new Error('Invalid floating clipboard attachment.')
  }
  return payload
}

export function importFloating(doc: MoteDocument, payload: FloatingClipboard, anchors: Anchor[]) {
  const { palette, remap } = mergePalette(doc, { ...payload, content: [] })
  const used = new Set(doc.floating.map(object => object.id))
  collectNodeIds(doc.content, used)
  for (const object of doc.floating) if ('content' in object) collectNodeIds(object.content, used)
  const mapping = new Map(payload.floating.map(object => [object.id, crypto.randomUUID()]))
  for (const id of mapping.values()) used.add(id)
  const floating = payload.floating.map(original => {
    const object = structuredClone(original)
    object.id = mapping.get(original.id)!
    Object.assign(object, anchorPoint(payload.geometry[original.id], anchors))
    if (object.kind === 'line') {
      const endpoint = (end: LineEnd): LineEnd => ({ ...anchorPoint(end, anchors),
        ...(end.connection ? { connection: { ...end.connection, targetId: mapping.get(end.connection.targetId)! } } : {}) })
      object.start = endpoint(object.start); object.end = endpoint(object.end)
    } else if (object.kind === 'label' && object.attachment) object.attachment.targetId = mapping.get(object.attachment.targetId)!
    if ('content' in object) object.content = remapPaletteContent(freshNode(object.content, used), remap)
    for (const key of ['fill', 'stroke', 'background', 'borderColor'] as const) {
      const record = object as unknown as Record<string, unknown>, value = record[key]
      if (typeof value === 'string' && remap.has(value.split(':')[0])) record[key] = `${remap.get(value.split(':')[0])}${value.endsWith(':soft') ? ':soft' : ''}`
    }
    return object
  })
  return { floating, palette }
}

export function floatingText(payload: FloatingClipboard) {
  const text = (node: JSONContent): string => node.text ?? (node.type === 'hardBreak' ? '\n' : node.content?.map(text).join(node.type === 'tableRow' ? '\t' : node.type === 'doc' || node.type === 'table' ? '\n' : '') ?? '')
  return payload.floating.map(object => 'content' in object ? text(object.content) : object.kind === 'katex' ? object.latex : object.kind === 'image' ? object.alt : `[${object.kind}]`).join('\n')
}

export function floatingClipboardJSON(data: DataTransfer) {
  const native = data.getData(FLOATING_MIME)
  if (native) return native
  const html = data.getData('text/html')
  return html.includes('data-mote-floating') ? new DOMParser().parseFromString(html, 'text/html').querySelector('[data-mote-floating]')?.getAttribute('data-mote-floating') ?? '' : ''
}
