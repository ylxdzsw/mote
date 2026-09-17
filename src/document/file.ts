import { inlineClasses, themeBlockClasses, type MoteDocument } from './model'
import { initializeDocument } from './initialize'

const maxCompressedBytes = 128 * 1024 * 1024
const maxDecompressedBytes = 128 * 1024 * 1024

class MoteFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoteFileError'
  }
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new MoteFileError(`Invalid .mote document: ${message}`)
}

function record(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) invalid(`${path} must be an object`)
  return value
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) invalid(`${path} must be a safe identifier`)
  return value
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(`${path} must be a string`)
  return value
}

function finite(value: unknown, path: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    invalid(`${path} must be a finite number${minimum === undefined ? '' : ` at least ${minimum}`}`)
  }
  return value
}

function finiteValues(value: unknown, path = 'document'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => finiteValues(item, `${path}[${index}]`))
    return
  }
  if (isRecord(value)) for (const [key, child] of Object.entries(value)) finiteValues(child, `${path}.${key}`)
}

function safeStyleString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 256 || !CSS.supports('color', value) || /var\s*\(/i.test(value)) {
    invalid(`${path} contains unsafe style text`)
  }
  return value
}

function themeLength(value: unknown, path: string): void {
  if (typeof value === 'number') {
    finite(value, path)
    return
  }
  if (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:px|em)$/.test(value) || !Number.isFinite(parseFloat(value))) invalid(`${path} must be a finite theme length`)
}

