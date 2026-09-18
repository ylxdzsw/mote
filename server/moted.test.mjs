import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMotedServer } from './moted.mjs'
import { fakeRunner } from './runner.mjs'

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
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'moted-test-'))
  const value = await createMotedServer({ ...options, stateDir, port: 0, useSystemd: false, defaultModel: 'codex/gpt-5.6-luna', env: { MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: 'http://localhost:5173', MOTED_SHARED_MU_DIR: path.join(stateDir, 'unused-config'), MOTED_MU_ENV_SOURCE: '', ...(options.env || {}) } })
  await value.start(); return value
}
async function post(app, body, pathName = '/api/ai/tasks', origin = 'http://localhost:5173') { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }) }
async function get(app, id) { const address = app.server.address(); return fetch(`http://127.0.0.1:${address.port}/api/ai/tasks/${id}`) }

 test('fake task reaches ready and status does not expose logs or document', async t => {
  const value = await app(); t.after(() => value.close())
  const id = crypto.randomUUID(); const created = await post(value, request(id)); assert.equal(created.status, 202)
  const initial = await created.json(); assert.ok(['queued', 'running'].includes(initial.status)); assert.equal(initial.id, id); assert.equal('document' in initial, false)
  let status
  for (let i = 0; i < 20; i++) { status = await (await get(value, id)).json(); if (status.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(status.status, 'ready'); assert.equal(status.candidate.summary, 'Fake candidate for text target.'); assert.equal(status.candidate.content[0].content[0].text, 'AI draft: Hello'); assert.equal('logs' in status, false); assert.equal('prompt' in status, false)
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
