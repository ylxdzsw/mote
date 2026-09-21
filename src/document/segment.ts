import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, LineEnd, MoteDocument, PaletteEntry } from './model'
import { defaultTheme } from './model'
import { initializeDocument } from './initialize'
import { validateDocument } from './validate'
import { neutralIds } from '../theme/palette'
import type { Geometry, Geometries } from '../canvas/floatingGeometry'

export const SEGMENT_MIME = 'application/x-mote-segment+json'

export interface SegmentPoint {
  index: number
  offset: number
}

export interface SegmentRange {
  start: SegmentPoint
  end: SegmentPoint
}

export interface SegmentClipboard {
  version: 'V0'
  type: 'segment'
  content: JSONContent[]
  floating: FloatingObject[]
  palette: PaletteEntry[]
  geometry: Geometries
  anchorTops: Record<string, number>
  originTop: number
}

export type { Geometries }

interface SpacerSlice {
  start: number
  end: number
  beforeId?: string
  afterId?: string
}

interface SelectedSegment {
  spacers: Map<string, SpacerSlice>
  blockIds: Set<string>
  indices: Set<number>
}

interface AnchorPlace {
  anchorId: string | null
  y: number
}

interface AnchorMapping {
  anchorId: string | null
  y: number
}

interface SpacerAlias {
  anchorId: string
  offset: number
}

const isSpacer = (node: JSONContent) => node.type === 'spacer'
const blockHeight = (node: JSONContent) => typeof node.attrs?.height === 'number' && Number.isFinite(node.attrs.height) ? node.attrs.height : 0
const blockId = (node: JSONContent) => typeof node.attrs?.id === 'string' ? node.attrs.id : undefined

function clone<T>(value: T): T {
  return structuredClone(value)
}

function freshId(used = new Set<string>()) {
  let id = crypto.randomUUID()
  while (used.has(id)) id = crypto.randomUUID()
  used.add(id)
  return id
}

function blocksOf(doc: MoteDocument): JSONContent[] {
  return doc.content.content ? [...doc.content.content] : []
}

function comparePoint(a: SegmentPoint, b: SegmentPoint) {
  return a.index - b.index || a.offset - b.offset
}

function canonicalPoint(point: SegmentPoint, blocks: JSONContent[]): SegmentPoint {
  if (!Number.isInteger(point.index) || point.index < 0 || point.index > blocks.length) throw new Error('Invalid segment point index')
  if (!Number.isFinite(point.offset) || point.offset < 0) throw new Error('Invalid segment point offset')
  if (point.index === blocks.length) {
    if (point.offset !== 0) throw new Error('The document end point must have offset 0')
    return { index: point.index, offset: 0 }
  }
  const block = blocks[point.index]
  if (!isSpacer(block)) {
    if (point.offset !== 0) throw new Error('Only spacers have interior segment points')
    return { index: point.index, offset: 0 }
  }
  const height = blockHeight(block)
  if (point.offset > height) throw new Error('Segment point exceeds spacer height')
  return point.offset === height ? { index: point.index + 1, offset: 0 } : { ...point }
}

function canonicalRange(doc: MoteDocument, range: SegmentRange): SegmentRange {
  const blocks = blocksOf(doc)
  const start = canonicalPoint(range.start, blocks)
  const end = canonicalPoint(range.end, blocks)
  if (comparePoint(start, end) > 0) throw new Error('Segment range is reversed')
  return { start, end }
}

function anchorTop(id: string | null, anchors: readonly { id: string; top: number }[]) {
  if (id === null) return 0
  return anchors.findLast(anchor => anchor.id === id)?.top ?? 0
}

function topAtPoint(point: SegmentPoint, blocks: JSONContent[], anchors: readonly { id: string; top: number; bottom?: number }[]) {
  if (point.index < blocks.length) {
    const node = blocks[point.index]
    return anchorTop(blockId(node) ?? null, anchors) + (isSpacer(node) ? point.offset : 0)
  }
  const previous = blocks.at(-1)
  if (!previous) return 0
  const bottom = anchors.findLast(anchor => anchor.id === blockId(previous))?.bottom
  if (bottom !== undefined) return bottom
  return anchorTop(blockId(previous) ?? null, anchors) + (isSpacer(previous) ? blockHeight(previous) : 0)
}

