import type { JSONContent } from '@tiptap/core'
import { validateComposition } from '../../shared/document.mjs'
import { objectAnchorId, paragraph, patchObject, supportsCaption, type FloatingObject, type MoteDocument } from './model'
import { collectNodeIds, collectObjectNodeIds, freshNode, type SegmentClipboard, type SegmentRange } from './segment'
import { objectSlideIndex, slideRanges } from './slides'

export const SLIDES_MIME = 'application/x-mote-slides+json'
export interface SlideSelection { first: number; last: number }
export interface SlidesClipboard {
  version: 1
  type: 'slides'
  documentVersion: 2 | 3
  slideHeight: number
  content: JSONContent[]
  objects: FloatingObject[]
}

export function slideSelectionRange(doc: MoteDocument, selection: SlideSelection): SegmentRange {
  const ranges = slideRanges(doc)
  return { start: { index: ranges[selection.first].start, offset: 0 }, end: { index: ranges[selection.last].end, offset: 0 } }
}

// Only gutter/segment gestures call this. Native text selection never promotes.
export function promoteSlideSelection(doc: MoteDocument, range: SegmentRange): SlideSelection | null {
  if (!doc.page.slideHeight || range.start.index === range.end.index && range.start.offset === range.end.offset) return null
  const ranges = slideRanges(doc)
  const touched = ranges.filter(slide => range.start.index < slide.end && (range.end.index > slide.start || range.end.index === slide.start && range.end.offset > 0))
  if (!touched.length) return null
  const first = touched[0], last = touched.at(-1)!
  const bodyStart = first.start + (first.id === null ? 0 : 1)
  return first !== last || range.start.offset === 0 && range.start.index <= bodyStart && range.end.index >= first.end
    ? { first: first.index, last: last.index } : null
}

export function slideObjectIds(doc: MoteDocument, selection: SlideSelection) {
  return new Set(doc.objects.filter(object => {
    const index = objectSlideIndex(doc, object)
    return index >= selection.first && index <= selection.last
  }).map(object => object.id))
}

export function copySlides(doc: MoteDocument, selection: SlideSelection): SlidesClipboard {
  const ranges = slideRanges(doc), first = ranges[selection.first], last = ranges[selection.last]
  const ids = slideObjectIds(doc, selection)
  const content = structuredClone(doc.content.content!.slice(first.start + (first.id === null ? 0 : 1), last.end))
  const objects = doc.objects.filter(object => ids.has(object.id)).map(object => object.layout.placement.type === 'float' && objectAnchorId(object) === first.id
    ? patchObject(structuredClone(object), { anchorId: null }) : structuredClone(object))
  const payload: SlidesClipboard = { version: 1, type: 'slides', documentVersion: doc.version === 1 ? 2 : doc.version, slideHeight: doc.page.slideHeight!, content, objects }
  validateSlides(payload)
  return payload
}

function validateSlides(value: unknown): asserts value is SlidesClipboard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Mote slides')
  const payload = value as SlidesClipboard
  if (payload.version !== 1 || payload.type !== 'slides' || ![2, 3].includes(payload.documentVersion)) throw new Error('Unsupported Mote slides version')
  if (Object.keys(payload).some(key => !['version', 'type', 'documentVersion', 'slideHeight', 'content', 'objects'].includes(key))
    || typeof payload.slideHeight !== 'number' || !Number.isFinite(payload.slideHeight) || payload.slideHeight <= 0) throw new Error('Invalid Mote slides')
  validateComposition(payload.content, payload.objects, { slides: true, version: payload.documentVersion })
  if (payload.content[0].type === 'slideBreak' || payload.content.at(-1)!.type === 'slideBreak'
    || payload.content.some((block, i) => block.type === 'slideBreak' && payload.content[i - 1]?.type === 'slideBreak')) throw new Error('Each copied slide requires content')
}

export function serializeSlides(payload: SlidesClipboard) { validateSlides(payload); return JSON.stringify(payload) }
export function parseSlides(json: string): SlidesClipboard {
  let payload: unknown
  try { payload = JSON.parse(json) } catch { throw new Error('Invalid Mote slides JSON') }
  validateSlides(payload)
  return structuredClone(payload)
}

