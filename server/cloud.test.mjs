import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createMotedServer } from './moted.mjs'
import { backupDatabase } from './backup.mjs'
import { muRunner, workerStorageProperties } from './runner.mjs'
import { MAX_BODY } from './validation.mjs'

const origin = 'http://localhost:5173'
const image = 'data:image/png;base64,iVBORw0KGgo='
function document(id = randomUUID(), value = 'Hello') {
  return { id, version: 'V0', width: 960, margins: { top: 48, right: 48, bottom: 48, left: 48 },
    theme: { hue: 145, defaults: { family: 'sans', size: 16, color: 'ink', background: 'paper', weight: 400, lineHeight: '1.5em', spaceBefore: '0em', spaceAfter: '1em', letterSpacing: '0em' }, blocks: {}, palette: [{ id: 'ink', name: 'Ink', strong: '#303830' }, { id: 'muted', name: 'Muted', strong: '#687166' }, { id: 'paper', name: 'Paper', strong: '#fffefa' }] },
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text: value }] }] },
    floating: [{ id: 'image-1', kind: 'image', src: image, alt: 'test', anchorId: 'block-1', x: 0, y: 0, width: 100, placement: 'float' }],
  }
}
async function app(t, options = {}) {
  const root = options.root || await mkdtemp(path.join(os.tmpdir(), 'mote-cloud-test-'))
  if (!options.root) t.after(() => rm(root, { recursive: true, force: true }))
  const value = await createMotedServer({ ...options, stateDir: root, backupDir: path.join(root, 'backups'), port: 0, useSystemd: false, defaultModel: options.defaultModel ?? 'fake', allowDirectTasks: false, env: { MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: origin, MOTED_SHARED_MU_DIR: path.join(root, 'unused-config'), MOTED_MU_ENV_SOURCE: '', MOTED_FAKE_DELAY_MS: '0', ...options.env } })
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

test('workspace model defaults are provider-free, durable, validated and revision checked', async t => {
  let runs = 0
  const value = await app(t, { runner: async () => { runs++ } })
  const original = await create(value)
  const initial = await value.call('GET', 'settings')
  assert.deepEqual(initial.body, { revision: 0, models: { builtin: '', indexing: '' }, indexingEnabled: false, serverDefaultModel: 'fake' })
  assert.equal(initial.headers.get('cache-control'), 'no-store')
  const models = { builtin: 'provider/author:high', indexing: 'provider/indexer:low' }
  assert.equal((await value.call('PUT', 'settings', { baseRevision: 0, models }, { origin: 'https://other.invalid' })).status, 403)
  assert.equal((await value.call('PUT', 'settings', { baseRevision: 0, models: { ...models, builtin: 'bad\nmodel' } })).status, 400)
  assert.equal((await value.call('PUT', 'settings', { baseRevision: 0, models: { ...models, indexing: 1 } })).status, 400)
  assert.equal((await value.call('PUT', 'settings', { baseRevision: 0, models })).status, 200)
  assert.equal((await value.call('PUT', 'settings', { baseRevision: 0, models: { builtin: '', indexing: '' } })).status, 409)
  assert.equal(await value.manager.resolveModel(), models.builtin)
  assert.deepEqual((await value.call('GET', `documents/${original.id}`)).body, original)
  assert.equal(runs, 0)
  await value.close()
  const restarted = await app(t, { root: value.root })
  assert.deepEqual((await restarted.call('GET', 'settings')).body.models, models)
  assert.equal((await restarted.call('PUT', 'settings', { baseRevision: 1, models: { builtin: '', indexing: '' } })).status, 200)
  assert.equal(await restarted.manager.resolveModel(), 'fake')
})

test('missing Mu and failed workers leave cloud documents usable without automatic execution retries', async t => {
  const value = await app(t, { runner: muRunner, env: { MOTED_MU_BIN: '/mote-test-missing-mu' } })
  const shared = value.manager.env.MOTED_SHARED_MU_DIR
  await mkdir(shared); await writeFile(path.join(shared, 'config.jsonc'), '{}')
  const original = await create(value), id = randomUUID()
  const body = { id, cloudDocumentId: original.id, baseRevision: original.revision, operationId: randomUUID(),
    document: original.document, prompt: 'Test unavailable executable', target: { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: false, area: { x: 48, y: 48, width: 200, height: 40 } } }
  await reservations(value, original, [body])
  assert.equal((await value.call('POST', 'ai/tasks', body)).status, 202)
  for (let i = 0; i < 100 && value.manager.tasks.get(id).meta.status !== 'error'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const failed = value.manager.tasks.get(id)
  assert.equal(failed.meta.status, 'error'); assert.match(failed.meta.error, /ENOENT/)
  const saved = await value.call('PUT', `documents/${original.id}`, save(original, 'Manual edit with Mu absent'))
  assert.equal(saved.status, 200)
  assert.equal((await value.call('GET', 'documents')).body.documents.length, 1)
  assert.equal((await value.call('POST', `documents/${original.id}/shares`, { mode: 'latest' })).status, 200)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(failed.meta.attempt, 1); assert.equal(value.manager.queue.length, 0)
  await value.close()
  const restarted = await app(t, { root: value.root, runner: async () => { assert.fail('must not rerun on restart') } })
  assert.equal(restarted.manager.tasks.get(id).meta.status, 'error')
  assert.deepEqual((await restarted.call('GET', `documents/${original.id}`)).body.document, saved.body.document)
})

test('slow Mu default lookup does not block cloud reads and saves; unavailable default fails once', async t => {
  const value = await app(t, { defaultModel: '', env: { MOTED_MU_DEFAULT_MODEL: '' } })
  const bin = path.join(value.root, 'slow-mu')
  await writeFile(bin, `#!/usr/bin/node\nsetTimeout(() => process.exit(1), 700)\n`, { mode: 0o700 })
  value.manager.env.MOTED_MU_BIN = bin
  const original = await create(value)
  let finished = false
  const body = { id: randomUUID(), cloudDocumentId: original.id, baseRevision: original.revision, operationId: randomUUID(),
    document: original.document, prompt: 'Test unavailable model', target: { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: false, area: { x: 48, y: 48, width: 200, height: 40 } } }
  await reservations(value, original, [body])
  const pending = value.call('POST', 'ai/tasks', body).then(result => { finished = true; return result })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await value.call('GET', 'settings')).status, 200)
  assert.equal((await value.call('GET', `documents/${original.id}`)).status, 200)
  assert.equal((await value.call('PUT', `documents/${original.id}`, save(original, 'Still usable'))).status, 200)
  assert.equal(finished, false)
  assert.equal((await pending).status, 503)
  assert.equal(value.manager.tasks.size, 0)
})

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
  assert.deepEqual(Object.keys(conflict.current).sort(), ['createdAt', 'id', 'name', 'privacyRevision', 'private', 'revision', 'updatedAt'])
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

