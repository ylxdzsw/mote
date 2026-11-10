import { boxColorIds } from '../shared/palette.mjs'
import { normalizeLinkHref, validLinkHref } from '../shared/links.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMotedServer, TaskManager } from './moted.mjs'
import { fakeRunner, stopWorkerUnit } from './runner.mjs'
import { agentRequest, submitResult } from './submit.mjs'
import { pathToFileURL } from 'node:url'
import { validateProposalCandidate, validateDocument } from './validation.mjs'
import { validateReservations } from './reservation-validation.mjs'
const checkedReservation = ({ id, document, target }) => validateReservations([{ id, documentId: document.id, target, original: document.content.content, workspaceRead: false }], document)[0]
import { WidgetScreenshots, widgetInput, publicIPv4, publicAddress, resourceHost, resourceBroker } from './widget-screenshot.mjs'
import { widgetHarness } from './widget-harness.mjs'
import { runInNewContext } from 'node:vm'
import { inflateSync } from 'node:zlib'
import net from 'node:net'
import http from 'node:http'
import { Resolver } from 'node:dns/promises'
import { PassThrough } from 'node:stream'

const png = 'data:image/png;base64,iVBORw0KGgo='
const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}`
const theme = {
  appearance: { mode: 'light', primaryHue: 145, secondaryHue: 260 }, autospace: true,
  defaults: { family: 'sans', size: 16, color: 'gray1', weight: 400, lineHeight: { value: 1.5, unit: 'ratio' }, spaceBefore: { value: 0, unit: 'em' }, spaceAfter: { value: 1, unit: 'em' }, letterSpacing: { value: 0, unit: 'em' } },
  paragraphs: {}, objects: {}, flow: {},
}
function document(kind = 'text') {
  const doc = { format: 'mote', version: 5, language: 'en', id: crypto.randomUUID(), page: { width: 800, margins: { top: 48, right: 48, bottom: 48, left: 48 } }, theme, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text: 'Hello' }] }] }, objects: [] }
  if (kind === 'text') doc.objects.push({ id: 'object-1', kind: 'text', layout: { width: 200, placement: { type: 'float', anchorId: 'block-1', x: 40, y: 10 } }, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'float-1', semantic: 'body' }, content: [] }] } })
  if (kind === 'html') doc.objects.push({ id: 'object-1', kind: 'html', layout: { width: 200, height: 100, placement: { type: 'float', anchorId: 'block-1', x: 40, y: 10 } }, html: '<button>+</button>', screenshot: svg, alt: 'demo' })
  return doc
}
function request(id, doc = document(), extra = {}) { return { id, protocol: 'mote-agent-v5', operationId: crypto.randomUUID(), document: doc, model: 'fake', prompt: 'Improve the target', target: { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: true, area: { x: 48, y: 48, width: 200, height: 40 } }, ...extra } }
function segmentDocument() {
  const doc = document('text')
  doc.content.content = [
    { type: 'paragraph', attrs: { id: 'seg-p0', semantic: 'body' }, content: [{ type: 'text', text: 'First' }] },
    { type: 'spacer', attrs: { id: 'seg-space', height: 80 } },
    { type: 'paragraph', attrs: { id: 'seg-p2', semantic: 'body' }, content: [{ type: 'text', text: 'Last' }] },
  ]
  doc.objects = [
    { id: 'seg-image', kind: 'image', layout: { width: 160, placement: { type: 'float', anchorId: 'seg-space', x: 40, y: 24 } }, src: svg, alt: 'Source figure', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'seg-image-caption' }, content: [{ type: 'text', text: 'Figure caption' }] }] } } },
    { id: 'seg-widget', kind: 'html', layout: { width: 120, height: 80, placement: { type: 'float', anchorId: 'seg-p2', x: 40, y: 12 } }, html: '<p>source</p>', screenshot: svg, alt: 'Source widget' },
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
  const image = { id: 'candidate-image', kind: 'image', layout: { width: 160, placement: { type: 'float', anchorId: 'candidate-p', x: 32, y: 12 } }, src: svg, alt: 'Generated figure', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'candidate-image-caption' }, content: [{ type: 'text', text: 'Generated figure' }] }] } } }
  const objects = [image]
  const geometry = { 'candidate-image': { x: 32, y: 12, width: 160, height: 60 } }
  if (withWidgets) for (const id of ['candidate-widget-a', 'candidate-widget-b']) {
    objects.push({ id, kind: 'html', layout: { width: 120, height: 80, placement: { type: 'float', anchorId: 'candidate-p', x: id.endsWith('a') ? 240 : 380, y: 12 } }, html: `<button>${id}</button>`, alt: id, ...(id.endsWith('a') ? { caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: `${id}-caption` }, content: [{ type: 'text', text: 'Widget caption' }] }] } } } : {}) })
    geometry[id] = { x: id.endsWith('a') ? 240 : 380, y: 12, width: 120, height: 80 }
  }
  return { version: 1, type: 'segment', content, objects, geometry, anchorTops: { 'candidate-p': 0, 'candidate-space': 28 }, originTop: 0 }
}
function pngHeader(width, height) { const header = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header); header.write('IHDR', 12); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20); return header }
async function app(options = {}) {
  const stateDir = options.stateDir || await mkdtemp(path.join(os.tmpdir(), 'moted-test-'))
  const value = await createMotedServer({ ...options, stateDir, port: 0, useSystemd: false, env: { MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: 'http://localhost:5173', MOTED_SHARED_MU_DIR: path.join(stateDir, 'unused-config'), MOTED_MU_ENV_SOURCE: '', ...(options.env || {}) } })
  if (options.runner) value.manager.runner = async context => {
    const result = await options.runner(context)
    try { await readFile(path.join(context.outputDir, 'result.json')) } catch (error) { if (error.code === 'ENOENT') return result; throw error }
    if (value.manager.tasks.get(context.taskId)?.meta.versions.length === context.agent.versionCount) await submitResult(context)
    return result
  }
  await value.start(); value.stateDir = stateDir; return value
}
async function post(app, body, pathName = '/api/ai/tasks', origin = 'http://localhost:5173') {
  if (pathName === '/api/ai/tasks' && origin === 'http://localhost:5173') {
    const reservation = { id: body.id, documentId: body.document.id, target: body.target, original: body.document.content.content, workspaceRead: false }
    app.store.create({ id: body.document.id, name: 'Task fixture', document: body.document, reservations: [reservation], operationId: crypto.randomUUID() })
    await app.manager.ensure(body.id)
    pathName = `/api/ai/tasks/${body.id}/revise`
    body = { prompt: body.prompt, model: body.model, operationId: body.operationId }
  }
  if (pathName.endsWith('/revise')) { const { executorRevision, ...current } = body; body = { operationId: crypto.randomUUID(), ...current } }
  const address = app.server.address()
  return fetch(`http://127.0.0.1:${address.port}${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
}
async function get(app, id) { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}`) }
async function events(app, id, suffix = '', headers = {}) { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}/events${suffix}`, { headers }) }
async function waitReady(value, id) {
  for (let i = 0; i < 60; i++) { if (value.manager.tasks.get(id)?.meta.status === 'ready' && !value.manager.tasks.get(id)?.current) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`task did not become ready: ${value.manager.tasks.get(id)?.meta.error}`)
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

test('unexpected HTTP failures return correlated IDs and log only sanitized diagnostics', async t => {
  const value = await app(); t.after(async () => { await value.close(); await rm(value.stateDir, { recursive: true, force: true }) })
  const address = value.server.address(), originalError = console.error
  const originalSettings = value.store.settings, originalGet = value.store.get, originalAuthorize = value.store.credentialByToken
  const lines = []
  console.error = line => lines.push(String(line))
  try {
    value.store.settings = () => { throw Object.assign(new TypeError(`PRIVATE DOCUMENT CONTENT\nsecret credential\n    at ${new URL('./forged-secret.mjs', import.meta.url).pathname}:1:1`), { code: 'EIO' }) }
    const mainResponse = await fetch(`http://127.0.0.1:${address.port}/api/settings?token=query-secret`)
    const mainBody = await mainResponse.json()
    assert.equal(mainResponse.status, 500)
    assert.equal(mainBody.error, 'internal server error')
    assert.match(mainBody.requestId, /^[0-9a-f-]{36}$/)
    assert.equal(mainResponse.headers.get('x-request-id'), mainBody.requestId)
    const mainLog = JSON.parse(lines[0])
    assert.deepEqual(Object.keys(mainLog).sort(), ['errorCode', 'errorType', 'event', 'frames', 'level', 'method', 'requestId', 'route', 'status'])
    assert.equal(mainLog.level, 'error')
    assert.equal(mainLog.event, 'http.unexpected_error')
    assert.equal(mainLog.requestId, mainBody.requestId)
    assert.equal(mainLog.method, 'GET')
    assert.equal(mainLog.route, '/api/settings')
    assert.equal(mainLog.status, 500)
    assert.equal(mainLog.errorType, 'TypeError')
    assert.equal(mainLog.errorCode, 'EIO')
    assert.ok(mainLog.frames.some(frame => /^moted\.mjs:\d+:\d+$/.test(frame)))
    assert.doesNotMatch(lines[0], /PRIVATE DOCUMENT CONTENT|secret credential|query-secret|forged-secret/)

    value.store.get = () => { throw new Error('PRIVATE DOCUMENT CONTENT and database path') }
    const documentId = crypto.randomUUID()
    const documentResponse = await fetch(`http://127.0.0.1:${address.port}/api/documents/${documentId}?token=query-secret`)
    const documentBody = await documentResponse.json()
    assert.equal(documentResponse.status, 500)
    assert.equal(documentBody.error, 'internal server error')
    assert.equal(documentResponse.headers.get('x-request-id'), documentBody.requestId)
    const documentLog = JSON.parse(lines[1])
    assert.equal(documentLog.requestId, documentBody.requestId)
    assert.equal(documentLog.route, '/api/documents/:id')
    assert.doesNotMatch(lines[1], new RegExp(`${documentId}|PRIVATE DOCUMENT CONTENT|database path|query-secret`))

    const notFound = await fetch(`http://127.0.0.1:${address.port}/not-found?token=query-secret`)
    assert.equal(notFound.status, 404)
    assert.equal(lines.length, 2)

    value.store.credentialByToken = () => { throw Object.assign(new Error('PRIVATE AGENT INPUT and bearer secret'), { code: 'ERR_INTERNAL' }) }
    const token = 'A'.repeat(22)
    const agentResponse = await fetch(`http://127.0.0.1:${address.port}/a/${token}/document.json?query-secret`)
    const agentBody = await agentResponse.json()
    assert.equal(agentResponse.status, 500)
    assert.deepEqual(Object.keys(agentBody).sort(), ['error', 'requestId'])
    assert.equal(agentBody.error, 'internal server error')
    assert.equal(agentResponse.headers.get('x-request-id'), agentBody.requestId)
    const agentLog = JSON.parse(lines[2])
    assert.equal(agentLog.requestId, agentBody.requestId)
    assert.equal(agentLog.method, 'GET')
    assert.equal(agentLog.route, '/a/:token/:resource')
    assert.equal(agentLog.errorCode, 'ERR_INTERNAL')
    assert.doesNotMatch(lines[2], /PRIVATE AGENT INPUT|bearer secret|query-secret|A{22}|document\.json/)
  } finally {
    console.error = originalError
    value.store.settings = originalSettings
    value.store.get = originalGet
    value.store.credentialByToken = originalAuthorize
  }
})


test('theme requires mode and two finite hues and rejects legacy palette fields', () => {
  for (const mode of [undefined, null, 'auto', 'LIGHT']) {
    const doc = structuredClone(document()); doc.theme.appearance.mode = mode
    assert.throws(() => validateDocument(doc), /theme.appearance.mode/)
  }
  for (const key of ['primaryHue', 'secondaryHue']) {
    for (const value of [undefined, null, -1, 360, NaN, Infinity, '145']) {
      const doc = structuredClone(document()); doc.theme.appearance[key] = value
      assert.throws(() => validateDocument(doc), new RegExp(`theme.appearance.${key}`))
    }
    for (const value of [0, 359.99]) {
      const doc = structuredClone(document()); doc.theme.appearance[key] = value
      assert.doesNotThrow(() => validateDocument(doc))
    }
  }
  for (const value of [[], null, undefined]) {
    const doc = structuredClone(document()); doc.theme.palette = value
    assert.throws(() => validateDocument(doc), { status: 400 })
    assert.doesNotThrow(() => validateProposalCandidate({ content: doc.content.content, summary: 'Independent' }))
    const segment = segmentPayload(); segment.palette = value
    assert.throws(() => validateProposalCandidate({ segment, summary: 'Legacy' }), /unsupported field/)
  }
  for (const background of ['gray6', 'paper', null, undefined]) {
    const doc = structuredClone(document()); doc.theme.defaults.background = background
    assert.throws(() => validateDocument(doc), { status: 400 })
  }
})

test('stateless object proposals accept supported kinds and reject removed kinds', () => {
  const doc = document('html'), original = doc.objects[0]
  const { id, layout: { width, placement } } = original
  const { x, y } = placement
  const base = { id, layout: { width, placement } }
  const target = { kind: 'object', objectId: id, isNew: true, area: { x, y, width, height: 100 } }
  const paragraph = { type: 'paragraph', attrs: { id: 'native-text', semantic: 'body' }, content: [{ type: 'text', text: 'Native text' }] }
  const objects = [
    { ...base, kind: 'drawing', layout: { ...base.layout, height: 100 }, background: null, strokes: [{ points: [[5, 8]], color: 'gray1', width: 2.5 }], labels: [] },
    { ...base, kind: 'code', source: 'const answer = 42\n', language: 'javascript' },
    { ...base, kind: 'formula', latex: String.raw`\int_0^1 x^2\,dx = \frac{1}{3}` },
    { ...base, kind: 'text', content: { type: 'doc', content: [paragraph] } },
    { ...base, kind: 'table', content: { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ ...paragraph, attrs: { id: 'native-cell' } }] }] }] }] } },
    { ...base, kind: 'image', src: png, alt: 'Image' }, original,
  ]
  for (const object of objects) {
    assert.equal(validateProposalCandidate({ object, summary: 'Candidate' }).object.kind, object.kind)
  }
  for (const kind of ['rectangle', 'ellipse', 'line']) {
    const object = { ...base, kind }
    assert.throws(() => validateDocument({ ...doc, objects: [object] }), { status: 400 })
    assert.throws(() => validateProposalCandidate({ object, summary: 'Candidate' }), { status: 400 })
  }
})


