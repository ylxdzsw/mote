import { createHash } from 'node:crypto'
import { HttpError, MAX_RESULT, MAX_SCREENSHOT, UUID, record, validateCandidate, validatePngDataUrl } from './validation.mjs'

export const AGENT_PROTOCOL = 'mote-agent-v1'
export const TOKEN = /^[A-Za-z0-9_-]{22}$/
export function operationId(value) { if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'operationId must be a UUID'); return value }
export function counter(value, label) { if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${label} must be a non-negative integer`); return value }
export function fingerprint(value) {
  const hash = createHash('sha256')
  const visit = (value, depth = 0) => {
    if (depth > 128) throw new HttpError(413, 'JSON nesting is too deep')
    if (Array.isArray(value)) { hash.update('['); for (const item of value) visit(item, depth + 1); hash.update(']') }
    else if (value && typeof value === 'object') { hash.update('{'); for (const key of Object.keys(value).sort()) { hash.update(JSON.stringify(key) + ':'); visit(value[key], depth + 1) }; hash.update('}') }
    else hash.update(JSON.stringify(value) + ',')
  }
  visit(value); return hash.digest('hex')
}

// Paths are names in the uploaded map, never paths/URLs to open on this server.
export function validateDelivery(raw, assets, document, target) {
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RESULT) throw new HttpError(413, 'candidate JSON is too large')
  const supplied = record(assets ?? {}, 'assets')
  const candidate = validateCandidate(structuredClone(raw), document, target, { allowScreenshotPath: true })
  const used = new Set()
  let total = 0
  const png = (value, width, height, label) => {
    validatePngDataUrl(value, label)
    const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')
    total += bytes.length
    if (total > MAX_SCREENSHOT * 4) throw new HttpError(413, 'candidate screenshots are too large in total')
    if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== Math.round(width) || bytes.readUInt32BE(20) !== Math.round(height)) throw new HttpError(400, `${label} must be a ${Math.round(width)} × ${Math.round(height)} PNG`)
    return value
  }
  const asset = name => {
    if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..') || !Object.hasOwn(supplied, name)) throw new HttpError(400, 'screenshot must name a supplied relative PNG asset')
    used.add(name); return supplied[name]
  }
  if (candidate.object?.kind === 'html') {
    const value = candidate.screenshotPath === undefined ? candidate.object.screenshot : asset(candidate.screenshotPath)
    const original = document.objects.find(object => object.id === target.objectId)
    candidate.object.screenshot = png(value, original.layout.width, original.layout.height, 'screenshot')
    delete candidate.screenshotPath
  }
  for (const object of candidate.segment?.objects ?? []) if (object.kind === 'html') {
    const name = candidate.screenshotPaths?.[object.id]
    object.screenshot = png(name === undefined ? object.screenshot : asset(name), object.layout.width, object.layout.height, `screenshot for ${object.id}`)
  }
  delete candidate.screenshotPaths
  if (Object.keys(supplied).some(name => !used.has(name))) throw new HttpError(400, 'unused uploaded asset')
  return validateCandidate(candidate, document, target)
}