test('private metadata defaults, persists, uses independent CAS/retries, and survives stale content saves', async t => {
  const value = await app(t); const original = await create(value); const base = `documents/${original.id}`
  assert.equal(original.private, false); assert.equal(original.privacyRevision, 0)
  assert.deepEqual((await value.call('GET', `${base}/privacy`)).body, {
    id: original.id, name: original.name, revision: original.revision, createdAt: original.createdAt, updatedAt: original.updatedAt, private: false, privacyRevision: 0,
  })
  assert.deepEqual(value.store.assertExternal(original.id, 0), (await value.call('GET', `${base}/privacy`)).body)
  assert.throws(() => value.store.assertExternal(original.id, 1), error => error.status === 403)

  const enable = { private: true, basePrivacyRevision: 0, operationId: randomUUID() }
  const enabled = await value.call('PUT', `${base}/privacy`, enable)
  assert.equal(enabled.status, 200); assert.equal(enabled.body.private, true); assert.equal(enabled.body.privacyRevision, 1)
  assert.throws(() => value.store.assertExternal(original.id, 0), error => error.status === 403)
  assert.deepEqual((await value.call('PUT', `${base}/privacy`, enable)).body, enabled.body)
  const conflict = await value.call('PUT', `${base}/privacy`, { private: false, basePrivacyRevision: 0, operationId: randomUUID() })
  assert.equal(conflict.status, 409); assert.equal(conflict.body.current.private, true); assert.equal(conflict.body.current.privacyRevision, 1)
  const unchanged = await value.call('PUT', `${base}/privacy`, { private: true, basePrivacyRevision: 1, operationId: randomUUID() })
  assert.equal(unchanged.status, 200); assert.equal(unchanged.body.privacyRevision, 1)

  const staleContent = await value.call('PUT', base, save(original, 'Saved from an older privacy view'))
  assert.equal(staleContent.status, 200); assert.equal(staleContent.body.private, true); assert.equal(staleContent.body.privacyRevision, 1)
  await value.close()
  const restarted = await app(t, { root: value.root })
  const persisted = await restarted.call('GET', `${base}/privacy`)
  assert.equal(persisted.body.private, true); assert.equal(persisted.body.privacyRevision, 1)
  const disabled = await restarted.call('PUT', `${base}/privacy`, { private: false, basePrivacyRevision: 1, operationId: randomUUID() })
  assert.equal(disabled.status, 200); assert.equal(disabled.body.private, false); assert.equal(disabled.body.privacyRevision, 2)
  assert.throws(() => restarted.store.assertExternal(original.id, 1), error => error.status === 403)
  assert.equal(restarted.store.assertExternal(original.id, 2).private, false)
  assert.deepEqual((await restarted.call('PUT', `${base}/privacy`, enable)).body, enabled.body)
  assert.equal((await restarted.call('GET', `${base}/privacy`)).body.privacyRevision, 2)
})