function selectedSegment(blocks: JSONContent[], range: SegmentRange): SelectedSegment {
  const spacers = new Map<string, SpacerSlice>()
  const blockIds = new Set<string>()
  const indices = new Set<number>()
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (isSpacer(block)) {
      const height = blockHeight(block)
      const start = index === range.start.index ? range.start.offset : 0
      const end = index === range.end.index ? range.end.offset : height
      if (index >= range.start.index && index <= range.end.index && end > start) {
        spacers.set(blockId(block) ?? `index:${index}`, { start, end })
        indices.add(index)
        if (blockId(block)) blockIds.add(blockId(block)!)
      }
    } else if (index >= range.start.index && index < range.end.index) {
      indices.add(index)
      if (blockId(block)) blockIds.add(blockId(block)!)
    }
  }
  return { spacers, blockIds, indices }
}

function spacerSliceFor(block: JSONContent, selected: SelectedSegment) {
  const id = blockId(block)
  return id ? selected.spacers.get(id) : undefined
}

function anchorIsSelected(anchorId: string | null, y: number, blocks: JSONContent[], selected: SelectedSegment) {
  if (anchorId === null) return false
  const index = blocks.findIndex(block => blockId(block) === anchorId)
  if (index < 0 || !selected.indices.has(index)) return false
  const block = blocks[index]
  if (!isSpacer(block)) return true
  const slice = spacerSliceFor(block, selected)
  if (!slice) return false
  const height = blockHeight(block)
  return y >= slice.start && (y < slice.end || slice.end === height && y >= height)
}

function pointInSelectedRange(place: AnchorPlace, blocks: JSONContent[], selected: SelectedSegment, range: SegmentRange) {
  if (place.anchorId === null) return range.start.index === 0 && range.start.offset === 0 && comparePoint(range.start, range.end) < 0
  return anchorIsSelected(place.anchorId, place.y, blocks, selected)
}

function objectAnchorPlace(object: FloatingObject): AnchorPlace {
  return { anchorId: object.anchorId, y: object.y }
}

function objectBaseIncluded(object: FloatingObject, objects: readonly FloatingObject[], blocks: JSONContent[], selected: SelectedSegment, range: SegmentRange) {
  if (object.kind === 'label' && object.attachment) return false
  if (object.kind === 'line' && object.start.connection) {
    const target = objects.find(other => other.id === object.start.connection!.targetId)
    if (target) return pointInSelectedRange(objectAnchorPlace(target), blocks, selected, range)
  }
  if (object.kind === 'line') return pointInSelectedRange({ anchorId: object.start.anchorId, y: object.start.y }, blocks, selected, range)
  return pointInSelectedRange(objectAnchorPlace(object), blocks, selected, range)
}

function selectedObjectSet(doc: MoteDocument, range: SegmentRange): Set<string> {
  const blocks = blocksOf(doc)
  const selected = selectedSegment(blocks, range)
  const ids = new Set<string>()
  for (const object of doc.floating) if (objectBaseIncluded(object, doc.floating, blocks, selected, range)) ids.add(object.id)
  // Attached labels follow their target, not their own saved rectangle or
  // possibly stale anchor. Iterate so a label attached to a selected object
  // is included even when its own anchor is elsewhere.
  let changed = true
  while (changed) {
    changed = false
    for (const object of doc.floating) {
      if (object.kind !== 'label' || !object.attachment || ids.has(object.id)) continue
      if (ids.has(object.attachment.targetId)) { ids.add(object.id); changed = true }
    }
  }
  return ids
}

export function segmentObjectIds(doc: MoteDocument, range: SegmentRange): Set<string> {
  return selectedObjectSet(doc, canonicalRange(doc, range))
}

function sourceAnchorTop(id: string | null, anchors: readonly { id: string; top: number }[], slices: Map<string, SpacerSlice>, originTop: number) {
  if (id === null) return originTop
  const slice = slices.get(id)
  return anchorTop(id, anchors) + (slice?.start ?? 0)
}

function absoluteLinePoint(end: LineEnd, geometry: Geometry | undefined, first: boolean, anchors: readonly { id: string; top: number }[]): { x: number; y: number } {
  if (geometry?.path?.length) return first ? geometry.path[0] : geometry.path.at(-1)!
  return { x: end.x, y: anchorTop(end.anchorId, anchors) + end.y }
}