test('segment targets use canonical points and exact block/object ownership', () => {
  const doc = segmentDocument()
  const accepted = checkedReservation(request(crypto.randomUUID(), doc, { target: segmentTarget() })).target
  assert.equal(accepted.kind, 'segment')
  assert.deepEqual(accepted.blockIds, ['seg-p0', 'seg-space'])
  assert.deepEqual(accepted.objectIds, ['seg-image'])
  assert.throws(() => checkedReservation(request(crypto.randomUUID(), doc, { target: segmentTarget({ objectIds: [] }) })), /objectIds does not match/)
  assert.throws(() => checkedReservation(request(crypto.randomUUID(), doc, { target: segmentTarget({ blockIds: ['seg-p0'] }) })), /blockIds does not match/)
  const partial = segmentTarget({ range: { start: { index: 1, offset: 20 }, end: { index: 1, offset: 60 } }, blockIds: ['seg-space'], objectIds: ['seg-image'] })
  assert.equal(checkedReservation(request(crypto.randomUUID(), doc, { target: partial })).target.range.start.offset, 20)
  const empty = segmentTarget({ range: { start: { index: 2, offset: 0 }, end: { index: 2, offset: 0 } }, blockIds: [], objectIds: [] })
  assert.equal(checkedReservation(request(crypto.randomUUID(), doc, { target: empty })).target.kind, 'segment')
  assert.throws(() => checkedReservation(request(crypto.randomUUID(), doc, { target: { ...empty, objectIds: ['seg-widget'] } })), /objectIds does not match/)
})