test('legacy SQLite privacy columns migrate idempotently without resetting documents', async t => {
  const value = await app(t); const original = await create(value)
  await value.close()
  const legacy = new DatabaseSync(value.store.databasePath)
  legacy.exec('ALTER TABLE documents DROP COLUMN privacyRevision; ALTER TABLE documents DROP COLUMN private;')
  legacy.close()
  const migrated = await app(t, { root: value.root })
  const loaded = await migrated.call('GET', `documents/${original.id}`)
  assert.equal(loaded.status, 200); assert.deepEqual(loaded.body.document, original.document)
  assert.equal(loaded.body.private, false); assert.equal(loaded.body.privacyRevision, 0)
  await migrated.close()
  const reopened = await app(t, { root: value.root })
  assert.deepEqual((await reopened.call('GET', `documents/${original.id}`)).body.document, original.document)
  assert.equal((await reopened.call('GET', `documents/${original.id}/privacy`)).body.privacyRevision, 0)
})

test('private creation is validated; snapshot/latest links are revoked and never revive', async t => {
  const value = await app(t); const doc = document(); const base = `documents/${doc.id}`
  const request = { id: doc.id, name: 'Private note', document: doc, private: true, operationId: randomUUID() }
  const created = await value.call('POST', 'documents', request)
  assert.equal(created.status, 201); assert.equal(created.body.private, true); assert.equal(created.body.privacyRevision, 0)
  assert.equal((await value.call('GET', base)).status, 200)
  assert.equal((await value.call('GET', `${base}/assistant`)).status, 200)
  assert.ok((await value.call('GET', 'documents')).body.documents.some(item => item.id === doc.id && item.private))
  assert.equal((await value.call('POST', `${base}/shares`, { mode: 'latest' })).status, 403)
  const invalidDoc = document()
  assert.equal((await value.call('POST', 'documents', { id: invalidDoc.id, name: 'Invalid', document: invalidDoc, private: 'true', operationId: randomUUID() })).status, 400)

  const publicDoc = await create(value)
  const publicBase = `documents/${publicDoc.id}`
  const snapshot = (await value.call('POST', `${publicBase}/shares`, { mode: 'snapshot', revision: publicDoc.revision })).body
  const latest = (await value.call('POST', `${publicBase}/shares`, { mode: 'latest' })).body
  const privateMeta = await value.call('PUT', `${publicBase}/privacy`, { private: true, basePrivacyRevision: 0, operationId: randomUUID() })
  assert.equal(privateMeta.status, 200); assert.equal(privateMeta.body.privacyRevision, 1)
  assert.equal((await value.call('GET', `shared/${snapshot.token}`)).status, 404)
  assert.equal((await value.call('GET', `shared/${latest.token}`)).status, 404)
  const forbidden = await value.call('POST', `${publicBase}/shares`, { mode: 'latest' })
  assert.equal(forbidden.status, 403); assert.match(forbidden.body.error, /Private/)
  await value.call('PUT', `${publicBase}/privacy`, { private: false, basePrivacyRevision: 1, operationId: randomUUID() })
  assert.equal((await value.call('GET', `shared/${snapshot.token}`)).status, 404)
  assert.equal((await value.call('GET', `shared/${latest.token}`)).status, 404)
  const fresh = await value.call('POST', `${publicBase}/shares`, { mode: 'latest' })
  assert.equal(fresh.status, 200); assert.notEqual(fresh.body.token, latest.token)
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

test('Notes round-trip through saves, validate as text or multiple notes, affect retries, and stay out of public shares', async t => {
  const value = await app(t), doc = document()
  doc.notes = 'Outline and unverified plan'
  const original = await create(value, doc), base = `documents/${original.id}`
  assert.equal((await value.call('GET', base)).body.document.notes, doc.notes)
  const snapshot = (await value.call('POST', `${base}/shares`, { mode: 'snapshot', revision: original.revision })).body
  const latest = (await value.call('POST', `${base}/shares`, { mode: 'latest' })).body

  const updatedDocument = { ...original.document, notes: ['Updated working notes', 'Another outline', ''] }
  const operation = { baseRevision: original.revision, document: updatedDocument, operationId: randomUUID() }
  const saved = await value.call('PUT', base, operation)
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.document.notes, updatedDocument.notes)
  assert.deepEqual((await value.call('GET', base)).body.document.notes, updatedDocument.notes)
  assert.equal((await value.call('PUT', base, { ...operation, document: { ...updatedDocument, notes: 'Different retry input' } })).status, 409)
  for (const notes of [null, 1, { text: 'not plain text' }, ['Valid note', null], [1], [['Nested note']]]) {
    assert.equal((await value.call('PUT', base, {
      baseRevision: saved.body.revision, document: { ...updatedDocument, notes }, operationId: randomUUID(),
    })).status, 400)
  }

  const publicSnapshot = await value.call('GET', `shared/${snapshot.token}`)
  const publicLatest = await value.call('GET', `shared/${latest.token}`)
  const { notes: _originalNotes, ...publicOriginal } = doc
  const { notes: _updatedNotes, ...publicUpdated } = updatedDocument
  assert.equal(Object.hasOwn(publicSnapshot.body.document, 'notes'), false)
  assert.equal(Object.hasOwn(publicLatest.body.document, 'notes'), false)
  assert.deepEqual(publicSnapshot.body.document, publicOriginal)
  assert.deepEqual(publicLatest.body.document, publicUpdated)
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
  assert.equal((await value.call('PUT', `${base}/privacy`, { private: true, basePrivacyRevision: 0, operationId: randomUUID() }, { origin: 'https://mote.ylxdzsw.com.evil.test' })).status, 403)
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
  const request = { id: randomUUID(), cloudDocumentId: original.id, baseRevision: original.revision, document: original.document, prompt: 'Improve', target, operationId: randomUUID() }
  assert.equal((await value.call('PUT', `documents/${original.id}/assistant`, { baseRevision: '0', tasks: [request], operationId: randomUUID() })).status, 200)
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

const portableRequest = original => ({ id: randomUUID(), cloudDocumentId: original.id, baseRevision: original.revision, executor: 'external', operationId: randomUUID(), snapshot: image,
  target: { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: false, area: { x: 48, y: 48, width: 200, height: 40 } } })
const submission = document => ({ executorRevision: 0, candidateRevision: 0, operationId: randomUUID(), candidate: { content: document.content.content, summary: 'Retained external result' } })
async function reservations(value, original, tasks) {
  const state = value.store.assistant(original.id)
  return value.call('PUT', `documents/${original.id}/assistant`, { baseRevision: state.revision, tasks, operationId: randomUUID() })
}

test('cloud reservation authorizes creation and permanently revokes grants on acceptance/removal even if artifact persistence fails', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  assert.equal((await value.call('POST', 'ai/tasks', request)).status, 410)
  assert.equal((await reservations(value, original, [request])).status, 200)
  assert.equal((await value.call('POST', 'ai/tasks', { ...request, target: { ...request.target, insert: true } })).status, 409)
  const creations = await Promise.all([value.call('POST', 'ai/tasks', request), value.call('POST', 'ai/tasks', request)])
  assert.deepEqual(creations.map(result => result.status), [202, 202]); assert.equal(value.manager.tasks.size, 1)
  const base = creations[0].body.externalPath.slice('/api/'.length)
  assert.equal((await value.call('POST', `${base}/submit`, submission(original.document), { origin: '' })).status, 200)
  const oldState = value.store.assistant(original.id)
  const persist = value.manager.persist.bind(value.manager)
  value.manager.persist = task => task.meta.released ? Promise.reject(new Error('simulated artifact disk failure')) : persist(task)
  assert.equal((await reservations(value, original, [{ ...request, acceptance: { workingCopyId: 'local', document: original.document } }])).status, 200)
  assert.equal((await value.call('GET', `${base}/document.json`)).status, 404)
  assert.equal((await value.call('POST', `${base}/submit`, submission(original.document))).status, 404)
  const retained = await value.call('GET', `ai/tasks/${request.id}`)
  assert.equal(retained.body.released, true); assert.equal(retained.body.candidate.summary, 'Retained external result')
  // Assistant JSON cannot resurrect an accepted task, even with the original active entry.
  assert.equal((await reservations(value, original, oldState.tasks)).status, 200)
  await value.close()
  const restarted = await app(t, { root: value.root })
  assert.equal((await restarted.call('GET', `${base}/document.json`)).status, 404)
  assert.equal((await restarted.call('GET', `ai/tasks/${request.id}`)).body.released, true)
  assert.equal((await restarted.call('POST', `ai/tasks/${request.id}/executor`, { executor: 'builtin', baseExecutorRevision: 0, operationId: randomUUID() })).status, 410)
  const second = portableRequest(original)
  assert.equal((await reservations(restarted, original, [request, second])).status, 200)
  const secondTask = await restarted.call('POST', 'ai/tasks', second)
  assert.equal(secondTask.status, 202)
  // Direct CloudStore mutation models a crash before TaskManager's best-effort cleanup.
  restarted.store.putAssistant(original.id, { baseRevision: restarted.store.assistant(original.id).revision, tasks: [request], operationId: randomUUID() })
  assert.equal((await restarted.call('GET', `${secondTask.body.externalPath.slice(5)}/document.json`)).status, 404)
  assert.equal((await restarted.call('GET', `ai/tasks/${second.id}`)).body.released, true)
  await readFile(path.join(restarted.manager.tasks.get(second.id).dir, 'input', 'document.json'))
})

test('cloud deletion is rechecked at candidate commit and survives restart without artifact cleanup', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath.slice(5)
  let entered, continueLoad
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { continueLoad = resolve })
  const load = value.manager.loadRequest.bind(value.manager)
  value.manager.loadRequest = async task => { entered(); await gate; return load(task) }
  const pending = value.call('POST', `${base}/submit`, submission(original.document), { origin: '' })
  await started
  value.store.delete(original.id, { baseRevision: original.revision })
  continueLoad()
  assert.equal((await pending).status, 404)
  assert.equal(value.manager.tasks.get(request.id).meta.candidate, undefined)
  for (const resource of ['document.json', 'target.json', 'snapshot.png', 'guide.md', 'manifest.json']) assert.equal((await value.call('GET', `${base}/${resource}`)).status, 404)
  await value.close()
  const restarted = await app(t, { root: value.root })
  assert.equal((await restarted.call('GET', `${base}/document.json`)).status, 404)
  assert.equal((await restarted.call('GET', `ai/tasks/${request.id}`)).body.released, true)
  assert.equal((await restarted.call('DELETE', `ai/tasks/${request.id}`)).status, 200)
  assert.equal((await restarted.call('POST', 'ai/tasks', request)).status, 410)
})

