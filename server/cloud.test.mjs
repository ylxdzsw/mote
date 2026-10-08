import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createMotedServer } from './moted.mjs'
import { backupDatabase } from './backup.mjs'
import { workerStorageProperties } from './runner.mjs'
import { MAX_BODY } from './validation.mjs'

const origin = 'http://localhost:5173'
const image = 'data:image/png;base64,iVBORw0KGgo='
function document(id = randomUUID(), value = 'Hello') {
  return { id, version: 'V0', width: 960, margins: { top: 48, right: 48, bottom: 48, left: 48 },
    theme: { hue: 145, defaults: { family: 'sans', size: 16, color: 'ink', background: 'paper', weight: 400, lineHeight: '1.5em', spaceBefore: '0em', spaceAfter: '1em', letterSpacing: '0em' }, blocks: {}, palette: [{ id: 'ink', name: 'Ink', strong: '#303830' }, { id: 'muted', name: 'Muted', strong: '#687166' }, { id: 'paper', name: 'Paper', strong: '#fffefa' }] },
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text: value }] }] },
    floating: [{ id: 'image-1', kind: 'image', src: image, alt: 'test', anchorId: 'block-1', x: 0, y: 0, width: 100, textFlow: 'overlap' }],
  }
}
async function app(t, options = {}) {
  const root = options.root || await mkdtemp(path.join(os.tmpdir(), 'mote-cloud-test-'))
  if (!options.root) t.after(() => rm(root, { recursive: true, force: true }))
  const value = await createMotedServer({ stateDir: root, backupDir: path.join(root, 'backups'), port: 0, useSystemd: false, defaultModel: 'fake', allowDirectTasks: false, env: { MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: origin, MOTED_SHARED_MU_DIR: path.join(root, 'unused-config'), MOTED_MU_ENV_SOURCE: '', MOTED_FAKE_DELAY_MS: '0' } })
  await value.start()
  t.after(() => value.close())
  value.root = root
  value.call = async (method, suffix, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${value.server.address().port}/api/${suffix}`, { method, headers: { origin, 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  return value
}
async function create(value, doc = document()) {
  const result = await value.call('POST', 'documents', { id: doc.id, name: 'Note', document: doc, operationId: randomUUID() })
  assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(typeof result.body.createdAt, 'number'); assert.equal(typeof result.body.updatedAt, 'number'); return result.body
}
const save = (envelope, text, extra = {}) => ({ baseRevision: envelope.revision, document: document(envelope.id, text), operationId: randomUUID(), ...extra })

test('competing saves CAS across SQLite connections; lost-response retry survives restart and later saves', async t => {
  const first = await app(t); const second = await app(t, { root: first.root })
  const original = await create(first)
  const left = save(original, 'Left'); const right = save(original, 'Right')
  const responses = await Promise.all([first.call('PUT', `documents/${original.id}`, left), second.call('PUT', `documents/${original.id}`, right)])
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409])
  const winner = responses.findIndex(value => value.status === 200)
  const acknowledged = responses[winner].body
  const conflict = responses[1 - winner].body
  assert.equal(conflict.current.revision, acknowledged.revision)
  assert.deepEqual(Object.keys(conflict.current).sort(), ['createdAt', 'id', 'name', 'revision', 'updatedAt'])
  const later = await first.call('PUT', `documents/${original.id}`, save(acknowledged, 'Later'))
  assert.equal(later.status, 200)
  await first.close(); await second.close()
  const restarted = await app(t, { root: first.root })
  const retried = await restarted.call('PUT', `documents/${original.id}`, winner === 0 ? left : right)
  assert.deepEqual(retried.body, acknowledged)
  assert.equal((await restarted.call('GET', `documents/${original.id}`)).body.revision, later.body.revision)
  const reused = await restarted.call('PUT', `documents/${original.id}`, { ...(winner === 0 ? left : right), document: original.document })
  assert.equal(reused.status, 409)
  assert.equal(restarted.store.db.prepare('SELECT count(*) AS n FROM revisions').get().n, 3)
})

test('create retries are idempotent; rename is separate; overwrite uses CAS without recovery copies', async t => {
  const value = await app(t); const doc = document()
  const request = { id: doc.id, name: 'Original', document: doc, operationId: randomUUID() }
  const first = await value.call('POST', 'documents', request)
  const renamed = await value.call('PATCH', `documents/${doc.id}`, { name: 'Renamed' })
  assert.equal(renamed.body.revision, first.body.revision)
  assert.equal(renamed.body.document, undefined)
  assert.deepEqual((await value.call('POST', 'documents', request)).body, first.body)
  const share = (await value.call('POST', `documents/${doc.id}/shares`, { mode: 'snapshot', revision: first.body.revision })).body
  const replacement = save(first.body, 'Replacement')
  const overwritten = await value.call('PUT', `documents/${doc.id}`, replacement)
  assert.equal(overwritten.status, 200); assert.equal(overwritten.body.name, 'Renamed')
  const stale = await value.call('PUT', `documents/${doc.id}`, save(first.body, 'Stale overwrite'))
  assert.equal(stale.status, 409)
  assert.equal(stale.body.current.revision, overwritten.body.revision)
  assert.deepEqual((await value.call('GET', `documents/${doc.id}`)).body.document, replacement.document)
  assert.equal((await value.call('GET', `documents/${doc.id}/recovery`)).status, 404)
  assert.equal((await value.call('DELETE', `documents/${doc.id}/recovery/${randomUUID()}`)).status, 404)
  assert.equal(value.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery'").get(), undefined)
  assert.equal(value.store.db.prepare('SELECT count(*) AS n FROM revisions').get().n, 2)
  assert.deepEqual((await value.call('GET', `shared/${share.token}`)).body.document, doc)
})

test('snapshot pins acknowledged revision, latest resolves head; deletion revokes all and prevents resurrection', async t => {
  const value = await app(t); const original = await create(value)
  const base = `documents/${original.id}`
  const snapshot = (await value.call('POST', `${base}/shares`, { mode: 'snapshot', revision: original.revision })).body
  const latest = (await value.call('POST', `${base}/shares`, { mode: 'latest' })).body
  assert.deepEqual((await value.call('POST', `${base}/shares`, { mode: 'latest' })).body, latest)
  assert.equal(Buffer.from(latest.token, 'base64url').length, 32)
  assert.equal(latest.revision, null)
  assert.equal((await value.call('POST', `${base}/shares`, { mode: 'snapshot' })).status, 400)
  const mutation = save(original, 'Published later')
  const updated = (await value.call('PUT', base, mutation)).body
  const pinned = await value.call('GET', `shared/${snapshot.token}`, undefined, { origin: 'http://untrusted.test' })
  assert.equal(pinned.status, 200); assert.deepEqual(pinned.body, { name: original.name, revision: original.revision, document: original.document })
  assert.deepEqual((await value.call('GET', `shared/${latest.token}`)).body.document, updated.document)
  assert.equal(pinned.headers.get('cache-control'), 'no-store'); assert.equal(pinned.headers.get('referrer-policy'), 'no-referrer'); assert.match(pinned.headers.get('x-robots-tag'), /noindex/)
  assert.equal(pinned.headers.get('access-control-allow-origin'), null)
  assert.equal((await value.call('DELETE', base, { baseRevision: original.revision })).status, 409)
  assert.equal((await value.call('DELETE', `${base}/shares/${snapshot.id}`)).status, 200)
  assert.equal((await value.call('GET', `shared/${snapshot.token}`)).status, 404)
  assert.equal((await value.call('DELETE', base, { baseRevision: updated.revision })).status, 200)
  assert.equal((await value.call('GET', `shared/${latest.token}`)).status, 404)
  for (const [method, suffix, body] of [['GET', '', undefined], ['PUT', '', mutation], ['PATCH', '', { name: 'Back' }], ['GET', '/assistant', undefined], ['PUT', '/assistant', { baseRevision: '0', tasks: [], operationId: randomUUID() }], ['POST', '/shares', { mode: 'latest' }]]) {
    assert.equal((await value.call(method, base + suffix, body)).status, 410)
  }
  assert.equal((await value.call('POST', 'documents', { id: original.id, name: 'Resurrection', document: original.document, operationId: randomUUID() })).status, 410)
  assert.deepEqual((await value.call('GET', 'documents')).body, { documents: [] })
  assert.equal((await value.call('GET', `documents/${randomUUID()}`)).status, 404)
})

test('assistant state CAS and retries are independent, inert, and hydrated', async t => {
  const value = await app(t); const original = await create(value); const base = `documents/${original.id}`
  assert.deepEqual((await value.call('GET', `${base}/assistant`)).body, { revision: '0', tasks: [] })
  const request = { baseRevision: '0', tasks: [{ id: randomUUID(), status: 'running', prompt: 'Do not execute this', candidate: { screenshot: image } }], operationId: randomUUID() }
  const first = await value.call('PUT', `${base}/assistant`, request)
  assert.equal(first.status, 200); assert.deepEqual(first.body.tasks, request.tasks)
  const conflict = await value.call('PUT', `${base}/assistant`, { ...request, operationId: randomUUID() })
  assert.equal(conflict.status, 409); assert.deepEqual(conflict.body.current, first.body)
  assert.equal((await value.call('PUT', base, save(original, 'Content changed'))).status, 200)
  const second = await value.call('PUT', `${base}/assistant`, { baseRevision: first.body.revision, tasks: [], operationId: randomUUID() })
  assert.equal(second.status, 200)
  assert.deepEqual((await value.call('PUT', `${base}/assistant`, request)).body, first.body)
  assert.deepEqual((await value.call('GET', `${base}/assistant`)).body, second.body)
  assert.equal(value.manager.tasks.size, 0)
  assert.equal(value.store.db.prepare('SELECT count(*) AS n FROM assets').get().n, 1)
  assert.equal(value.store.db.prepare('SELECT body FROM revisions LIMIT 1').get().body.includes(image), false)
})

test('save validates V0, reads preserve unreadable old JSON, and all mutations enforce exact Origin', async t => {
  const value = await app(t); const original = await create(value); const base = `documents/${original.id}`
  const invalid = save(original, 'Bad'); invalid.document.version = 'bad'
  assert.equal((await value.call('PUT', base, invalid)).status, 400)
  assert.equal((await value.call('PUT', base, save(original, 'Bad origin'), { origin: 'https://mote.ylxdzsw.com.evil.test' })).status, 403)
  assert.equal((await value.call('PATCH', base, { name: 'Bad origin' }, { origin: '' })).status, 403)
  assert.equal((await value.call('DELETE', base, { baseRevision: original.revision }, { origin: 'null' })).status, 403)
  const old = { ...original.document, version: 'old-unreadable' }
  value.store.db.prepare('UPDATE revisions SET body=? WHERE revision=?').run(value.store.pack(old), original.revision)
  assert.deepEqual((await value.call('GET', base)).body.document, old)
  assert.equal((await value.call('PUT', base, save(original, 'Explicit reset'))).status, 200)
  assert.equal(MAX_BODY, 128 * 1024 * 1024)
})

test('AI tasks bind immutable saved revisions and retain candidates/sessions past old TTL and restart', async t => {
  const value = await app(t); const original = await create(value)
  const target = { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: true, area: { x: 48, y: 48, width: 200, height: 40 } }
  const request = { id: randomUUID(), cloudDocumentId: original.id, baseRevision: original.revision, document: original.document, prompt: 'Improve', target }
  assert.equal((await value.call('POST', 'ai/tasks', { ...request, document: document(original.id, 'Unsaved') })).status, 409)
  assert.equal((await value.call('POST', 'ai/tasks', { ...request, cloudDocumentId: undefined })).status, 400)
  await value.call('PUT', `documents/${original.id}`, save(original, 'New head'))
  const submitted = await value.call('POST', 'ai/tasks', { ...request, document: undefined })
  assert.equal(submitted.status, 202); assert.equal(submitted.body.documentId, original.id); assert.equal(submitted.body.baseRevision, original.revision)
  for (let i = 0; i < 100 && value.manager.tasks.get(request.id).meta.status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const task = value.manager.tasks.get(request.id)
  assert.equal(task.meta.status, 'ready')
  assert.equal(task.meta.candidate.content[0].content[0].text, 'AI draft: Hello')
  assert.equal(value.store.db.prepare('SELECT revision FROM task_revisions WHERE taskId=?').get(request.id).revision, original.revision)
  const taskDir = task.dir
  await value.close()
  const meta = JSON.parse(await readFile(path.join(taskDir, 'meta.json'), 'utf8')); meta.expiresAt = 1
  await writeFile(path.join(taskDir, 'meta.json'), JSON.stringify(meta))
  const restarted = await app(t, { root: value.root })
  const recovered = await restarted.call('GET', `ai/tasks/${request.id}`)
  assert.deepEqual(recovered.body.candidate, meta.candidate)
  assert.equal(restarted.manager.tasks.get(request.id).meta.sessionId, meta.sessionId)
  assert.ok(recovered.body.expiresAt > Date.now())
})

test('private SQLite/WAL, worker isolation properties, and both consistent backup paths preserve live data', async t => {
  const value = await app(t); const original = await create(value)
  const updated = (await value.call('PUT', `documents/${original.id}`, save(original, 'In WAL'))).body
  for (const [file, mode] of [[value.store.dataDir, 0o700], [value.store.databasePath, 0o600], [value.store.databasePath + '-wal', 0o600], [value.manager.tasksDir, 0o700]]) assert.equal((await stat(file)).mode & 0o777, mode)
  const props = workerStorageProperties({ taskDir: path.join(value.manager.tasksDir, 'own'), tasksDir: value.manager.tasksDir, dataDir: value.store.dataDir, backupDir: value.store.backupDir, env: {} })
  assert.ok(props.some(prop => prop.startsWith('InaccessiblePaths=') && prop.includes(value.store.dataDir) && prop.includes(value.store.backupDir)))
  assert.ok(props.some(prop => prop.startsWith('TemporaryFileSystem=') && prop.includes(value.manager.tasksDir)))
  const files = []
  for (const vacuum of [false, true]) {
    const file = await backupDatabase({ stateDir: value.root, backupDir: value.store.backupDir, vacuum })
    files.push(file)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const backup = new DatabaseSync(file, { readOnly: true })
    try {
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.equal(backup.prepare('SELECT revision FROM documents WHERE id=?').get(original.id).revision, updated.revision)
      assert.equal(backup.prepare('SELECT count(*) AS n FROM revisions').get().n, 2)
      assert.equal(backup.prepare('SELECT count(*) AS n FROM assets').get().n, 1)
    } finally { backup.close() }
  }
  assert.notEqual(files[0], files[1]); await stat(files[0])
  assert.equal((await stat(value.store.backupDir)).mode & 0o777, 0o700)
})