test('fake segment task returns a deterministic native composition', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); assert.equal((await post(value, request(id, segmentDocument(), { target: segmentTarget() }))).status, 202)
  await waitReady(value, id)
  const status = await (await get(value, id)).json()
  assert.equal(status.status, 'ready')
  assert.equal(status.versions[0].candidate.summary, 'Fake candidate for segment target.')
  assert.deepEqual(status.versions[0].candidate.segment.content.map(node => node.type), ['paragraph', 'flow'])
  assert.deepEqual(status.versions[0].candidate.segment.objects.map(object => object.kind ?? 'text'), ['image'])
  assert.equal(status.versions[0].candidate.segment.objects[0].caption.content.content[0].content[0].text, 'AI figure')
  assert.equal(status.versions[0].candidate.segment.objects[0].layout.placement.type, 'flow')
  assert.equal(status.versions[0].candidate.segment.content[1].attrs.objectId, status.versions[0].candidate.segment.objects[0].id)
  assert.deepEqual(Object.keys(status.versions[0].candidate.segment.geometry).sort(), status.versions[0].candidate.segment.objects.map(object => object.id).sort())
})

test('Flow validation enforces structural pairs, scope ownership, and paragraph-only text tasks', () => {
  const doc = segmentDocument()
  const flow = { type: 'flow', attrs: { id: 'seg-flow', objectId: 'seg-image' } }
  doc.content.content[1] = flow
  doc.objects[0].layout.placement = { type: 'flow', x: 'center' }
  Object.assign(doc.objects[1].layout.placement, { anchorId: 'seg-flow', x: -8, y: -12 })
  assert.equal(validateDocument(doc), doc)
  const target = segmentTarget({ blockIds: ['seg-p0', 'seg-flow'], objectIds: ['seg-image', 'seg-widget'] })
  assert.equal(checkedReservation(request(crypto.randomUUID(), doc, { target })).target, target)
  assert.throws(() => checkedReservation(request(crypto.randomUUID(), doc, { target: { ...target, objectIds: ['seg-image'] } })), /selected segment scope/)
  for (const mutate of [
    value => { value.content.content.splice(1, 1) },
    value => { value.content.content.push({ ...flow, attrs: { ...flow.attrs, id: 'duplicate-flow' } }) },
    value => { value.content.content[1].attrs.objectId = 'outside' },
    value => { value.objects[0].layout.placement.type = 'float' },
    value => { value.objects[0].layout.placement.anchorId = 'seg-p0' },
    value => { value.objects[0].layout.placement.y = 1 },
    value => { value.objects[0].layout.placement.centered = 'yes' },
    value => { value.objects[1].layout.placement.anchorId = 'seg-p0' },
    value => { value.content.content[0].attrs.id = 'seg-image' },
    value => { value.objects[1].layout.placement.type = 'flow' },
    value => { value.objects[0].textFlow = 'repel' },
    value => { value.objects[0].caption.content.content[0].content.push(flow) },
  ]) {
    const invalid = structuredClone(doc); mutate(invalid)
    assert.throws(() => validateDocument(invalid))
  }
  const textTarget = { ...request(crypto.randomUUID()).target, blockIds: ['seg-flow'] }
  assert.throws(() => checkedReservation(request(crypto.randomUUID(), doc, { target: textTarget })), /target block/)
  assert.throws(() => checkedReservation(request(crypto.randomUUID(), doc, { target: { ...textTarget, blockIds: ['seg-p0', 'seg-p2'] } })), /consecutive paragraphs/)
  assert.throws(() => validateProposalCandidate({ content: [flow], summary: 'bad text' }), /paragraph/)
  const payload = segmentPayload()
  payload.content[1] = { type: 'flow', attrs: { id: 'candidate-space', objectId: 'candidate-image' } }
  payload.objects[0].layout.placement = { type: 'flow', x: 0 }
  assert.equal(validateProposalCandidate({ segment: payload, summary: 'Flow composition' }).segment, payload)
  payload.content.pop()
  assert.throws(() => validateProposalCandidate({ segment: payload, summary: 'orphaned Flow' }), { status: 400 })
})


