import { boxColorIds, validPaletteReference } from './palette.mjs'
import { validLinkHref } from './links.mjs'

export const DOCUMENT_VERSION = 1
const MAX_STRING = 8 * 1024 * 1024
const MAX_IMAGE = 10 * 1024 * 1024
const MAX_NODES = 100000
const SIDES = ['top', 'right', 'bottom', 'left']
const CLASSES = ['title', 'heading', 'subheading', 'body', 'caption', 'list']
const STYLE = ['family', 'size', 'color', 'weight', 'lineHeight', 'spaceBefore', 'spaceAfter', 'letterSpacing']
const KINDS = ['text', 'table', 'image', 'drawing', 'formula', 'code', 'html']
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

export class DocumentFormatError extends Error {
  constructor(message, path = '', code = 'invalid') {
    super(code === 'unsupported' ? message : `Invalid Mote document: ${path ? `${path}: ` : ''}${message}`)
    this.name = 'DocumentFormatError'
    this.path = path
    this.code = code
  }
}

const fail = (path, message) => { throw new DocumentFormatError(message, path) }
const present = (value, key) => value[key] !== undefined
function record(value, path, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  for (const key of Object.keys(value)) {
    if (UNSAFE.has(key) || required && !required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, 'unsupported field')
  }
  for (const key of required ?? []) if (!present(value, key)) fail(`${path}.${key}`, 'is required')
  return value
}
function array(value, path, max = MAX_NODES, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `must be an array with ${min}–${max} entries`)
  return value
}
function text(value, path, max = MAX_STRING) {
  if (typeof value !== 'string' || value.length > max) fail(path, `must be a string of at most ${max} characters`)
  return value
}
function number(value, path, min = -Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(path, `must be a finite number${Number.isFinite(min) ? ` at least ${min}` : ''}`)
  return value
}
function choice(value, choices, path) {
  if (!choices.includes(value)) fail(path, `must be ${choices.join(' | ')}`)
}
function boolean(value, path) {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
}
function identifier(value, path, ids) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || UNSAFE.has(value)) fail(path, 'must be a safe identifier of 1–128 characters')
  if (ids?.has(value)) fail(path, `duplicate ID ${value}`)
  ids?.add(value)
  return value
}
function color(value, path) {
  if (!validPaletteReference(value)) fail(path, 'must be a fixed palette reference')
}
function length(value, path, min = 0, ratio = false) {
  record(value, path, ['value', 'unit'])
  number(value.value, `${path}.value`, min)
  choice(value.unit, ratio ? ['px', 'em', 'ratio'] : ['px', 'em'], `${path}.unit`)
}
function insets(value, path, min) {
  record(value, path, SIDES)
  for (const side of SIDES) number(value[side], `${path}.${side}`, min)
}
function style(value, path, fields = STYLE, defaults = false) {
  record(value, path, defaults ? fields : [], defaults ? [] : fields)
  for (const key of fields) {
    if (!present(value, key)) continue
    const field = `${path}.${key}`
    if (key === 'family') choice(value[key], ['sans', 'serif', 'mono'], field)
    else if (key === 'color') color(value[key], field)
    else if (key === 'weight') {
      if (number(value[key], field, 1) > 1000) fail(field, 'must not exceed 1000')
    } else if (key === 'size' && defaults) number(value[key], field, Number.MIN_VALUE)
    else length(value[key], field, key === 'letterSpacing' ? -Infinity : ['size', 'lineHeight'].includes(key) ? Number.MIN_VALUE : 0, key === 'lineHeight')
  }
}
function theme(value) {
  record(value, 'theme', ['appearance', 'autospace', 'defaults', 'paragraphs', 'objects', 'flow'])
  const appearance = record(value.appearance, 'theme.appearance', ['mode', 'primaryHue', 'secondaryHue'])
  choice(appearance.mode, ['light', 'dark'], 'theme.appearance.mode')
  for (const key of ['primaryHue', 'secondaryHue']) if (number(appearance[key], `theme.appearance.${key}`, 0) >= 360) fail(`theme.appearance.${key}`, 'must be less than 360')
  boolean(value.autospace, 'theme.autospace')
  style(value.defaults, 'theme.defaults', STYLE, true)
  record(value.paragraphs, 'theme.paragraphs', [], CLASSES)
  for (const name of CLASSES) if (present(value.paragraphs, name)) style(value.paragraphs[name], `theme.paragraphs.${name}`)
  record(value.objects, 'theme.objects', [], ['table', 'code', 'formula'])
  if (present(value.objects, 'table')) style(value.objects.table, 'theme.objects.table')
  if (present(value.objects, 'code')) style(value.objects.code, 'theme.objects.code', ['size', 'weight', 'lineHeight', 'letterSpacing'])
  if (present(value.objects, 'formula')) style(value.objects.formula, 'theme.objects.formula', ['size', 'color'])
  record(value.flow, 'theme.flow', [], ['spaceBefore', 'spaceAfter'])
  for (const key of ['spaceBefore', 'spaceAfter']) if (present(value.flow, key)) length(value.flow[key], `theme.flow.${key}`)
}

