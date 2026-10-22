import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, symlink, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMotedServer } from './moted.mjs'
import { fakeRunner, stopWorkerUnit } from './runner.mjs'
import { agentRequest, submitResult } from './submit.mjs'
import { pathToFileURL } from 'node:url'
import { validateCandidate, validateDocument, validateRequest } from './validation.mjs'
import { validateDelivery } from './agent-protocol.mjs'

const png = 'data:image/png;base64,iVBORw0KGgo='
const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}`
const theme = {
  mode: 'light', hue: 145, secondaryHue: 260,
  defaults: { family: 'sans', size: 16, color: 'gray1', weight: 400, lineHeight: '1.5em', spaceBefore: '0em', spaceAfter: '1em', letterSpacing: '0em' },
  blocks: { title: {}, heading: {}, body: {}, caption: {}, code: {}, list: {}, table: {}, math: {} },
}
function document(kind = 'text') {
  const doc = { version: 'V0', id: 'doc-1', width: 800, margins: { top: 48, right: 48, bottom: 48, left: 48 }, theme, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text: 'Hello' }] }] }, floating: [] }
  if (kind === 'text') doc.floating.push({ id: 'object-1', anchorId: 'block-1', x: 40, y: 10, width: 200, placement: 'float', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'float-1', semantic: 'body' }, content: [] }] } })
  if (kind === 'html') doc.floating.push({ id: 'object-1', kind: 'html', anchorId: 'block-1', x: 40, y: 10, width: 200, height: 100, placement: 'float', html: '<button>+</button>', screenshot: svg, alt: 'demo' })
  return doc
}
function request(id, doc = document(), extra = {}) { return { id, document: doc, model: 'codex/gpt-5.6-luna', prompt: 'Improve the target', target: { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: true, area: { x: 48, y: 48, width: 200, height: 40 } }, ...extra } }
function segmentDocument() {
  const doc = document('text')
  doc.content.content = [
    { type: 'paragraph', attrs: { id: 'seg-p0', semantic: 'body' }, content: [{ type: 'text', text: 'First' }] },
    { type: 'spacer', attrs: { id: 'seg-space', height: 80 } },
    { type: 'paragraph', attrs: { id: 'seg-p2', semantic: 'body' }, content: [{ type: 'text', text: 'Last' }] },
  ]
  doc.floating = [
    { id: 'seg-image', kind: 'image', anchorId: 'seg-space', x: 40, y: 24, width: 160, placement: 'float', src: svg, alt: 'Source figure', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'seg-image-caption' }, content: [{ type: 'text', text: 'Figure caption' }] }] } } },
    { id: 'seg-widget', kind: 'html', anchorId: 'seg-p2', x: 40, y: 12, width: 120, height: 80, placement: 'float', html: '<p>source</p>', screenshot: svg, alt: 'Source widget' },
  ]
  return doc
}
function segmentTarget(overrides = {}) {
  return { kind: 'segment', range: { start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, blockIds: ['seg-p0', 'seg-space'], objectIds: ['seg-image'], area: { x: 0, y: 0, width: 800, height: 180 }, ...overrides }
}
function segmentPayload(withWidgets = false) {
  const content = [
    { type: 'paragraph', attrs: { id: 'candidate-p', semantic: 'heading' }, content: [{ type: 'text', text: 'Generated composition' }] },
    { type: 'spacer', attrs: { id: 'candidate-space', height: 72 } },
  ]
  const image = { id: 'candidate-image', kind: 'image', anchorId: 'candidate-p', x: 32, y: 12, width: 160, placement: 'float', src: svg, alt: 'Generated figure', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'candidate-image-caption' }, content: [{ type: 'text', text: 'Generated figure' }] }] } } }
  const floating = [image]
  const geometry = { 'candidate-image': { x: 32, y: 12, width: 160, height: 60 } }
  if (withWidgets) for (const id of ['candidate-widget-a', 'candidate-widget-b']) {
    floating.push({ id, kind: 'html', anchorId: 'candidate-p', x: id.endsWith('a') ? 240 : 380, y: 12, width: 120, height: 80, placement: 'float', html: `<button>${id}</button>`, alt: id, ...(id.endsWith('a') ? { caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: `${id}-caption` }, content: [{ type: 'text', text: 'Widget caption' }] }] } } } : {}) })
    geometry[id] = { x: id.endsWith('a') ? 240 : 380, y: 12, width: 120, height: 80 }
  }
  return { version: 'V0', type: 'segment', content, floating, geometry, anchorTops: { 'candidate-p': 0, 'candidate-space': 28 }, originTop: 0 }
}
function pngHeader(width, height) { const header = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header); header.write('IHDR', 12); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20); return header }
async function app(options = {}) {
  const stateDir = options.stateDir || await mkdtemp(path.join(os.tmpdir(), 'moted-test-'))
  const value = await createMotedServer({ ...options, stateDir, port: 0, useSystemd: false, defaultModel: 'codex/gpt-5.6-luna', env: { MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: 'http://localhost:5173', MOTED_SHARED_MU_DIR: path.join(stateDir, 'unused-config'), MOTED_MU_ENV_SOURCE: '', ...(options.env || {}) } })
  if (options.runner) value.manager.runner = async context => {
    const result = await options.runner(context)
    try { await readFile(path.join(context.outputDir, 'result.json')) } catch (error) { if (error.code === 'ENOENT') return result; throw error }
    if (value.manager.tasks.get(context.taskId)?.meta.candidateRevision === context.agent.candidateRevision) await submitResult(context)
    return result
  }
  await value.start(); value.stateDir = stateDir; return value
}
async function post(app, body, pathName = '/api/ai/tasks', origin = 'http://localhost:5173') { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }) }
async function get(app, id) { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}`) }
async function events(app, id, suffix = '', headers = {}) { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}/events${suffix}`, { headers }) }
async function waitReady(value, id) {
  for (let i = 0; i < 60; i++) { if (value.manager.tasks.get(id)?.meta.status === 'ready' && !value.manager.tasks.get(id)?.current) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('task did not become ready')
}
async function takeEvents(response, count) {
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const result = []
  try {
    while (result.length < count) {
      const next = await reader.read(); if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2)
        const fields = Object.fromEntries(frame.split('\n').filter(line => line.includes(': ')).map(line => { const at = line.indexOf(': '); return [line.slice(0, at), line.slice(at + 2)] }))
        if (fields.event === 'transcript') result.push(JSON.parse(fields.data))
        else if (fields.event === 'reset') result.push({ reset: true })
        if (result.length >= count) break
      }
    }
  } finally { await reader.cancel().catch(() => {}) }
  return result
}

test('fixed palette slots validate across documents, text candidates, and segments', () => {
  const references = ['primary', 'secondary', 'red', 'amber', 'green', 'blue', 'violet', 'pink'].flatMap(id => [id, `${id}:soft`])
  references.push('gray1', 'gray2', 'gray3', 'gray4', 'gray5', 'gray6')
  const paragraph = color => ({ type: 'paragraph', attrs: { id: 'color-paragraph', semantic: 'body' }, content: [{ type: 'text', text: 'Color', marks: [{ type: 'color', attrs: { color } }] }] })
  for (const mode of ['light', 'dark']) for (const color of references) {
    const doc = structuredClone(document())
    doc.theme.mode = mode
    doc.theme.defaults.color = color
    doc.theme.blocks.math = { color }
    doc.content.content[0].content = paragraph(color).content
    Object.assign(doc.floating[0], { background: color, borderColor: color, decoration: { kind: 'info', color } })
    assert.equal(validateDocument(doc), doc)
    assert.doesNotThrow(() => validateCandidate({ content: [paragraph(color)], summary: 'Color' }, doc, request('unused', doc).target))
    const segment = segmentPayload()
    segment.content[0].content = paragraph(color).content
    segment.floating[0].caption.content.content[0].content = paragraph(color).content
    assert.equal(validateCandidate({ segment, summary: 'Color' }, segmentDocument(), segmentTarget()).segment, segment)
  }
  for (const color of ['ink', 'muted', 'paper', 'detail', 'gray1:soft', 'gray6:soft', 'gray7', 'primary:strong', 'blue:soft:soft', '#ffffff']) {
    const doc = structuredClone(document())
    doc.theme.defaults.color = color
    assert.throws(() => validateDocument(doc), /unknown palette color/)
    assert.throws(() => validateCandidate({ content: [paragraph(color)], summary: 'Invalid' }, document(), request('unused').target), /unknown palette color/)
    const segment = segmentPayload()
    segment.content[0].content = paragraph(color).content
    assert.throws(() => validateCandidate({ segment, summary: 'Invalid' }, segmentDocument(), segmentTarget()), /unknown palette color/)
  }
})

test('theme requires mode and two finite hues and rejects legacy palette fields', () => {
  for (const mode of [undefined, null, 'auto', 'LIGHT']) {
    const doc = structuredClone(document()); doc.theme.mode = mode
    assert.throws(() => validateDocument(doc), /theme.mode/)
  }
  for (const key of ['hue', 'secondaryHue']) {
    for (const value of [undefined, null, -1, 360, NaN, Infinity, '145']) {
      const doc = structuredClone(document()); doc.theme[key] = value
      assert.throws(() => validateDocument(doc), new RegExp(`theme.${key}`))
    }
    for (const value of [0, 359.99]) {
      const doc = structuredClone(document()); doc.theme[key] = value
      assert.doesNotThrow(() => validateDocument(doc))
    }
  }
  for (const value of [[], null, undefined]) {
    const doc = structuredClone(document()); doc.theme.palette = value
    assert.throws(() => validateDocument(doc), /theme.palette is unsupported/)
    assert.throws(() => validateCandidate({ content: doc.content.content, summary: 'Legacy' }, doc, request('unused').target), /theme.palette is unsupported/)
    const segment = segmentPayload(); segment.palette = value
    assert.throws(() => validateCandidate({ segment, summary: 'Legacy' }, segmentDocument(), segmentTarget()), /segment.palette is unsupported/)
  }
  for (const background of ['gray6', 'paper', null, undefined]) {
    const doc = structuredClone(document()); doc.theme.defaults.background = background
    assert.throws(() => validateDocument(doc), /theme.defaults.background is unsupported/)
  }
})

test('new floating reservations accept supported kinds and reject removed kinds', () => {
  const doc = document('html'), original = doc.floating[0]
  const { id, anchorId, x, y, width, placement } = original
  const base = { id, anchorId, x, y, width, placement }
  const target = { kind: 'object', objectId: id, isNew: true, area: { x, y, width, height: 100 } }
  const paragraph = { type: 'paragraph', attrs: { semantic: 'body' }, content: [{ type: 'text', text: 'Native text' }] }
  const objects = [
    { ...base, kind: 'drawing', height: 100, background: null, strokes: [{ points: [[5, 8]], color: 'gray1', width: 2.5 }], labels: [] },
    { ...base, kind: 'code', source: 'const answer = 42\n', language: 'javascript', scheme: 'dark' },
    { ...base, kind: 'katex', latex: String.raw`\int_0^1 x^2\,dx = \frac{1}{3}` },
    { ...base, kind: 'text', content: { type: 'doc', content: [paragraph] } },
    { ...base, kind: 'table', content: { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph] }] }] }] } },
    { ...base, kind: 'image', src: png, alt: 'Image' }, original,
  ]
  for (const object of objects) {
    assert.equal(validateCandidate({ object, summary: 'Candidate' }, doc, target).object.kind, object.kind)
    if (object.kind !== 'html') assert.throws(() => validateCandidate({ object, summary: 'Candidate' }, doc, { ...target, isNew: false }), /retain target kind/)
  }
  for (const kind of ['rectangle', 'ellipse', 'line']) {
    const object = { ...base, kind }
    assert.throws(() => validateDocument({ ...doc, floating: [object] }), /unsupported floating kind/)
    assert.throws(() => validateCandidate({ object, summary: 'Candidate' }, doc, target), /unsupported floating kind/)
  }
})

test('drawings roundtrip with bounded native data and allow supported single-object conversions', () => {
  const doc = document('html'), widget = doc.floating[0]
  const drawing = { id: widget.id, kind: 'drawing', anchorId: widget.anchorId, x: widget.x, y: widget.y, width: widget.width, height: 100, placement: 'float', background: 'gray6',
    strokes: [{ points: [[-1, 2], [3.5, 8]], color: 'primary:soft', width: 2.5 }], labels: [{ x: 1, y: 2, text: 'A < B', color: 'gray1', size: 13.5 }] }
  doc.floating = [drawing]
  assert.deepEqual(validateDocument(JSON.parse(JSON.stringify(doc))), doc)
  const target = { kind: 'object', objectId: drawing.id, isNew: false, area: { x: drawing.x, y: drawing.y, width: drawing.width, height: drawing.height } }
  for (const object of [drawing, widget, { ...widget, kind: 'image', src: png }, document().floating[0]]) {
    assert.equal(validateCandidate({ object, summary: 'Convert sketch to figure' }, doc, target).object, object)
  }
  const mutations = [value => { value.width = 0 }, value => { value.height = 0 }, value => { value.background = 'gray1' }, value => { value.background = 'paper' },
    value => { value.strokes[0].width = 0 }, value => { value.strokes[0].points = [] }, value => { value.strokes[0].points[0] = [NaN, 0] },
    value => { value.strokes[0].points[0].push(0) }, value => { value.strokes[0].points = Array(100001).fill([0, 0]) },
    value => { value.labels[0].size = -1 }, value => { value.labels[0].x = Infinity }, value => { value.labels[0].text = 'x'.repeat(4097) },
    value => { value.labels[0].color = 'missing' }, value => { value.strokes[0].color = '#ffffff' }]
  for (const mutate of mutations) {
    const invalid = structuredClone(doc); mutate(invalid.floating[0])
    assert.throws(() => validateDocument(invalid))
  }
  const segment = segmentPayload()
  segment.floating.push({ ...drawing, id: 'candidate-drawing-extra', anchorId: 'candidate-p' })
  assert.equal(validateCandidate({ segment, summary: 'A drawing in a segment' }, segmentDocument(), segmentTarget()).segment, segment)
  segment.floating.at(-1).labels[0].color = 'missing'
  assert.throws(() => validateCandidate({ segment, summary: 'Invalid palette' }, segmentDocument(), segmentTarget()), /unknown palette/)
})

test('segment targets use canonical points and exact block/object ownership', () => {
  const doc = segmentDocument()
  const accepted = validateRequest(request(crypto.randomUUID(), doc, { target: segmentTarget() })).target
  assert.equal(accepted.kind, 'segment')
  assert.deepEqual(accepted.blockIds, ['seg-p0', 'seg-space'])
  assert.deepEqual(accepted.objectIds, ['seg-image'])
  assert.throws(() => validateRequest(request(crypto.randomUUID(), doc, { target: segmentTarget({ objectIds: [] }) })), /objectIds does not match/)
  assert.throws(() => validateRequest(request(crypto.randomUUID(), doc, { target: segmentTarget({ blockIds: ['seg-p0'] }) })), /blockIds does not match/)
  const partial = segmentTarget({ range: { start: { index: 1, offset: 20 }, end: { index: 1, offset: 60 } }, blockIds: ['seg-space'], objectIds: ['seg-image'] })
  assert.equal(validateRequest(request(crypto.randomUUID(), doc, { target: partial })).target.range.start.offset, 20)
  const empty = segmentTarget({ range: { start: { index: 2, offset: 0 }, end: { index: 2, offset: 0 } }, blockIds: [], objectIds: [] })
  assert.equal(validateRequest(request(crypto.randomUUID(), doc, { target: empty })).target.kind, 'segment')
  assert.throws(() => validateRequest(request(crypto.randomUUID(), doc, { target: { ...empty, objectIds: ['seg-widget'] } })), /objectIds does not match/)
})

test('caption subobjects validate, preserve content and user width, clear when explicitly empty, and reject legacy schemas', () => {
  const caption = (id, textValue = 'A caption', width) => ({ content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: textValue, marks: [{ type: 'bold' }, { type: 'color', attrs: { color: 'gray2' } }, { type: 'decoration', attrs: { decoration: 'underline' } }] }] }] }, ...(width === undefined ? {} : { width }) })
  const doc = document('html')
  doc.floating[0].caption = caption('html-caption', 'A caption', 240)
  assert.equal(validateDocument(doc).floating[0].caption.content.content[0].content[0].text, 'A caption')
  assert.equal(doc.floating[0].caption.width, 240, 'caption width may exceed the owner width')
  const followsOwner = { ...document('html'), floating: [{ ...document('html').floating[0], caption: caption('owner-width-caption') }] }
  assert.equal(validateDocument(followsOwner).floating[0].caption.width, undefined)
  for (const width of [0, -1, Infinity, NaN, '200']) {
    const invalid = document('html'); invalid.floating[0].caption = caption('bad-width-caption', 'A caption', width)
    assert.throws(() => validateDocument(invalid), /caption.width must be a finite number/)
  }
  for (const key of ['id', 'x', 'y', 'placement', 'detach']) {
    const invalid = document('html'); invalid.floating[0].caption = { ...caption('extra-caption-field'), [key]: key === 'x' || key === 'y' ? 0 : 'value' }
    assert.throws(() => validateDocument(invalid), /caption must contain content and optional width/)
  }

  const table = { id: 'caption-table', kind: 'table', anchorId: 'block-1', x: 0, y: 0, width: 200, placement: 'float', content: { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [] }] }] }] }] }, caption: caption('table-caption', 'Table caption', 240) }
  const image = { id: 'caption-image', kind: 'image', anchorId: 'block-1', x: 0, y: 0, width: 200, placement: 'float', src: png, alt: 'Image', caption: caption('image-caption') }
  assert.doesNotThrow(() => validateDocument({ ...document(), floating: [table, image] }))
  for (const id of ['table-caption', 'caption-image', 'block-1']) {
    assert.throws(() => validateDocument({ ...document(), floating: [table, { ...image, caption: caption(id) }] }), /caption paragraph IDs/)
  }

  const unsupported = { ...document(), floating: [{ id: 'drawing-caption', kind: 'drawing', anchorId: 'block-1', x: 0, y: 0, width: 20, height: 20, placement: 'float', background: null, strokes: [], labels: [], caption: null }] }
  assert.throws(() => validateDocument(unsupported), /caption is only supported/)
  for (const mutate of [
    value => { value.content.content.push({ type: 'paragraph', attrs: { id: 'second-caption' } }) },
    value => { value.content.content[0].attrs.semantic = 'caption' },
    value => { value.content.content[0].attrs.listLevel = 0 },
    value => { value.content.content[0].content[0].type = 'image' },
    value => { value.content.content[0].attrs = { id: 'bad-caption', semantic: 'caption' } },
    value => { value.content.content[0].content[0].marks[0].attrs = { weight: 700 } },
  ]) {
    const invalid = caption('invalid-caption')
    mutate(invalid)
    const badDoc = document('html'); badDoc.floating[0].caption = invalid
    assert.throws(() => validateDocument(badDoc))
  }
  const badPalette = document('html'); badPalette.floating[0].caption = { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'bad-color-caption' }, content: [{ type: 'text', text: 'Color', marks: [{ type: 'color', attrs: { color: 'missing' } }] }] }] } }
  assert.throws(() => validateDocument(badPalette), /unknown palette color/)

  const original = document('html')
  original.floating[0].caption = caption('original-caption', 'Retained caption', 240)
  const target = { kind: 'object', objectId: 'object-1', isNew: false, area: { x: 40, y: 10, width: 200, height: 100 } }
  const reservation = validateRequest(request(crypto.randomUUID(), original, { target }))
  assert.equal(reservation.document.floating[0].caption.content.content[0].content[0].text, 'Retained caption')
  const omitted = structuredClone(original.floating[0]); delete omitted.caption
  assert.deepEqual(validateCandidate({ object: omitted, summary: 'Retain caption' }, original, target).object.caption, original.floating[0].caption)
  const revised = { ...structuredClone(original.floating[0]), screenshot: `data:image/png;base64,${pngHeader(200, 100).toString('base64')}`, caption: caption('revised-caption', 'New text', 320) }
  const revisedResult = { object: revised, summary: 'Revise caption' }
  assert.equal(validateCandidate(revisedResult, original, target).object.caption.width, 240, 'AI revisions retain user-owned caption width')
  assert.equal(validateDelivery(revisedResult, {}, original, target).object.caption.width, 240)
  const originalFollowsOwner = document('html')
  originalFollowsOwner.floating[0].caption = caption('original-follow-owner')
  const candidateAddsCaption = { ...structuredClone(originalFollowsOwner.floating[0]), caption: caption('added-caption', 'New caption', 320) }
  assert.equal(validateCandidate({ object: candidateAddsCaption, summary: 'Add caption' }, originalFollowsOwner, target).object.caption.width, undefined)
  const cleared = { ...omitted, screenshot: `data:image/png;base64,${pngHeader(200, 100).toString('base64')}`, caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'empty-caption' }, content: [] }] }, width: 320 } }
  const clearResult = { object: cleared, summary: 'Clear caption' }
  assert.deepEqual(validateCandidate(clearResult, original, target).object.caption, { ...cleared.caption, width: 240 })
  assert.deepEqual(validateDelivery(clearResult, {}, original, target).object.caption, { ...cleared.caption, width: 240 })
  assert.throws(() => validateCandidate({ object: { ...omitted, attachment: null }, summary: 'Legacy field' }, original, target), /legacy attachment/)
  const legacy = document('html'); legacy.floating[0].attachment = null
  assert.throws(() => validateDocument(legacy), /legacy attachment/)
  const nestedLegacy = document('html'); nestedLegacy.content.content[0].attachment = null
  assert.throws(() => validateDocument(nestedLegacy), /legacy attachment/)
  assert.throws(() => validateCandidate({ object: omitted, summary: 'Legacy source field' }, legacy, target), /legacy attachment/)
  const bareCaption = document('html'); bareCaption.floating[0].caption = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'bare-caption' }, content: [] }] }
  assert.throws(() => validateDocument(bareCaption), /caption must contain content and optional width/)
  assert.throws(() => validateCandidate({ object: { ...omitted, caption: bareCaption.floating[0].caption }, summary: 'Legacy caption' }, original, target), /caption must contain content and optional width/)
  const legacyLabel = structuredClone(original); legacyLabel.floating[0].kind = 'label'; delete legacyLabel.floating[0].caption
  assert.throws(() => validateDocument(legacyLabel), /unsupported floating kind/)
})

test('segment candidate rejects external refs and accepts native composition payloads', () => {
  const doc = segmentDocument(), target = segmentTarget()
  const candidate = validateCandidate({ segment: segmentPayload(), summary: 'native segment' }, doc, target)
  assert.equal(candidate.segment.type, 'segment')
  assert.deepEqual(candidate.segment.floating.map(object => object.id), ['candidate-image'])
  assert.equal(candidate.segment.floating[0].caption.content.content[0].content[0].text, 'Generated figure')
  const externalAnchor = segmentPayload(); externalAnchor.floating[0].anchorId = 'outside'
  assert.throws(() => validateCandidate({ segment: externalAnchor, summary: 'bad' }, doc, target), /anchor is outside/)
  const externalGeometry = segmentPayload(); externalGeometry.geometry.outside = { x: 0, y: 0, width: 1, height: 1 }
  assert.throws(() => validateCandidate({ segment: externalGeometry, summary: 'bad' }, doc, target), /geometry references/)
  const unknownPalette = segmentPayload(); unknownPalette.content[0].content[0].marks = [{ type: 'color', attrs: { color: 'outside' } }]
  assert.throws(() => validateCandidate({ segment: unknownPalette, summary: 'bad' }, doc, target), /unknown palette/)
  const unknownCaptionPalette = segmentPayload(); unknownCaptionPalette.floating[0].caption.content.content[0].content[0].marks = [{ type: 'color', attrs: { color: 'outside' } }]
  assert.throws(() => validateCandidate({ segment: unknownCaptionPalette, summary: 'bad' }, doc, target), /unknown palette/)
  const emptyTarget = segmentTarget({ range: { start: { index: 2, offset: 0 }, end: { index: 2, offset: 0 } }, blockIds: [], objectIds: [] })
  assert.deepEqual(validateCandidate({ segment: { version: 'V0', type: 'segment', content: [], floating: [], geometry: {}, anchorTops: {}, originTop: 0 }, summary: 'empty' }, doc, emptyTarget).segment.content, [])
})

test('fake segment task returns a deterministic native composition', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); assert.equal((await post(value, request(id, segmentDocument(), { target: segmentTarget() }))).status, 202)
  await waitReady(value, id)
  const status = await (await get(value, id)).json()
  assert.equal(status.status, 'ready')
  assert.equal(status.candidate.summary, 'Fake candidate for segment target.')
  assert.deepEqual(status.candidate.segment.content.map(node => node.type), ['paragraph', 'flow'])
  assert.deepEqual(status.candidate.segment.floating.map(object => object.kind ?? 'text'), ['image'])
  assert.equal(status.candidate.segment.floating[0].caption.content.content[0].content[0].text, 'AI figure')
  assert.equal(status.candidate.segment.floating[0].placement, 'flow')
  assert.equal(status.candidate.segment.floating[0].anchorId, status.candidate.segment.content[1].attrs.id)
  assert.equal(status.candidate.segment.content[1].attrs.objectId, status.candidate.segment.floating[0].id)
  assert.deepEqual(Object.keys(status.candidate.segment.geometry).sort(), status.candidate.segment.floating.map(object => object.id).sort())
})

test('Flow validation enforces structural pairs, scope ownership, and paragraph-only text tasks', () => {
  const doc = segmentDocument()
  const flow = { type: 'flow', attrs: { id: 'seg-flow', objectId: 'seg-image' } }
  doc.content.content[1] = flow
  Object.assign(doc.floating[0], { placement: 'flow', anchorId: 'seg-flow', x: 0, y: 0, centered: true })
  Object.assign(doc.floating[1], { anchorId: 'seg-flow', x: -8, y: -12 })
  assert.equal(validateDocument(doc), doc)
  const target = segmentTarget({ blockIds: ['seg-p0', 'seg-flow'], objectIds: ['seg-image', 'seg-widget'] })
  assert.equal(validateRequest(request(crypto.randomUUID(), doc, { target })).target, target)
  assert.throws(() => validateRequest(request(crypto.randomUUID(), doc, { target: { ...target, objectIds: ['seg-image'] } })), /selected segment scope/)
  for (const mutate of [
    value => { value.content.content.splice(1, 1) },
    value => { value.content.content.push({ ...flow, attrs: { ...flow.attrs, id: 'duplicate-flow' } }) },
    value => { value.content.content[1].attrs.objectId = 'outside' },
    value => { value.floating[0].placement = 'float' },
    value => { value.floating[0].anchorId = 'seg-p0' },
    value => { value.floating[0].y = 1 },
    value => { value.floating[0].centered = 'yes' },
    value => { value.floating[1].anchorId = 'seg-p0' },
    value => { value.content.content[0].attrs.id = 'seg-image' },
    value => { value.floating[1].placement = 'flow' },
    value => { value.floating[0].textFlow = 'repel' },
    value => { value.floating[0].caption.content.content[0].content.push(flow) },
  ]) {
    const invalid = structuredClone(doc); mutate(invalid)
    assert.throws(() => validateDocument(invalid))
  }
  const textTarget = { ...request(crypto.randomUUID()).target, blockIds: ['seg-flow'] }
  assert.throws(() => validateRequest(request(crypto.randomUUID(), doc, { target: textTarget })), /target block/)
  assert.throws(() => validateRequest(request(crypto.randomUUID(), doc, { target: { ...textTarget, blockIds: ['seg-p0', 'seg-p2'] } })), /consecutive paragraphs/)
  assert.throws(() => validateCandidate({ content: [flow], summary: 'bad text' }, doc, textTarget), /paragraphs/)
  const payload = segmentPayload()
  payload.content[1] = { type: 'flow', attrs: { id: 'candidate-space', objectId: 'candidate-image' } }
  Object.assign(payload.floating[0], { placement: 'flow', anchorId: 'candidate-space', x: 0, y: 0 })
  assert.equal(validateCandidate({ segment: payload, summary: 'Flow composition' }, doc, target).segment, payload)
  payload.content.pop()
  assert.throws(() => validateCandidate({ segment: payload, summary: 'orphaned Flow' }, doc, target), /Flow object requires/)
})

test('segment HTML screenshotPaths embed bounded screenshots for multiple widgets', async t => {
  const payload = segmentPayload(true)
  const value = await app({ runner: async context => {
    await writeFile(path.join(context.outputDir, 'widget-a.png'), pngHeader(120, 80))
    await writeFile(path.join(context.outputDir, 'widget-b.png'), pngHeader(120, 80))
    await writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify({ segment: payload, screenshotPaths: { 'candidate-widget-a': 'widget-a.png', 'candidate-widget-b': 'widget-b.png' }, summary: 'two widgets' }))
  } }); t.after(() => value.close())
  const id = crypto.randomUUID(); assert.equal((await post(value, request(id, segmentDocument(), { target: segmentTarget() }))).status, 202)
  await waitReady(value, id)
  const status = await (await get(value, id)).json()
  assert.equal(status.status, 'ready')
  assert.equal(status.candidate.screenshotPaths, undefined)
  assert.ok(status.candidate.segment.floating.filter(object => object.kind === 'html').every(object => /^data:image\/png;base64,/.test(object.screenshot)))
})

test('a native KaTeX delivery reaches ready without HTML or screenshot artifacts', async t => {
  const doc = document('html'), original = doc.floating[0]
  const value = await app({ runner: async context => {
    const { id, anchorId, x, y, width, placement } = original
    await writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify({ object: { id, anchorId, x, y, width, placement, kind: 'katex', latex: 'E = mc^2' }, summary: 'Native formula' }))
  } }); t.after(() => value.close())
  const id = crypto.randomUUID()
  assert.equal((await post(value, request(id, doc, { target: { kind: 'object', objectId: original.id, isNew: true, area: { x: 40, y: 10, width: 200, height: 100 } } }))).status, 202)
  let status
  for (let i = 0; i < 30; i++) { status = await (await get(value, id)).json(); if (!['queued', 'running'].includes(status.status)) break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(status.status, 'ready'); assert.equal(status.candidate.object.kind, 'katex'); assert.equal(status.candidate.object.latex, 'E = mc^2')
  assert.equal(status.candidate.object.screenshot, undefined)
})

test('fake task reaches ready and status does not expose logs or document', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); const created = await post(value, request(id)); assert.equal(created.status, 202)
  const initial = await created.json(); assert.ok(['queued', 'running'].includes(initial.status)); assert.equal(initial.id, id); assert.equal('document' in initial, false)
  let status
  for (let i = 0; i < 20; i++) { status = await (await get(value, id)).json(); if (status.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(status.status, 'ready'); assert.equal(status.candidate.summary, 'Fake candidate for text target.'); assert.equal(status.candidate.content[0].content[0].text, 'AI draft: Hello'); assert.equal('logs' in status, false); assert.equal('prompt' in status, false)
 })

test('fake transcript streams incremental ANSI/plain stdout and stderr', async t => {
  const value = await app({ env: { MOTED_FAKE_DELAY_MS: '35' } }); t.after(() => value.close())
  const id = crypto.randomUUID(); const body = request(id); await post(value, body)
  const response = await events(value, id); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  const first = await takeEvents(response, 2)
  assert.deepEqual(first.map(event => event.kind), ['request', 'stdout'])
  assert.equal(first[0].text, body.prompt); assert.equal(first[0].attempt, 1); assert.match(first[1].text, /\u001b\[36m/)
  await waitReady(value, id)
  const journal = value.manager.tasks.get(id).transcript.events
  assert.ok(journal.some(event => event.kind === 'stderr' && /no model call/.test(event.text)))
})

test('completed transcript replays from after and Last-Event-ID cursors', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id)); await waitReady(value, id)
  const all = await takeEvents(await events(value, id, '?after=0'), 5)
  assert.deepEqual(all.map(event => event.id), [1, 2, 3, 4, 5]); assert.ok(all.every(event => event.attempt === 1))
  const after = await takeEvents(await events(value, id, '', { 'Last-Event-ID': '1' }), 4)
  assert.deepEqual(after.map(event => event.id), [2, 3, 4, 5])
  const reconnected = await takeEvents(await events(value, id, '?after=0', { 'Last-Event-ID': '3' }), 2)
  assert.deepEqual(reconnected.map(event => event.id), [4, 5])
})

test('revisions append attempts to the same transcript journal', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id)); await waitReady(value, id)
  assert.equal((await post(value, { executorRevision: 0, prompt: 'Revise the transcript' }, `/api/ai/tasks/${id}/revise`)).status, 202); await waitReady(value, id)
  const all = await takeEvents(await events(value, id, '?after=0'), 10)
  assert.deepEqual(all.filter(event => event.kind === 'request').map(event => [event.attempt, event.text]), [[1, 'Improve the target'], [2, 'Revise the transcript']])
  assert.deepEqual([...new Set(all.map(event => event.attempt))], [1, 2]); assert.deepEqual(all.map(event => event.id), [...Array(10)].map((_, index) => index + 1))
})

test('truncated replay announces reset and restart recovers the bounded journal', async t => {
  const value = await app({ transcriptMaxEvents: 3 }); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id)); await waitReady(value, id)
  const beforeRestart = await takeEvents(await events(value, id, '?after=0'), 4)
  assert.equal(beforeRestart[0].reset, true); assert.deepEqual(beforeRestart.slice(1).map(event => event.id), [3, 4, 5])
  const stateDir = value.stateDir; await value.close()
  const restarted = await app({ stateDir, transcriptMaxEvents: 3 }); t.after(() => restarted.close())
  const afterRestart = await takeEvents(await events(restarted, id, '?after=0'), 4)
  assert.equal(afterRestart[0].reset, true); assert.deepEqual(afterRestart.slice(1).map(event => event.id), [3, 4, 5])
})

test('deleting a task closes its transcript and removes replay state', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id)); await waitReady(value, id)
  const response = await events(value, id, '?after=0'); const reader = response.body.getReader(); await reader.read()
  const address = value.server.address(); const deleted = await fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}`, { method: 'DELETE', headers: { origin: 'http://localhost:5173' } })
  assert.equal(deleted.status, 200); await assert.rejects(reader.read()); assert.equal((await get(value, id)).status, 404)
})

