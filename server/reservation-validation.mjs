import { HttpError, UUID, DOCUMENT_VERSIONS, record, text, finite, safeId, validateDocument } from './validation.mjs'

function area(value, label) { const object = record(value, label); for (const key of ['x', 'y']) finite(object[key], `${label}.${key}`); for (const key of ['width', 'height']) finite(object[key], `${label}.${key}`, 0); return object }

function segmentBlockHeight(block) { return typeof block?.attrs?.height === 'number' && Number.isFinite(block.attrs.height) ? block.attrs.height : 0 }
function segmentBlockId(block) { return typeof block?.attrs?.id === 'string' ? block.attrs.id : undefined }
function compareSegmentPoints(a, b) { return a.index - b.index || a.offset - b.offset }

function canonicalSegmentPoint(value, blocks, label) {
  const point = record(value, label)
  finite(point.index, `${label}.index`, 0)
  if (!Number.isInteger(point.index) || point.index > blocks.length) throw new HttpError(400, `${label}.index must be an integer in the document`)
  finite(point.offset, `${label}.offset`, 0)
  if (point.index === blocks.length) {
    if (point.offset !== 0) throw new HttpError(400, `${label}.offset must be zero at the document end`)
    return { index: point.index, offset: 0 }
  }
  const block = blocks[point.index]
  if (block.type !== 'spacer') {
    if (point.offset !== 0) throw new HttpError(400, `${label}.offset must be zero at a paragraph boundary`)
    return { index: point.index, offset: 0 }
  }
  const height = segmentBlockHeight(block)
  if (point.offset > height) throw new HttpError(400, `${label}.offset exceeds spacer height`)
  return point.offset === height ? { index: point.index + 1, offset: 0 } : { index: point.index, offset: point.offset }
}

function segmentSelection(blocks, range) {
  const spacers = new Map()
  const blockIds = new Set()
  const indices = new Set()
  const blockIndices = new Map()
  const flowAnchors = new Map()
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    const id = segmentBlockId(block)
    if (id !== undefined) blockIndices.set(id, index)
    if (block.type === 'flow' && id !== undefined) flowAnchors.set(block.attrs.objectId, id)
    if (block.type === 'spacer') {
      const height = segmentBlockHeight(block)
      const start = index === range.start.index ? range.start.offset : 0
      const end = index === range.end.index ? range.end.offset : height
      if (index >= range.start.index && index <= range.end.index && end > start) {
        spacers.set(id ?? `index:${index}`, { start, end })
        indices.add(index)
        if (id) blockIds.add(id)
      }
    } else if (index >= range.start.index && index < range.end.index) {
      indices.add(index)
      if (id) blockIds.add(id)
    }
  }
  return { spacers, blockIds, indices, blockIndices, flowAnchors }
}

function segmentAnchorSelected(anchorId, y, blocks, selected) {
  if (anchorId === null) return false
  const index = selected.blockIndices.get(anchorId)
  if (index === undefined || !selected.indices.has(index)) return false
  const block = blocks[index]
  if (block.type !== 'spacer') return true
  const slice = selected.spacers.get(anchorId)
  if (!slice) return false
  const height = segmentBlockHeight(block)
  return y >= slice.start && (y < slice.end || slice.end === height && y >= height)
}

function segmentPointSelected(anchorId, y, blocks, selected, range) {
  return anchorId === null
    ? range.start.index === 0 && range.start.offset === 0 && compareSegmentPoints(range.start, range.end) < 0
    : segmentAnchorSelected(anchorId, y, blocks, selected)
}

function segmentOwnedObjects(document, blocks, range, selected) {
  const objectIds = new Set()
  for (const object of document.objects) {
    const placement = object.layout.placement
    const anchorId = placement.type === 'flow' ? selected.flowAnchors.get(object.id) : placement.anchorId
    if (segmentPointSelected(anchorId, placement.type === 'flow' ? 0 : placement.y, blocks, selected, range)) objectIds.add(object.id)
  }
  return objectIds
}