function relativeToSelectedAnchor(point: { x: number; y: number }, blocks: JSONContent[], selected: SelectedSegment, anchors: readonly { id: string; top: number }[], originTop: number): LineEnd {
  const anchor = blocks.filter((_block, index) => selected.indices.has(index)).map(block => ({ id: blockId(block)!,
    top: sourceAnchorTop(blockId(block)!, anchors, selected.spacers, originTop) })).findLast(anchor => anchor.top <= point.y)
  return { x: point.x, y: Math.max(0, point.y - (anchor?.top ?? 0)), anchorId: anchor?.id ?? null }
}

function transformCopiedObject(object: FloatingObject, selectedIds: Set<string>, blocks: JSONContent[], selected: SelectedSegment, anchors: readonly { id: string; top: number }[], geometry: Geometries, originTop: number): FloatingObject {
  const result = clone(object)
  const shiftAnchor = (id: string | null, y: number) => {
    if (id === null) return { anchorId: null, y }
    const block = blocks.find(node => blockId(node) === id)
    const slice = block && spacerSliceFor(block, selected)
    return slice ? { anchorId: id, y: Math.max(0, y - slice.start) } : { anchorId: id, y }
  }
  Object.assign(result, shiftAnchor(result.anchorId, result.y))
  if (result.kind === 'line') {
    const sourceLine = object as Extract<FloatingObject, { kind: 'line' }>
    result.start = { ...result.start, ...shiftAnchor(result.start.anchorId, result.start.y) }
    result.end = { ...result.end, ...shiftAnchor(result.end.anchorId, result.end.y) }
    const sourceGeometry = geometry[result.id]
    const detach = (end: LineEnd, first: boolean) => {
      const sourceEnd = first ? sourceLine.start : sourceLine.end
      const point = absoluteLinePoint(sourceEnd, sourceGeometry, first, anchors)
      const internal = anchorIsSelected(sourceEnd.anchorId, sourceEnd.y, blocks, selected)
      if (!end.connection && internal) return end
      if (end.connection && selectedIds.has(end.connection.targetId)) {
        if (internal) return end
        return { ...end, ...relativeToSelectedAnchor(point, blocks, selected, anchors, originTop) }
      }
      return relativeToSelectedAnchor(point, blocks, selected, anchors, originTop)
    }
    result.start = detach(result.start, true)
    result.end = detach(result.end, false)
  } else if (result.kind === 'label' && result.attachment && !selectedIds.has(result.attachment.targetId)) {
    const box = geometry[result.id]
    if (box) {
      result.x = box.x
      result.y = Math.max(0, box.y - sourceAnchorTop(result.anchorId, anchors, selected.spacers, originTop))
    }
    result.attachment = null
  }
  return result
}

function paletteReferences(content: JSONContent, result = new Set<string>()) {
  for (const mark of content.marks ?? []) if (mark.type === 'color' && typeof mark.attrs?.color === 'string') result.add(mark.attrs.color)
  for (const child of content.content ?? []) paletteReferences(child, result)
  return result
}

export function objectPaletteReferences(object: FloatingObject, result = new Set<string>()) {
  if ('content' in object) paletteReferences(object.content, result)
  for (const key of ['fill', 'stroke', 'background', 'borderColor'] as const) {
    const value = (object as unknown as Record<string, unknown>)[key]
    if (typeof value === 'string') result.add(value)
  }
  return result
}