test('a native KaTeX delivery reaches ready without HTML or screenshot artifacts', async t => {
  const doc = document('html'), original = doc.objects[0]
  const value = await app({ runner: async context => {
    const { id, layout: { width, placement } } = original
  const { x, y } = placement
    await writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify({ object: { id, layout: { width, placement }, kind: 'formula', latex: 'E = mc^2' }, summary: 'Native formula' }))
  } }); t.after(() => value.close())
  const id = crypto.randomUUID()
  assert.equal((await post(value, request(id, doc, { target: { kind: 'object', objectId: original.id, isNew: true, area: { x: 40, y: 10, width: 200, height: 100 } } }))).status, 202)
  let status
  for (let i = 0; i < 30; i++) { status = await (await get(value, id)).json(); if (!['queued', 'running'].includes(status.status)) break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(status.status, 'ready'); assert.equal(status.versions[0].candidate.object.kind, 'formula'); assert.equal(status.versions[0].candidate.object.latex, 'E = mc^2')
  assert.equal(status.versions[0].candidate.object.screenshot, undefined)
})

test('fake task reaches ready and status does not expose logs or document', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); const created = await post(value, request(id)); assert.equal(created.status, 202)
  const initial = await created.json(); assert.ok(['queued', 'running'].includes(initial.status)); assert.equal(initial.id, id); assert.equal('document' in initial, false)
  let status
  for (let i = 0; i < 20; i++) { status = await (await get(value, id)).json(); if (status.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(status.status, 'ready'); assert.equal(status.versions[0].candidate.summary, 'Fake candidate for text target.'); assert.equal(status.versions[0].candidate.content[0].content[0].text, 'AI draft: Hello'); assert.equal('logs' in status, false); assert.equal('prompt' in status, false)
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



test('queued requests remain in the transcript when stopped before a worker starts', async t => {
  const value = await app({ maxConcurrent: 1, env: { MOTED_FAKE_DELAY_MS: '200' } }); t.after(() => value.close())
  await post(value, request(crypto.randomUUID()))
  const id = crypto.randomUUID(); await post(value, request(id))
  assert.equal(value.manager.tasks.get(id).meta.status, 'queued')
  await post(value, {}, `/api/ai/tasks/${id}/stop`)
  const replay = await takeEvents(await events(value, id), 1)
  assert.equal(replay[0].kind, 'request'); assert.equal(replay[0].text, 'Improve the target')
})



test('HTML screenshotPath is bounded, embedded, and candidate HTML is not executed', async t => {
  const customRunner = async context => {
    const header = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(header); header.write('IHDR', 12); header.writeUInt32BE(200, 16); header.writeUInt32BE(100, 20)
    await writeFile(path.join(context.outputDir, 'screenshot.png'), header)
    const object = { ...context.targetObject }; delete object.screenshot
    await writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify({ object: { ...object, id: context.target.objectId }, summary: 'html', screenshotPath: 'screenshot.png' }))
  }
  const doc = document('html'); const value = await app({ runner: async context => { context.targetObject = doc.objects[0]; return customRunner(context) } }); t.after(() => value.close())
  const id = crypto.randomUUID(); const body = request(id, doc, { target: { kind: 'object', objectId: 'object-1', isNew: false, area: { x: 40, y: 10, width: 200, height: 100 } } }); assert.equal((await post(value, body)).status, 202)
  let status; for (let i = 0; i < 20; i++) { status = await (await get(value, id)).json(); if (status.status !== 'running' && status.status !== 'queued') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(status.status, 'ready'); assert.match(status.versions[0].candidate.object.screenshot, /^data:image\/png;base64,/); assert.equal(status.versions[0].candidate.screenshotPath, undefined)
 })

test('timeout marks the task error and ignores a late runner result', async t => {
  const value = await app({ timeoutMs: 25, runner: async () => { await new Promise(resolve => setTimeout(resolve, 200)); return { sessionId: 'late-session' } } }); t.after(() => value.close())
  const id = crypto.randomUUID(); await post(value, request(id))
  await new Promise(resolve => setTimeout(resolve, 160))
  const status = await (await get(value, id)).json()
  assert.equal(status.status, 'error'); assert.equal(status.error, 'Worker timed out.'); assert.deepEqual(status.versions, []); assert.equal(value.manager.tasks.get(id).meta.unit, undefined)
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
  value.store.putSettings({ baseRevision: 2, models: { builtin: '', indexing: '' } })
  assert.equal((await post(value, request(crypto.randomUUID(), document(), { model: undefined }))).status, 400)
  assert.equal((await post(value, { prompt: 'Continue without a workspace default', executorRevision: 0 }, `/api/ai/tasks/${id}/revise`)).status, 202)
  await waitReady(value, id)
  assert.equal(value.manager.tasks.get(id).meta.model, 'workspace/first')
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
  assert.equal((await fetch(endpoint(value, `/api/ai/tasks/${id}`), { method: 'DELETE', headers: { origin: 'http://localhost:5173' } })).status, 404)
  await readFile(path.join(task.dir, 'meta.json'))
  assert.equal(runs, 1)
})

test('unavailable systemd cleanup probes have finite attempts with backoff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-cleanup-test-'))
  const bin = path.join(root, 'systemctl'), log = path.join(root, 'calls')
  await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n'); process.exit(1)\n`, { mode: 0o700 })
  await assert.rejects(stopWorkerUnit(`moted-${crypto.randomUUID()}-0`, { MOTED_SYSTEMCTL: bin }), /cleanup could not be confirmed/)
  const calls = (await readFile(log, 'utf8')).trim().split('\n')
  assert.deepEqual(calls.slice(0, 3), ['kill', 'kill', 'stop'])
  assert.equal(calls.filter(call => call === 'show').length, 6)
})

