export const PROD_ORIGIN = 'https://mote.ylxdzsw.com'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_BODY = 128 * 1024 * 1024
export const MAX_RESULT = 8 * 1024 * 1024
export const MAX_SCREENSHOT = 10 * 1024 * 1024
const MAX_NODES = 100000
const MAX_STRING = 8 * 1024 * 1024
const SAFE_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype'])
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const NEUTRALS = new Set(['ink', 'muted', 'paper'])
const PRIMARY = new Set(['primary', 'primary-soft', 'primary-surface'])

export class HttpError extends Error {
  constructor(status, message, current) { super(message); this.status = status; if (current !== undefined) this.current = current }
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

function rejectLegacyAttachments(value, label, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (key === 'attachment') throw new HttpError(400, `${label} contains an unsupported legacy attachment field`)
    rejectLegacyAttachments(child, label, seen)
  }
}

function themeLength(value, label, nonnegative = true) {
  if (typeof value === 'number') return finite(value, label, nonnegative ? 0 : undefined)
  if (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:px|em)$/.test(value)) throw new HttpError(400, `${label} must be a theme length`)
  if (nonnegative && Number(value.slice(0, -2)) < 0) throw new HttpError(400, `${label} must be nonnegative`)
}

function content(value, label = 'content', state = { count: 0, depth: 0 }, flowDepth = -1) {
  if (++state.count > MAX_NODES || state.depth > 100) throw new HttpError(413, 'document content is too large')
  const node = record(value, label)
  text(node.type, `${label}.type`, 64, true)
  if (node.type === 'flow') {
    if (state.depth !== flowDepth) throw new HttpError(400, 'Flow nodes are only supported as top-level main blocks')
    const attrs = record(node.attrs, `${label}.attrs`)
    safeId(attrs.id, `${label}.attrs.id`); safeId(attrs.objectId, `${label}.attrs.objectId`)
    if (Object.keys(attrs).some(key => !['id', 'objectId'].includes(key)) || node.content?.length || node.text !== undefined || node.marks?.length) throw new HttpError(400, 'Flow blocks contain only id and objectId')
  }
  if ('text' in node) text(node.text, `${label}.text`)
  if ('attrs' in node && node.attrs != null) {
    const attrs = record(node.attrs, `${label}.attrs`)
    if (node.type === 'paragraph' && attrs.semantic === 'code') throw new HttpError(400, `${label}.attrs.semantic code paragraphs are unsupported`)
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
    node.content.forEach((item, i) => content(item, `${label}.content[${i}]`, child, flowDepth))
    state.count = child.count
  }
}