function segmentScope(document, value) {
  const selectedTarget = record(value, 'target')
  const blocks = document.content.content ?? []
  const rangeValue = record(selectedTarget.range, 'target.range')
  const range = {
    start: canonicalSegmentPoint(rangeValue.start, blocks, 'target.range.start'),
    end: canonicalSegmentPoint(rangeValue.end, blocks, 'target.range.end'),
  }
  if (compareSegmentPoints(range.start, range.end) > 0) throw new HttpError(400, 'target.range is reversed')
  const selected = segmentSelection(blocks, range)
  const objectIds = segmentOwnedObjects(document, blocks, range, selected)
  return { blocks, range, blockIds: selected.blockIds, objectIds }
}

function exactSegmentIds(values, expected, label) {
  if (!Array.isArray(values) || values.length > 2048) throw new HttpError(400, `${label} must be an array`)
  const actual = new Set()
  values.forEach((id, index) => { safeId(id, `${label}[${index}]`); if (actual.has(id)) throw new HttpError(400, `${label} must be unique`); actual.add(id) })
  if (actual.size !== expected.size || [...actual].some(id => !expected.has(id))) throw new HttpError(400, `${label} does not match the selected segment scope`)
  return actual
}

function target(value, document) {
  const object = record(value, 'target')
  if (object.kind === 'object') { safeId(object.objectId, 'target.objectId'); if (typeof object.isNew !== 'boolean') throw new HttpError(400, 'target.isNew must be boolean'); area(object.area, 'target.area'); if (!document.objects.some(item => item.id === object.objectId)) throw new HttpError(400, 'target object must be a document placeholder'); return object }
  if (object.kind === 'text') {
    if (!Array.isArray(object.blockIds) || !object.blockIds.length || object.blockIds.length > 128) throw new HttpError(400, 'target.blockIds must be a non-empty array')
    const ids = new Set((document.content.content ?? []).filter(node => node.type === 'paragraph').map(node => node.attrs.id)); const unique = new Set(object.blockIds); if (unique.size !== object.blockIds.length) throw new HttpError(400, 'target.blockIds must be unique')
    object.blockIds.forEach((id, i) => { safeId(id, `target.blockIds[${i}]`); if (!ids.has(id)) throw new HttpError(400, 'target block is not in document') })
    const blocks = document.content.content ?? [], first = blocks.findIndex(node => node.attrs.id === object.blockIds[0])
    if (object.blockIds.some((id, index) => blocks[first + index]?.attrs.id !== id)) throw new HttpError(400, 'text targets must contain consecutive paragraphs')
    const selection = record(object.selection, 'target.selection'); for (const key of ['from', 'to']) { finite(selection[key], `target.selection.${key}`, 0); if (!Number.isInteger(selection[key])) throw new HttpError(400, 'selection offsets must be integers') }; if (selection.to < selection.from) throw new HttpError(400, 'invalid selection range')
    if (typeof object.insert !== 'boolean') throw new HttpError(400, 'target.insert must be boolean'); area(object.area, 'target.area'); return object
  }
  if (object.kind === 'segment') {
    area(object.area, 'target.area')
    const scope = segmentScope(document, object)
    exactSegmentIds(object.blockIds, scope.blockIds, 'target.blockIds')
    exactSegmentIds(object.objectIds, scope.objectIds, 'target.objectIds')
    if (object.selectedText !== undefined) text(object.selectedText, 'target.selectedText')
    return object
  }
  throw new HttpError(400, 'target.kind must be object, text, or segment')
}