const endpoint = (value, suffix) => `http://127.0.0.1:${value.server.address().port}${suffix}`
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('condition did not become true')
}



test('unsupported task startup cleans recorded workers without rewriting retained artifacts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-old-worker-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'systemctl'), log = path.join(root, 'calls')
  await writeFile(bin, String.raw`#!${process.execPath}
const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\n')
if (args[0] === 'show') {
  if (args.at(-1).endsWith('-1')) process.exit(1)
  console.log('LoadState=not-found\nActiveState=inactive')
}
`, { mode: 0o700 })
  const fixtures = []
  for (const [generation, field] of ['workerUnit', 'unit'].entries()) {
    const id = crypto.randomUUID(), directory = path.join(root, 'tasks', id)
    await mkdir(path.join(directory, 'input'), { recursive: true })
    const unit = `moted-${id}-${generation}`
    const meta = JSON.stringify({ id, status: 'running', executor: 'builtin', [field]: unit, candidate: { summary: 'Retained V0 candidate' } })
    const snapshot = JSON.stringify({ version: 'V0', id: 'old-document', floating: [] })
    await writeFile(path.join(directory, 'meta.json'), meta)
    await writeFile(path.join(directory, 'input', 'document.json'), snapshot)
    fixtures.push({ id, directory, unit, meta, snapshot, generation })
  }
  let runs = 0
  const manager = new TaskManager({ stateDir: root, useSystemd: true, timeoutMs: 10000,
    env: { MOTED_FAKE_RUNNER: '1', MOTED_SYSTEMCTL: bin }, runner: async () => { runs++ } })
  t.after(() => manager.shutdown())
  await manager.init()
  for (const fixture of fixtures) assert.equal(manager.tasks.get(fixture.id).executions.size, 1)
  await manager.shutdown()
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const fixture of fixtures) {
    const task = manager.tasks.get(fixture.id)
    const commands = calls.filter(args => args.at(-1) === fixture.unit).map(args => args[0])
    assert.deepEqual(commands.slice(0, 3), ['kill', 'kill', 'stop'])
    assert.equal(commands.filter(command => command === 'show').length, fixture.generation ? 6 : 1)
    assert.equal(task.executions.size, fixture.generation ? 1 : 0)
    if (fixture.generation) assert.equal([...task.executions][0].cleanupFailed, true)
    assert.equal(await readFile(path.join(fixture.directory, 'meta.json'), 'utf8'), fixture.meta)
    assert.equal(await readFile(path.join(fixture.directory, 'input', 'document.json'), 'utf8'), fixture.snapshot)
    assert.deepEqual(task.meta, JSON.parse(fixture.meta))
  }
  assert.equal(runs, 0)
  assert.equal(manager.queue.length, 0)
})