test('concurrent revision and deletion cannot queue an orphaned worker', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id)); await waitReady(value, id)
  const address = value.server.address()
  const [revision, deletion] = await Promise.all([
    post(value, { executorRevision: 0, prompt: 'Concurrent revision' }, `/api/ai/tasks/${id}/revise`),
    fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}`, { method: 'DELETE', headers: { origin: 'http://localhost:5173' } }),
  ])
  assert.ok([202, 404].includes(revision.status)); assert.equal(deletion.status, 200)
  assert.equal(value.manager.tasks.has(id), false)
  assert.equal(value.manager.queue.some(task => task.id === id), false)
  assert.equal(value.manager.active, 0)
})

test('queued requests remain in the transcript when stopped before a worker starts', async t => {
  const value = await app({ maxConcurrent: 1, env: { MOTED_FAKE_DELAY_MS: '200' } }); t.after(() => value.close())
  await post(value, request(crypto.randomUUID()))
  const id = crypto.randomUUID(); await post(value, request(id))
  assert.equal(value.manager.tasks.get(id).meta.status, 'queued')
  await post(value, {}, `/api/ai/tasks/${id}/stop`)
  const replay = await takeEvents(await events(value, id), 1)
  assert.equal(replay[0].kind, 'request'); assert.equal(replay[0].text, 'Improve the target')
})

test('mutations require exact configured origin and IDs collide', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); const body = request(id)
  assert.equal((await post(value, body, '/api/ai/tasks', 'http://evil.test')).status, 403)
  assert.equal((await post(value, body)).status, 202)
  assert.equal((await post(value, body)).status, 409)
 })

test('stop preserves the last candidate and delete removes task files', async t => {
  const value = await app({ env: { MOTED_FAKE_DELAY_MS: '500' } }); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id)); const stopped = await post(value, {}, `/api/ai/tasks/${id}/stop`); assert.equal(stopped.status, 200); assert.equal((await stopped.json()).status, 'stopped'); await new Promise(resolve => setTimeout(resolve, 600)); const late = await (await get(value, id)).json(); assert.equal(late.status, 'stopped'); assert.equal(late.candidate, undefined)
  const deleted = await (async () => { const address = value.server.address(); return fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}`, { method: 'DELETE', headers: { origin: 'http://localhost:5173' } }) })(); assert.equal(deleted.status, 200); assert.equal((await get(value, id)).status, 404)
 })

