export const PROD_ORIGIN = 'https://mote.ylxdzsw.com'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_BODY = 64 * 1024 * 1024
export const MAX_RESULT = 8 * 1024 * 1024
export const MAX_SCREENSHOT = 10 * 1024 * 1024
const MAX_NODES = 100000
const MAX_STRING = 8 * 1024 * 1024
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype'])
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const NEUTRALS = new Set(['ink', 'muted', 'subtle', 'paper'])

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`)
  for (const key of Object.keys(value)) if (DANGEROUS.has(key)) throw new HttpError(400, `${label} contains an unsafe key`)
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
  if (typeof value !== 'string' || !SAFE_ID.test(value) || DANGEROUS.has(value)) throw new HttpError(400, `${label} must be a safe identifier`)
  return value
}

function themeLength(value, label, nonnegative = true) {
  if (typeof value === 'number') return finite(value, label, nonnegative ? 0 : undefined)
  if (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:px|em)$/.test(value)) throw new HttpError(400, `${label} must be a theme length`)
  if (nonnegative && Number(value.slice(0, -2)) < 0) throw new HttpError(400, `${label} must be nonnegative`)
}

function content(value, label = 'content', state = { count: 0, depth: 0 }) {
  if (++state.count > MAX_NODES || state.depth > 100) throw new HttpError(413, 'document content is too large')
  const node = record(value, label)
  text(node.type, `${label}.type`, 64, true)
  if ('text' in node) text(node.text, `${label}.text`)
  if ('attrs' in node && node.attrs != null) {
    const attrs = record(node.attrs, `${label}.attrs`)
    if ('id' in attrs) safeId(attrs.id, `${label}.attrs.id`)
    if ('height' in attrs) finite(attrs.height, `${label}.attrs.height`, 0)
    if ('listLevel' in attrs) { finite(attrs.listLevel, `${label}.attrs.listLevel`, 0); if (!Number.isInteger(attrs.listLevel)) throw new HttpError(400, `${label}.attrs.listLevel must be an integer`) }
    if ('columns' in attrs) {
      if (!Array.isArray(attrs.columns)) throw new HttpError(400, `${label}.attrs.columns must be an array`)
      for (const [i, item] of attrs.columns.entries()) {
        const column = record(item, `${label}.attrs.columns[${i}]`)
        finite(column.width, `${label}.attrs.columns[${i}].width`, Number.MIN_VALUE)
        if (!['left', 'center', 'right'].includes(column.align)) throw new HttpError(400, `${label}.attrs.columns[${i}].align is unsupported`)
      }
    }
  }
  if ('marks' in node) {
    if (!Array.isArray(node.marks)) throw new HttpError(400, `${label}.marks must be an array`)
    for (const [i, markValue] of node.marks.entries()) {
      const mark = record(markValue, `${label}.marks[${i}]`)
      if (!['bold', 'color', 'decoration'].includes(mark.type)) throw new HttpError(400, `${label}.marks[${i}] is unsupported`)
      if (mark.type === 'color') text(record(mark.attrs, `${label}.marks[${i}].attrs`).color, 'mark color', 128, true)
      if (mark.type === 'decoration' && !['box', 'underline'].includes(record(mark.attrs, `${label}.marks[${i}].attrs`).decoration)) throw new HttpError(400, 'unsupported decoration')
    }
  }
  if ('content' in node) {
    if (!Array.isArray(node.content)) throw new HttpError(400, `${label}.content must be an array`)
    const child = { count: state.count, depth: state.depth + 1 }
    node.content.forEach((item, i) => content(item, `${label}.content[${i}]`, child))
    state.count = child.count
  }
}

function embeddedImage(value, label) {
  text(value, label, Math.ceil(MAX_SCREENSHOT * 4 / 3) + 1024, true)
  const comma = value.indexOf(',')
  const match = /^data:(image\/(?:svg\+xml|png|jpeg|webp|gif|avif))(?:;[^,]*)?,/i.exec(value)
  if (comma < 0 || !match) throw new HttpError(400, `${label} must be an embedded image data URL`)
  const header = value.slice(5, comma)
  const payload = value.slice(comma + 1)
  let bytes
  try { bytes = /(?:^|;)base64(?:;|$)/i.test(header) ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8') } catch { throw new HttpError(400, `${label} contains unreadable image data`) }
  if (bytes.length > MAX_SCREENSHOT) throw new HttpError(400, `${label} is too large`)
  if (match[1].toLowerCase() === 'image/png' && !PNG.equals(bytes.subarray(0, 8))) throw new HttpError(400, `${label} is not a PNG`)
  if (match[1].toLowerCase() === 'image/svg+xml' && /<\s*(?:script|iframe|object|embed|foreignObject)\b|\bon[a-z]+\s*=|@import|<!\s*(?:doctype|entity)\b|\b(?:href|src)\s*=\s*(?:"(?!#)|'(?!#)|(?!["'#]))|url\(\s*["']?(?:https?:|ftp:|\/\/|javascript:|data:)/i.test(bytes.toString('utf8'))) throw new HttpError(400, `${label} contains unsafe SVG content`)
}

function palette(document) {
  const entries = new Map()
  if (!Array.isArray(document.theme.palette)) throw new HttpError(400, 'theme.palette must be an array')
  for (const value of document.theme.palette) {
    const entry = record(value, 'theme.palette entry')
    safeId(entry.id, 'theme.palette.id')
    if (entries.has(entry.id)) throw new HttpError(400, 'duplicate palette ID')
    text(entry.name, 'theme.palette.name', 256, true)
    for (const [key, colorValue] of [['strong', entry.strong], ['soft', entry.soft]]) {
      if (key === 'soft' && colorValue === undefined) continue
      if (typeof colorValue !== 'string' || !/^#[0-9a-f]{6}$/i.test(colorValue)) throw new HttpError(400, 'palette colors must be six-digit hex')
    }
    if (NEUTRALS.has(entry.id) ? entry.soft !== undefined : typeof entry.soft !== 'string') throw new HttpError(400, 'invalid palette tones')
    entries.set(entry.id, entry)
  }
  for (const id of NEUTRALS) if (!entries.has(id)) throw new HttpError(400, `missing palette color ${id}`)
  const ref = (value, label) => {
    text(value, label, 128, true)
    const [id, tone, ...rest] = value.split(':')
    if (rest.length || !entries.has(id) || (tone !== undefined && (tone !== 'soft' || !entries.get(id).soft))) throw new HttpError(400, `${label} references an unknown palette color`)
  }
  ref(document.theme.defaults.color, 'theme.defaults.color')
  ref(document.theme.defaults.background, 'theme.defaults.background')
  const visit = node => {
    for (const mark of node.marks ?? []) if (mark.type === 'color') ref(record(mark.attrs, 'mark.attrs').color, 'mark color')
    node.content?.forEach(visit)
  }
  visit(document.content)
  for (const object of document.floating) {
    if (object.content) visit(object.content)
    for (const key of ['fill', 'stroke', 'background', 'borderColor']) if (object[key] != null) ref(object[key], `${key} color`)
  }
}

function theme(value) {
  const valueObject = record(value, 'theme')
  if (valueObject.autospace !== undefined && typeof valueObject.autospace !== 'boolean') throw new HttpError(400, 'theme.autospace must be a boolean')
  const defaults = record(valueObject.defaults, 'theme.defaults')
  for (const key of ['family', 'size', 'color', 'background', 'weight', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']) if (!(key in defaults)) throw new HttpError(400, `theme.defaults.${key} is missing`)
  if (!['sans', 'serif', 'mono'].includes(defaults.family)) throw new HttpError(400, 'invalid default family')
  finite(defaults.size, 'theme.defaults.size', Number.MIN_VALUE)
  for (const key of ['lineHeight', 'spaceBefore', 'spaceAfter']) themeLength(defaults[key], `theme.defaults.${key}`)
  themeLength(defaults.letterSpacing, 'theme.defaults.letterSpacing', false)
  text(defaults.color, 'theme.defaults.color', 128, true); text(defaults.background, 'theme.defaults.background', 128, true)
  const blocks = record(valueObject.blocks, 'theme.blocks')
  for (const name of ['title', 'heading', 'body', 'caption', 'code', 'list', 'table', 'label', 'math']) {
    const style = record(blocks[name] ?? {}, `theme.blocks.${name}`)
    if (style.family !== undefined && !['sans', 'serif', 'mono'].includes(style.family)) throw new HttpError(400, 'invalid theme family')
    for (const key of ['size', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']) if (style[key] !== undefined) themeLength(style[key], `theme.blocks.${name}.${key}`, key !== 'letterSpacing')
    if (style.color !== undefined) text(style.color, 'theme block color', 128, true)
    if (style.weight !== undefined) finite(style.weight, 'theme block weight')
  }
}

function lineEnd(value, label) {
  const end = record(value, label)
  finite(end.x, `${label}.x`); finite(end.y, `${label}.y`, 0)
  if (end.anchorId !== null) safeId(end.anchorId, `${label}.anchorId`)
  if (end.connection) { const connection = record(end.connection, `${label}.connection`); safeId(connection.targetId, 'connection.targetId'); if (!['auto', 'top', 'bottom', 'left', 'right'].includes(connection.side)) throw new HttpError(400, 'invalid connection side') }
}

export function validateFloating(value, label = 'floating object', options = {}) {
  const object = record(value, label)
  safeId(object.id, `${label}.id`)
  if (object.anchorId !== null) safeId(object.anchorId, `${label}.anchorId`)
  finite(object.x, `${label}.x`); finite(object.y, `${label}.y`, 0); finite(object.width, `${label}.width`, 0)
  if (!['overlap', 'repel'].includes(object.textFlow)) throw new HttpError(400, 'invalid text flow')
  const kind = object.kind ?? 'text'
  if (['text', 'table', 'label'].includes(kind)) content(object.content, `${label}.content`)
  if (kind === 'text') { if (object.padding !== undefined) themeLength(object.padding, `${label}.padding`); for (const key of ['background', 'borderColor']) if (key in object && object[key] !== null) text(object[key], `${label}.${key}`, 128) }
  if (kind === 'image') { embeddedImage(object.src, `${label}.src`); text(object.alt, `${label}.alt`, 4096) }
  else if (kind === 'katex') text(object.latex, `${label}.latex`)
  else if (kind === 'html') { text(object.html, `${label}.html`); if (!(options.allowMissingScreenshot && object.screenshot === undefined)) embeddedImage(object.screenshot, `${label}.screenshot`); text(object.alt, `${label}.alt`, 4096); finite(object.height, `${label}.height`, Number.MIN_VALUE) }
  else if (kind === 'rectangle' || kind === 'ellipse') { finite(object.height, `${label}.height`, Number.MIN_VALUE); for (const key of ['fill', 'stroke']) if (object[key] !== null) text(object[key], `${label}.${key}`, 128); finite(object.strokeWidth, `${label}.strokeWidth`, Number.MIN_VALUE); if (typeof object.dashed !== 'boolean' || typeof object.rounded !== 'boolean') throw new HttpError(400, 'invalid shape settings') }
  else if (kind === 'line') { lineEnd(object.start, `${label}.start`); lineEnd(object.end, `${label}.end`); if (object.stroke !== null) text(object.stroke, `${label}.stroke`, 128); finite(object.strokeWidth, `${label}.strokeWidth`, Number.MIN_VALUE); finite(object.bend, `${label}.bend`); if (!['straight', 'elbow'].includes(object.route) || typeof object.dashed !== 'boolean' || typeof object.arrowStart !== 'boolean' || typeof object.arrowEnd !== 'boolean') throw new HttpError(400, 'invalid line settings') }
  else if (kind === 'label') { if (!(object.attachment === null || object.attachment && typeof object.attachment === 'object')) throw new HttpError(400, 'invalid label attachment'); if (object.attachment) { safeId(object.attachment.targetId, 'label target'); if (!['center', 'top-inside', 'top-outside', 'bottom-inside', 'bottom-outside', 'left', 'right', 'above', 'below'].includes(object.attachment.position)) throw new HttpError(400, 'invalid label position') } }
  else if (!['text', 'table', 'image', 'katex', 'html', 'rectangle', 'ellipse', 'line'].includes(kind)) throw new HttpError(400, 'unsupported floating kind')
  return object
}

export function validateDocument(value) {
  const document = record(value, 'document')
  if (document.version !== 'V0') throw new HttpError(400, 'document.version must be V0')
  safeId(document.id, 'document.id')
  if (document.language !== undefined && !['en', 'zh-Hans'].includes(document.language)) throw new HttpError(400, 'unsupported document language')
  finite(document.width, 'document.width', Number.MIN_VALUE)
  const margins = record(document.margins, 'document.margins')
  for (const side of ['top', 'right', 'bottom', 'left']) finite(margins[side], `document.margins.${side}`, 0)
  theme(document.theme); content(document.content); if (document.content.type !== 'doc') throw new HttpError(400, 'document.content must be a doc node')
  if (!Array.isArray(document.floating)) throw new HttpError(400, 'document.floating must be an array')
  const ids = new Set(); for (const [i, object] of document.floating.entries()) { if (ids.has(object?.id)) throw new HttpError(400, 'duplicate floating object ID'); validateFloating(object, `document.floating[${i}]`); ids.add(object.id) }
  palette(document)
  return document
}

function blockIds(node, result = new Set()) {
  if (node?.attrs?.id && ['paragraph', 'spacer'].includes(node.type)) result.add(node.attrs.id)
  for (const child of node?.content ?? []) blockIds(child, result)
  return result
}

function area(value, label) { const object = record(value, label); for (const key of ['x', 'y']) finite(object[key], `${label}.${key}`); for (const key of ['width', 'height']) finite(object[key], `${label}.${key}`, 0); return object }

function target(value, document) {
  const object = record(value, 'target')
  if (object.kind === 'object') { safeId(object.objectId, 'target.objectId'); if (typeof object.isNew !== 'boolean') throw new HttpError(400, 'target.isNew must be boolean'); area(object.area, 'target.area'); if (!document.floating.some(item => item.id === object.objectId)) throw new HttpError(400, 'target object must be a document placeholder'); return object }
  if (object.kind === 'text') {
    if (!Array.isArray(object.blockIds) || !object.blockIds.length || object.blockIds.length > 128) throw new HttpError(400, 'target.blockIds must be a non-empty array')
    const ids = blockIds(document.content); const unique = new Set(object.blockIds); if (unique.size !== object.blockIds.length) throw new HttpError(400, 'target.blockIds must be unique')
    object.blockIds.forEach((id, i) => { safeId(id, `target.blockIds[${i}]`); if (!ids.has(id)) throw new HttpError(400, 'target block is not in document') })
    const selection = record(object.selection, 'target.selection'); for (const key of ['from', 'to']) { finite(selection[key], `target.selection.${key}`, 0); if (!Number.isInteger(selection[key])) throw new HttpError(400, 'selection offsets must be integers') }; if (selection.to < selection.from) throw new HttpError(400, 'invalid selection range')
    if (typeof object.insert !== 'boolean') throw new HttpError(400, 'target.insert must be boolean'); area(object.area, 'target.area'); return object
  }
  throw new HttpError(400, 'target.kind must be object or text')
}

export function validatePngDataUrl(value, label = 'snapshot') {
  text(value, label, Math.ceil(MAX_SCREENSHOT * 4 / 3) + 1024, true)
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  if (!match || Buffer.byteLength(match[1], 'base64') > MAX_SCREENSHOT || !PNG.equals(Buffer.from(match[1], 'base64').subarray(0, 8))) throw new HttpError(400, `${label} must be a bounded PNG data URL`)
}

export function validateRequest(value) {
  const body = record(value, 'request')
  if (!UUID.test(body.id ?? '')) throw new HttpError(400, 'id must be a client-generated UUID')
  const document = validateDocument(body.document)
  const model = body.model === undefined ? undefined : text(body.model, 'model', 256, true)
  if (model && (model.includes('\0') || /[\r\n]/.test(model))) throw new HttpError(400, 'model contains an invalid character')
  const prompt = text(body.prompt, 'prompt', 32 * 1024, true)
  const selectedTarget = target(body.target, document)
  if (body.snapshot !== undefined) validatePngDataUrl(body.snapshot)
  return { id: body.id, document, model, prompt, target: selectedTarget, snapshot: body.snapshot }
}

export function validateCandidate(value, document, selectedTarget, options = {}) {
  const result = record(value, 'result')
  const candidate = result.candidate === undefined ? result : record(result.candidate, 'result.candidate')
  const output = { summary: text(candidate.summary, 'candidate.summary', 4096, true) }
  if (candidate.object && candidate.content) throw new HttpError(400, 'Deliver object or content, not both')
  if (candidate.object?.screenshotPath !== undefined) throw new HttpError(400, 'Put screenshotPath at the result root, alongside object and summary, not inside object')
  if (candidate.sources !== undefined) {
    if (!Array.isArray(candidate.sources) || candidate.sources.length > 32) throw new HttpError(400, 'candidate.sources is invalid')
    output.sources = candidate.sources.map((sourceValue, i) => { const source = record(sourceValue, `candidate.sources[${i}]`); const title = text(source.title, 'source title', 512, true); const url = text(source.url, 'source url', 2048, true); let parsed; try { parsed = new URL(url) } catch { throw new HttpError(400, 'source URL is invalid') }; if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'source URL must use http or https'); return { title, url } })
  }
  if (selectedTarget.kind === 'object') {
    if (!candidate.object || candidate.object.id !== selectedTarget.objectId) throw new HttpError(400, 'candidate.object must retain target id')
    const original = document.floating.find(item => item.id === selectedTarget.objectId)
    if (!selectedTarget.isNew && (candidate.object.kind ?? 'text') !== (original.kind ?? 'text')) throw new HttpError(400, 'candidate.object must retain target kind')
    const hasScreenshotPath = candidate.screenshotPath !== undefined
    const candidateObject = hasScreenshotPath && (candidate.object.kind ?? 'text') === 'html' ? { ...candidate.object } : candidate.object
    if (hasScreenshotPath) delete candidateObject.screenshot
    validateFloating(candidateObject, 'candidate.object', { allowMissingScreenshot: hasScreenshotPath && options.allowScreenshotPath }); output.object = candidateObject
  } else {
    if (!Array.isArray(candidate.content) || !candidate.content.length || candidate.content.length > 128) throw new HttpError(400, 'candidate.content is required')
    candidate.content.forEach((node, i) => content(node, `candidate.content[${i}]`)); output.content = candidate.content
  }
  if (candidate.screenshotPath !== undefined) { if (selectedTarget.kind !== 'object' || (candidate.object?.kind ?? 'text') !== 'html') throw new HttpError(400, 'candidate.screenshotPath requires an HTML object'); output.screenshotPath = text(candidate.screenshotPath, 'candidate.screenshotPath', 2048, true) }
  return output
}

export function pngSignature(bytes) { return PNG.equals(bytes.subarray(0, 8)) }
export function pngDataUrl(bytes) { return `data:image/png;base64,${bytes.toString('base64')}` }
