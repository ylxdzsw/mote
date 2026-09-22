import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMotedServer } from './moted.mjs'
import { fakeRunner } from './runner.mjs'
import { validateCandidate } from './validation.mjs'

const png = 'data:image/png;base64,iVBORw0KGgo='
const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}`
const theme = {
  defaults: { family: 'sans', size: 16, color: 'ink', background: 'paper', weight: 400, lineHeight: '1.5em', spaceBefore: '0em', spaceAfter: '1em', letterSpacing: '0em' },
  blocks: { title: {}, heading: {}, body: {}, caption: {}, code: {}, list: {}, table: {}, label: {}, math: {} },
  palette: [
    { id: 'ink', name: 'Ink', strong: '#303830' }, { id: 'muted', name: 'Muted', strong: '#687166' },
    { id: 'subtle', name: 'Subtle', strong: '#e8ece3' }, { id: 'paper', name: 'Paper', strong: '#fffefa' },
    { id: 'key-idea', name: 'Key idea', strong: '#355b43', soft: '#e9efdf' },
  ],
}
function document(kind = 'text') {
  const doc = { version: 'V0', id: 'doc-1', width: 800, margins: { top: 48, right: 48, bottom: 48, left: 48 }, theme, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text: 'Hello' }] }] }, floating: [] }
  if (kind === 'text') doc.floating.push({ id: 'object-1', anchorId: 'block-1', x: 40, y: 10, width: 200, textFlow: 'overlap', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'float-1', semantic: 'body' }, content: [] }] } })
  if (kind === 'html') doc.floating.push({ id: 'object-1', kind: 'html', anchorId: 'block-1', x: 40, y: 10, width: 200, height: 100, textFlow: 'overlap', html: '<button>+</button>', screenshot: svg, alt: 'demo' })
  return doc
}
function request(id, doc = document(), extra = {}) { return { id, document: doc, model: 'codex/gpt-5.6-luna', prompt: 'Improve the target', target: { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: true, area: { x: 48, y: 48, width: 200, height: 40 } }, ...extra } }
async function app(options = {}) {
  const stateDir = options.stateDir || await mkdtemp(path.join(os.tmpdir(), 'moted-test-'))
  const value = await createMotedServer({ ...options, stateDir, port: 0, useSystemd: false, defaultModel: 'codex/gpt-5.6-luna', env: { MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: 'http://localhost:5173', MOTED_SHARED_MU_DIR: path.join(stateDir, 'unused-config'), MOTED_MU_ENV_SOURCE: '', ...(options.env || {}) } })
  await value.start(); value.stateDir = stateDir; return value
}
async function post(app, body, pathName = '/api/ai/tasks', origin = 'http://localhost:5173') { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }) }
async function get(app, id) { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}`) }
async function events(app, id, suffix = '', headers = {}) { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}/events${suffix}`, { headers }) }
async function waitReady(value, id) {
  for (let i = 0; i < 60; i++) { if (value.manager.tasks.get(id)?.meta.status === 'ready') return; await new Promise(resolve => setTimeout(resolve, 10)) }
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

test('new floating reservations accept all supported kinds, not only HTML and images', () => {
  const doc = document('html'), original = doc.floating[0]
  const { id, anchorId, x, y, width, textFlow } = original
  const base = { id, anchorId, x, y, width, textFlow }
  const target = { kind: 'object', objectId: id, isNew: true, area: { x, y, width, height: 100 } }
  const paragraph = { type: 'paragraph', attrs: { semantic: 'body' }, content: [{ type: 'text', text: 'Native text' }] }
  const stroke = { stroke: null, strokeWidth: 1, dashed: false }
  const objects = [
    { ...base, kind: 'katex', latex: String.raw`\int_0^1 x^2\,dx = \frac{1}{3}` },
    { ...base, kind: 'text', content: { type: 'doc', content: [paragraph] } },
    { ...base, kind: 'table', content: { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph] }] }] }] } },
    ...['rectangle', 'ellipse'].map(kind => ({ ...base, ...stroke, kind, height: 100, fill: null, rounded: false })),
    { ...base, ...stroke, kind: 'line', start: { x, y, anchorId }, end: { x: 200, y: 80, anchorId }, route: 'straight', bend: 0, arrowStart: false, arrowEnd: true },
    { ...base, kind: 'label', content: { type: 'doc', content: [paragraph] }, attachment: null },
    { ...base, kind: 'image', src: png, alt: 'Image' }, original,
  ]
  for (const object of objects) {
    assert.equal(validateCandidate({ object, summary: 'Candidate' }, doc, target).object.kind, object.kind)
    if (object.kind !== 'html') assert.throws(() => validateCandidate({ object, summary: 'Candidate' }, doc, { ...target, isNew: false }), /retain target kind/)
  }
})

test('a native KaTeX delivery reaches ready without HTML or screenshot artifacts', async t => {
  const doc = document('html'), original = doc.floating[0]
  const value = await app({ runner: async context => {
    const { id, anchorId, x, y, width, textFlow } = original
    await writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify({ object: { id, anchorId, x, y, width, textFlow, kind: 'katex', latex: 'E = mc^2' }, summary: 'Native formula' }))
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
  assert.equal((await post(value, { prompt: 'Revise the transcript' }, `/api/ai/tasks/${id}/revise`)).status, 202); await waitReady(value, id)
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
    post(value, { prompt: 'Concurrent revision' }, `/api/ai/tasks/${id}/revise`),
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
  for (let i = 0; i < 20; i++) { if (value.manager.tasks.get(id)?.meta.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  const session = value.manager.tasks.get(id).meta.sessionId
  assert.match(session, /^fake-/)
  const revised = await post(value, { prompt: 'Revise the candidate' }, `/api/ai/tasks/${id}/revise`)
  assert.equal(revised.status, 202)
  for (let i = 0; i < 20; i++) { if (value.manager.tasks.get(id)?.meta.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)) }
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
  assert.equal((await post(value, { prompt: 'Retry after failure' }, `/api/ai/tasks/${id}/revise`)).status, 202)
  for (let i = 0; i < 30; i++) { if (value.manager.tasks.get(id)?.meta.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(value.manager.tasks.get(id).meta.status, 'ready'); assert.equal(runs, 2)
})