test('HTML screenshotPath is bounded, embedded, and candidate HTML is not executed', async t => {
  const customRunner = async context => {
    const header = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(header); header.write('IHDR', 12); header.writeUInt32BE(200, 16); header.writeUInt32BE(100, 20)
    await writeFile(path.join(context.outputDir, 'screenshot.png'), header)
    const object = { ...context.targetObject }; delete object.screenshot
    await writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify({ object: { ...object, id: context.target.objectId }, summary: 'html', screenshotPath: 'screenshot.png' }))
  }
  const doc = document('html'); const value = await app({ runner: async context => { context.targetObject = doc.floating[0]; return customRunner(context) } }); t.after(() => value.close())
  const id = crypto.randomUUID(); const body = request(id, doc, { target: { kind: 'object', objectId: 'object-1', isNew: false, area: { x: 40, y: 10, width: 200, height: 100 } } }); assert.equal((await post(value, body)).status, 202)
  let status; for (let i = 0; i < 20; i++) { status = await (await get(value, id)).json(); if (status.status !== 'running' && status.status !== 'queued') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(status.status, 'ready'); assert.match(status.candidate.object.screenshot, /^data:image\/png;base64,/); assert.equal(status.candidate.screenshotPath, undefined)
 })

test('revision reuses the fake Mu session and advances generation', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id))
  await waitReady(value, id)
  const session = value.manager.tasks.get(id).meta.sessionId
  assert.match(session, /^fake-/)
  const revised = await post(value, { executorRevision: 0, prompt: 'Revise the candidate' }, `/api/ai/tasks/${id}/revise`)
  assert.equal(revised.status, 202)
  await waitReady(value, id)
  assert.equal(value.manager.tasks.get(id).meta.sessionId, session)
  assert.equal(value.manager.tasks.get(id).meta.generation, 1)
})


