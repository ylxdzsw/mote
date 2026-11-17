import type { FloatingObject, MoteDocument } from '../document/model'
import { objectAnchorId } from '../document/model'
import { promoteSlideSelection } from '../document/slideClipboard'
import { slideRanges } from '../document/slides'
import { segmentBlockIds } from './segments'
import { resolveSegmentRange, type SegmentContext } from './segments'
import type { AITarget, Area, SegmentTarget } from './types'

export type { ReservationMarkup } from './types'

export interface ReservationMarkupGeometry {
  // Current target origin in page coordinates; saved x/y are relative to this point.
  origin: { x: number; y: number }
  // Page-space viewport that contains the target and its owned Float bodies.
  frame: Area
}

export interface ReservationMarkupMeasurements {
  blockAreas: Record<string, Area>
  objectBodies: Record<string, Area>
  objectExtents: Record<string, Area>
  context?: SegmentContext
}

const bottom = (area: Area) => area.y + area.height

function combineVertical(areas: Area[], start: number, end: number, minimum = 0) {
  const y = Math.min(start, ...areas.map(area => area.y))
  const bottom = Math.max(end, ...areas.map(area => area.y + area.height))
  return { y, height: Math.max(minimum, bottom - y) }
}

function targetObjects(doc: MoteDocument, ids: string[]) {
  const selected = new Set(ids)
  return doc.objects.filter(object => selected.has(object.id))
}

function blockPosition(doc: MoteDocument, index: number, offset: number, measurements: ReservationMarkupMeasurements) {
  const blocks = doc.content.content ?? []
  if (index < blocks.length) {
    const block = blocks[index]
    const id = typeof block.attrs?.id === 'string' ? block.attrs.id : undefined
    const measured = id ? measurements.blockAreas[id] : undefined
    if (measured) return measured.y + (block.type === 'spacer' ? offset : 0)
    const anchor = id ? measurements.context?.anchors.find(item => item.id === id) : undefined
    if (anchor) return anchor.top + (block.type === 'spacer' ? offset : 0)
  }
  if (index > 0) {
    const previous = blocks[index - 1]
    const id = typeof previous.attrs?.id === 'string' ? previous.attrs.id : undefined
    const measured = id ? measurements.blockAreas[id] : undefined
    if (measured) return bottom(measured)
    const anchor = id ? measurements.context?.anchors.find(item => item.id === id) : undefined
    if (anchor?.bottom !== undefined) return anchor.bottom
    if (anchor) return anchor.top
  }
  const anchors = measurements.context?.anchors
  return anchors?.at(-1)?.top ?? doc.page.margins.top
}

function objectExtent(objects: FloatingObject[], measurements: ReservationMarkupMeasurements) {
  return objects.flatMap(object => measurements.objectExtents[object.id] ? [measurements.objectExtents[object.id]] : [])
}

function selectedObjects(doc: MoteDocument, target: AITarget, blockIds: string[]) {
  if (target.kind === 'segment') return targetObjects(doc, target.objectIds)
  const anchors = new Set(blockIds)
  return doc.objects.filter(object => anchors.has(objectAnchorId(object, doc.content) ?? ''))
}

function resolveSegment(doc: MoteDocument, target: SegmentTarget, measurements: ReservationMarkupMeasurements): ReservationMarkupGeometry | undefined {
  const range = resolveSegmentRange(doc, target)
  if (!range) return undefined
  const ids = segmentBlockIds(doc, range)
  const areas = ids.flatMap(id => measurements.blockAreas[id] ? [measurements.blockAreas[id]] : [])
  if (areas.length !== ids.length) return undefined
  const objects = selectedObjects(doc, target, ids)
  const extents = objectExtent(objects, measurements)
  if (extents.length !== objects.length) return undefined
  const slideSelection = promoteSlideSelection(doc, range)
  const slides = doc.page.slideHeight ? slideRanges(doc) : []
  const slideTop = (index: number) => {
    const slide = slides[index]
    return slide?.id ? measurements.context?.anchors.find(anchor => anchor.id === slide.id)?.top ?? index * doc.page.slideHeight! : 0
  }
  const origin = { x: 0, y: slideSelection ? slideTop(slideSelection.first)
    : blockPosition(doc, range.start.index, range.start.offset, measurements) }
  let start = origin.y, end = blockPosition(doc, range.end.index, range.end.offset, measurements)
  if (areas.length) {
    start = Math.min(start, ...areas.map(area => area.y))
    end = Math.max(end, ...areas.map(bottom))
  }
  if (slideSelection && doc.page.slideHeight) {
    const first = slideTop(slideSelection.first), lastTop = slideTop(slideSelection.last)
    const next = slides[slideSelection.last + 1]
    const lastEnd = next ? slideTop(next.index)
      : Math.max(lastTop + doc.page.slideHeight, end, ...extents.map(bottom))
    start = Math.min(start, first)
    end = Math.max(end, lastEnd)
  }
  const vertical = combineVertical(extents, start, end, ids.length ? 0 : 180)
  return { origin, frame: { x: 0, y: vertical.y, width: doc.page.width, height: vertical.height } }
}