function image(value, path) {
  text(value, path, MAX_IMAGE * 3 + 1024)
  const match = /^data:(image\/(?:svg\+xml|png|jpeg|webp|gif|avif))(?:;[^,]*)?,/i.exec(value)
  if (!match) fail(path, 'must be an embedded SVG, PNG, JPEG, WebP, GIF, or AVIF image')
  const header = match[0], payload = value.slice(header.length)
  let bytes
  try {
    bytes = /;base64(?:;|,)/i.test(header)
      ? Uint8Array.from(atob(payload), character => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload))
  } catch { fail(path, 'contains unreadable image data') }
  if (!bytes.length || bytes.length > MAX_IMAGE) fail(path, 'image must contain 1 byte to 10 MiB')
  const mime = match[1].toLowerCase()
  if (mime === 'image/png' && ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) fail(path, 'is not a PNG')
  if (mime === 'image/svg+xml') {
    let svg
    try { svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail(path, 'contains unreadable SVG text') }
    if (/<\s*(?:script|iframe|object|embed|foreignObject)\b|\bon[a-z]+\s*=|@import|<!\s*(?:doctype|entity)\b|\b(?:href|src)\s*=\s*(?:"(?!#)|'(?!#)|(?!["'#]))|url\(\s*["']?(?:https?:|ftp:|\/\/|javascript:|data:)/i.test(svg)) fail(path, 'contains executable or external SVG content')
  }
}

function marks(value, path) {
  const types = new Set()
  for (const [index, mark] of array(value, path, 4).entries()) {
    const p = `${path}[${index}]`
    record(mark, p, ['type'], ['attrs'])
    choice(mark.type, ['bold', 'color', 'decoration', 'link'], `${p}.type`)
    if (types.has(mark.type)) fail(p, 'duplicate mark type')
    types.add(mark.type)
    if (mark.type === 'bold') { record(mark, p, ['type']); continue }
    const key = mark.type === 'link' ? 'href' : mark.type
    record(mark.attrs, `${p}.attrs`, [key])
    if (key === 'color') color(mark.attrs.color, `${p}.attrs.color`)
    else if (key === 'decoration') choice(mark.attrs.decoration, ['box'], `${p}.attrs.decoration`)
    else if (!validLinkHref(text(mark.attrs.href, `${p}.attrs.href`))) fail(`${p}.attrs.href`, 'must be a safe, credential-free absolute HTTP(S) URL')
  }
}