const privacyChange = (value, original, enabled) => value.call('PUT', `documents/${original.id}/privacy`, {
  private: enabled, basePrivacyRevision: value.store.privacyMeta(original.id).privacyRevision, operationId: randomUUID(),
})

test('Private revokes external context and delivery, preserves candidate/reservation, and keeps built-in generation available', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath.slice(5)
  assert.equal((await value.call('POST', `${base}/submit`, submission(original.document))).status, 200)
  assert.equal((await privacyChange(value, original, true)).status, 200)
  const own = await value.call('GET', `ai/tasks/${request.id}`)
  assert.equal(own.body.executor, 'builtin'); assert.equal(own.body.executorRevision, 1)
  assert.equal(own.body.released, false); assert.equal(own.body.candidate.summary, 'Retained external result')
  assert.equal(own.body.externalPath, undefined)
  for (const resource of ['', '/document.json', '/snapshot.png', '/target.json', '/manifest.json', '/candidate.json', '/guide.md']) {
    assert.equal((await value.call('GET', base + resource)).status, 404)
  }
  assert.equal((await value.call('POST', `${base}/submit`, submission(original.document))).status, 404)
  assert.equal((await value.call('POST', `ai/tasks/${request.id}/executor`, { executor: 'external', baseExecutorRevision: 1, operationId: randomUUID() })).status, 403)
  const second = portableRequest(original)
  await reservations(value, original, [request, second])
  assert.equal((await value.call('POST', 'ai/tasks', second)).status, 403)
  assert.equal(value.manager.tasks.has(second.id), false)
  assert.equal((await value.call('POST', `ai/tasks/${request.id}/revise`, { prompt: 'Revise privately', executorRevision: 1 })).status, 202)
  const task = value.manager.tasks.get(request.id)
  for (let i = 0; i < 100 && (task.meta.status !== 'ready' || task.current); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(task.meta.status, 'ready'); assert.equal(task.meta.candidateRevision, 2)
  assert.equal((await value.call('GET', `documents/${original.id}`)).status, 200)
  assert.equal((await privacyChange(value, original, false)).status, 200)
  assert.equal((await value.call('GET', `${base}/document.json`)).status, 404)
  const fresh = await value.call('POST', `ai/tasks/${request.id}/executor`, { executor: 'external', baseExecutorRevision: 1, operationId: randomUUID() })
  assert.equal(fresh.status, 200); assert.notEqual(fresh.body.externalPath, created.body.externalPath)
  assert.equal((await value.call('GET', `${fresh.body.externalPath.slice(5)}/document.json`)).status, 200)
})