test('builtin file output alone is not delivery; supervisor never picks up result.json', async t => {
  const value = await app(); t.after(() => value.close())
  value.manager.runner = async context => { await writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify({ content: document().content.content, summary: 'Unsubmitted file' })) }
  const id = crypto.randomUUID(); await post(value, request(id))
  await until(() => value.manager.tasks.get(id).meta.status === 'error')
  const task = await (await get(value, id)).json()
  assert.match(task.error, /without submitting/); assert.deepEqual(task.versions, [])
})



function screenshotBytes(result) { return Buffer.from(result.screenshot.split(',')[1], 'base64') }
function firstPixel(png) {
  const chunks = []
  for (let at = 8; at < png.length;) { const size = png.readUInt32BE(at); if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + size)); at += size + 12 }
  // At the first pixel, all PNG predictors have zero neighbors.
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)]
}

test('widget harness preserves literal source, script boundaries and native dimensions', async () => {
  const html = `<p>$& $' $\` __MOTE_CANDIDATE_HTML__ frame.srcdoc = Number(params.get('width') || 690)</p><script>window.literal = '</script><script>literal'</script>`
  const template = await readFile(new URL('./preview-harness.html', import.meta.url), 'utf8')
  const harness = widgetHarness(template, { html, width: 321, height: 123 })
  assert.equal(harness.split('</script>').length, 2)
  const frame = {}
  runInNewContext(harness.match(/<script>([\s\S]*)<\/script>/)[1], { document: { querySelector: () => frame }, URLSearchParams, location: { search: '' } })
  assert.equal(frame.width, 321); assert.equal(frame.height, 123)
  assert.equal(frame.srcdoc.slice(frame.srcdoc.indexOf('</head>') + 7), html)
})