export function copySegment(doc: MoteDocument, range: SegmentRange, anchors: readonly { id: string; top: number }[], geometry: Geometries): SegmentClipboard {
  const canonical = canonicalRange(doc, range)
  const blocks = blocksOf(doc)
  const selected = selectedSegment(blocks, canonical)
  const content: JSONContent[] = []
  const originTop = topAtPoint(canonical.start, blocks, anchors)
  const anchorTops: Record<string, number> = {}
  for (let index = 0; index < blocks.length; index++) {
    if (!selected.indices.has(index)) continue
    const block = clone(blocks[index])
    const id = blockId(block)
    const slice = spacerSliceFor(block, selected)
    if (slice && id) {
      block.attrs = { ...block.attrs, height: slice.end - slice.start }
      anchorTops[id] = anchorTop(id, anchors) + slice.start
    } else if (id) anchorTops[id] = anchorTop(id, anchors)
    content.push(block)
  }
  const selectedIds = selectedObjectSet(doc, canonical)
  const floating = doc.floating.filter(object => selectedIds.has(object.id)).map(object => transformCopiedObject(object, selectedIds, blocks, selected, anchors, geometry, originTop))
  const refs = new Set<string>()
  for (const block of content) paletteReferences(block, refs)
  for (const object of floating) objectPaletteReferences(object, refs)
  const palette = doc.theme.palette.filter(entry => refs.has(entry.id) || refs.has(`${entry.id}:soft`)).map(clone)
  const selectedGeometry: Geometries = {}
  for (const object of floating) if (geometry[object.id]) selectedGeometry[object.id] = clone(geometry[object.id])
  return { version: 'V0', type: 'segment', content, floating, palette, geometry: selectedGeometry, anchorTops, originTop }
}

function paletteEntryEqual(a: PaletteEntry, b: PaletteEntry) {
  return a.name === b.name && a.strong === b.strong && a.soft === b.soft
}

const paletteNames = (id: string) => [id, `${id}-soft`, `${id}-surface`]
function uniquePaletteId(id: string, existing: Set<string>) {
  let candidate = `${id}-copy`
  let suffix = 2
  while (paletteNames(candidate).some(name => existing.has(name))) candidate = `${id}-copy-${suffix++}`
  return candidate
}

export function mergePalette(doc: MoteDocument, payload: Pick<SegmentClipboard, 'content' | 'floating' | 'palette'>) {
  const palette = doc.theme.palette.map(clone)
  const byId = new Map(palette.map(entry => [entry.id, entry]))
  const ids = new Set(palette.flatMap(entry => paletteNames(entry.id)))
  const references = new Set<string>()
  for (const block of payload.content) paletteReferences(block, references)
  for (const object of payload.floating) objectPaletteReferences(object, references)
  const remap = new Map<string, string>()
  for (const source of payload.palette) {
    if (!references.has(source.id) && !references.has(`${source.id}:soft`)) continue
    const destination = byId.get(source.id)
    if (destination && ((neutralIds as readonly string[]).includes(source.id) || paletteEntryEqual(destination, source))) {
      remap.set(source.id, source.id)
      continue
    }
    const equal = palette.find(entry => paletteEntryEqual(entry, source))
    if (equal) {
      remap.set(source.id, equal.id)
      continue
    }
    const id = paletteNames(source.id).some(name => ids.has(name)) ? uniquePaletteId(source.id, ids) : source.id
    const entry = { ...clone(source), id }
    palette.push(entry); byId.set(id, entry); paletteNames(id).forEach(name => ids.add(name)); remap.set(source.id, id)
  }
  return { palette, remap }
}

export function remapPaletteContent(node: JSONContent, remap: Map<string, string>): JSONContent {
  return { ...node,
    ...(node.marks && { marks: node.marks.map(mark => mark.type === 'color' && typeof mark.attrs?.color === 'string'
      ? { ...mark, attrs: { ...mark.attrs, color: remap.get(mark.attrs.color.split(':')[0]) ? `${remap.get(mark.attrs.color.split(':')[0])}${mark.attrs.color.endsWith(':soft') ? ':soft' : ''}` : mark.attrs?.color } } : mark) }),
    ...(node.content && { content: node.content.map(child => remapPaletteContent(child, remap)) }),
  }
}

export function freshNode(node: JSONContent, used: Set<string>, top = false): JSONContent {
  const result = clone(node)
  if (result.attrs && typeof result.attrs.id === 'string') {
    result.attrs = { ...result.attrs, id: freshId(used) }
  } else if (top) {
    const next = freshId(used); result.attrs = { ...result.attrs, id: next }
  }
  if (result.content) result.content = result.content.map(child => freshNode(child, used))
  return result
}

export function collectNodeIds(node: JSONContent, used: Set<string>) {
  const id = blockId(node)
  if (id) used.add(id)
  for (const child of node.content ?? []) collectNodeIds(child, used)
}