const fields = new Set(['id', 'documentId', 'target', 'original', 'snapshotDocument', 'documentVersion', 'segmentOriginalBlocks', 'segmentOriginalObjects', 'createdAt', 'workspaceRead', 'expiresAt', 'released', 'title'])
function currentTarget(value, document) {
  if (value.kind !== 'segment' || !value.bookmarks) return target(value, document)
  const blocks = document.content.content
  const range = record(value.range, 'target.range')
  for (const side of ['start', 'end']) {
    const point = record(range[side], `target.range.${side}`)
    finite(point.index, 'target.range index', 0); finite(point.offset, 'target.range offset', 0)
    if (!Number.isInteger(point.index)) throw new HttpError(400, 'target.range index must be an integer')
  }
  record(value.bookmarks, 'target.bookmarks')
  record(value.bookmarks.start, 'target.bookmarks.start')
  const empty = compareSegmentPoints(range.start, range.end) === 0
  const resolve = bookmark => {
    record(bookmark, 'bookmark')
    finite(bookmark.offset, 'bookmark.offset', 0)
    if (bookmark.blockId === null) return { index: bookmark.after ? blocks.length : 0, offset: 0 }
    const index = blocks.findIndex(block => block.attrs.id === bookmark.blockId)
    if (index < 0) throw new HttpError(400, 'reservation bookmark is missing')
    return { index: index + (bookmark.after ? 1 : 0), offset: bookmark.after ? 0 : bookmark.offset }
  }
  const start = empty && value.bookmarks.start.after ? { index: blocks.length, offset: 0 } : resolve(value.bookmarks.start)
  return target({ ...value, range: { start, end: empty ? start : resolve(value.bookmarks.end) } }, document)
}
function overlaps(a, b, document) {
  const objects = value => value.kind === 'object' ? [value.objectId] : value.objectIds ?? []
  if (objects(a).some(id => objects(b).includes(id))) return true
  if (a.kind === 'object' || b.kind === 'object') return false
  if (a.blockIds.some(id => b.blockIds.includes(id))) return true
  const range = value => {
    if (value.kind === 'segment') return value.range
    const index = document.content.content.findIndex(block => block.attrs.id === value.blockIds[0])
    return { start: { index, offset: 0 }, end: { index: index + value.blockIds.length, offset: 0 } }
  }
  const left = range(a), right = range(b), cmp = compareSegmentPoints
  const le = cmp(left.start, left.end) === 0, re = cmp(right.start, right.end) === 0
  if (le && re) return cmp(left.start, right.start) === 0
  if (le || re) {
    const point = le ? left.start : right.start, span = le ? right : left
    return cmp(span.start, point) <= 0 && cmp(point, span.end) < 0
  }
  return cmp(left.start, right.end) < 0 && cmp(right.start, left.end) < 0
}
export function validateReservations(values, document) {
  if (!Array.isArray(values)) throw new HttpError(400, 'reservations must be an array')
  const ids = new Set(), active = []
  for (const value of values) {
    const item = record(value, 'reservation')
    if (Object.keys(item).some(key => !fields.has(key))) throw new HttpError(400, 'reservation contains an unsupported field')
    if (!UUID.test(item.id ?? '') || ids.has(item.id)) throw new HttpError(400, 'reservation ID must be a unique UUID')
    ids.add(item.id)
    if (item.documentId !== document.id) throw new HttpError(400, 'reservation.documentId must match document')
    if (typeof item.workspaceRead !== 'boolean') throw new HttpError(400, 'reservation.workspaceRead must be boolean')
    if (item.released !== undefined && typeof item.released !== 'boolean') throw new HttpError(400, 'reservation.released must be boolean')
    record(item.target, 'reservation.target')
    if (item.original === undefined || item.original === null || typeof item.original !== 'object') throw new HttpError(400, 'reservation.original is required')
    for (const key of ['createdAt', 'expiresAt']) if (item[key] !== undefined) finite(item[key], `reservation.${key}`, 0)
    if (item.title !== undefined) text(item.title, 'reservation.title', 1024)
    if (item.documentVersion !== undefined && !DOCUMENT_VERSIONS.includes(item.documentVersion)) throw new HttpError(400, 'unsupported reservation document version')
    if (item.snapshotDocument !== undefined) {
      validateDocument(item.snapshotDocument)
      if (item.snapshotDocument.id !== document.id) throw new HttpError(400, 'snapshot belongs to another document')
    }
    for (const key of ['segmentOriginalBlocks', 'segmentOriginalObjects']) if (item[key] !== undefined && !Array.isArray(item[key])) throw new HttpError(400, `${key} must be an array`)
    if (item.released || item.expiresAt !== undefined && item.expiresAt <= Date.now()) continue
    const selected = currentTarget(item.target, document)
    if (active.some(other => overlaps(selected, other, document))) throw new HttpError(400, 'active reservations overlap')
    active.push(selected)
  }
  return values
}
