import { DocumentFormatError, DOCUMENT_VERSION, DOCUMENT_VERSIONS, validateDocument as nativeDocument, loadDocument as nativeLoad, validateObject, validateContent, validateComposition, publishDocument as nativePublish } from '../shared/document.mjs'

export const PROD_ORIGIN = 'https://mote.ylxdzsw.com'
export const PROPOSAL_SCHEMA_URL = `${PROD_ORIGIN}/skills/proposal-schema.json`
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_BODY = 128 * 1024 * 1024
export const MAX_RESULT = 8 * 1024 * 1024
export const MAX_SCREENSHOT = 10 * 1024 * 1024
const MAX_NODES = 100000
const MAX_STRING = 8 * 1024 * 1024
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export class HttpError extends Error {
  constructor(status, message, current, details = {}) { super(message); this.status = status; if (current !== undefined) this.current = current; if (details.path !== undefined) this.path = details.path; if (details.schemaUrl !== undefined) this.schemaUrl = details.schemaUrl }
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
    if (error instanceof DocumentFormatError) throw new HttpError(400, error.message, undefined, { path: error.path })
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
    const box = closed(value, `candidate.segment.geometry.${id}`, ['x', 'y', 'width', 'height'])
    for (const key of ['x', 'y']) finite(box[key], `candidate.segment.geometry.${id}.${key}`)
    for (const key of ['width', 'height']) finite(box[key], `candidate.segment.geometry.${id}.${key}`, 0)
  }
  return geometry
}

function segmentScreenshotPathMap(value, payload) {
  if (value === undefined) return new Map()
  const paths = record(value, 'candidate.screenshotPaths')
  const objects = new Map(payload.objects.map(object => [object?.id, object]))
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

function validateSegmentPayload(value, options = {}) {
  const payload = closed(value, 'candidate.segment', ['version', 'type', 'content', 'objects', 'geometry', 'anchorTops', 'originTop'])
  if (![1, 2].includes(payload.version) || payload.type !== 'segment') throw new HttpError(400, 'candidate.segment must be V1 or V2')
  if (!Array.isArray(payload.objects) || payload.objects.length > MAX_NODES) throw new HttpError(400, 'candidate.segment.objects must be an array')
  const paths = segmentScreenshotPathMap(options.screenshotPaths, payload)
  composition(payload.content, payload.objects, { version: DOCUMENT_VERSION, allowEmpty: true, slides: payload.version === 2, allowMissingScreenshotIds: new Set(paths.keys()) })
  const topIds = new Set(payload.content.map(node => node.attrs.id))
  validateSegmentGeometry(payload.geometry, new Set(payload.objects.map(object => object.id)))
  const anchorTops = record(payload.anchorTops, 'candidate.segment.anchorTops')
  for (const [id, value] of Object.entries(anchorTops)) {
    safeId(id, 'candidate.segment.anchorTops ID')
    if (!topIds.has(id)) throw new HttpError(400, 'candidate.segment.anchorTops references a block outside the segment')
    finite(value, `candidate.segment.anchorTops.${id}`)
  }
  finite(payload.originTop, 'candidate.segment.originTop')
  return payload
}

export function validatePngDataUrl(value, label = 'snapshot') {
  text(value, label, Math.ceil(MAX_SCREENSHOT * 4 / 3) + 1024, true)
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  if (!match || Buffer.byteLength(match[1], 'base64') > MAX_SCREENSHOT || !PNG.equals(Buffer.from(match[1], 'base64').subarray(0, 8))) throw new HttpError(400, `${label} must be a bounded PNG data URL`)
}

function closed(value, label, fields) {
  record(value, label)
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new HttpError(400, `${label}.${key}: unsupported field`, undefined, { path: `${label}.${key}` })
  return value
}

// Proposal grammar is always current-schema and has no document/target input.
// Reservation compatibility, inherited fields and final application belong to Accept.
export function validateProposalCandidate(value, { allowScreenshotPath = false } = {}) {
  const candidate = closed(value, 'candidate', ['summary', 'sources', 'object', 'content', 'segment', ...(allowScreenshotPath ? ['screenshotPath', 'screenshotPaths'] : [])])
  text(candidate.summary, 'candidate.summary', 4096, true)
  const deliveries = ['object', 'content', 'segment'].filter(key => candidate[key] !== undefined)
  if (deliveries.length !== 1) throw new HttpError(400, 'Deliver exactly one of object, content, or segment')
  if (candidate.sources !== undefined) {
    if (!Array.isArray(candidate.sources) || candidate.sources.length > 32) throw new HttpError(400, 'candidate.sources is invalid')
    candidate.sources.forEach((value, i) => {
      const source = closed(value, `candidate.sources[${i}]`, ['title', 'url'])
      text(source.title, 'source title', 512, true)
      const url = text(source.url, 'source url', 2048, true)
      let parsed
      try { parsed = new URL(url) } catch { throw new HttpError(400, 'source URL is invalid') }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'source URL must use http or https')
    })
  }
  if (candidate.screenshotPath !== undefined) {
    if (candidate.object?.kind !== 'html') throw new HttpError(400, 'candidate.screenshotPath requires an HTML object')
    text(candidate.screenshotPath, 'candidate.screenshotPath', 2048, true)
  }
  if (candidate.screenshotPaths !== undefined && candidate.segment === undefined) throw new HttpError(400, 'candidate.screenshotPaths requires a segment candidate')
  if (candidate.object !== undefined) validateNativeObject(candidate.object, { version: DOCUMENT_VERSION, allowMissingScreenshot: candidate.screenshotPath !== undefined })
  else if (candidate.content !== undefined) {
    if (!Array.isArray(candidate.content) || !candidate.content.length || candidate.content.length > 128) throw new HttpError(400, 'candidate.content must contain 1–128 paragraphs')
    content({ type: 'doc', content: candidate.content }, 'text')
  } else validateSegmentPayload(candidate.segment, { screenshotPaths: candidate.screenshotPaths })
  return candidate
}