test('timeout marks the task error and ignores a late runner result', async t => {
  const value = await app({ timeoutMs: 25, runner: async () => { await new Promise(resolve => setTimeout(resolve, 200)); return { sessionId: 'late-session' } } }); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id))
  await new Promise(resolve => setTimeout(resolve, 160))
  const status = await (await get(value, id)).json()
  assert.equal(status.status, 'error'); assert.equal(status.error, 'Worker timed out.'); assert.equal(status.candidate, undefined); assert.equal(value.manager.tasks.get(id).meta.unit, undefined)
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(value.manager.tasks.get(id).current, null)
})


test('failed first turn can retry without a recorded session', async t => {
  let runs = 0
  const value = await app({ runner: async context => { runs++; if (runs === 1) { await writeFile(path.join(context.taskDir, '.mu', 'sessions', 'saved-session.jsonl'), 'fake journal'); await symlink('sessions/saved-session.jsonl', path.join(context.taskDir, '.mu', 'current-session')); throw new Error('first turn failed') } return fakeRunner(context) } }); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id))
  for (let i = 0; i < 30; i++) { if (value.manager.tasks.get(id)?.meta.status === 'error') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(value.manager.tasks.get(id).meta.sessionId, 'saved-session')
  assert.equal((await post(value, { executorRevision: 0, prompt: 'Retry after failure' }, `/api/ai/tasks/${id}/revise`)).status, 202)
  for (let i = 0; i < 30; i++) { if (value.manager.tasks.get(id)?.meta.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(value.manager.tasks.get(id).meta.status, 'ready'); assert.equal(runs, 2)
})

test('workspace defaults apply only to new sessions and explicit document model wins', async t => {
  const value = await app(); t.after(() => value.close())
  value.store.putSettings({ baseRevision: 0, models: { builtin: 'workspace/first', indexing: 'workspace/indexer' } })
  const id = crypto.randomUUID()
  assert.equal((await post(value, request(id, document(), { model: undefined }))).status, 202)
  await waitReady(value, id)
  assert.equal(value.manager.tasks.get(id).meta.model, 'workspace/first')
  value.store.putSettings({ baseRevision: 1, models: { builtin: 'workspace/second', indexing: '' } })
  await post(value, { prompt: 'Continue', executorRevision: 0 }, `/api/ai/tasks/${id}/revise`)
  await waitReady(value, id)
  assert.equal(value.manager.tasks.get(id).meta.model, 'workspace/first')
  const explicit = crypto.randomUUID()
  await post(value, request(explicit, document(), { model: 'document/override' }))
  await waitReady(value, explicit)
  assert.equal(value.manager.tasks.get(explicit).meta.model, 'document/override')
})

test('unconfirmed worker cleanup stays fenced without requeue or unsafe artifact deletion', async t => {
  let runs = 0
  const value = await app({ runner: async context => { runs++; context.cleanupFailed = true; throw new Error('cleanup unavailable') } })
  t.after(() => value.close())
  const id = crypto.randomUUID()
  await post(value, request(id))
  for (let i = 0; i < 100 && ![...value.manager.tasks.get(id).executions].some(run => run.cleanupFailed); i++) await new Promise(resolve => setTimeout(resolve, 10))
  const task = value.manager.tasks.get(id)
  assert.equal(task.executions.size, 1)
  assert.match(task.meta.error, /cleanup could not be confirmed/)
  assert.ok(task.meta.workerUnit)
  assert.equal((await post(value, { prompt: 'Retry', executorRevision: 0 }, `/api/ai/tasks/${id}/revise`)).status, 503)
  assert.equal((await fetch(endpoint(value, `/api/ai/tasks/${id}`), { method: 'DELETE', headers: { origin: 'http://localhost:5173' } })).status, 409)
  await readFile(path.join(task.dir, 'meta.json'))
  assert.equal(runs, 1)
})

test('unavailable systemd cleanup probes have finite attempts with backoff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-cleanup-test-'))
  const bin = path.join(root, 'systemctl'), log = path.join(root, 'calls')
  await writeFile(bin, `#!/usr/bin/node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n'); process.exit(1)\n`, { mode: 0o700 })
  await assert.rejects(stopWorkerUnit(`moted-${crypto.randomUUID()}-0`, { MOTED_SYSTEMCTL: bin }), /cleanup could not be confirmed/)
  const calls = (await readFile(log, 'utf8')).trim().split('\n')
  assert.deepEqual(calls.slice(0, 3), ['kill', 'kill', 'stop'])
  assert.equal(calls.filter(call => call === 'show').length, 6)
})

