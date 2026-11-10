import { createHash } from 'node:crypto'
import { HttpError, MAX_RESULT, MAX_SCREENSHOT, UUID, record, validateProposalCandidate, validatePngDataUrl, PROPOSAL_SCHEMA_URL } from './validation.mjs'

export { PROPOSAL_SCHEMA_URL }

export const AGENT_PROTOCOL = 'mote-agent-v5'
export const TOKEN = /^[A-Za-z0-9_-]{22}$/
export function operationId(value) { if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'operationId must be a UUID'); return value }
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

// Early grammar feedback only: no document, target, source version, executor or
// session is an input. Browser Accept owns applicability and final edit checks.
// Paths are names in the uploaded map, never paths/URLs to open on this server.
export function validateProposalDelivery(raw, assets) {
  try { return proposalDelivery(raw, assets) } catch (error) {
    if (error instanceof HttpError) {
      error.schemaUrl = PROPOSAL_SCHEMA_URL
      error.message += ` Schema: ${PROPOSAL_SCHEMA_URL}`
    }
    throw error
  }
}

function proposalDelivery(raw, assets) {
  record(raw, 'candidate')
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RESULT) throw new HttpError(413, 'candidate JSON is too large')
  const supplied = record(assets ?? {}, 'assets')
  const candidate = validateProposalCandidate(structuredClone(raw), { allowScreenshotPath: true })
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
    candidate.object.screenshot = png(value, candidate.object.layout.width, candidate.object.layout.height, 'screenshot')
    delete candidate.screenshotPath
  }
  for (const object of candidate.segment?.objects ?? []) if (object.kind === 'html') {
    const name = Object.hasOwn(candidate.screenshotPaths ?? {}, object.id) ? candidate.screenshotPaths[object.id] : undefined
    object.screenshot = png(name === undefined ? object.screenshot : asset(name), object.layout.width, object.layout.height, `screenshot for ${object.id}`)
  }
  delete candidate.screenshotPaths
  if (Object.keys(supplied).some(name => !used.has(name))) throw new HttpError(400, 'unused uploaded asset')
  return validateProposalCandidate(candidate)
}