export function slidesClipboardJSON(data: DataTransfer) {
  const native = data.getData(SLIDES_MIME)
  if (native) return native
  const html = data.getData('text/html')
  return html.includes('data-mote-slides') ? new DOMParser().parseFromString(html, 'text/html').querySelector('[data-mote-slides]')?.getAttribute('data-mote-slides') ?? '' : ''
}

export function deleteSlides(doc: MoteDocument, selection: SlideSelection): MoteDocument {
  const ranges = slideRanges(doc), first = ranges[selection.first], last = ranges[selection.last]
  const ids = slideObjectIds(doc, selection)
  const content = [...doc.content.content!.slice(0, first.start), ...doc.content.content!.slice(last.end)]
  let objects = doc.objects.filter(object => !ids.has(object.id))
  if (selection.first === 0 && content[0]?.type === 'slideBreak') {
    const id = content.shift()!.attrs!.id
    objects = objects.map(object => object.layout.placement.type === 'float' && objectAnchorId(object) === id ? patchObject(object, { anchorId: null }) : object)
  }
  return { ...doc, content: { ...doc.content, content: content.length ? content : [paragraph('')] }, objects }
}

export function insertSlides(doc: MoteDocument, payload: SlidesClipboard, boundary: number): { doc: MoteDocument; slides: SlideSelection; range: SegmentRange } {
  validateSlides(payload)
  const ranges = slideRanges(doc)
  if (!doc.page.slideHeight || !Number.isInteger(boundary) || boundary < 0 || boundary > ranges.length) throw new Error('Invalid slide insertion boundary')
  const used = new Set<string>()
  collectNodeIds(doc.content, used)
  for (const object of doc.objects) { used.add(object.id); collectObjectNodeIds(object, used) }
  const fresh = () => { let id = crypto.randomUUID(); while (used.has(id)) id = crypto.randomUUID(); used.add(id); return id }
  const marker = (): JSONContent => ({ type: 'slideBreak', attrs: { id: fresh() } })
  const blockIds = new Map<string, string>(), objectIds = new Map(payload.objects.map(object => [object.id, fresh()]))
  const copied = payload.content.map(block => {
    const next = freshNode(block, used, true)
    blockIds.set(block.attrs!.id, next.attrs!.id)
    if (next.type === 'flow') next.attrs = { ...next.attrs, objectId: objectIds.get(block.attrs!.objectId)! }
    return next
  })
  const leading = boundary ? marker() : null
  const trailing = boundary === 0 ? marker() : null
  const objects = payload.objects.map(object => {
    let next = structuredClone(object)
    next.id = objectIds.get(object.id)!
    if (next.layout.placement.type === 'float') next = patchObject(next, { anchorId: objectAnchorId(object) === null ? leading?.attrs!.id ?? null : blockIds.get(objectAnchorId(object)!)! })
    if ('content' in next) next.content = freshNode(next.content, used)
    if (supportsCaption(next) && next.caption) next.caption.content = freshNode(next.caption.content, used)
    return next
  })
  const retained = doc.objects.map(object => trailing && object.layout.placement.type === 'float' && objectAnchorId(object) === null ? patchObject(object, { anchorId: trailing.attrs!.id }) : object)
  const at = ranges[boundary]?.start ?? doc.content.content!.length
  const content = [...doc.content.content!.slice(0, at), ...(leading ? [leading] : []), ...copied, ...(trailing ? [trailing] : []), ...doc.content.content!.slice(at)]
  const next = { ...doc, content: { ...doc.content, content }, objects: [...retained, ...objects] }
  const slides = { first: boundary, last: boundary + payload.content.filter(block => block.type === 'slideBreak').length }
  return { doc: next, slides, range: slideSelectionRange(next, slides) }
}

// Keep slide-top anchors as ordinary empty paragraphs; no slide mode or fixed
// height survives flattening into a continuous document.
export function flattenSlides(payload: SlidesClipboard): SegmentClipboard {
  validateSlides(payload)
  return { version: 1, type: 'segment', content: payload.content.map(block => block.type === 'slideBreak'
    ? { type: 'paragraph', attrs: { id: block.attrs!.id, semantic: 'body' }, content: [] } : structuredClone(block)),
  objects: structuredClone(payload.objects), geometry: {}, anchorTops: {}, originTop: 0 }
}