const children = { paragraph: ['text', 'hardBreak'], table: ['tableRow'], tableRow: ['tableCell'], tableCell: ['paragraph'] }
const docChildren = { main: ['paragraph', 'spacer', 'flow'], text: ['paragraph'], table: ['table'], caption: ['paragraph'] }
function rich(node, path, mode, allowed, state, depth = 0, allowEmpty = false) {
  if (++state.count > MAX_NODES || depth > 100) fail(path, 'content exceeds the node/depth limit')
  record(node, path, ['type'], ['attrs', 'content', 'text', 'marks'])
  choice(node.type, allowed, `${path}.type`)
  const type = node.type
  if (type === 'text') {
    record(node, path, ['type', 'text'], ['marks'])
    if (!text(node.text, `${path}.text`).length) fail(`${path}.text`, 'must not be empty')
  } else if (type === 'hardBreak') record(node, path, ['type'], ['marks'])
  else if (type === 'spacer') {
    record(node, path, ['type', 'attrs'])
    record(node.attrs, `${path}.attrs`, ['id', 'height'])
    identifier(node.attrs.id, `${path}.attrs.id`, state.ids)
    number(node.attrs.height, `${path}.attrs.height`, 0)
  } else if (type === 'flow') {
    record(node, path, ['type', 'attrs'])
    record(node.attrs, `${path}.attrs`, ['id', 'objectId'])
    identifier(node.attrs.id, `${path}.attrs.id`, state.ids)
    identifier(node.attrs.objectId, `${path}.attrs.objectId`)
  } else if (type === 'paragraph') {
    record(node, path, ['type', 'attrs'], ['content'])
    const semantic = mode === 'main' || mode === 'text'
    record(node.attrs, `${path}.attrs`, semantic ? ['id', 'semantic'] : ['id'], semantic && node.attrs?.semantic === 'list' ? ['listLevel'] : [])
    identifier(node.attrs.id, `${path}.attrs.id`, state.ids)
    if (semantic) {
      choice(node.attrs.semantic, CLASSES, `${path}.attrs.semantic`)
      if (node.attrs.semantic === 'list') {
        if (!Number.isSafeInteger(number(node.attrs.listLevel, `${path}.attrs.listLevel`, 0))) fail(`${path}.attrs.listLevel`, 'must be a nonnegative integer')
      }
    }
  } else {
    record(node, path, ['type', 'content'], type === 'table' ? ['attrs'] : [])
    if (type === 'table' && present(node, 'attrs')) {
      record(node.attrs, `${path}.attrs`, [], ['columns'])
      if (present(node.attrs, 'columns')) {
        let total = 0
        for (const [index, column] of array(node.attrs.columns, `${path}.attrs.columns`, MAX_NODES, 1).entries()) {
          const p = `${path}.attrs.columns[${index}]`
          record(column, p, ['weight', 'align'])
          total += number(column.weight, `${p}.weight`, Number.MIN_VALUE)
          choice(column.align, ['left', 'center', 'right'], `${p}.align`)
        }
        if (!Number.isFinite(total)) fail(`${path}.attrs.columns`, 'total weight must be finite')
      }
    }
  }
  if (present(node, 'marks')) marks(node.marks, `${path}.marks`)
  const childTypes = type === 'doc' ? docChildren[mode] : children[type] ?? []
  const list = present(node, 'content') ? array(node.content, `${path}.content`) : []
  if (['doc', 'table', 'tableRow', 'tableCell'].includes(type) && !list.length && !(type === 'doc' && allowEmpty)) fail(path, 'requires child content')
  if ((type === 'tableCell' || type === 'doc' && ['table', 'caption'].includes(mode)) && list.length !== 1) fail(path, 'requires exactly one child')
  list.forEach((child, index) => rich(child, `${path}.content[${index}]`, mode, childTypes, state, depth + 1))
  if (type === 'table') {
    const count = list[0].content.length
    if (list.some(row => row.content.length !== count)) fail(path, 'table rows must have the same number of cells')
    if (node.attrs?.columns && node.attrs.columns.length !== count) fail(`${path}.attrs.columns`, 'must match the table column count')
  }
}

export function validateContent(value, mode = 'main') {
  choice(mode, Object.keys(docChildren), 'content mode')
  rich(value, 'content', mode, ['doc'], { count: 0, ids: new Set() })
  return value
}