function normalizeSpacers(blocks: JSONContent[]) {
  const result: JSONContent[] = []
  const aliases = new Map<string, SpacerAlias>()
  for (const block of blocks) {
    const previous = result.at(-1)
    if (previous && isSpacer(previous) && isSpacer(block)) {
      const previousId = blockId(previous)
      const currentId = blockId(block)
      const height = blockHeight(previous)
      previous.attrs = { ...previous.attrs, height: height + blockHeight(block) }
      if (currentId && previousId) aliases.set(currentId, { anchorId: previousId, offset: height })
      continue
    }
    result.push(block)
  }
  return { blocks: result, aliases }
}

function applyAlias(point: AnchorMapping, aliases: Map<string, SpacerAlias>): AnchorMapping {
  if (point.anchorId === null) return point
  const alias = aliases.get(point.anchorId)
  return alias ? { anchorId: alias.anchorId, y: point.y + alias.offset } : point
}

function absoluteToAnchor(point: { x: number; y: number }, anchors: readonly { id: string; top: number }[]): AnchorMapping {
  const anchor = anchors.findLast(candidate => candidate.top <= point.y)
  return { anchorId: anchor?.id ?? null, y: Math.max(0, point.y - (anchor?.top ?? 0)) }
}

function fallbackGeometry(object: FloatingObject, geometry: Geometries, anchors: readonly { id: string; top: number }[]) {
  const box = geometry[object.id]
  return box ? { ...absoluteToAnchor({ x: box.x, y: box.y }, anchors), x: box.x } : { anchorId: null, y: 0 }
}

function remapRetainedObject(object: FloatingObject, selectedIds: Set<string>, selected: SelectedSegment, parts: Map<string, SpacerSlice>, aliases: Map<string, SpacerAlias>, geometry: Geometries, oldAnchors: readonly { id: string; top: number }[], resultAnchors: readonly { id: string; top: number }[]): FloatingObject {
  const result = clone(object)
  const mapExisting = (id: string | null, y: number): AnchorMapping | undefined => {
    if (id === null) return { anchorId: null, y }
    const part = parts.get(id)
    if (part) {
      if (y < part.start && part.beforeId) return applyAlias({ anchorId: part.beforeId, y }, aliases)
      if (y >= part.end && part.afterId) return applyAlias({ anchorId: part.afterId, y: y - part.end }, aliases)
      return undefined
    }
    if (selected.blockIds.has(id)) return undefined
    return applyAlias({ anchorId: id, y }, aliases)
  }
  const mapped = mapExisting(result.anchorId, result.y)
  if (mapped) Object.assign(result, mapped)
  else Object.assign(result, fallbackGeometry(result, geometry, resultAnchors))

  if (result.kind === 'line') {
    const sourceGeometry = geometry[result.id]
    const detach = (end: LineEnd, first: boolean) => {
      const connectionGone = end.connection && selectedIds.has(end.connection.targetId)
      const endpoint = mapExisting(end.anchorId, end.y)
      if (!connectionGone && endpoint) return { ...end, ...endpoint }
      const point = absoluteLinePoint(end, sourceGeometry, first, oldAnchors)
      return { x: point.x, ...absoluteToAnchor(point, resultAnchors) }
    }
    result.start = detach(result.start, true)
    result.end = detach(result.end, false)
  } else if (result.kind === 'label' && result.attachment && selectedIds.has(result.attachment.targetId)) {
    result.attachment = null
    const box = geometry[result.id]
    if (box) Object.assign(result, { x: box.x, ...absoluteToAnchor({ x: box.x, y: box.y }, resultAnchors) })
  }
  return result
}

export function validateGeometry(geometry: unknown): asserts geometry is Geometries {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) throw new Error('Invalid segment geometry')
  for (const [id, value] of Object.entries(geometry as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid segment geometry ID')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid segment geometry')
    const box = value as Record<string, unknown>
    for (const key of ['x', 'y']) if (typeof box[key] !== 'number' || !Number.isFinite(box[key])) throw new Error('Invalid segment geometry')
    for (const key of ['width', 'height']) if (typeof box[key] !== 'number' || !Number.isFinite(box[key]) || box[key] < 0) throw new Error('Invalid segment geometry')
    if (box.path !== undefined) {
      if (!Array.isArray(box.path) || box.path.some(point => !point || typeof point !== 'object' || typeof (point as Record<string, unknown>).x !== 'number' || typeof (point as Record<string, unknown>).y !== 'number' || !Number.isFinite((point as Record<string, unknown>).x as number) || !Number.isFinite((point as Record<string, unknown>).y as number))) throw new Error('Invalid segment geometry path')
    }
  }
}