test('privacy epochs revoke external grants across off/on cycles and restart even if task metadata cleanup fails', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath.slice(5)
  assert.equal((await value.call('POST', `${base}/submit`, submission(original.document))).status, 200)
  const persist = value.manager.persist.bind(value.manager)
  value.manager.persist = (task, meta = task.meta) => meta.executor === 'builtin' ? Promise.reject(new Error('simulated cleanup failure')) : persist(task, meta)
  assert.equal((await privacyChange(value, original, true)).status, 200)
  assert.equal((await privacyChange(value, original, false)).status, 200)
  assert.equal(value.manager.tasks.get(request.id).meta.executor, 'external')
  assert.equal(value.manager.view(value.manager.tasks.get(request.id)).externalPath, undefined)
  assert.equal((await value.call('GET', `${base}/document.json`)).status, 404)
  assert.equal((await value.call('POST', `${base}/submit`, submission(original.document))).status, 404)
  value.manager.persist = persist
  await value.close()
  const restarted = await app(t, { root: value.root })
  assert.equal((await restarted.call('GET', `${base}/document.json`)).status, 404)
  const recovered = (await restarted.call('GET', `ai/tasks/${request.id}`)).body
  assert.equal(recovered.executor, 'builtin'); assert.equal(recovered.released, false)
  assert.equal(recovered.candidate.summary, 'Retained external result')
  assert.equal((await restarted.call('POST', 'ai/tasks', request)).body.externalPath, undefined)
})