function themeStyle(value: unknown, path: string): void {
  const style = record(value, path)
  if ('family' in style && !['sans', 'serif', 'mono'].includes(style.family as string)) invalid(`${path}.family is unsupported`)
  for (const property of ['size', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']) {
    if (property in style) themeLength(style[property], `${path}.${property}`)
  }
  for (const property of ['color', 'background']) if (property in style) safeStyleString(style[property], `${path}.${property}`)
  if ('weight' in style) finite(style.weight, `${path}.weight`)
  if ('italic' in style && typeof style.italic !== 'boolean') invalid(`${path}.italic must be a boolean`)
  if ('decoration' in style && !['none', 'underline', 'line-through'].includes(style.decoration as string)) invalid(`${path}.decoration is unsupported`)
}

function checkTheme(value: unknown): void {
  const theme = record(value, 'theme')
  if ('autospace' in theme && typeof theme.autospace !== 'boolean') invalid('theme.autospace must be a boolean')
  const defaults = record(theme.defaults, 'theme.defaults')
  for (const property of ['family', 'size', 'color', 'background', 'weight', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']) {
    if (!(property in defaults)) invalid(`theme.defaults.${property} is missing`)
  }
  themeStyle(defaults, 'theme.defaults')
  if (!['sans', 'serif', 'mono'].includes(defaults.family as string)) invalid('theme.defaults.family is unsupported')
  finite(defaults.size, 'theme.defaults.size', Number.MIN_VALUE)
  const blocks = isRecord(theme.blocks) ? theme.blocks : undefined
  for (const name of themeBlockClasses) {
    if (name === 'math' && (!blocks || !(name in blocks))) continue
    themeStyle(record(blocks?.[name], `theme.blocks.${name}`), `theme.blocks.${name}`)
  }
  for (const name of inlineClasses) themeStyle(record(theme.inline && isRecord(theme.inline) ? theme.inline[name] : undefined, `theme.inline.${name}`), `theme.inline.${name}`)
}

function inspectContent(value: unknown, path: string): void {
  const node = record(value, path)
  if (typeof node.type !== 'string') invalid(`${path}.type must be a string`)
  if ('attrs' in node && node.attrs !== null && node.attrs !== undefined) {
    const attrs = record(node.attrs, `${path}.attrs`)
    if ('id' in attrs) identifier(attrs.id, `${path}.attrs.id`)
    if (node.type === 'spacer' && 'height' in attrs) finite(attrs.height, `${path}.attrs.height`, 0)
    if (node.type === 'paragraph' && 'listLevel' in attrs) finite(attrs.listLevel, `${path}.attrs.listLevel`, 0)
    if (node.type === 'table' && attrs.columns !== null && attrs.columns !== undefined) {
      if (!Array.isArray(attrs.columns)) invalid(`${path}.attrs.columns must be an array`)
      let total = 0
      for (const [index, item] of attrs.columns.entries()) {
        const column = record(item, `${path}.attrs.columns[${index}]`)
        finite(column.width, `${path}.attrs.columns[${index}].width`, Number.MIN_VALUE)
        if (!['left', 'center', 'right'].includes(column.align as string)) invalid(`${path}.attrs.columns[${index}].align is unsupported`)
        total += column.width as number
      }
      if (attrs.columns.length && !Number.isFinite(total)) invalid(`${path}.attrs.columns has an invalid total width`)
    }
  }
  if (node.type === 'text' && typeof node.text !== 'string') invalid(`${path}.text must be a string`)
  if ('content' in node) {
    if (!Array.isArray(node.content)) invalid(`${path}.content must be an array`)
    node.content.forEach((child, index) => inspectContent(child, `${path}.content[${index}]`))
  }
}

function embeddedImageSource(value: unknown, path: string): void {
  if (typeof value !== 'string') invalid(`${path} must be an embedded image data URL`)
  const match = /^data:(image\/(?:svg\+xml|png|jpeg|webp|gif|avif))(?:;[^,]*)?,/i.exec(value)
  if (!match) invalid(`${path} must be an embedded SVG, PNG, JPEG, WebP, GIF, or AVIF data URL`)
  if (match[1].toLowerCase() !== 'image/svg+xml') return

  const comma = value.indexOf(',')
  const header = value.slice(5, comma)
  const payload = value.slice(comma + 1)
  let svg: string
  try {
    if (/(?:^|;)base64(?:;|$)/i.test(header)) {
      const binary = atob(payload)
      svg = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
    } else svg = decodeURIComponent(payload)
  } catch {
    invalid(`${path} contains an unreadable SVG image`)
  }
  if (/<\s*(?:script|iframe|object|embed|foreignObject)\b|\bon[a-z]+\s*=|@import|<!\s*(?:doctype|entity)\b|\b(?:href|src)\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*'|(?!["\'#])[^\s>]+)|url\(\s*["']?(?:https?:|ftp:|\/\/|javascript:|data:)/i.test(svg!)) {
    invalid(`${path} contains executable or external SVG content`)
  }
}

function anchor(value: unknown, path: string): void {
  if (value !== null) identifier(value, path)
}

function color(value: unknown, path: string): void {
  if (value !== null) safeStyleString(value, path)
}

function lineEnd(value: unknown, path: string): void {
  const end = record(value, path)
  finite(end.x, `${path}.x`)
  finite(end.y, `${path}.y`, 0)
  anchor(end.anchorId, `${path}.anchorId`)
  if ('connection' in end) {
    const connection = record(end.connection, `${path}.connection`)
    identifier(connection.targetId, `${path}.connection.targetId`)
    if (!['auto', 'top', 'bottom', 'left', 'right'].includes(connection.side as string)) invalid(`${path}.connection.side is unsupported`)
  }
}

function checkFloating(value: unknown, index: number, ids: Set<string>): void {
  const path = `floating[${index}]`
  const object = record(value, path)
  const id = identifier(object.id, `${path}.id`)
  if (ids.has(id)) invalid(`floating object IDs must be unique`)
  ids.add(id)
  anchor(object.anchorId, `${path}.anchorId`)
  finite(object.x, `${path}.x`)
  finite(object.y, `${path}.y`, 0)
  finite(object.width, `${path}.width`, 0)
  if (!['overlap', 'repel'].includes(object.textFlow as string)) invalid(`${path}.textFlow is unsupported`)

  const kind = object.kind
  if (kind === undefined || kind === 'text') {
    for (const property of ['background', 'borderColor']) if (property in object) color(object[property], `${path}.${property}`)
    if ('padding' in object) {
      themeLength(object.padding, `${path}.padding`)
      finite(typeof object.padding === 'number' ? object.padding : parseFloat(object.padding as string), `${path}.padding`, 0)
    }
  }
  if (kind === undefined || kind === 'text' || kind === 'table' || kind === 'label') {
    if (!('content' in object)) invalid(`${path}.content is missing`)
    inspectContent(object.content, `${path}.content`)
  }
  if (kind === 'table') return
  if (kind === 'label') {
    if (!('attachment' in object) || (object.attachment !== null && !isRecord(object.attachment))) invalid(`${path}.attachment must be an object or null`)
    if (object.attachment) {
      identifier(object.attachment.targetId, `${path}.attachment.targetId`)
      if (!['center', 'top-inside', 'top-outside', 'bottom-inside', 'bottom-outside', 'left', 'right', 'above', 'below'].includes(object.attachment.position as string)) invalid(`${path}.attachment.position is unsupported`)
    }
    return
  }
  if (kind === 'image') {
    embeddedImageSource(object.src, `${path}.src`)
    text(object.alt, `${path}.alt`)
    return
  }
  if (kind === 'katex') {
    text(object.latex, `${path}.latex`)
    return
  }
  if (kind === 'html') {
    text(object.html, `${path}.html`)
    embeddedImageSource(object.screenshot, `${path}.screenshot`)
    text(object.alt, `${path}.alt`)
    finite(object.height, `${path}.height`, Number.MIN_VALUE)
    return
  }
  if (kind === 'rectangle' || kind === 'ellipse') {
    finite(object.height, `${path}.height`, Number.MIN_VALUE)
    color(object.fill, `${path}.fill`)
    color(object.stroke, `${path}.stroke`)
    finite(object.strokeWidth, `${path}.strokeWidth`, Number.MIN_VALUE)
    if (typeof object.dashed !== 'boolean' || typeof object.rounded !== 'boolean') invalid(`${path} has invalid shape settings`)
    return
  }
  if (kind === 'line') {
    lineEnd(object.start, `${path}.start`)
    lineEnd(object.end, `${path}.end`)
    color(object.stroke, `${path}.stroke`)
    finite(object.strokeWidth, `${path}.strokeWidth`, Number.MIN_VALUE)
    finite(object.bend, `${path}.bend`)
    if (!['straight', 'elbow'].includes(object.route as string) || typeof object.dashed !== 'boolean' || typeof object.arrowStart !== 'boolean' || typeof object.arrowEnd !== 'boolean') invalid(`${path} has invalid line settings`)
    return
  }
  if (kind !== undefined && kind !== 'text') invalid(`${path}.kind is unsupported`)
}

function validateDocument(value: unknown): asserts value is MoteDocument {
  finiteValues(value)
  const document = record(value, 'document')
  if (document.version !== 'V0') invalid('unsupported document version')
  if ('language' in document && !['en', 'zh-Hans'].includes(document.language as string)) invalid('document.language is unsupported')
  identifier(document.id, 'document.id')
  finite(document.width, 'document.width', Number.MIN_VALUE)
  const margins = record(document.margins, 'document.margins')
  for (const side of ['top', 'right', 'bottom', 'left']) finite(margins[side], `document.margins.${side}`, 0)
  checkTheme(document.theme)
  inspectContent(document.content, 'content')
  if (!Array.isArray(document.floating)) invalid('document.floating must be an array')
  const ids = new Set<string>()
  document.floating.forEach((object, index) => checkFloating(object, index, ids))
}

async function gzip(data: Blob): Promise<ArrayBuffer> {
  try {
    return await new Response(data.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  } catch {
    throw new Error('Could not gzip the document in this browser.')
  }
}

async function gunzip(data: Blob): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = data.stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  } catch {
    throw new MoteFileError('This .mote file could not be opened as gzip data.')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > maxDecompressedBytes) {
        try { await reader.cancel() } catch { /* The size error is the useful one. */ }
        throw new MoteFileError('The .mote file expands beyond the 128 MiB limit.')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } catch (error) {
    if (error instanceof MoteFileError) throw error
    throw new MoteFileError('This .mote file is not valid gzip-compressed UTF-8.')
  }
  return chunks.join('')
}