const endpoint = (value, suffix) => `http://127.0.0.1:${value.server.address().port}${suffix}`
const externalRequest = (id, doc = document(), extra = {}) => request(id, doc, { executor: 'external', operationId: crypto.randomUUID(), prompt: undefined, model: undefined, snapshot: png, ...extra })
const delivery = (doc, extra = {}) => ({ operationId: crypto.randomUUID(), executorRevision: 0, candidateRevision: 0, candidate: { content: doc.content.content, summary: 'External candidate' }, ...extra })
const switchMode = (value, task, executor, extra = {}) => post(value, { executor, baseExecutorRevision: task.executorRevision, operationId: crypto.randomUUID(), ...extra }, `/api/ai/tasks/${task.id}/executor`)
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('condition did not become true')
}

test('external handoff is immutable, agent-independent, and accepts only validated candidate bytes', async t => {
  const value = await app({ env: { MOTED_MU_BIN: '/not-an-installed-agent', MOTED_SHARED_MU_DIR: '/not-a-provider' } }); t.after(() => value.close())
  value.manager.defaultModel = undefined
  const doc = document('html'), id = crypto.randomUUID()
  doc.notes = 'Internal working outline for authorized agent context'
  const target = { kind: 'object', objectId: 'object-1', isNew: false, area: { x: 40, y: 10, width: 200, height: 100 } }
  const body = externalRequest(id, doc, { target, snapshot: `data:image/png;base64,${pngHeader(800, 400).toString('base64')}` })
  const response = await post(value, body); assert.equal(response.status, 202)
  const task = await response.json(), base = task.externalPath
  assert.equal(task.status, 'waiting'); assert.equal(task.executorRevision, 0); assert.equal(task.candidateRevision, 0)
  assert.equal(Buffer.from(base.split('/').at(-1), 'base64url').length, 32); assert.equal(value.manager.active, 0)
  await assert.rejects(readFile(path.join(value.manager.tasks.get(id).dir, '.mu', 'config.jsonc')), { code: 'ENOENT' })
  const handoff = await fetch(endpoint(value, base))
  assert.match(handoff.headers.get('content-type'), /text\/markdown/)
  assert.equal(handoff.headers.get('cache-control'), 'no-store'); assert.equal(handoff.headers.get('referrer-policy'), 'no-referrer')
  assert.match(await handoff.text(), /manifest\.json/)
  const manifest = await agentRequest(endpoint(value, `${base}/manifest.json`))
  const guide = await (await fetch(endpoint(value, `${base}/guide.md`))).text()
  assert.equal(crypto.createHash('sha256').update(guide).digest('hex'), manifest.guideVersion)
  assert.doesNotMatch(guide, /\/root\/mote|Mu session/)
  assert.deepEqual(await agentRequest(endpoint(value, `${base}/document.json`)), doc)
  assert.deepEqual(await agentRequest(endpoint(value, `${base}/target.json`)), target)
  assert.deepEqual(Buffer.from(await (await fetch(endpoint(value, `${base}/snapshot.png`))).arrayBuffer()), pngHeader(800, 400))
  for (const resource of ['meta.json', 'providers.json', 'tasks', 'document.json/extra']) assert.equal((await fetch(endpoint(value, `${base}/${resource}`))).status, 404)
  assert.equal((await fetch(endpoint(value, `${base}/document.json`), { method: 'PUT', body: '{}' })).status, 404)
  const object = { ...doc.floating[0], html: '<script>throw new Error("must never execute")</script>' }; delete object.screenshot
  const candidate = { object, screenshotPath: 'figure.png', summary: 'Validated HTML and actual uploaded PNG', notes: 'Attempted Notes edit' }
  const payload = delivery(doc, { candidate, assets: { 'figure.png': `data:image/png;base64,${pngHeader(200, 100).toString('base64')}` } })
  for (const invalid of [
    { ...payload, assets: {} },
    { ...payload, assets: { 'figure.png': png } },
    { ...payload, assets: { 'figure.png': `data:image/png;base64,${pngHeader(400, 100).toString('base64')}` } },
    { ...payload, assets: { 'figure.png': 'http://127.0.0.1:1/private.png' } },
    { ...payload, candidate: { ...candidate, screenshotPath: '/etc/passwd' } },
    { ...payload, candidate: { ...candidate, screenshotPath: 'file:///etc/passwd' } },
    { ...payload, candidate: { ...candidate, screenshotPath: '../figure.png' } },
    { ...payload, candidate: { ...candidate, object: { ...object, id: 'other-object' } } },
  ]) assert.equal((await post(value, invalid, `${base}/submit`, 'http://untrusted.test')).status, 400)
  assert.equal(value.manager.tasks.get(id).meta.candidate, undefined)
  const local = await mkdtemp(path.join(os.tmpdir(), 'mote-external-'))
  const helper = await fetch(endpoint(value, `${base}/submit.mjs`)); assert.match(helper.headers.get('content-disposition'), /attachment/)
  await writeFile(path.join(local, 'submit.mjs'), await helper.text())
  await writeFile(path.join(local, 'result.json'), JSON.stringify(candidate)); await writeFile(path.join(local, 'figure.png'), pngHeader(200, 100))
  const standalone = await import(pathToFileURL(path.join(local, 'submit.mjs')).href)
  const receipt = await standalone.submitResult({ outputDir: local, agent: { url: endpoint(value, base), executorRevision: 0, candidateRevision: 0 } })
  assert.equal(receipt.candidateRevision, 1)
  const saved = await (await get(value, id)).json()
  assert.equal(saved.candidate.object.html, object.html); assert.equal(saved.candidate.screenshotPath, undefined)
  assert.equal(saved.candidate.notes, undefined)
  assert.equal(saved.candidate.object.screenshot, payload.assets['figure.png'])
  assert.deepEqual(await agentRequest(endpoint(value, `${base}/document.json`)), doc)
})