test('privacy changes serialize with asynchronous external candidate commits before acknowledging revocation', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath.slice(5)
  let entered, resume
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { resume = resolve })
  const persist = value.manager.persist.bind(value.manager)
  value.manager.persist = async (task, meta = task.meta) => {
    if (meta.executor === 'external' && meta.candidateRevision === 1) { entered(); await gate }
    return persist(task, meta)
  }
  const pending = value.call('POST', `${base}/submit`, submission(original.document))
  await started
  const committing = value.manager.documentOperations.get(original.id)
  const changing = privacyChange(value, original, true)
  for (let i = 0; i < 100 && value.manager.documentOperations.get(original.id) === committing; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.notEqual(value.manager.documentOperations.get(original.id), committing)
  assert.equal(value.store.privacyMeta(original.id).private, false)
  resume()
  assert.equal((await pending).status, 200)
  assert.equal((await changing).status, 200)
  assert.equal((await value.call('POST', `${base}/submit`, submission(original.document))).status, 404)
  const retained = (await value.call('GET', `ai/tasks/${request.id}`)).body
  assert.equal(retained.executor, 'builtin'); assert.equal(retained.candidateRevision, 1)
})

test('in-flight public context reads recheck privacy after asynchronous snapshot access', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath.slice(5)
  let entered, resume
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { resume = resolve })
  const load = value.manager.loadRequest.bind(value.manager)
  value.manager.loadRequest = async task => { entered(); await gate; return load(task) }
  const pending = value.call('GET', `${base}/manifest.json`)
  await started
  assert.equal((await privacyChange(value, original, true)).status, 200)
  resume()
  assert.equal((await pending).status, 404)
})