test('widget dimensions, bytes and public destination policy are bounded', async () => {
  assert.deepEqual(widgetInput({ html: '', width: 100.4, height: 20.6 }), { html: '', width: 100, height: 21 })
  for (const width of [0, -1, NaN, Infinity, '100', 2049]) assert.throws(() => widgetInput({ html: '', width, height: 100 }))
  assert.throws(() => widgetInput({ html: '', width: 2048, height: 2048 }), { status: 413 })
  assert.throws(() => widgetInput({ html: 'é'.repeat(524289), width: 100, height: 100 }), { status: 413 })
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', '2001:4860:4860::8888']) assert.equal(publicIPv4(address), false, address)
  assert.equal(publicIPv4('8.8.8.8'), true)
  for (const authority of ['example.org:80', 'example.org:444', 'user@example.org:443', '[::1]:443', 'example.org/path:443', 'example.org:443?x']) assert.throws(() => resourceHost(authority))
  for (const authority of ['2130706433:443', '0x7f000001:443', '127.1:443']) assert.equal(resourceHost(authority), '127.0.0.1')
  await assert.rejects(publicAddress('fixture.test', { resolve4: async () => ['8.8.8.8', '10.0.0.1'] }))
})

test('widget broker pins numeric destinations and rejects rebinding, redirects and own addresses', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mote-widget-broker-test-'))
  const socket = path.join(directory, 'broker.sock'), connect = net.connect.bind(net)
  const destinations = []; let answers = ['93.184.216.34']
  t.mock.method(Resolver.prototype, 'resolve4', async () => answers)
  t.mock.method(net, 'connect', options => {
    destinations.push(options)
    const stream = new PassThrough(); stream.setTimeout = () => stream
    process.nextTick(() => stream.emit('connect')); return stream
  })
  const close = await resourceBroker(socket, new AbortController().signal)
  t.after(async () => { await close(); await (await import('node:fs/promises')).rm(directory, { recursive: true, force: true }) })
  const tunnel = authority => new Promise((resolve, reject) => {
    let reply = ''
    const client = connect(socket)
    client.on('error', reject)
    client.on('connect', () => client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    client.on('data', chunk => { reply += chunk; client.destroy() })
    client.on('close', () => resolve(reply))
  })
  assert.match(await tunnel('fixture.test:443'), /200 Connection Established/)
  assert.deepEqual(destinations, [{ host: '93.184.216.34', port: 443, family: 4 }])
  answers = ['127.0.0.1']
  assert.equal(await tunnel('fixture.test:443'), '')
  for (const authority of ['127.0.0.1:443', '169.254.169.254:443', '[::1]:443', 'example.org:80']) assert.equal(await tunnel(authority), '')
  const own = Object.values(os.networkInterfaces()).flat().find(item => publicIPv4(item.address))?.address
  if (own) { answers = [own]; assert.equal(await tunnel('own.test:443'), '') }
  assert.equal(destinations.length, 1)
})

test('widget screenshot API is exact-Origin, bounded, deterministic fake PNG and no-store', async t => {
  const value = await app(); t.after(() => value.close())
  const route = '/api/widgets/screenshot', body = { html: '<script>throw new Error("not executed in fake mode")</script>', width: 100.4, height: 50.6 }
  for (const origin of ['', 'https://untrusted.example', 'http://localhost:5173.evil']) assert.equal((await post(value, body, route, origin)).status, 403)
  assert.equal((await fetch(endpoint(value, route), { headers: { origin: 'http://localhost:5173' } })).status, 404)
  const response = await post(value, body, route)
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  const result = await response.json(), png = screenshotBytes(result)
  assert.equal(png.readUInt32BE(16), 200); assert.equal(png.readUInt32BE(20), 102)
  assert.deepEqual(await (await post(value, body, route)).json(), result)
  assert.equal((await post(value, { ...body, width: -1 }, route)).status, 400)
  assert.equal((await post(value, { ...body, html: 'a'.repeat(1024 * 1024 + 1) }, route)).status, 413)
  assert.equal((await post(value, { ...body, extra: 'a'.repeat(2 * 1024 * 1024) }, route)).status, 413)
})