function object(value, path, state, options) {
  record(value, path, ['id', 'kind', 'layout'], ['content', 'padding', 'decoration', 'style', 'headerRow', 'caption', 'src', 'alt', 'strokes', 'labels', 'background', 'latex', 'source', 'language', 'html', 'screenshot'])
  identifier(value.id, `${path}.id`, state.ids)
  choice(value.kind, KINDS, `${path}.kind`)
  const kind = value.kind
  const fields = {
    text: [['content'], ['padding', 'decoration']], table: [['content'], ['style', 'headerRow', 'caption']],
    image: [['src', 'alt'], ['caption']], drawing: [['strokes', 'labels', 'background'], []],
    formula: [['latex'], []], code: [['source', 'language'], []],
    html: [['html', 'alt', ...(options.allowMissingScreenshot ? [] : ['screenshot'])], ['caption', ...(options.allowMissingScreenshot ? ['screenshot'] : [])]],
  }[kind]
  record(value, path, ['id', 'kind', 'layout', ...fields[0]], fields[1])
  const fixedHeight = ['html', 'drawing'].includes(kind)
  const layout = record(value.layout, `${path}.layout`, ['width', 'placement', ...(fixedHeight ? ['height'] : [])], ['margins'])
  number(layout.width, `${path}.layout.width`, Number.MIN_VALUE)
  if (fixedHeight) number(layout.height, `${path}.layout.height`, Number.MIN_VALUE)
  if (present(layout, 'margins')) insets(layout.margins, `${path}.layout.margins`, -Infinity)
  const placement = record(layout.placement, `${path}.layout.placement`)
  choice(placement.type, ['flow', 'float'], `${path}.layout.placement.type`)
  if (placement.type === 'flow') {
    record(placement, `${path}.layout.placement`, ['type', 'x'])
    if (placement.x !== 'center') number(placement.x, `${path}.layout.placement.x`)
  } else {
    record(placement, `${path}.layout.placement`, ['type', 'anchorId', 'x', 'y'])
    if (placement.anchorId !== null) identifier(placement.anchorId, `${path}.layout.placement.anchorId`)
    number(placement.x, `${path}.layout.placement.x`)
    number(placement.y, `${path}.layout.placement.y`)
  }
  if (kind === 'text' || kind === 'table') rich(value.content, `${path}.content`, kind, ['doc'], state)
  if (kind === 'text') {
    if (present(value, 'padding')) length(value.padding, `${path}.padding`)
    if (present(value, 'decoration')) {
      record(value.decoration, `${path}.decoration`, ['kind', 'color'])
      choice(value.decoration.kind, ['left', 'box'], `${path}.decoration.kind`)
      choice(value.decoration.color, boxColorIds, `${path}.decoration.color`)
    }
  } else if (kind === 'table') {
    if (present(value, 'style')) choice(value.style, ['simple', 'academic', 'business'], `${path}.style`)
    if (present(value, 'headerRow')) boolean(value.headerRow, `${path}.headerRow`)
  } else if (kind === 'image') image(value.src, `${path}.src`)
  else if (kind === 'formula') text(value.latex, `${path}.latex`)
  else if (kind === 'code') {
    text(value.source, `${path}.source`)
    if (!/^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/.test(text(value.language, `${path}.language`, 64))) fail(`${path}.language`, 'must be a safe language identifier')
  } else if (kind === 'html') {
    text(value.html, `${path}.html`)
    if (present(value, 'screenshot')) image(value.screenshot, `${path}.screenshot`)
  } else if (kind === 'drawing') {
    if (value.background !== null && value.background !== 'gray6') fail(`${path}.background`, 'must be gray6 or null')
    let points = 0
    for (const [index, stroke] of array(value.strokes, `${path}.strokes`, 10000).entries()) {
      const p = `${path}.strokes[${index}]`
      record(stroke, p, ['points', 'color', 'width'])
      color(stroke.color, `${p}.color`)
      number(stroke.width, `${p}.width`, Number.MIN_VALUE)
      for (const point of array(stroke.points, `${p}.points`, 100000, 1)) {
        if (++points > 100000) fail(`${path}.strokes`, 'must contain at most 100000 points')
        array(point, `${p}.point`, 2, 2)
        number(point[0], `${p}.point.x`); number(point[1], `${p}.point.y`)
      }
    }
    for (const [index, label] of array(value.labels, `${path}.labels`, 1000).entries()) {
      const p = `${path}.labels[${index}]`
      record(label, p, ['x', 'y', 'text', 'color', 'size'])
      number(label.x, `${p}.x`); number(label.y, `${p}.y`)
      number(label.size, `${p}.size`, Number.MIN_VALUE)
      text(label.text, `${p}.text`, 4096); color(label.color, `${p}.color`)
    }
  }
  if (present(value, 'alt')) text(value.alt, `${path}.alt`, 4096)
  if (present(value, 'caption')) {
    record(value.caption, `${path}.caption`, ['content'], ['width'])
    if (present(value.caption, 'width')) number(value.caption.width, `${path}.caption.width`, Number.MIN_VALUE)
    rich(value.caption.content, `${path}.caption.content`, 'caption', ['doc'], state)
  }
  return value
}