function validatePayloadMappings(payload: SegmentClipboard) {
  const safe = (id: string) => /^[A-Za-z0-9_-]+$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id)
  const blockIds = new Set<string>()
  for (const block of payload.content) {
    const id = blockId(block)
    if (id && (!safe(id) || blockIds.has(id))) throw new Error('Invalid or duplicate segment anchor ID')
    if (id) blockIds.add(id)
  }
  const anchorTops = payload.anchorTops as Record<string, unknown>
  for (const id of Object.keys(anchorTops)) if (!safe(id) || !blockIds.has(id)) throw new Error('Invalid segment anchor mapping')
  const paletteIds = new Set<string>()
  for (const entry of payload.palette) {
    const id = (entry as unknown as Record<string, unknown>)?.id
    if (typeof id !== 'string' || !safe(id) || paletteIds.has(id)) throw new Error('Invalid or duplicate segment palette ID')
    paletteIds.add(id)
  }
}

function payloadCandidate(payload: SegmentClipboard): MoteDocument {
  const entries = new Map(defaultTheme.palette.filter(entry => (neutralIds as readonly string[]).includes(entry.id)).map(entry => [entry.id, clone(entry)]))
  for (const entry of payload.palette) entries.set(entry.id, clone(entry))
  return {
    version: 'V0', id: 'segment', width: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 },
    theme: { ...clone(defaultTheme), palette: [...entries.values()] },
    content: { type: 'doc', content: clone(payload.content) }, floating: clone(payload.floating),
  }
}

function validateClipboard(value: unknown): asserts value is SegmentClipboard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Mote segment')
  const payload = value as Partial<SegmentClipboard>
  if (payload.version !== 'V0' || payload.type !== 'segment') throw new Error('Unsupported Mote segment version')
  if (!Array.isArray(payload.content) || !Array.isArray(payload.floating) || !Array.isArray(payload.palette)) throw new Error('Invalid Mote segment contents')
  if (typeof payload.originTop !== 'number' || !Number.isFinite(payload.originTop) || !payload.anchorTops || typeof payload.anchorTops !== 'object' || Array.isArray(payload.anchorTops)) throw new Error('Invalid Mote segment anchors')
  for (const value of Object.values(payload.anchorTops as Record<string, unknown>)) if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid Mote segment anchor top')
  validateGeometry(payload.geometry)
  validatePayloadMappings(payload as SegmentClipboard)
  try {
    const candidate = payloadCandidate(payload as SegmentClipboard)
    validateDocument(candidate)
    initializeDocument(candidate)
  } catch (error) {
    throw new Error(`Invalid Mote segment: ${error instanceof Error ? error.message : 'document content'}`)
  }
}

export function serializeSegment(payload: SegmentClipboard): string {
  validateClipboard(payload)
  return JSON.stringify(payload)
}

export function parseSegment(text: string): SegmentClipboard {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Invalid Mote segment JSON') }
  validateClipboard(value)
  const candidate = payloadCandidate(value)
  initializeDocument(candidate)
  return { ...clone(value), content: clone(candidate.content.content ?? []), floating: clone(candidate.floating) }
}

function sourcePayloadAnchorTop(payload: SegmentClipboard, id: string | null) {
  return id === null ? 0 : payload.anchorTops[id] ?? payload.originTop
}

function destinationPayloadTop(payload: SegmentClipboard, sourceId: string | null, insertionTop: number) {
  return insertionTop + sourcePayloadAnchorTop(payload, sourceId) - payload.originTop
}

function payloadEndpointPoint(payload: SegmentClipboard, end: LineEnd, geometry: Geometry | undefined, first: boolean) {
  if (geometry?.path?.length) return first ? geometry.path[0] : geometry.path.at(-1)!
  return { x: end.x, y: sourcePayloadAnchorTop(payload, end.anchorId) + end.y }
}