function validateCaption(value, label) {
  const doc = record(value, label)
  if (doc.type !== 'doc' || Object.keys(doc).some(key => !['type', 'content'].includes(key)) || !Array.isArray(doc.content) || doc.content.length !== 1) throw new HttpError(400, `${label} must contain exactly one paragraph`)
  const paragraph = record(doc.content[0], `${label}.content[0]`)
  if (paragraph.type !== 'paragraph' || Object.keys(paragraph).some(key => !['type', 'attrs', 'content'].includes(key))) throw new HttpError(400, `${label} must contain exactly one paragraph`)
  const attrs = record(paragraph.attrs, `${label}.content[0].attrs`)
  if (Object.keys(attrs).length !== 1 || !Object.hasOwn(attrs, 'id')) throw new HttpError(400, `${label} paragraph attrs must contain only id`)
  safeId(attrs.id, `${label}.content[0].attrs.id`)
  if (paragraph.content !== undefined && !Array.isArray(paragraph.content)) throw new HttpError(400, `${label}.content[0].content must be an array`)
  content(doc, label)
  for (const [index, value] of (paragraph.content ?? []).entries()) {
    const node = record(value, `${label}.content[0].content[${index}]`)
    if (node.type === 'text') {
      if (!Object.hasOwn(node, 'text') || Object.keys(node).some(key => !['type', 'text', 'marks'].includes(key))) throw new HttpError(400, `${label} supports only inline text and hard breaks`)
    } else if (node.type === 'hardBreak') {
      if (Object.keys(node).some(key => !['type', 'marks'].includes(key))) throw new HttpError(400, `${label} supports only inline text and hard breaks`)
    } else throw new HttpError(400, `${label} supports only inline text and hard breaks`)
    for (const [markIndex, markValue] of (node.marks ?? []).entries()) {
      const mark = record(markValue, `${label}.content[0].content[${index}].marks[${markIndex}]`)
      const allowed = mark.type === 'bold' ? ['type'] : ['type', 'attrs']
      if (Object.keys(mark).some(key => !allowed.includes(key))) throw new HttpError(400, `${label} uses an unsupported mark shape`)
      if (mark.type !== 'bold') {
        const markAttrs = record(mark.attrs, `${label}.content[0].content[${index}].marks[${markIndex}].attrs`)
        const attr = mark.type === 'color' ? 'color' : 'decoration'
        if (Object.keys(markAttrs).length !== 1 || !Object.hasOwn(markAttrs, attr)) throw new HttpError(400, `${label} uses an unsupported mark shape`)
      }
    }
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
  const entries = new Map([['primary', { soft: true }]])
  if (!Array.isArray(document.theme.palette)) throw new HttpError(400, 'theme.palette must be an array')
  for (const value of document.theme.palette) {
    const entry = record(value, 'theme.palette entry')
    safeId(entry.id, 'theme.palette.id')
    if (PRIMARY.has(entry.id)) throw new HttpError(400, 'Primary is generated from theme.hue, not stored in the palette')
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
  for (const style of Object.values(document.theme.blocks)) if (style.color !== undefined) ref(style.color, 'theme block color')
  const visit = node => {
    for (const mark of node.marks ?? []) if (mark.type === 'color') ref(record(mark.attrs, 'mark.attrs').color, 'mark color')
    node.content?.forEach(visit)
  }
  visit(document.content)
  for (const object of document.floating) {
    if (object.content) visit(object.content)
    if (object.caption) visit(object.caption)
    if (object.kind === 'drawing') for (const item of [...object.strokes, ...object.labels]) ref(item.color, 'drawing color')
    for (const key of ['background', 'borderColor']) if (object[key] != null) ref(object[key], `${key} color`)
  }
}

function theme(value) {
  const valueObject = record(value, 'theme')
  if (finite(valueObject.hue, 'theme.hue', 0) >= 360) throw new HttpError(400, 'theme.hue must be less than 360')
  if (valueObject.autospace !== undefined && typeof valueObject.autospace !== 'boolean') throw new HttpError(400, 'theme.autospace must be a boolean')
  const defaults = record(valueObject.defaults, 'theme.defaults')
  for (const key of ['family', 'size', 'color', 'background', 'weight', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']) if (!(key in defaults)) throw new HttpError(400, `theme.defaults.${key} is missing`)
  if (!['sans', 'serif', 'mono'].includes(defaults.family)) throw new HttpError(400, 'invalid default family')
  finite(defaults.size, 'theme.defaults.size', Number.MIN_VALUE)
  for (const key of ['lineHeight', 'spaceBefore', 'spaceAfter']) themeLength(defaults[key], `theme.defaults.${key}`)
  themeLength(defaults.letterSpacing, 'theme.defaults.letterSpacing', false)
  text(defaults.color, 'theme.defaults.color', 128, true); text(defaults.background, 'theme.defaults.background', 128, true)
  const blocks = record(valueObject.blocks, 'theme.blocks')
  for (const name of ['title', 'heading', 'body', 'caption', 'code', 'list', 'table', 'math']) {
    const style = record(blocks[name] ?? {}, `theme.blocks.${name}`)
    if (style.family !== undefined && !['sans', 'serif', 'mono'].includes(style.family)) throw new HttpError(400, 'invalid theme family')
    for (const key of ['size', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']) if (style[key] !== undefined) themeLength(style[key], `theme.blocks.${name}.${key}`, key !== 'letterSpacing')
    if (style.color !== undefined) text(style.color, 'theme block color', 128, true)
    if (style.weight !== undefined) finite(style.weight, 'theme block weight')
  }
}

export function validateFloating(value, label = 'floating object', options = {}) {
  rejectLegacyAttachments(value, label)
  const object = record(value, label)
  safeId(object.id, `${label}.id`)
  if (object.anchorId !== null) safeId(object.anchorId, `${label}.anchorId`)
  finite(object.x, `${label}.x`); finite(object.y, `${label}.y`); finite(object.width, `${label}.width`, 0)
  if ('textFlow' in object || !['flow', 'float'].includes(object.placement)) throw new HttpError(400, 'invalid object placement')
  if (object.centered !== undefined && typeof object.centered !== 'boolean') throw new HttpError(400, 'centered must be a boolean')
  if (object.placement === 'flow' && (object.anchorId === null || object.y !== 0)) throw new HttpError(400, 'Flow objects require their block anchor and y=0')
  const kind = object.kind ?? 'text'
  if ('caption' in object) {
    if (!['image', 'html', 'table'].includes(kind)) throw new HttpError(400, `${label}.caption is only supported on image, html, and table objects`)
    validateCaption(object.caption, `${label}.caption`)
  }
  if (['text', 'table'].includes(kind)) content(object.content, `${label}.content`)
  if (kind === 'text') { if (object.padding !== undefined) themeLength(object.padding, `${label}.padding`); for (const key of ['background', 'borderColor']) if (key in object && object[key] !== null) text(object[key], `${label}.${key}`, 128) }
  if (kind === 'image') { embeddedImage(object.src, `${label}.src`); text(object.alt, `${label}.alt`, 4096) }
  else if (kind === 'katex') text(object.latex, `${label}.latex`)
  else if (kind === 'html') { text(object.html, `${label}.html`); if (!(options.allowMissingScreenshot && object.screenshot === undefined)) embeddedImage(object.screenshot, `${label}.screenshot`); text(object.alt, `${label}.alt`, 4096); finite(object.height, `${label}.height`, Number.MIN_VALUE) }
  else if (kind === 'code') {
    text(object.source, `${label}.source`)
    const language = text(object.language, `${label}.language`, 64, true)
    if (!SAFE_LANGUAGE.test(language)) throw new HttpError(400, `${label}.language must be a safe identifier`)
    if (!['light', 'dark'].includes(object.scheme)) throw new HttpError(400, `${label}.scheme must be light or dark`)
  }
  else if (kind === 'drawing') {
    finite(object.width, `${label}.width`, Number.MIN_VALUE)
    finite(object.height, `${label}.height`, Number.MIN_VALUE)
    if (object.background !== null && object.background !== 'paper') throw new HttpError(400, `${label}.background must be paper or null`)
    if (!Array.isArray(object.strokes) || object.strokes.length > 10000) throw new HttpError(400, `${label}.strokes must contain at most 10000 strokes`)
    let points = 0
    for (const [index, value] of object.strokes.entries()) {
      const name = `${label}.strokes[${index}]`, stroke = record(value, name)
      text(stroke.color, `${name}.color`, 128, true)
      finite(stroke.width, `${name}.width`, Number.MIN_VALUE)
      if (!Array.isArray(stroke.points) || !stroke.points.length || (points += stroke.points.length) > 100000) throw new HttpError(400, `${label} must contain at most 100000 points, with at least one per stroke`)
      for (const point of stroke.points) {
        if (!Array.isArray(point) || point.length !== 2) throw new HttpError(400, `${name}.points must contain coordinate pairs`)
        finite(point[0], `${name}.point.x`); finite(point[1], `${name}.point.y`)
      }
    }
    if (!Array.isArray(object.labels) || object.labels.length > 1000) throw new HttpError(400, `${label}.labels must contain at most 1000 labels`)
    for (const [index, value] of object.labels.entries()) {
      const name = `${label}.labels[${index}]`, item = record(value, name)
      finite(item.x, `${name}.x`); finite(item.y, `${name}.y`)
      finite(item.size, `${name}.size`, Number.MIN_VALUE)
      text(item.color, `${name}.color`, 128, true)
      text(item.text, `${name}.text`, 4096)
    }
  }
  else if (!['text', 'table', 'image', 'katex', 'html', 'code', 'drawing'].includes(kind)) throw new HttpError(400, 'unsupported floating kind')
  return object
}

function validateCaptionIds(blocks, objects, scope) {
  const ids = new Set([...blocks.map(block => block.attrs?.id), ...objects.map(object => object.id)])
  for (const object of objects) if (object.caption) {
    const id = object.caption.content[0].attrs.id
    if (ids.has(id)) throw new HttpError(400, `${scope} caption paragraph IDs must be unique and distinct from object and main block IDs`)
    ids.add(id)
  }
}

function validateFlowReferences(blocks, objects, scope) {
  validateCaptionIds(blocks, objects, scope)
  const byId = new Map(objects.map(object => [object.id, object]))
  const blockIds = new Set(), flowAnchors = new Set(), flows = new Set()
  for (const block of blocks) {
    const id = block.attrs?.id
    safeId(id, `${scope} block ID`)
    if (blockIds.has(id) || byId.has(id)) throw new HttpError(400, `${scope} block IDs must be unique and distinct from object IDs`)
    blockIds.add(id)
    if (block.type !== 'flow') continue
    const objectId = block.attrs.objectId, object = byId.get(objectId)
    if (!object || object.placement !== 'flow' || object.anchorId !== id || object.y !== 0 || flows.has(objectId)) throw new HttpError(400, `${scope} Flow block must reference exactly one matching Flow object`)
    flows.add(objectId)
    flowAnchors.add(id)
  }
  for (const object of objects) {
    if (object.placement === 'flow' && !flows.has(object.id)) throw new HttpError(400, `${scope} Flow object requires exactly one Flow block`)
    if (object.anchorId !== null && !blockIds.has(object.anchorId)) throw new HttpError(400, `${scope} object anchor is outside its blocks`)
    if (!flowAnchors.has(object.anchorId) && object.y < 0) throw new HttpError(400, `${scope} object y must be nonnegative outside a Flow anchor`)
  }
}

export function validateDocument(value) {
  rejectLegacyAttachments(value, 'document')
  const document = record(value, 'document')
  if (document.version !== 'V0') throw new HttpError(400, 'document.version must be V0')
  safeId(document.id, 'document.id')
  if (document.language !== undefined && !['en', 'zh-Hans'].includes(document.language)) throw new HttpError(400, 'unsupported document language')
  if (Array.isArray(document.notes)) document.notes.forEach((note, index) => text(note, `document.notes[${index}]`))
  else if (document.notes !== undefined) text(document.notes, 'document.notes')
  finite(document.width, 'document.width', Number.MIN_VALUE)
  const margins = record(document.margins, 'document.margins')
  for (const side of ['top', 'right', 'bottom', 'left']) finite(margins[side], `document.margins.${side}`, 0)
  theme(document.theme); content(document.content, 'content', { count: 0, depth: 0 }, 1); if (document.content.type !== 'doc') throw new HttpError(400, 'document.content must be a doc node')
  if (!Array.isArray(document.floating)) throw new HttpError(400, 'document.floating must be an array')
  const ids = new Set(); for (const [i, object] of document.floating.entries()) { if (ids.has(object?.id)) throw new HttpError(400, 'duplicate floating object ID'); validateFloating(object, `document.floating[${i}]`); ids.add(object.id) }
  validateFlowReferences(document.content.content ?? [], document.floating, 'document')
  palette(document)
  return document
}

function segmentNodeIds(node, result = new Set()) {
  if (node?.attrs?.id !== undefined) safeId(node.attrs.id, 'segment node ID')
  if (node?.attrs?.id) result.add(node.attrs.id)
  for (const child of node?.content ?? []) segmentNodeIds(child, result)
  return result
}

function validateSegmentPalette(entries) {
  if (!Array.isArray(entries) || entries.length > 512) throw new HttpError(400, 'candidate.segment.palette must be an array')
  const byId = new Map()
  for (const [index, value] of entries.entries()) {
    const entry = record(value, `candidate.segment.palette[${index}]`)
    safeId(entry.id, `candidate.segment.palette[${index}].id`)
    if (PRIMARY.has(entry.id)) throw new HttpError(400, 'Primary follows the destination theme; omit it from the segment palette')
    if (byId.has(entry.id)) throw new HttpError(400, 'candidate.segment.palette IDs must be unique')
    text(entry.name, `candidate.segment.palette[${index}].name`, 256, true)
    if (!/^#[0-9a-f]{6}$/i.test(entry.strong ?? '')) throw new HttpError(400, 'candidate.segment palette colors must be six-digit hex')
    if (NEUTRALS.has(entry.id)) {
      if (entry.soft !== undefined) throw new HttpError(400, 'neutral segment palette colors must not have a soft tone')
    } else if (!/^#[0-9a-f]{6}$/i.test(entry.soft ?? '')) {
      throw new HttpError(400, 'non-neutral segment palette colors need a soft tone')
    }
    byId.set(entry.id, entry)
  }
  return byId
}

function segmentPaletteReferences(node, result = new Set()) {
  for (const mark of node?.marks ?? []) if (mark.type === 'color' && typeof mark.attrs?.color === 'string') result.add(mark.attrs.color)
  for (const child of node?.content ?? []) segmentPaletteReferences(child, result)
  return result
}

function segmentObjectPaletteReferences(object, result = new Set()) {
  if (object.kind === 'drawing') for (const item of [...object.strokes, ...object.labels]) result.add(item.color)
  if ('content' in object) segmentPaletteReferences(object.content, result)
  if ('caption' in object) segmentPaletteReferences(object.caption, result)
  for (const key of ['background', 'borderColor']) {
    const value = object[key]
    if (typeof value === 'string') result.add(value)
  }
  return result
}

function validateSegmentGeometry(value, objectIds) {
  const geometry = record(value, 'candidate.segment.geometry')
  for (const [id, value] of Object.entries(geometry)) {
    safeId(id, 'candidate.segment.geometry ID')
    if (!objectIds.has(id)) throw new HttpError(400, 'candidate.segment.geometry references an unknown floating object')
    const box = record(value, `candidate.segment.geometry.${id}`)
    for (const key of ['x', 'y']) finite(box[key], `candidate.segment.geometry.${id}.${key}`)
    for (const key of ['width', 'height']) finite(box[key], `candidate.segment.geometry.${id}.${key}`, 0)
  }
  return geometry
}

function segmentScreenshotPathMap(value, payload) {
  if (value === undefined) return new Map()
  const paths = record(value, 'candidate.screenshotPaths')
  const objects = new Map(payload.floating.map(object => [object.id, object]))
  const result = new Map()
  if (Object.keys(paths).length > 32) throw new HttpError(400, 'candidate.screenshotPaths has too many files')
  for (const [id, pathValue] of Object.entries(paths)) {
    safeId(id, 'candidate.screenshotPaths object ID')
    text(pathValue, `candidate.screenshotPaths.${id}`, 2048, true)
    const object = objects.get(id)
    if (!object || (object.kind ?? 'text') !== 'html') throw new HttpError(400, 'candidate.screenshotPaths must reference HTML objects in the segment')
    result.set(id, pathValue)
  }
  return result
}

function validateSegmentPayload(value, document, selectedTarget, options = {}) {
  const payload = record(value, 'candidate.segment')
  if (payload.version !== 'V0' || payload.type !== 'segment') throw new HttpError(400, 'candidate.segment must be a V0 segment')
  if (!Array.isArray(payload.content) || payload.content.length > MAX_NODES) throw new HttpError(400, 'candidate.segment.content must be an array')
  if (!Array.isArray(payload.floating) || payload.floating.length > MAX_NODES) throw new HttpError(400, 'candidate.segment.floating must be an array')
  const topIds = new Set()
  for (const [index, node] of payload.content.entries()) {
    if (!node || !['paragraph', 'spacer', 'flow'].includes(node.type)) throw new HttpError(400, 'candidate.segment.content must contain paragraphs, spacers, and Flow blocks')
    content(node, `candidate.segment.content[${index}]`, { count: 0, depth: 0 }, 0)
    const attrs = record(node.attrs, `candidate.segment.content[${index}].attrs`)
    safeId(attrs.id, `candidate.segment.content[${index}].attrs.id`)
    if (topIds.has(attrs.id)) throw new HttpError(400, 'candidate.segment.content block IDs must be unique')
    topIds.add(attrs.id)
    if (node.type === 'spacer') finite(attrs.height, `candidate.segment.content[${index}].attrs.height`, 0)
    if (node.type === 'paragraph' && attrs.semantic !== undefined && !['title', 'heading', 'body', 'caption', 'list'].includes(attrs.semantic)) throw new HttpError(400, 'candidate.segment paragraph semantic is unsupported')
  }
  const nodeIds = new Set()
  for (const node of payload.content) segmentNodeIds(node, nodeIds)
  const paletteById = validateSegmentPalette(payload.palette)
  const objects = new Map()
  const screenshotIds = options.screenshotIds ?? new Set()
  for (const [index, value] of payload.floating.entries()) {
    const object = record(value, `candidate.segment.floating[${index}]`)
    if (objects.has(object.id)) throw new HttpError(400, 'candidate.segment floating object IDs must be unique')
    validateFloating(object, `candidate.segment.floating[${index}]`, { allowMissingScreenshot: screenshotIds.has(object.id) })
    objects.set(object.id, object)
  }
  const objectIds = new Set(objects.keys())
  validateFlowReferences(payload.content, [...objects.values()], 'candidate.segment')
  const geometry = validateSegmentGeometry(payload.geometry, objectIds)
  const anchorTops = record(payload.anchorTops, 'candidate.segment.anchorTops')
  for (const [id, value] of Object.entries(anchorTops)) {
    safeId(id, 'candidate.segment.anchorTops ID')
    if (!topIds.has(id)) throw new HttpError(400, 'candidate.segment.anchorTops references a block outside the segment')
    finite(value, `candidate.segment.anchorTops.${id}`)
  }
  finite(payload.originTop, 'candidate.segment.originTop')
  const references = new Set()
  for (const node of payload.content) segmentPaletteReferences(node, references)
  for (const object of objects.values()) segmentObjectPaletteReferences(object, references)
  const available = new Set(['primary', ...NEUTRALS, ...paletteById.keys()])
  for (const reference of references) {
    const [id, tone, ...rest] = reference.split(':')
    if (rest.length || !available.has(id) || (tone !== undefined && (tone !== 'soft' || (id !== 'primary' && !paletteById.get(id)?.soft)))) throw new HttpError(400, 'candidate.segment references an unknown palette color')
  }
  for (const object of objects.values()) if (object.kind === 'html' && object.screenshot === undefined && !screenshotIds.has(object.id)) throw new HttpError(400, 'candidate.segment HTML objects need screenshots')
  const paths = segmentScreenshotPathMap(options.screenshotPaths, payload)
  if ([...screenshotIds].some(id => !paths.has(id))) throw new HttpError(400, 'candidate.screenshotPaths is incomplete')
  if (selectedTarget?.kind === 'segment') {
    const scope = segmentScope(document, selectedTarget)
    if (!scope) throw new HttpError(400, 'candidate.segment target scope is invalid')
  }
  return { payload, paths, geometry, objects, nodeIds }
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
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block.type === 'spacer') {
      const height = segmentBlockHeight(block)
      const start = index === range.start.index ? range.start.offset : 0
      const end = index === range.end.index ? range.end.offset : height
      if (index >= range.start.index && index <= range.end.index && end > start) {
        const id = segmentBlockId(block)
        spacers.set(id ?? `index:${index}`, { start, end })
        indices.add(index)
        if (id) blockIds.add(id)
      }
    } else if (index >= range.start.index && index < range.end.index) {
      indices.add(index)
      const id = segmentBlockId(block)
      if (id) blockIds.add(id)
    }
  }
  return { spacers, blockIds, indices }
}

function segmentAnchorSelected(anchorId, y, blocks, selected) {
  if (anchorId === null) return false
  const index = blocks.findIndex(block => segmentBlockId(block) === anchorId)
  if (index < 0 || !selected.indices.has(index)) return false
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
  return new Set(document.floating.filter(object => segmentPointSelected(object.anchorId, object.y, blocks, selected, range)).map(object => object.id))
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
  if (object.kind === 'object') { safeId(object.objectId, 'target.objectId'); if (typeof object.isNew !== 'boolean') throw new HttpError(400, 'target.isNew must be boolean'); area(object.area, 'target.area'); if (!document.floating.some(item => item.id === object.objectId)) throw new HttpError(400, 'target object must be a document placeholder'); return object }
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

export function validateRequest(value) {
  rejectLegacyAttachments(value, 'request')
  const body = record(value, 'request')
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
  return { id: body.id, document, model, prompt, executor, workspaceRead: body.workspaceRead ?? false, target: selectedTarget, snapshot: body.snapshot }
}

export function validateCandidate(value, document, selectedTarget, options = {}) {
  rejectLegacyAttachments(document, 'document')
  rejectLegacyAttachments(selectedTarget, 'target')
  rejectLegacyAttachments(value, 'candidate')
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
    const original = document.floating.find(item => item.id === selectedTarget.objectId)
    if (!selectedTarget.isNew && original.kind !== 'drawing' && (candidate.object.kind ?? 'text') !== (original.kind ?? 'text')) throw new HttpError(400, 'candidate.object must retain target kind')
    const hasScreenshotPath = candidate.screenshotPath !== undefined
    let candidateObject = hasScreenshotPath && (candidate.object.kind ?? 'text') === 'html' ? { ...candidate.object } : candidate.object
    if (hasScreenshotPath) delete candidateObject.screenshot
    if (!selectedTarget.isNew && ['image', 'html', 'table'].includes(original.kind) && original.caption !== undefined && !Object.hasOwn(candidateObject, 'caption') && (candidateObject.kind ?? 'text') === original.kind) candidateObject = { ...candidateObject, caption: structuredClone(original.caption) }
    validateFloating(candidateObject, 'candidate.object', { allowMissingScreenshot: hasScreenshotPath && options.allowScreenshotPath })
    validateCaptionIds(document.content.content ?? [], document.floating.map(object => object.id === candidateObject.id ? candidateObject : object), 'candidate.object')
    output.object = candidateObject
    palette({ ...document, content: { type: 'doc' }, floating: [candidateObject] })
  } else if (selectedTarget.kind === 'text') {
    if (!Array.isArray(candidate.content) || !candidate.content.length || candidate.content.length > 128) throw new HttpError(400, 'candidate.content is required')
    candidate.content.forEach((node, i) => { if (node?.type !== 'paragraph') throw new HttpError(400, 'text candidates must contain paragraphs'); content(node, `candidate.content[${i}]`) }); output.content = candidate.content
    palette({ ...document, content: { type: 'doc', content: candidate.content }, floating: [] })
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
  if (candidate.screenshotPath !== undefined) { if (selectedTarget.kind !== 'object' || (candidate.object?.kind ?? 'text') !== 'html') throw new HttpError(400, 'candidate.screenshotPath requires an HTML object'); output.screenshotPath = text(candidate.screenshotPath, 'candidate.screenshotPath', 2048, true) }
  if (candidate.screenshotPaths !== undefined && selectedTarget.kind !== 'segment') throw new HttpError(400, 'candidate.screenshotPaths requires a segment candidate')
  return output
}

export function pngSignature(bytes) { return PNG.equals(bytes.subarray(0, 8)) }
export function pngDataUrl(bytes) { return `data:image/png;base64,${bytes.toString('base64')}` }
