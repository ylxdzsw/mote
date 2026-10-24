import { boxDecorationKinds, supportsCaption, tableStyles, themeBlockClasses, type BoxDecoration, type FloatingObject, type MoteDocument, type TableStyle } from './model'
import { boxColorIds } from '../../shared/palette.mjs'

export class MoteFileError extends Error {
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
  throw new MoteFileError(`Invalid Mote document: ${message}`)
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

function aiModel(value: unknown, path: string): void {
  const model = text(value, path)
  if (model.length > 256) invalid(`${path} must be at most 256 characters`)
  if (/[\u0000-\u001F\u007F-\u009F]/.test(model)) invalid(`${path} must not contain control characters`)
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
  if (isRecord(value)) for (const [key, child] of Object.entries(value)) {
    if (key === 'attachment') invalid(`${path}.attachment is unsupported`)
    finiteValues(child, `${path}.${key}`)
  }
}

function themeLength(value: unknown, path: string, nonnegative = false): void {
  if (typeof value === 'number') {
    finite(value, path, nonnegative ? 0 : undefined)
    return
  }
  if (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:px|em)$/.test(value) || !Number.isFinite(parseFloat(value))) invalid(`${path} must be a finite theme length`)
  if (nonnegative && parseFloat(value) < 0) invalid(`${path} must be nonnegative`)
}