export async function encodeMote(doc: MoteDocument): Promise<Blob> {
  let json: string
  try {
    json = JSON.stringify(doc)
  } catch {
    throw new Error('The document could not be serialized for export.')
  }
  if (!json) throw new Error('The document could not be serialized for export.')
  const input = new Blob([json])
  if (input.size > maxDecompressedBytes) throw new MoteFileError('The document exceeds the 128 MiB .mote limit.')
  const compressed = await gzip(input)
  if (compressed.byteLength > maxCompressedBytes) throw new MoteFileError('The compressed document exceeds the 128 MiB .mote limit.')
  return new Blob([compressed], { type: 'application/gzip' })
}

export async function decodeMote(file: File): Promise<MoteDocument> {
  if (!file.name.toLowerCase().endsWith('.mote')) throw new MoteFileError('Choose a .mote file.')
  if (file.size > maxCompressedBytes) throw new MoteFileError('The .mote file is larger than the 128 MiB limit.')

  let compressed: Uint8Array
  try { compressed = new Uint8Array(await file.slice(0, 2).arrayBuffer()) }
  catch { throw new MoteFileError('The .mote file could not be read.') }
  if (compressed.length < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new MoteFileError('The .mote file is not gzip-compressed.')

  const json = await gunzip(file)
  let value: unknown
  try { value = JSON.parse(json) }
  catch { throw new MoteFileError('The .mote file does not contain valid JSON.') }
  validateDocument(value)
  try { return initializeDocument(value) }
  catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : ''
    throw new MoteFileError(`The .mote document content is not valid for V0${detail}`)
  }
}