export function replaceSegment(doc: MoteDocument, range: SegmentRange, payload: SegmentClipboard | null, anchors: readonly { id: string; top: number }[], geometry: Geometries): MoteDocument {
  const canonical = canonicalRange(doc, range)
  if (payload) validateClipboard(payload)
  const oldBlocks = blocksOf(doc)
  const selected = selectedSegment(oldBlocks, canonical)
  const selectedIds = selectedObjectSet(doc, canonical)
  const insertionTop = topAtPoint(canonical.start, oldBlocks, anchors)
  const used = new Set<string>()
  for (const block of oldBlocks) collectNodeIds(block, used)
  for (const object of doc.floating) {
    used.add(object.id)
    if ('content' in object) collectNodeIds(object.content, used)
  }
  const preBlocks: JSONContent[] = []
  const parts = new Map<string, SpacerSlice>()
  const preTops = new Map<string, number>()
  const addPre = (block: JSONContent, top: number) => { preBlocks.push(block); if (blockId(block)) preTops.set(blockId(block)!, top) }
  for (const [id, slice] of selected.spacers) parts.set(id, { ...slice })
  let startingSpacerPart: string | undefined

  for (let index = 0; index < canonical.start.index; index++) addPre(clone(oldBlocks[index]), anchorTop(blockId(oldBlocks[index]) ?? null, anchors))
  if (canonical.start.offset > 0) {
    const original = oldBlocks[canonical.start.index], id = blockId(original)!
    const block = { ...clone(original), attrs: { ...original.attrs, height: canonical.start.offset } }
    addPre(block, anchorTop(id, anchors)); startingSpacerPart = id
    parts.set(id, { start: canonical.start.offset, end: blockHeight(original), beforeId: id })
  }

  const payloadBlockMap = new Map<string, string>()
  const payloadObjectMap = new Map<string, string>()
  let payloadBlocks: JSONContent[] = []
  let destinationPalette = doc.theme.palette
  let paletteMap = new Map<string, string>()
  if (payload) {
    const merged = mergePalette(doc, payload)
    destinationPalette = merged.palette; paletteMap = merged.remap
    payloadBlocks = payload.content.map(block => {
      const fresh = freshNode(remapPaletteContent(block, paletteMap), used, true)
      if (blockId(block)) payloadBlockMap.set(blockId(block)!, blockId(fresh)!)
      const id = blockId(fresh)
      if (id) preTops.set(id, destinationPayloadTop(payload, blockId(block) ?? null, insertionTop))
      return fresh
    })
    for (const block of payloadBlocks) addPre(block, preTops.get(blockId(block)!) ?? insertionTop)
  }

  if (canonical.end.offset > 0) {
    const original = oldBlocks[canonical.end.index], oldId = blockId(original)!
    const id = canonical.start.index === canonical.end.index && canonical.start.offset > 0 ? freshId(used) : oldId
    const block = { ...clone(original), attrs: { ...original.attrs, id, height: blockHeight(original) - canonical.end.offset } }
    addPre(block, anchorTop(oldId, anchors) + canonical.end.offset)
    parts.set(oldId, { start: canonical.start.index === canonical.end.index ? canonical.start.offset : 0, end: canonical.end.offset, beforeId: canonical.start.index === canonical.end.index ? startingSpacerPart : undefined, afterId: id })
  }
  for (let index = canonical.end.index + (canonical.end.offset > 0 ? 1 : 0); index < oldBlocks.length; index++) addPre(clone(oldBlocks[index]), anchorTop(blockId(oldBlocks[index]) ?? null, anchors))

  // A range ending at a normal boundary retains blocks after that boundary;
  // a range beginning at a normal boundary already started with the prefix
  // loop above. The selected ordinary blocks themselves are intentionally not
  // copied.
  const normalized = normalizeSpacers(preBlocks)
  const aliases = normalized.aliases
  const postBlocks = normalized.blocks
  const resultAnchors = postBlocks.flatMap(block => {
    const id = blockId(block)
    if (!id) return []
    const alias = aliases.get(id)
    const top = (preTops.get(id) ?? insertionTop) - (alias?.offset ?? 0)
    return [{ id: alias?.anchorId ?? id, top }]
  }).filter((anchor, index, all) => all.findIndex(other => other.id === anchor.id) === index)

  const retained = doc.floating.filter(object => !selectedIds.has(object.id)).map(object => remapRetainedObject(object, selectedIds, selected, parts, aliases, geometry, anchors, resultAnchors))
  if (payload) {
    for (const object of payload.floating) {
      const nextId = freshId(used)
      payloadObjectMap.set(object.id, nextId)
    }
    for (const object of payload.floating) {
      const next = clone(object)
      next.id = payloadObjectMap.get(object.id)!
      const sourceAnchor = object.anchorId
      const rawAnchor = sourceAnchor === null ? undefined : payloadBlockMap.get(sourceAnchor)
      const translated = (point: { x: number; y: number }) => ({ x: point.x,
        ...absoluteToAnchor({ x: point.x, y: Math.max(0, insertionTop + point.y - payload.originTop) }, resultAnchors) })
      const mapped = rawAnchor ? applyAlias({ anchorId: rawAnchor, y: object.y }, aliases)
        : translated(payload.geometry[object.id] ?? { x: object.x, y: object.y + sourcePayloadAnchorTop(payload, sourceAnchor) })
      const mappedAnchor = mapped.anchorId
      const aliasOffset = mapped.y - object.y
      next.anchorId = mappedAnchor
      next.y = mapped.y
      if (next.kind === 'line') {
        const sourceGeometry = payload.geometry[object.id]
        const detach = (end: LineEnd, first: boolean) => {
          const mappedEndAnchor = end.anchorId === null ? undefined : payloadBlockMap.get(end.anchorId)
          if (end.connection && payloadObjectMap.has(end.connection.targetId)) {
            const endpoint = mappedEndAnchor ? applyAlias({ anchorId: mappedEndAnchor, y: end.y }, aliases)
              : translated(payloadEndpointPoint(payload, end, sourceGeometry, first))
            return { ...end, ...endpoint, connection: { ...end.connection, targetId: payloadObjectMap.get(end.connection.targetId)! } }
          }
          if (mappedEndAnchor) return { x: end.x, ...applyAlias({ anchorId: mappedEndAnchor, y: end.y }, aliases) }
          const point = payloadEndpointPoint(payload, end, sourceGeometry, first)
          return translated(point)
        }
        const line = next as Extract<FloatingObject, { kind: 'line' }>
        const sourceLine = object as Extract<FloatingObject, { kind: 'line' }>
        line.start = detach(sourceLine.start, true)
        line.end = detach(sourceLine.end, false)
      } else if (next.kind === 'label') {
        if (next.attachment && payloadObjectMap.has(next.attachment.targetId)) next.attachment = { ...next.attachment, targetId: payloadObjectMap.get(next.attachment.targetId)! }
        else if (next.attachment) {
          const box = payload.geometry[object.id]
          if (box) { next.x = box.x; next.y = Math.max(0, box.y - sourcePayloadAnchorTop(payload, sourceAnchor) + aliasOffset) }
          next.attachment = null
        }
      }
      if ('content' in next) next.content = remapPaletteContent(freshNode(next.content, used), paletteMap)
      for (const key of ['fill', 'stroke', 'background', 'borderColor'] as const) {
        const value = (next as unknown as Record<string, unknown>)[key]
        if (typeof value === 'string') {
          const mapped = paletteMap.get(value.split(':')[0])
          if (mapped) (next as unknown as Record<string, unknown>)[key] = `${mapped}${value.endsWith(':soft') ? ':soft' : ''}`
        }
      }
      retained.push(next)
    }
  }

  const content = postBlocks.length ? { ...clone(doc.content), content: postBlocks } : { ...clone(doc.content), content: [{ type: 'paragraph', attrs: { id: freshId(used), semantic: 'body' }, content: [] }] }
  return { ...doc, theme: destinationPalette === doc.theme.palette ? doc.theme : { ...doc.theme, palette: destinationPalette }, content, floating: retained }
}

function nodeText(node: JSONContent): string {
  if (node.type === 'hardBreak') return '\n'
  if (node.text) return node.text
  return (node.content ?? []).map(nodeText).join('')
}

export function segmentText(payload: SegmentClipboard): string {
  return payload.content.map(block => block.type === 'spacer' ? '' : nodeText(block)).join('\n')
}