function themeStyle(value: unknown, path: string): void {
  const style = record(value, path)
  if ('family' in style && !['sans', 'serif', 'mono'].includes(style.family as string)) invalid(`${path}.family is unsupported`)
  for (const property of ['size', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']) {
    if (property in style) themeLength(style[property], `${path}.${property}`, property === 'spaceBefore' || property === 'spaceAfter')
  }
  if ('background' in style) invalid(`${path}.background is unsupported`)
  if ('color' in style) text(style.color, `${path}.color`)
  if ('weight' in style) finite(style.weight, `${path}.weight`)
}

function checkTheme(value: unknown): void {
  const theme = record(value, 'theme')
  if (!['light', 'dark'].includes(theme.mode as string)) invalid('theme.mode must be light or dark')
  for (const name of ['hue', 'secondaryHue']) if (finite(theme[name], `theme.${name}`, 0) >= 360) invalid(`theme.${name} must be less than 360`)
  if ('palette' in theme) invalid('theme.palette is unsupported')
  if ('autospace' in theme && typeof theme.autospace !== 'boolean') invalid('theme.autospace must be a boolean')
  if ('flow' in theme) {
    const flow = record(theme.flow, 'theme.flow')
    if (Object.keys(flow).some(property => property !== 'spaceBefore' && property !== 'spaceAfter')) invalid('theme.flow contains an unsupported property')
    for (const property of ['spaceBefore', 'spaceAfter']) {
      if (flow[property] !== undefined) themeLength(flow[property], `theme.flow.${property}`, true)
    }
  }
  const defaults = record(theme.defaults, 'theme.defaults')
  for (const property of ['family', 'size', 'color', 'weight', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']) {
    if (!(property in defaults)) invalid(`theme.defaults.${property} is missing`)
  }
  themeStyle(defaults, 'theme.defaults')
  if (!['sans', 'serif', 'mono'].includes(defaults.family as string)) invalid('theme.defaults.family is unsupported')
  finite(defaults.size, 'theme.defaults.size', Number.MIN_VALUE)
  const blocks = isRecord(theme.blocks) ? theme.blocks : undefined
  for (const name of themeBlockClasses) {
    if ((name === 'math' || name === 'subheading') && (!blocks || !(name in blocks))) continue
    themeStyle(record(blocks?.[name], `theme.blocks.${name}`), `theme.blocks.${name}`)
  }
}

function inspectContent(value: unknown, path: string, allowFlow = false): void {
  const node = record(value, path)
  if (typeof node.type !== 'string') invalid(`${path}.type must be a string`)
  if (node.type === 'flow') {
    if (!allowFlow) invalid(`${path}: Flow blocks belong only in the main document`)
    const attrs = record(node.attrs, `${path}.attrs`)
    identifier(attrs.id, `${path}.attrs.id`)
    identifier(attrs.objectId, `${path}.attrs.objectId`)
    if (node.text !== undefined || Array.isArray(node.content) && node.content.length || Array.isArray(node.marks) && node.marks.length) invalid(`${path}: Flow blocks must be atomic`)
  }
  if ('attrs' in node && node.attrs !== null && node.attrs !== undefined) {
    const attrs = record(node.attrs, `${path}.attrs`)
    if ('id' in attrs) identifier(attrs.id, `${path}.attrs.id`)
    if (node.type === 'spacer' && 'height' in attrs) finite(attrs.height, `${path}.attrs.height`, 0)
    if (node.type === 'paragraph' && 'listLevel' in attrs) finite(attrs.listLevel, `${path}.attrs.listLevel`, 0)
    if (node.type === 'paragraph' && attrs.semantic === 'code') invalid(`${path}: Code is a floating object, not a paragraph class`)
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
    node.content.forEach((child, index) => inspectContent(child, `${path}.content[${index}]`, path === 'content' && node.type === 'doc'))
  }
}

function checkCaption(value: unknown, path: string): string {
  const caption = record(value, path)
  if (!('content' in caption) || Object.keys(caption).some(key => !['content', 'width'].includes(key))) invalid(`${path} must contain content and optional width`)
  if ('width' in caption) finite(caption.width, `${path}.width`, Number.MIN_VALUE)
  const doc = record(caption.content, `${path}.content`)
  if (doc.type !== 'doc' || Object.keys(doc).some(key => !['type', 'content'].includes(key))
    || !Array.isArray(doc.content) || doc.content.length !== 1) invalid(`${path} must be a document with exactly one paragraph`)
  const paragraph = record(doc.content[0], `${path}.content.content[0]`)
  if (paragraph.type !== 'paragraph' || Object.keys(paragraph).some(key => !['type', 'attrs', 'content'].includes(key))) invalid(`${path} must contain exactly one paragraph`)
  const attrs = record(paragraph.attrs, `${path}.content.content[0].attrs`)
  if (Object.keys(attrs).length !== 1 || !('id' in attrs)) invalid(`${path} paragraph attributes must contain only id`)
  const id = identifier(attrs.id, `${path}.content.content[0].attrs.id`)
  if ('content' in paragraph && !Array.isArray(paragraph.content)) invalid(`${path}.content.content[0].content must be an array`)
  const inlineNodes = paragraph.content === undefined ? [] : paragraph.content as unknown[]
  for (const [index, inlineValue] of inlineNodes.entries()) {
    const inlinePath = `${path}.content.content[0].content[${index}]`
    const inline = record(inlineValue, inlinePath)
    const keys = inline.type === 'text' ? ['type', 'text', 'marks'] : inline.type === 'hardBreak' ? ['type', 'marks'] : []
    if (!keys.length || Object.keys(inline).some(key => !keys.includes(key))) invalid(`${inlinePath} must be inline text or a hard break`)
    if (inline.type === 'text' && typeof inline.text !== 'string') invalid(`${inlinePath}.text must be a string`)
    if ('marks' in inline) {
      if (!Array.isArray(inline.marks)) invalid(`${inlinePath}.marks must be an array`)
      for (const [markIndex, markValue] of inline.marks.entries()) {
        const markPath = `${inlinePath}.marks[${markIndex}]`, mark = record(markValue, markPath)
        if (mark.type === 'bold') {
          if (Object.keys(mark).some(key => key !== 'type')) invalid(`${markPath} is not a shared inline mark`)
        } else if (mark.type === 'color' || mark.type === 'decoration') {
          const markAttrs = record(mark.attrs, `${markPath}.attrs`)
          const expected = mark.type === 'color' ? 'color' : 'decoration'
          if (Object.keys(mark).some(key => !['type', 'attrs'].includes(key)) || Object.keys(markAttrs).length !== 1 || !(expected in markAttrs)) invalid(`${markPath} is not a shared inline mark`)
          if (mark.type === 'color') text(markAttrs.color, `${markPath}.attrs.color`)
          else if (!['box', 'underline'].includes(markAttrs.decoration as string)) invalid(`${markPath}.attrs.decoration is unsupported`)
        } else invalid(`${markPath} is not a shared inline mark`)
      }
    }
  }
  return id
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


function checkFloating(value: unknown, index: number, ids: Set<string>, captionIds: Set<string>): void {
  const path = `floating[${index}]`
  const object = record(value, path)
  const id = identifier(object.id, `${path}.id`)
  if (ids.has(id)) invalid(`floating object IDs must be unique`)
  ids.add(id)
  anchor(object.anchorId, `${path}.anchorId`)
  finite(object.x, `${path}.x`)
  finite(object.y, `${path}.y`)
  finite(object.width, `${path}.width`, 0)
  if ('attachment' in object) invalid(`${path}.attachment is unsupported`)
  if ('textFlow' in object) invalid(`${path}.textFlow is unsupported`)
  if (!['flow', 'float'].includes(object.placement as string)) invalid(`${path}.placement is unsupported`)
  if ('centered' in object && typeof object.centered !== 'boolean') invalid(`${path}.centered must be a boolean`)
  if ('margins' in object) {
    const margins = record(object.margins, `${path}.margins`)
    const sides = ['top', 'right', 'bottom', 'left']
    if (Object.keys(margins).some(side => !sides.includes(side)) || sides.some(side => !(side in margins))) invalid(`${path}.margins must contain top, right, bottom, and left`)
    for (const side of sides) finite(margins[side], `${path}.margins.${side}`)
  }

  const kind = object.kind
  if ('decoration' in object) {
    if (kind !== undefined && kind !== 'text') invalid(`${path}.decoration is only supported on text boxes`)
    if (object.decoration !== null) {
      const decoration = record(object.decoration, `${path}.decoration`)
      if (!boxDecorationKinds.includes(decoration.kind as BoxDecoration['kind'])) invalid(`${path}.decoration.kind is unsupported`)
      if (!boxColorIds.includes(decoration.color as string)) invalid(`${path}.decoration.color must be a color pair`)
    }
  }
  if (kind === undefined || kind === 'text') {
    for (const property of ['background', 'borderColor']) if (property in object) invalid(`${path}.${property} is unsupported`)
    if ('padding' in object) {
      themeLength(object.padding, `${path}.padding`)
      finite(typeof object.padding === 'number' ? object.padding : parseFloat(object.padding as string), `${path}.padding`, 0)
    }
  }
  for (const property of ['style', 'headerRow']) if (property in object && kind !== 'table') invalid(`${path}.${property} is only supported on tables`)
  if ('style' in object && !tableStyles.includes(object.style as TableStyle)) invalid(`${path}.style is unsupported`)
  if ('headerRow' in object && typeof object.headerRow !== 'boolean') invalid(`${path}.headerRow must be a boolean`)
  if (kind === undefined || kind === 'text' || kind === 'table') {
    if (!('content' in object)) invalid(`${path}.content is missing`)
    inspectContent(object.content, `${path}.content`)
  }
  if ('caption' in object) {
    if (!supportsCaption(object as unknown as FloatingObject)) invalid(`${path}.caption is unsupported for this kind`)
    const id = checkCaption(object.caption, `${path}.caption`)
    if (captionIds.has(id)) invalid('caption paragraph IDs must be unique')
    captionIds.add(id)
  }
  if (kind === 'table') return
  if (kind === 'drawing') {
    finite(object.width, `${path}.width`, Number.MIN_VALUE)
    finite(object.height, `${path}.height`, Number.MIN_VALUE)
    if (object.background !== null && object.background !== 'gray6') invalid(`${path}.background must be gray6 or null`)
    if (!Array.isArray(object.strokes) || object.strokes.length > 10000) invalid(`${path}.strokes must contain at most 10000 strokes`)
    let points = 0
    for (const [index, value] of object.strokes.entries()) {
      const name = `${path}.strokes[${index}]`, stroke = record(value, name)
      text(stroke.color, `${name}.color`)
      finite(stroke.width, `${name}.width`, Number.MIN_VALUE)
      if (!Array.isArray(stroke.points) || !stroke.points.length || (points += stroke.points.length) > 100000) invalid(`${path} must contain at most 100000 points, with at least one per stroke`)
      for (const point of stroke.points) {
        if (!Array.isArray(point) || point.length !== 2) invalid(`${name}.points must contain coordinate pairs`)
        finite(point[0], `${name}.point.x`); finite(point[1], `${name}.point.y`)
      }
    }
    if (!Array.isArray(object.labels) || object.labels.length > 1000) invalid(`${path}.labels must contain at most 1000 labels`)
    for (const [index, value] of object.labels.entries()) {
      const name = `${path}.labels[${index}]`, label = record(value, name)
      finite(label.x, `${name}.x`); finite(label.y, `${name}.y`)
      finite(label.size, `${name}.size`, Number.MIN_VALUE)
      text(label.color, `${name}.color`)
      if (text(label.text, `${name}.text`).length > 4096) invalid(`${name}.text must be at most 4096 characters`)
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
  if (kind === 'code') {
    text(object.source, `${path}.source`)
    if (!/^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/.test(text(object.language, `${path}.language`))) invalid(`${path}.language is unsupported`)
    return
  }
  if (kind === 'html') {
    text(object.html, `${path}.html`)
    embeddedImageSource(object.screenshot, `${path}.screenshot`)
    text(object.alt, `${path}.alt`)
    finite(object.height, `${path}.height`, Number.MIN_VALUE)
    return
  }
  if (kind !== undefined && kind !== 'text') invalid(`${path}.kind is unsupported`)
}

export function validateDocument(value: unknown): asserts value is MoteDocument {
  finiteValues(value)
  const document = record(value, 'document')
  if (document.version !== 'V0') invalid('unsupported document version')
  if ('language' in document && !['en', 'zh-Hans'].includes(document.language as string)) invalid('document.language is unsupported')
  if ('aiModel' in document) aiModel(document.aiModel, 'document.aiModel')
  if ('notes' in document && typeof document.notes !== 'string'
    && !(Array.isArray(document.notes) && document.notes.every(note => typeof note === 'string'))) invalid('document.notes must be plain text or an array of plain-text notes')
  identifier(document.id, 'document.id')
  finite(document.width, 'document.width', Number.MIN_VALUE)
  const margins = record(document.margins, 'document.margins')
  for (const side of ['top', 'right', 'bottom', 'left']) finite(margins[side], `document.margins.${side}`, 0)
  checkTheme(document.theme)
  inspectContent(document.content, 'content')
  if (!Array.isArray(document.floating)) invalid('document.floating must be an array')
  const ids = new Set<string>()
  const captionIds = new Set<string>()
  document.floating.forEach((object, index) => checkFloating(object, index, ids, captionIds))
  const content = record(document.content, 'content')
  if (content.type !== 'doc' || !Array.isArray(content.content)) invalid('content must be a document with blocks')
  const blockIds = new Set<string>()
  const flows = new Map<string, string>()
  const flowAnchors = new Set<string>()
  for (const [index, value] of content.content.entries()) {
    const block = record(value, `content.content[${index}]`)
    const attrs = record(block.attrs, `content.content[${index}].attrs`)
    const id = identifier(attrs.id, `content.content[${index}].attrs.id`)
    if (blockIds.has(id) || ids.has(id)) invalid('main block IDs must be unique and distinct from object IDs')
    blockIds.add(id)
    if (block.type !== 'flow') continue
    const objectId = identifier(attrs.objectId, `content.content[${index}].attrs.objectId`)
    if (!ids.has(objectId)) invalid('Flow block objectId does not exist')
    if (flows.has(objectId)) invalid('each Flow object must have exactly one Flow block')
    flows.set(objectId, id)
    flowAnchors.add(id)
  }
  for (const id of captionIds) if (ids.has(id) || blockIds.has(id)) invalid('caption paragraph IDs must be distinct from object and main block IDs')
  const objects = document.floating as RecordValue[]
  objects.forEach((object, index) => {
    if (object.anchorId !== null && !blockIds.has(object.anchorId as string)) invalid(`floating[${index}].anchorId does not exist`)
    if (object.placement === 'flow') {
      if (!flows.has(object.id as string) || flows.get(object.id as string) !== object.anchorId || object.y !== 0) invalid(`floating[${index}] must bind its own Flow block with y=0`)
    } else {
      if (flows.has(object.id as string)) invalid(`floating[${index}]: Float objects cannot own Flow blocks`)
      if (!flowAnchors.has(object.anchorId as string) && (object.y as number) < 0) invalid(`floating[${index}].y must be nonnegative outside a Flow anchor`)
    }
  })
}