/** Resolve the current page-space target region from read-canvas measurements. */
export function resolveReservationMarkupGeometry(doc: MoteDocument, target: AITarget, measurements: ReservationMarkupMeasurements): ReservationMarkupGeometry | undefined {
  if (target.kind === 'object') {
    const body = measurements.objectBodies[target.objectId]
    return body ? { origin: { x: body.x, y: body.y }, frame: { ...body } } : undefined
  }
  if (target.kind === 'segment') return resolveSegment(doc, target, measurements)

  const areas = target.blockIds.flatMap(id => measurements.blockAreas[id] ? [measurements.blockAreas[id]] : [])
  if (areas.length !== target.blockIds.length || !areas.length) return undefined
  const objects = selectedObjects(doc, target, target.blockIds)
  const extents = objectExtent(objects, measurements)
  if (extents.length !== objects.length) return undefined
  const origin = { x: 0, y: areas[0].y }
  const vertical = combineVertical(extents, Math.min(...areas.map(area => area.y)), Math.max(...areas.map(bottom)))
  return { origin, frame: { x: 0, y: vertical.y, width: doc.page.width, height: vertical.height } }
}

function pageArea(sheet: HTMLElement, element: Element, pageWidth: number) {
  const page = sheet.getBoundingClientRect(), rect = element.getBoundingClientRect()
  const scale = page.width / pageWidth || 1
  return { x: (rect.left - page.left) / scale - sheet.clientLeft,
    y: (rect.top - page.top) / scale - sheet.clientTop,
    width: rect.width / scale, height: rect.height / scale }
}

function areaUnion(first: ReturnType<typeof pageArea>, second: ReturnType<typeof pageArea>) {
  const x = Math.min(first.x, second.x), y = Math.min(first.y, second.y)
  return { x, y, width: Math.max(first.x + first.width, second.x + second.width) - x,
    height: Math.max(first.y + first.height, second.y + second.height) - y }
}

/** Measure the shared renderer for editor and local agent-preview overlays. */
export function measureReservationMarkup(root: HTMLElement, doc: MoteDocument, target: AITarget, context?: SegmentContext) {
  const sheet = root.querySelector<HTMLElement>('.sheet')
  if (!sheet || !sheet.getBoundingClientRect().width) return undefined
  const blockAreas: ReservationMarkupMeasurements['blockAreas'] = {}
  const objectBodies: ReservationMarkupMeasurements['objectBodies'] = {}
  const objectExtents: ReservationMarkupMeasurements['objectExtents'] = {}
  for (const element of root.querySelectorAll<HTMLElement>('.main-text [data-id]')) {
    const id = element.dataset.id
    if (id) blockAreas[id] = pageArea(sheet, element, doc.page.width)
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-note-id] > .object-body')) {
    const id = element.parentElement?.dataset.noteId
    if (!id) continue
    const body = pageArea(sheet, element, doc.page.width)
    objectBodies[id] = body
    const caption = element.parentElement?.querySelector<HTMLElement>(':scope > .object-caption')
    objectExtents[id] = caption ? areaUnion(body, pageArea(sheet, caption, doc.page.width)) : body
  }
  const measurements: ReservationMarkupMeasurements = { blockAreas, objectBodies, objectExtents, context }
  return resolveReservationMarkupGeometry(doc, target, measurements)
}