test('switch roundtrip retains candidates, rotates grants, and rejects late builtin delivery on narrow socket', async t => {
  const value = await app(); t.after(() => value.close())
  let context, finish, lateError
  const gate = new Promise(resolve => { finish = resolve })
  t.after(() => finish())
  value.manager.runner = async current => {
    context = current
    await gate
    try { await agentRequest(`${current.agent.url}/submit`, { socketPath: current.agent.socketPath, body: delivery(document()) }) } catch (error) { lateError = error }
    return { sessionId: 'late-builtin-session' }
  }
  const id = crypto.randomUUID(); await post(value, request(id)); await until(() => context)
  let task = await (await get(value, id)).json()
  assert.equal(task.executor, 'builtin'); assert.equal(task.externalPath, undefined)
  const internalPath = new URL(context.agent.url).pathname
  assert.equal((await fetch(endpoint(value, internalPath))).status, 404)
  const manifest = await agentRequest(`${context.agent.url}/manifest.json`, { socketPath: context.agent.socketPath })
  assert.equal(manifest.taskId, id)
  for (const suffix of ['/api/documents', `/api/ai/tasks/${id}`, '/api/shared/anything']) await assert.rejects(agentRequest(`http://moted.local${suffix}`, { socketPath: context.agent.socketPath }), { status: 404 })
  task = await (await switchMode(value, task, 'external')).json(); assert.equal(task.executorRevision, 1)
  const oldExternal = task.externalPath
  await assert.rejects(agentRequest(`${context.agent.url}/document.json`, { socketPath: context.agent.socketPath }), { status: 404 })
  assert.equal((await post(value, delivery(document(), { executorRevision: 1 }), `${oldExternal}/submit`, '')).status, 200)
  task = await (await get(value, id)).json(); const candidate = task.candidate
  task = await (await switchMode(value, task, 'builtin')).json()
  assert.equal(task.externalPath, undefined); assert.equal(task.executorRevision, 2); assert.deepEqual(task.candidate, candidate)
  await assert.rejects(agentRequest(`${context.agent.url}/document.json`, { socketPath: context.agent.socketPath }), { status: 404 })
  assert.equal((await fetch(endpoint(value, `${oldExternal}/document.json`))).status, 404)
  assert.equal((await post(value, { prompt: 'stale', executorRevision: 0 }, `/api/ai/tasks/${id}/revise`)).status, 409)
  assert.equal((await post(value, { prompt: 'missing revision' }, `/api/ai/tasks/${id}/revise`)).status, 400)
  task = await (await switchMode(value, task, 'external')).json()
  assert.equal(task.executorRevision, 3); assert.notEqual(task.externalPath, oldExternal); assert.deepEqual(task.candidate, candidate)
  assert.equal((await fetch(endpoint(value, `${oldExternal}/document.json`))).status, 404)
  assert.equal((await post(value, { prompt: 'wrong mode', executorRevision: 3 }, `/api/ai/tasks/${id}/revise`)).status, 409)
  finish(); await until(() => lateError && value.manager.active === 0)
  assert.equal(lateError.status, 404)
  task = await (await get(value, id)).json()
  assert.equal(task.status, 'waiting'); assert.equal(task.candidateRevision, 1); assert.deepEqual(task.candidate, candidate)
  assert.equal(value.manager.tasks.get(id).meta.sessionId, undefined)
  task = await (await switchMode(value, task, 'builtin')).json()
  assert.equal(value.manager.active, 0); assert.equal(task.status, 'ready')
  value.manager.runner = fakeRunner
  assert.equal((await post(value, { prompt: 'Explicit builtin continuation', executorRevision: 4 }, `/api/ai/tasks/${id}/revise`)).status, 202)
  await waitReady(value, id)
  assert.equal(value.manager.tasks.get(id).meta.candidateRevision, 2)
})