test('widget capture has no queue, cancels active work and keeps errors capture-specific', async () => {
  const service = new WidgetScreenshots({})
  service.run = async (_input, controller) => new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
  const input = async () => ({ html: '', width: 100, height: 100 })
  const first = service.capture(input), second = service.capture(input)
  const results = Promise.allSettled([first, second])
  await assert.rejects(service.capture(input), { status: 429 })
  await service.shutdown()
  for (const result of await results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.status, 422); assert.match(result.reason.message, /canceled/) }
  assert.equal(service.active.size, 0)
  await assert.rejects(service.capture(input), { status: 422 })
  const failing = new WidgetScreenshots({})
  failing.run = async () => { throw new Error('fixture failure') }
  await assert.rejects(failing.capture(input), { status: 422, message: 'Widget capture failed' })
})

test('widget deadline is a capture-specific error and an aborted completion cannot succeed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const service = new WidgetScreenshots({})
  service.run = async (_input, controller) => new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(Buffer.alloc(24)), { once: true }))
  const result = service.capture(async () => ({ html: '', width: 100, height: 100 }))
  const rejected = assert.rejects(result, { status: 422, message: 'Widget capture timed out' })
  await Promise.resolve()
  t.mock.timers.tick(25000)
  await rejected
  assert.equal(service.active.size, 0)
})

test('widget HTTP disconnect cancels body parsing and active capture and releases its slot', async t => {
  const value = await app({ env: { MOTED_FAKE_RUNNER: '0' } }); t.after(() => value.close())
  let started
  const running = new Promise(resolve => { started = resolve })
  value.screenshots.run = async (_input, controller) => new Promise((_, reject) => { started(); controller.signal.addEventListener('abort', () => reject(new Error('disconnected')), { once: true }) })
  const controller = new AbortController()
  const request = fetch(endpoint(value, '/api/widgets/screenshot'), { method: 'POST', headers: { origin: 'https://mote.ylxdzsw.com', 'content-type': 'application/json' }, body: JSON.stringify({ html: '', width: 100, height: 100 }), signal: controller.signal })
  const rejected = assert.rejects(request)
  await running; controller.abort(); await rejected
  for (let i = 0; value.screenshots.active.size && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(value.screenshots.active.size, 0)
  const upload = http.request(endpoint(value, '/api/widgets/screenshot'), { method: 'POST', headers: { origin: 'https://mote.ylxdzsw.com', 'content-length': 10000 } })
  upload.on('error', () => {}); upload.write('{'); t.after(() => upload.destroy())
  for (let i = 0; !value.screenshots.active.size && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(value.screenshots.active.size, 1)
  upload.destroy()
  for (let i = 0; value.screenshots.active.size && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(value.screenshots.active.size, 0)
})

test('real widget capture loads CDN in opaque sandbox, preserves literals and blocks host-network resources', { skip: process.env.MOTED_TEST_WIDGET_CAPTURE !== '1', timeout: 40000 }, async t => {
  const mask = process.umask(0o007); t.after(() => process.umask(mask))
  const service = new WidgetScreenshots({}); t.after(() => service.shutdown())
  let hits = 0
  const trap = http.createServer((_request, response) => { hits++; response.end('private fixture') })
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => trap.close(resolve)))
  const literal = "$& $' $` __MOTE_CANDIDATE_HTML__ frame.srcdoc = Number(params.get('width') || 690)"
  const html = `<style>body{background:red}</style><div id="literal">${literal}</div><script src="https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js"></script><script>
    const expected = ${JSON.stringify(literal)};
    let opaque = false; try { parent.document.body.innerHTML = 'escape' } catch { opaque = true }
    const port = ${trap.address().port};
    Promise.allSettled(['http://127.0.0.1:'+port, 'https://127.0.0.1:'+port, 'https://[::1]:'+port, 'https://2130706433', 'https://169.254.169.254', 'https://localhost'].map(url => fetch(url, {mode:'no-cors'}))).then(results => {
      document.body.style.background = opaque && typeof _ === 'function' && document.querySelector('#literal').textContent === expected && results.slice(1).every(r => r.status === 'rejected') ? 'green' : 'red';
      document.querySelector('#literal').remove();
    });
  </script>`
  const png = screenshotBytes(await service.capture(async () => ({ html, width: 320, height: 160 })))
  assert.equal(png.readUInt32BE(16), 640); assert.equal(png.readUInt32BE(20), 320)
  assert.deepEqual(firstPixel(png), [0, 128, 0]); assert.equal(hits, 0)
})
