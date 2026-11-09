import { DocumentFormatError, DOCUMENT_VERSIONS, validateDocument as nativeDocument, loadDocument as nativeLoad, validateObject, validateContent, validateComposition, publishDocument as nativePublish } from '../shared/document.mjs'
import { isDeepStrictEqual } from 'node:util'

export const PROD_ORIGIN = 'https://mote.ylxdzsw.com'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_BODY = 128 * 1024 * 1024
export const MAX_RESULT = 8 * 1024 * 1024
export const MAX_SCREENSHOT = 10 * 1024 * 1024
const MAX_NODES = 100000
const MAX_STRING = 8 * 1024 * 1024
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export class HttpError extends Error {
  constructor(status, message, current) { super(message); this.status = status; if (current !== undefined) this.current = current }
}

export function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`)

  return value
}

export function text(value, label, max = MAX_STRING, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new HttpError(400, `${label} must be a ${required ? 'non-empty ' : ''}string`)
  return value
}

export function finite(value, label, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) throw new HttpError(400, `${label} must be a finite number`)
  return value
}

export function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new HttpError(400, `${label} must be a safe identifier`)
  return value
}

function native(check) {
  try { return check() } catch (error) {
    if (error instanceof DocumentFormatError) throw new HttpError(400, error.message)
    throw error
  }
}

export function validateDocument(value) { return native(() => nativeDocument(value)) }
export function loadDocument(value) { return native(() => nativeLoad(value)) }
export function publishDocument(value) { return native(() => nativePublish(nativeLoad(value))) }
export { DOCUMENT_VERSIONS }
export function validateNativeObject(value, options = {}) { return native(() => validateObject(value, options)) }
function composition(blocks, objects, options = {}) { return native(() => validateComposition(blocks, objects, options)) }
function content(value, mode = 'main') { return native(() => validateContent(value, mode)) }

function validateSegmentGeometry(value, objectIds) {
  const geometry = record(value, 'candidate.segment.geometry')
  for (const [id, value] of Object.entries(geometry)) {
    safeId(id, 'candidate.segment.geometry ID')
    if (!objectIds.has(id)) throw new HttpError(400, 'candidate.segment.geometry references an unknown object')
    const box = record(value, `candidate.segment.geometry.${id}`)
    for (const key of ['x', 'y']) finite(box[key], `candidate.segment.geometry.${id}.${key}`)
    for (const key of ['width', 'height']) finite(box[key], `candidate.segment.geometry.${id}.${key}`, 0)
  }
  return geometry
}

function segmentScreenshotPathMap(value, payload) {
  if (value === undefined) return new Map()
  const paths = record(value, 'candidate.screenshotPaths')
  const objects = new Map(payload.objects.map(object => [object.id, object]))
  const result = new Map()
  if (Object.keys(paths).length > 32) throw new HttpError(400, 'candidate.screenshotPaths has too many files')
  for (const [id, pathValue] of Object.entries(paths)) {
    safeId(id, 'candidate.screenshotPaths object ID')
    text(pathValue, `candidate.screenshotPaths.${id}`, 2048, true)
    const object = objects.get(id)
    if (!object || object.kind !== 'html') throw new HttpError(400, 'candidate.screenshotPaths must reference HTML objects in the segment')
    result.set(id, pathValue)
  }
  return result
}

function validateSegmentPayload(value, document, selectedTarget, options = {}) {
  const payload = record(value, 'candidate.segment')
  if (![1, 2].includes(payload.version) || payload.type !== 'segment' || payload.version === 2 && document.page.slideHeight === undefined) throw new HttpError(400, 'candidate.segment must be V1, or V2 for a Slides document')
  if (!Array.isArray(payload.content) || payload.content.length > MAX_NODES) throw new HttpError(400, 'candidate.segment.content must be an array')
  if (!Array.isArray(payload.objects) || payload.objects.length > MAX_NODES) throw new HttpError(400, 'candidate.segment.objects must be an array')
  const screenshotIds = options.screenshotIds ?? new Set()
  composition(payload.content, payload.objects, { version: document.version, allowEmpty: true, slides: payload.version === 2, allowMissingScreenshotIds: screenshotIds })
  if (Object.keys(payload).some(key => !['version', 'type', 'content', 'objects', 'geometry', 'anchorTops', 'originTop'].includes(key))) throw new HttpError(400, 'candidate.segment contains an unsupported field')
  const topIds = new Set(payload.content.map(node => node.attrs.id))
  const objects = new Map(payload.objects.map(object => [object.id, object]))
  const objectIds = new Set(objects.keys())
  validateSegmentGeometry(payload.geometry, objectIds)
  const anchorTops = record(payload.anchorTops, 'candidate.segment.anchorTops')
  for (const [id, value] of Object.entries(anchorTops)) {
    safeId(id, 'candidate.segment.anchorTops ID')
    if (!topIds.has(id)) throw new HttpError(400, 'candidate.segment.anchorTops references a block outside the segment')
    finite(value, `candidate.segment.anchorTops.${id}`)
  }
  finite(payload.originTop, 'candidate.segment.originTop')
  const paths = segmentScreenshotPathMap(options.screenshotPaths, payload)
  if ([...screenshotIds].some(id => !paths.has(id))) throw new HttpError(400, 'candidate.screenshotPaths is incomplete')
  if (selectedTarget?.kind === 'segment') {
    const scope = segmentScope(document, selectedTarget)
    if (!scope) throw new HttpError(400, 'candidate.segment target scope is invalid')
    const selected = scope.blocks.slice(scope.range.start.index, scope.range.end.index)
    const boundaries = selected.filter(block => block.type === 'slideBreak').length
    const supplied = payload.content.filter(block => block.type === 'slideBreak').length
    const omittedLeading = selected[0]?.type === 'slideBreak' && payload.content[0]?.type !== 'slideBreak' ? 1 : 0
    if (payload.content.length || payload.objects.length) {
      if (supplied + omittedLeading !== boundaries) throw new HttpError(400, 'Preserve the reserved slide boundaries in a V2 segment. The leading boundary may be omitted; internal boundaries must remain.')
    }
  }
  return { payload, paths }
}

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

export function validatePngDataUrl(value, label = 'snapshot') {
  text(value, label, Math.ceil(MAX_SCREENSHOT * 4 / 3) + 1024, true)
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  if (!match || Buffer.byteLength(match[1], 'base64') > MAX_SCREENSHOT || !PNG.equals(Buffer.from(match[1], 'base64').subarray(0, 8))) throw new HttpError(400, `${label} must be a bounded PNG data URL`)
}

// Re-resolve location, never ownership. Context edits may move a reservation but
// may not replace its locked contents, body dimensions, or section composition.
export function reservationTarget(original, document, selectedTarget) {
  if (original.id !== document.id || document.version < original.version
    || original.version < 4 && document.version >= 4) throw new HttpError(409, 'Reserved document changed across an incompatible native version; release this task before upgrading')
  const current = structuredClone(selectedTarget)
  const blocks = document.content.content
  if (current.kind === 'segment' && current.bookmarks) {
    const resolve = bookmark => {
      if (bookmark.blockId === null) return { index: bookmark.after ? blocks.length : 0, offset: 0 }
      const index = blocks.findIndex(block => block.attrs.id === bookmark.blockId)
      if (index < 0) throw new HttpError(409, 'Reserved section boundary is missing')
      return { index: index + (bookmark.after ? 1 : 0), offset: bookmark.after ? 0 : bookmark.offset }
    }
    const empty = compareSegmentPoints(current.range.start, current.range.end) === 0
    const start = empty && current.bookmarks.start.after ? { index: blocks.length, offset: 0 } : resolve(current.bookmarks.start)
    current.range = { start, end: empty ? start : resolve(current.bookmarks.end) }
  }
  try { target(current, document) } catch { throw new HttpError(409, 'Reserved target is missing or its scope changed') }
  const objectBody = object => {
    if (!object) return undefined
    const { layout, ...body } = object
    return { ...body, layout: { width: layout.width, height: layout.height },
      ...(object.caption ? { caption: { content: object.caption.content } } : {}) }
  }
  const locked = doc => selectedTarget.kind === 'object'
    ? objectBody(doc.objects.find(object => object.id === selectedTarget.objectId))
    : { blocks: doc.content.content.filter(block => selectedTarget.blockIds.includes(block.attrs.id)),
      ...(selectedTarget.kind === 'segment' ? { objects: doc.objects.filter(object => selectedTarget.objectIds.includes(object.id)) } : {}) }
  if (!isDeepStrictEqual(locked(original), locked(document))) throw new HttpError(409, 'Original reserved content or dimensions changed; create a new reservation')
  return current
}

export function validateRequest(value) {
  const body = record(value, 'request')
  const protocol = body.protocol ?? 'mote-agent-v1'
  if (!['mote-agent-v1', 'mote-agent-v2'].includes(protocol)) throw new HttpError(400, 'unsupported agent protocol')
  if (protocol === 'mote-agent-v2' && !body.cloudDocumentId) throw new HttpError(400, 'mote-agent-v2 requires a cloud document reservation')
  if (!UUID.test(body.id ?? '')) throw new HttpError(400, 'id must be a client-generated UUID')
  const document = validateDocument(body.document)
  const executor = body.executor ?? 'builtin'
  if (!['builtin', 'external'].includes(executor)) throw new HttpError(400, 'executor must be builtin or external')
  if (body.workspaceRead !== undefined && typeof body.workspaceRead !== 'boolean') throw new HttpError(400, 'workspaceRead must be a boolean')
  const model = body.model === undefined ? undefined : text(body.model, 'model', 256, true)
  if (model && (model.includes('\0') || /[\r\n]/.test(model))) throw new HttpError(400, 'model contains an invalid character')
  const prompt = text(body.prompt ?? (executor === 'external' ? '' : undefined), 'prompt', 32 * 1024, executor === 'builtin')
  const selectedTarget = target(body.target, document)
  if (body.snapshot !== undefined) validatePngDataUrl(body.snapshot)
  if (body.targetSnapshot !== undefined) {
    if (selectedTarget.kind !== 'object') throw new HttpError(400, 'targetSnapshot requires an object target')
    validatePngDataUrl(body.targetSnapshot, 'targetSnapshot')
  }
  return { id: body.id, protocol, document, model, prompt, executor, workspaceRead: body.workspaceRead ?? false, target: selectedTarget, snapshot: body.snapshot, targetSnapshot: body.targetSnapshot }
}

export function validateCandidate(value, document, selectedTarget, options = {}) {
  validateDocument(document)
  const result = record(value, 'result')
  const candidate = result.candidate === undefined ? result : record(result.candidate, 'result.candidate')
  const output = { summary: text(candidate.summary, 'candidate.summary', 4096, true) }
  const deliveries = ['object', 'content', 'segment'].filter(key => candidate[key] !== undefined)
  if (deliveries.length > 1) throw new HttpError(400, 'Deliver exactly one of object, content, or segment')
  if (candidate.object?.screenshotPath !== undefined) throw new HttpError(400, 'Put screenshotPath at the result root, alongside object and summary, not inside object')
  if (candidate.sources !== undefined) {
    if (!Array.isArray(candidate.sources) || candidate.sources.length > 32) throw new HttpError(400, 'candidate.sources is invalid')
    output.sources = candidate.sources.map((sourceValue, i) => { const source = record(sourceValue, `candidate.sources[${i}]`); const title = text(source.title, 'source title', 512, true); const url = text(source.url, 'source url', 2048, true); let parsed; try { parsed = new URL(url) } catch { throw new HttpError(400, 'source URL is invalid') }; if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'source URL must use http or https'); return { title, url } })
  }
  if (selectedTarget.kind === 'object') {
    if (!candidate.object || candidate.object.id !== selectedTarget.objectId) throw new HttpError(400, 'candidate.object must retain target id')
    const original = document.objects.find(item => item.id === selectedTarget.objectId)
    if (!selectedTarget.isNew && original.kind !== 'drawing' && candidate.object.kind !== original.kind) throw new HttpError(400, 'candidate.object must retain target kind')
    const hasScreenshotPath = candidate.screenshotPath !== undefined
    let candidateObject = hasScreenshotPath && candidate.object.kind === 'html' ? { ...candidate.object } : candidate.object
    if (hasScreenshotPath) delete candidateObject.screenshot
    if (!selectedTarget.isNew && ['image', 'html'].includes(candidateObject.kind)
      && candidateObject.kind === original.kind && original.markup !== undefined && !Object.hasOwn(candidateObject, 'markup')) {
      candidateObject = { ...candidateObject, markup: structuredClone(original.markup) }
    }
    if (!selectedTarget.isNew && ['image', 'html', 'table'].includes(candidateObject.kind)) {
      const sameKind = candidateObject.kind === original.kind
      if (sameKind && original.caption !== undefined && !Object.hasOwn(candidateObject, 'caption')) candidateObject = { ...candidateObject, caption: structuredClone(original.caption) }
      if (Object.hasOwn(candidateObject, 'caption')) {
        validateNativeObject(candidateObject, { version: document.version, allowMissingScreenshot: hasScreenshotPath && options.allowScreenshotPath })
        const caption = { ...candidateObject.caption }
        const width = sameKind ? original.caption?.width : undefined
        if (width === undefined) delete caption.width
        else caption.width = width
        candidateObject = { ...candidateObject, caption }
      }
    }
    validateNativeObject(candidateObject, { version: document.version, allowMissingScreenshot: hasScreenshotPath && options.allowScreenshotPath })
    candidateObject = { ...candidateObject, layout: { ...candidateObject.layout } }
    if (original.layout.margins === undefined) delete candidateObject.layout.margins
    else candidateObject.layout.margins = structuredClone(original.layout.margins)
    composition(document.content.content, document.objects.map(object => object.id === candidateObject.id ? candidateObject : object), {
      version: document.version, slides: document.page.slideHeight !== undefined,
      allowMissingScreenshotIds: hasScreenshotPath && options.allowScreenshotPath ? new Set([candidateObject.id]) : new Set(),
    })
    output.object = candidateObject
  } else if (selectedTarget.kind === 'text') {
    if (!Array.isArray(candidate.content) || !candidate.content.length || candidate.content.length > 128) throw new HttpError(400, 'candidate.content is required')
    content({ type: 'doc', content: candidate.content }, 'text')
    output.content = candidate.content
  } else {
    if (!candidate.segment) throw new HttpError(400, 'candidate.segment is required')
    let screenshotPaths
    let screenshotIds = new Set()
    if (candidate.screenshotPaths !== undefined) {
      screenshotPaths = record(candidate.screenshotPaths, 'candidate.screenshotPaths')
      for (const id of Object.keys(screenshotPaths)) { safeId(id, 'candidate.screenshotPaths object ID'); screenshotIds.add(id) }
    }
    const checked = validateSegmentPayload(candidate.segment, document, selectedTarget, { screenshotIds, screenshotPaths })
    output.segment = checked.payload
    if (screenshotPaths !== undefined) output.screenshotPaths = Object.fromEntries(checked.paths)
  }
  if (candidate.screenshotPath !== undefined) { if (selectedTarget.kind !== 'object' || candidate.object?.kind !== 'html') throw new HttpError(400, 'candidate.screenshotPath requires an HTML object'); output.screenshotPath = text(candidate.screenshotPath, 'candidate.screenshotPath', 2048, true) }
  if (candidate.screenshotPaths !== undefined && selectedTarget.kind !== 'segment') throw new HttpError(400, 'candidate.screenshotPaths requires a segment candidate')
  return output
}
