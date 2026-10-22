import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, MoteDocument, PaletteEntry } from './model'
import { defaultTheme, isText, supportsCaption } from './model'
import { initializeDocument } from './initialize'
import { validateDocument } from './validate'
import { neutralIds, primaryVariables } from '../theme/palette'
import type { Geometries } from '../canvas/floatingGeometry'

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

function objectBaseIncluded(object: FloatingObject, blocks: JSONContent[], selected: SelectedSegment, range: SegmentRange) {
  return pointInSelectedRange(objectAnchorPlace(object), blocks, selected, range)
}

function selectedObjectSet(doc: MoteDocument, range: SegmentRange): Set<string> {
  const blocks = blocksOf(doc)
  const selected = selectedSegment(blocks, range)
  const ids = new Set<string>()
  for (const object of doc.floating) if (objectBaseIncluded(object, blocks, selected, range)) ids.add(object.id)
  return ids
}

export function segmentObjectIds(doc: MoteDocument, range: SegmentRange): Set<string> {
  return selectedObjectSet(doc, canonicalRange(doc, range))
}

function transformCopiedObject(object: FloatingObject, blocks: JSONContent[], selected: SelectedSegment): FloatingObject {
  const result = clone(object)
  const shiftAnchor = (id: string | null, y: number) => {
    if (id === null) return { anchorId: null, y }
    const block = blocks.find(node => blockId(node) === id)
    const slice = block && spacerSliceFor(block, selected)
    return slice ? { anchorId: id, y: Math.max(0, y - slice.start) } : { anchorId: id, y }
  }
  Object.assign(result, shiftAnchor(result.anchorId, result.y))
  return result
}

function paletteReferences(content: JSONContent, result = new Set<string>()) {
  for (const mark of content.marks ?? []) if (mark.type === 'color' && typeof mark.attrs?.color === 'string') result.add(mark.attrs.color)
  for (const child of content.content ?? []) paletteReferences(child, result)
  return result
}