test('builtin file output alone is not delivery; supervisor never picks up result.json', async t => {
  const value = await app(); t.after(() => value.close())
  value.manager.runner = async context => { await writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify({ content: document().content.content, summary: 'Unsubmitted file' })) }
  const id = crypto.randomUUID(); await post(value, request(id))
  await until(() => value.manager.tasks.get(id).meta.status === 'error')
  const task = await (await get(value, id)).json()
  assert.match(task.error, /without submitting/); assert.equal(task.candidate, undefined); assert.equal(task.candidateRevision, 0)
})

test('executor roundtrip and revise issue no future grant until abort-ignoring runner and cleanup both finish', async t => {
  const value = await app({ maxConcurrent: 2 })
  let finishRun, finishCleanup, firstContext, calls = 0, prepared = 0, discovered = 0, cleaned = false
  const runGate = new Promise(resolve => { finishRun = resolve }), cleanupGate = new Promise(resolve => { finishCleanup = resolve })
  t.after(async () => { finishRun(); finishCleanup(); await value.close() })
  const prepare = value.manager.prepareScope.bind(value.manager), discover = value.manager.discoverSession.bind(value.manager)
  value.manager.prepareScope = async dir => { prepared++; return prepare(dir) }
  value.manager.discoverSession = async task => { discovered++; return discover(task) }
  value.manager.runner = async context => {
    calls++
    if (calls > 1) {
      assert.equal(cleaned, true); assert.equal(context.sessionId, 'after-cleanup')
      return fakeRunner(context)
    }
    firstContext = context
    context.stop = async () => { await cleanupGate; cleaned = true }
    await runGate
    await writeFile(path.join(context.taskDir, '.mu', 'sessions', 'after-cleanup.jsonl'), 'completed journal')
    await symlink('sessions/after-cleanup.jsonl', path.join(context.taskDir, '.mu', 'current-session'))
    return { sessionId: 'after-cleanup' }
  }
  const id = crypto.randomUUID(); await post(value, request(id)); await until(() => firstContext)
  let task = await (await get(value, id)).json()
  task = await (await switchMode(value, task, 'external')).json()
  task = await (await switchMode(value, task, 'builtin')).json()
  assert.equal((await post(value, { prompt: 'Queued continuation', executorRevision: task.executorRevision }, `/api/ai/tasks/${id}/revise`)).status, 202)
  const record = value.manager.tasks.get(id)
  const assertGated = async () => {
    assert.equal(calls, 1); assert.equal(prepared, 1); assert.equal(discovered, 1)
    assert.equal(record.meta.status, 'queued'); assert.equal(record.meta.builtinToken, undefined)
    assert.equal(record.executions.size, 1)
    assert.deepEqual(await readdir(path.join(record.dir, 'runs')), ['0'])
    await assert.rejects(readFile(path.join(record.dir, `a${record.generation}.sock`)), { code: 'ENOENT' })
  }
  await assertGated()
  const oldExecution = record.current
  finishRun(); await until(() => oldExecution.finished)
  await assertGated()
  finishCleanup(); await waitReady(value, id)
  assert.equal(calls, 2); assert.equal(prepared, 2); assert.equal(discovered, 2)
  assert.equal(record.meta.candidateRevision, 1); assert.equal(record.meta.sessionId, 'after-cleanup')
})