export function validateObject(value, options = {}) {
  return object(value, 'object', { count: 0, ids: new Set() }, options)
}

export function validateComposition(blocks, objects, options = {}) {
  array(blocks, 'content', MAX_NODES, options.allowEmpty ? 0 : 1)
  array(objects, 'objects')
  const state = { count: 0, ids: new Set() }
  rich({ type: 'doc', content: blocks }, 'content', 'main', ['doc'], state, 0, options.allowEmpty)
  objects.forEach((value, index) => object(value, `objects[${index}]`, state, { allowMissingScreenshot: options.allowMissingScreenshotIds?.has(value?.id) }))
  const byId = new Map(objects.map(value => [value.id, value]))
  const blockIds = new Set(blocks.map(block => block.attrs.id))
  const flowAnchors = new Set(), flows = new Set()
  for (const block of blocks) {
    if (block.type !== 'flow') continue
    const id = block.attrs.objectId, owner = byId.get(id)
    if (!owner || owner.layout.placement.type !== 'flow' || flows.has(id)) fail('content', 'each Flow block must reference one distinct Flow object')
    flowAnchors.add(block.attrs.id); flows.add(id)
  }
  for (const value of objects) {
    const placement = value.layout.placement
    if (placement.type === 'flow') {
      if (!flows.has(value.id)) fail(`objects.${value.id}`, 'Flow object requires exactly one main Flow block')
    } else {
      if (placement.anchorId !== null && !blockIds.has(placement.anchorId)) fail(`objects.${value.id}.layout.placement.anchorId`, 'must reference a main block or null')
      if (!flowAnchors.has(placement.anchorId) && placement.y < 0) fail(`objects.${value.id}.layout.placement.y`, 'must be nonnegative outside a Flow anchor')
    }
  }
}

export function validateDocument(value) {
  record(value, 'document')
  if (value.version !== DOCUMENT_VERSION) throw new DocumentFormatError(`Unsupported Mote document version ${JSON.stringify(value.version) ?? '(missing)'}. This client opens V1 documents. The saved document has not been changed.`, 'version', 'unsupported')
  record(value, 'document', ['format', 'version', 'id', 'language', 'page', 'theme', 'content', 'objects'], ['authoring'])
  choice(value.format, ['mote'], 'format')
  identifier(value.id, 'id')
  choice(value.language, ['en', 'zh-Hans'], 'language')
  record(value.page, 'page', ['width', 'margins'])
  number(value.page.width, 'page.width', Number.MIN_VALUE)
  insets(value.page.margins, 'page.margins', 0)
  theme(value.theme)
  record(value.content, 'content', ['type', 'content'])
  choice(value.content.type, ['doc'], 'content.type')
  validateComposition(value.content.content, value.objects)
  if (present(value, 'authoring')) {
    record(value.authoring, 'authoring', ['notes'], ['aiModel'])
    array(value.authoring.notes, 'authoring.notes').forEach((note, index) => text(note, `authoring.notes[${index}]`))
    if (present(value.authoring, 'aiModel')) {
      const model = text(value.authoring.aiModel, 'authoring.aiModel', 256)
      if (/[\u0000-\u001f\u007f-\u009f]/.test(model)) fail('authoring.aiModel', 'must not contain control characters')
    }
  }
  return value
}

// Future version upgrades belong here, before validating the current model.
// V1 is the compatibility baseline; V0 deliberately has no converter.
export function loadDocument(value) {
  return validateDocument(value)
}

export function publishDocument(value) {
  validateDocument(value)
  const { authoring: _authoring, ...published } = value
  return structuredClone(published)
}