export function objectPaletteReferences(object: FloatingObject, result = new Set<string>()) {
  if (isText(object) && object.decoration) result.add(object.decoration.color)
  if (object.kind === 'drawing') for (const item of [...object.strokes, ...object.labels]) result.add(item.color)
  if ('content' in object) paletteReferences(object.content, result)
  if (supportsCaption(object) && object.caption) paletteReferences(object.caption, result)
  for (const key of ['background', 'borderColor'] as const) {
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
  const floating = doc.floating.filter(object => selectedIds.has(object.id)).map(object => transformCopiedObject(object, blocks, selected))
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
  const ids = new Set([...primaryVariables, ...palette.flatMap(entry => paletteNames(entry.id))])
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

export function remapObjectPalette(object: FloatingObject, remap: Map<string, string>) {
  const reference = (value: string) => `${remap.get(value.split(':')[0]) ?? value.split(':')[0]}${value.endsWith(':soft') ? ':soft' : ''}`
  if (isText(object) && object.decoration) object.decoration = { ...object.decoration, color: reference(object.decoration.color) }
  for (const key of ['background', 'borderColor'] as const) {
    const record = object as unknown as Record<string, unknown>, value = record[key]
    if (typeof value === 'string') record[key] = reference(value)
  }
  if (object.kind === 'drawing') {
    object.strokes = object.strokes.map(stroke => ({ ...stroke, color: reference(stroke.color) }))
    object.labels = object.labels.map(label => ({ ...label, color: reference(label.color) }))
  }
  if (supportsCaption(object) && object.caption) object.caption = remapPaletteContent(object.caption, remap)
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

export function collectObjectNodeIds(object: FloatingObject, used: Set<string>) {
  if ('content' in object) collectNodeIds(object.content, used)
  if (supportsCaption(object) && object.caption) collectNodeIds(object.caption, used)
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

function applyAlias<T extends AnchorMapping>(point: T, aliases: Map<string, SpacerAlias>): T {
  if (point.anchorId === null) return point
  const alias = aliases.get(point.anchorId)
  return alias ? { ...point, anchorId: alias.anchorId, y: point.y + alias.offset } : point
}

function absoluteToAnchor(point: { x: number; y: number }, anchors: readonly { id: string; top: number }[]): AnchorMapping {
  const anchor = anchors.findLast(candidate => candidate.top <= point.y)
  return { anchorId: anchor?.id ?? null, y: Math.max(0, point.y - (anchor?.top ?? 0)) }
}

function fallbackGeometry(object: FloatingObject, geometry: Geometries, anchors: readonly { id: string; top: number }[]) {
  const box = geometry[object.id]
  return box ? { ...absoluteToAnchor({ x: box.x, y: box.y }, anchors), x: box.x } : { anchorId: null, y: 0 }
}

function remapRetainedObject(object: FloatingObject, selected: SelectedSegment, parts: Map<string, SpacerSlice>, aliases: Map<string, SpacerAlias>, geometry: Geometries, resultAnchors: readonly { id: string; top: number }[]): FloatingObject {
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

const segmentExtent = (node: JSONContent) => isSpacer(node) ? blockHeight(node) : 1

export function segmentPosition(content: JSONContent[], point: SegmentPoint) {
  return content.slice(0, point.index).reduce((sum, node) => sum + segmentExtent(node), point.offset)
}

export function segmentPointAt(content: JSONContent[], position: number): SegmentPoint {
  for (const [index, node] of content.entries()) {
    const size = segmentExtent(node)
    if (position < size - .0001) return { index, offset: isSpacer(node) ? Math.max(0, position) : 0 }
    position -= size
  }
  return { index: content.length, offset: 0 }
}

export function moveSegment(doc: MoteDocument, range: SegmentRange, destination: SegmentPoint,
  anchors: readonly { id: string; top: number; bottom?: number }[], geometry: Geometries): { doc: MoteDocument; range: SegmentRange } {
  const canonical = canonicalRange(doc, range), blocks = blocksOf(doc)
  const target = canonicalPoint(destination, blocks)
  const start = segmentPosition(blocks, canonical.start), end = segmentPosition(blocks, canonical.end), at = segmentPosition(blocks, target)
  if (start === end || at >= start && at <= end) return { doc, range: canonical }

  const payload = copySegment(doc, canonical, anchors, geometry)
  const used = new Set<string>()
  collectNodeIds(doc.content, used)
  for (const object of doc.floating) { used.add(object.id); collectObjectNodeIds(object, used) }
  let position = 0
  // Split only the source and destination spaces. Ordinary blocks keep their IDs.
  const pieces = blocks.flatMap(block => {
    const from = position, size = segmentExtent(block)
    position += size
    const cuts = [0, ...[...new Set([start, end, at])].filter(cut => cut > from && cut < position).map(cut => cut - from).sort((a, b) => a - b), size]
    return cuts.slice(0, -1).map((offset, i) => ({
      originalId: blockId(block)!, offset, from: from + offset, moved: from + offset >= start && from + offset < end,
      block: { ...clone(block), attrs: { ...block.attrs, id: i ? freshId(used) : blockId(block), ...(isSpacer(block) && { height: cuts[i + 1] - offset }) } },
    }))
  })
  const moving = pieces.filter(piece => piece.moved), retained = pieces.filter(piece => !piece.moved)
  const prefix = retained.filter(piece => piece.from < at)
  const ordered = [...prefix, ...moving, ...retained.filter(piece => piece.from >= at)]
  const removedHeight = at > end ? topAtPoint(canonical.end, blocks, anchors) - payload.originTop : 0
  const insertionTop = topAtPoint(target, blocks, anchors) - removedHeight
  const prefixAnchors = prefix.filter(piece => piece.block.type !== 'flow').map(piece => ({ id: blockId(piece.block)!,
    top: anchorTop(piece.originalId, anchors) + piece.offset - (piece.from >= end ? removedHeight : 0) }))
  const { blocks: content, aliases } = normalizeSpacers(ordered.map(piece => piece.block))
  const mapRetained = (point: AnchorMapping) => {
    const piece = pieces.findLast(piece => piece.originalId === point.anchorId && piece.offset <= point.y)
    return piece ? applyAlias({ anchorId: blockId(piece.block)!, y: point.y - piece.offset }, aliases) : point
  }
  const mapMoved = (point: FloatingObject, absoluteY?: number) => {
    const piece = moving.find(piece => piece.originalId === point.anchorId)
    if (piece) return applyAlias({ anchorId: blockId(piece.block)!, y: point.y }, aliases)
    const offset = (absoluteY ?? sourcePayloadAnchorTop(payload, point.anchorId) + point.y) - payload.originTop
    // Objects above the moved segment need a preceding anchor instead of clamping to its top.
    const first: JSONContent = moving[0].block
    const flow = first.type === 'flow' ? doc.floating.find(object => object.id === first.attrs?.objectId) : undefined
    const origin = flow && geometry[flow.id]
    const mapped = offset < 0 ? absoluteToAnchor({ x: 0, y: Math.max(0, insertionTop + offset) }, prefixAnchors)
      : origin ? { anchorId: blockId(first)!, x: (geometry[point.id]?.x ?? point.x) - origin.x, y: offset + payload.originTop - origin.y }
      : { anchorId: blockId(first)!, y: offset }
    return applyAlias(mapped, aliases)
  }
  const movedObjects = new Map(payload.floating.map(object => [object.id, object]))
  const floating = doc.floating.map(original => {
    const moved = movedObjects.get(original.id), object = moved ?? original
    const next = { ...object, ...(moved ? mapMoved(object, geometry[object.id]?.y) : mapRetained(object)) }
    return next
  })
  const insertion = at < start ? at : at - (end - start)
  return { doc: { ...doc, content: { ...doc.content, content }, floating },
    range: { start: segmentPointAt(content, insertion), end: segmentPointAt(content, insertion + end - start) } }
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
    collectObjectNodeIds(object, used)
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
  const resultAnchors = postBlocks.filter(block => block.type !== 'flow').flatMap(block => {
    const id = blockId(block)
    if (!id) return []
    const alias = aliases.get(id)
    const top = (preTops.get(id) ?? insertionTop) - (alias?.offset ?? 0)
    return [{ id: alias?.anchorId ?? id, top }]
  }).filter((anchor, index, all) => all.findIndex(other => other.id === anchor.id) === index)

  const retained = doc.floating.filter(object => !selectedIds.has(object.id)).map(object => remapRetainedObject(object, selected, parts, aliases, geometry, resultAnchors))
  if (payload) {
    for (const object of payload.floating) {
      const nextId = freshId(used)
      payloadObjectMap.set(object.id, nextId)
    }
    for (const block of payloadBlocks) if (block.type === 'flow') block.attrs = { ...block.attrs, objectId: payloadObjectMap.get(block.attrs!.objectId)! }
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
      next.anchorId = mappedAnchor
      next.y = mapped.y
      if ('x' in mapped) next.x = mapped.x as number
      if ('content' in next) next.content = remapPaletteContent(freshNode(next.content, used), paletteMap)
      if (supportsCaption(next) && next.caption) next.caption = freshNode(next.caption, used)
      remapObjectPalette(next, paletteMap)
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