test('switch and submission operations are idempotent, CAS serialized, durable, and independently revocable', async t => {
  const value = await app(); t.after(() => value.close())
  const body = externalRequest(crypto.randomUUID()), id = body.id
  const creations = await Promise.all([post(value, body), post(value, body)])
  assert.deepEqual(creations.map(response => response.status), [202, 202]); assert.equal(value.manager.tasks.size, 1)
  let task = await (await get(value, id)).json(), base = task.externalPath
  const first = delivery(body.document)
  const persist = value.manager.persist.bind(value.manager)
  value.manager.persist = async () => { throw new Error('simulated failed metadata commit') }
  assert.equal((await post(value, first, `${base}/submit`, '')).status, 500)
  assert.equal((await (await get(value, id)).json()).candidateRevision, 0)
  value.manager.persist = persist
  const duplicate = await Promise.all([post(value, first, `${base}/submit`, ''), post(value, first, `${base}/submit`, '')])
  assert.deepEqual(duplicate.map(response => response.status), [200, 200])
  const receipt = await duplicate[0].json(); assert.deepEqual(await duplicate[1].json(), receipt)
  const competitors = await Promise.all([post(value, delivery(body.document, { candidateRevision: 1 }), `${base}/submit`, ''), post(value, delivery(body.document, { candidateRevision: 1 }), `${base}/submit`, '')])
  assert.deepEqual(competitors.map(response => response.status).sort(), [200, 409])
  assert.deepEqual(await (await post(value, first, `${base}/submit`, '')).json(), receipt)
  assert.equal((await post(value, { ...first, candidate: { ...first.candidate, summary: 'different' } }, `${base}/submit`, '')).status, 409)
  const change = { executor: 'builtin', baseExecutorRevision: 0, operationId: crypto.randomUUID() }
  value.manager.persist = async () => { throw new Error('simulated failed switch commit') }
  assert.equal((await post(value, change, `/api/ai/tasks/${id}/executor`)).status, 500)
  assert.equal((await (await get(value, id)).json()).executorRevision, 0)
  value.manager.persist = persist
  const changes = await Promise.all([post(value, change, `/api/ai/tasks/${id}/executor`), post(value, { ...change, operationId: crypto.randomUUID() }, `/api/ai/tasks/${id}/executor`)])
  assert.deepEqual(changes.map(response => response.status).sort(), [200, 409])
  // Whichever operation won can be retried without another switch.
  const winning = changes[0].status === 200 ? change : undefined
  if (winning) assert.equal((await post(value, winning, `/api/ai/tasks/${id}/executor`)).status, 200)
  task = await (await get(value, id)).json(); assert.equal(task.executorRevision, 1); assert.equal(task.candidateRevision, 2)
  const externalSwitch = { executor: 'external', baseExecutorRevision: 1, operationId: crypto.randomUUID() }
  task = await (await post(value, externalSwitch, `/api/ai/tasks/${id}/executor`)).json(); base = task.externalPath
  assert.equal((await post(value, { ...externalSwitch, executor: 'builtin' }, `/api/ai/tasks/${id}/executor`)).status, 409)
  const savedGuide = await (await fetch(endpoint(value, `${base}/guide.md`))).text()
  const finalSubmission = delivery(body.document, { executorRevision: 2, candidateRevision: 2 })
  const finalReceipt = await (await post(value, finalSubmission, `${base}/submit`, '')).json()
  await value.close()
  const restarted = await app({ stateDir: value.stateDir }); t.after(() => restarted.close())
  assert.equal((await (await get(restarted, id)).json()).externalPath, base)
  assert.deepEqual(await (await post(restarted, finalSubmission, `${base}/submit`, '')).json(), finalReceipt)
  assert.equal((await (await post(restarted, externalSwitch, `/api/ai/tasks/${id}/executor`)).json()).externalPath, base)
  assert.equal((await post(restarted, body)).status, 202)
  assert.equal(await (await fetch(endpoint(restarted, `${base}/guide.md`))).text(), savedGuide)
  const released = await (await post(restarted, {}, `/api/ai/tasks/${id}/release`)).json()
  assert.equal(released.released, true); assert.equal(released.externalPath, undefined); assert.equal(released.candidateRevision, 3)
  assert.equal((await post(restarted, {}, `/api/ai/tasks/${id}/release`)).status, 200)
  for (const suffix of ['', '/guide.md', '/document.json', '/candidate.json', '/manifest.json']) assert.equal((await fetch(endpoint(restarted, base + suffix))).status, 404)
  assert.equal((await post(restarted, finalSubmission, `${base}/submit`, '')).status, 404)
  assert.equal((await switchMode(restarted, released, 'builtin')).status, 410)
  await readFile(path.join(restarted.manager.tasks.get(id).dir, 'input', 'document.json'))
  assert.equal((await fetch(endpoint(restarted, `/api/ai/tasks/${id}`), { method: 'DELETE', headers: { origin: 'http://localhost:5173' } })).status, 200)
  assert.equal((await get(restarted, id)).status, 404)
  assert.equal((await fetch(endpoint(restarted, base))).status, 404)
})
