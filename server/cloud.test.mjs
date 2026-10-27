import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createMotedServer } from './moted.mjs'
import { backupDatabase } from './backup.mjs'
import { muRunner, workerStorageProperties } from './runner.mjs'
import { MAX_BODY } from './validation.mjs'

const origin = 'http://localhost:5173'
const image = 'data:image/png;base64,iVBORw0KGgo='
function document(id = randomUUID(), value = 'Hello') {
  return { id, format: 'mote', version: 1, language: 'en', page: { width: 960, margins: { top: 48, right: 48, bottom: 48, left: 48 } },
    theme: { appearance: { mode: 'light', primaryHue: 145, secondaryHue: 260 }, autospace: true, defaults: { family: 'sans', size: 16, color: 'gray1', weight: 400, lineHeight: { value: 1.5, unit: 'ratio' }, spaceBefore: { value: 0, unit: 'em' }, spaceAfter: { value: 1, unit: 'em' }, letterSpacing: { value: 0, unit: 'em' } }, paragraphs: {}, objects: {}, flow: {} },
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text: value }] }] },
    objects: [{ id: 'image-1', kind: 'image', src: image, alt: 'test', layout: { width: 100, placement: { type: 'float', anchorId: 'block-1', x: 0, y: 0 } } }],
  }
}
async function app(t, options = {}) {
  const root = options.root || await mkdtemp(path.join(os.tmpdir(), 'mote-cloud-test-'))
  if (!options.root) t.after(() => rm(root, { recursive: true, force: true }))
  const value = await createMotedServer({ ...options, stateDir: root, backupDir: path.join(root, 'backups'), port: 0, useSystemd: false, allowDirectTasks: false, env: { MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: origin, MOTED_SHARED_MU_DIR: path.join(root, 'unused-config'), MOTED_MU_ENV_SOURCE: '', MOTED_FAKE_DELAY_MS: '0', ...options.env } })
  if (!options.root && options.workspaceModel !== '') value.store.putSettings({ baseRevision: 0, models: { builtin: 'fake', indexing: '' } })
  await value.start()
  t.after(() => value.close())
  value.root = root
  value.call = async (method, suffix, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${value.server.address().port}${suffix.startsWith('/') ? suffix : `/api/${suffix}`}`, { method, headers: { origin, 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  return value
}
async function create(value, doc = document()) {
  const result = await value.call('POST', 'documents', { id: doc.id, name: 'Note', document: doc, operationId: randomUUID() })
  assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(typeof result.body.createdAt, 'number'); assert.equal(typeof result.body.updatedAt, 'number'); return result.body
}
const save = (envelope, text, extra = {}) => ({ baseRevision: envelope.revision, document: document(envelope.id, text), operationId: randomUUID(), ...extra })
const shareMutation = (value, id, baseRevision, action, operationId = randomUUID()) => value.call('PUT', `documents/${id}/shares`, { baseRevision, operationId, action })

test('workspace model defaults are provider-free, durable, validated and revision checked', async t => {
  let runs = 0
  const value = await app(t, { workspaceModel: '', runner: async () => { runs++ } })
  const original = await create(value)
  const initial = await value.call('GET', 'settings')
  assert.deepEqual(initial.body, { revision: 0, models: { builtin: '', indexing: '' }, indexingEnabled: false })
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
  assert.equal(await restarted.manager.resolveModel(), '')
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
  assert.equal((await shareMutation(value, original.id, 0, 'enable')).status, 200)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(failed.meta.attempt, 1); assert.equal(value.manager.queue.length, 0)
  await value.close()
  const restarted = await app(t, { root: value.root, runner: async () => { assert.fail('must not rerun on restart') } })
  assert.equal(restarted.manager.tasks.get(id).meta.status, 'error')
  assert.deepEqual((await restarted.call('GET', `documents/${original.id}`)).body.document, saved.body.document)
})

test('missing model ignores global defaults, starts no worker, and leaves cloud work usable', async t => {
  const value = await app(t, { workspaceModel: '', env: { MOTED_MU_DEFAULT_MODEL: 'global/ignored' },
    runner: async () => assert.fail('missing configuration must not start a worker') })
  const bin = path.join(value.root, 'configured-mu'), marker = path.join(value.root, 'mu-called')
  await writeFile(bin, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); console.log(JSON.stringify({model:{canonical:'mu/ignored'}}))
`, { mode: 0o700 })
  value.manager.env.MOTED_MU_BIN = bin
  const original = await create(value)
  const body = { id: randomUUID(), cloudDocumentId: original.id, baseRevision: original.revision, operationId: randomUUID(),
    document: original.document, prompt: 'Test unavailable model', target: { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: false, area: { x: 48, y: 48, width: 200, height: 40 } } }
  await reservations(value, original, [body])
  const result = await value.call('POST', 'ai/tasks', body)
  assert.equal(result.status, 400)
  assert.match(result.body.error, /Choose a model in Settings/)
  await assert.rejects(stat(marker), { code: 'ENOENT' })
  assert.equal(value.manager.tasks.size, 0)
  assert.equal((await value.call('GET', 'settings')).status, 200)
  assert.equal((await value.call('GET', `documents/${original.id}`)).status, 200)
  assert.equal((await value.call('PUT', `documents/${original.id}`, save(original, 'Still usable'))).status, 200)
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

test('private creation is validated; latest links are revoked and never revive', async t => {
  const value = await app(t); const doc = document(); const base = `documents/${doc.id}`
  const request = { id: doc.id, name: 'Private note', document: doc, private: true, operationId: randomUUID() }
  const created = await value.call('POST', 'documents', request)
  assert.equal(created.status, 201); assert.equal(created.body.private, true); assert.equal(created.body.privacyRevision, 0)
  assert.equal((await value.call('GET', base)).status, 200)
  assert.equal((await value.call('GET', `${base}/assistant`)).status, 200)
  assert.ok((await value.call('GET', 'documents')).body.documents.some(item => item.id === doc.id && item.private))
  assert.deepEqual((await value.call('GET', `${base}/shares`)).body, { revision: 0, share: null })
  assert.equal((await shareMutation(value, doc.id, 0, 'enable')).status, 403)
  const invalidDoc = document()
  assert.equal((await value.call('POST', 'documents', { id: invalidDoc.id, name: 'Invalid', document: invalidDoc, private: 'true', operationId: randomUUID() })).status, 400)

  const publicDoc = await create(value)
  const publicBase = `documents/${publicDoc.id}`
  const latest = (await shareMutation(value, publicDoc.id, 0, 'enable')).body.share
  assert.deepEqual((await value.call('GET', `${publicBase}/shares`)).body, { revision: 1, share: latest })
  const staleConfirmation = await value.call('PUT', `${publicBase}/privacy`, { private: true, basePrivacyRevision: 0, baseShareRevision: 0, operationId: randomUUID() })
  assert.equal(staleConfirmation.status, 409)
  assert.equal(staleConfirmation.body.current.private, false)
  assert.equal((await value.call('GET', `shared/${latest.token}`)).status, 200)
  const privateMeta = await value.call('PUT', `${publicBase}/privacy`, { private: true, basePrivacyRevision: 0, baseShareRevision: 1, operationId: randomUUID() })
  assert.equal(privateMeta.status, 200); assert.equal(privateMeta.body.privacyRevision, 1)
  assert.deepEqual((await value.call('GET', `${publicBase}/shares`)).body, { revision: 2, share: null })
  assert.equal((await value.call('GET', `shared/${latest.token}`)).status, 404)
  const forbidden = await shareMutation(value, publicDoc.id, 2, 'enable')
  assert.equal(forbidden.status, 403); assert.match(forbidden.body.error, /Private/)
  await value.call('PUT', `${publicBase}/privacy`, { private: false, basePrivacyRevision: 1, operationId: randomUUID() })
  assert.deepEqual((await value.call('GET', `${publicBase}/shares`)).body, { revision: 3, share: null })
  assert.equal((await value.call('GET', `shared/${latest.token}`)).status, 404)
  const fresh = await shareMutation(value, publicDoc.id, 3, 'enable')
  assert.equal(fresh.status, 200); assert.notEqual(fresh.body.share.token, latest.token)
})

test('create retries are idempotent; rename is separate; overwrite uses CAS without recovery copies', async t => {
  const value = await app(t); const doc = document()
  const request = { id: doc.id, name: 'Original', document: doc, operationId: randomUUID() }
  const first = await value.call('POST', 'documents', request)
  const renamed = await value.call('PATCH', `documents/${doc.id}`, { name: 'Renamed' })
  assert.equal(renamed.body.revision, first.body.revision)
  assert.equal(renamed.body.document, undefined)
  assert.deepEqual((await value.call('POST', 'documents', request)).body, first.body)
  const share = (await shareMutation(value, doc.id, 0, 'enable')).body.share
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
  assert.deepEqual((await value.call('GET', `shared/${share.token}`)).body.document, replacement.document)
})

test('single latest share is CAS-controlled, retry-safe, and revoked on deletion', async t => {
  const value = await app(t); const original = await create(value)
  const base = `documents/${original.id}`
  assert.deepEqual((await value.call('GET', `${base}/shares`)).body, { revision: 0, share: null })
  assert.equal((await value.call('POST', `${base}/shares`, { mode: 'latest' })).status, 404)
  assert.equal((await value.call('DELETE', `${base}/shares/${randomUUID()}`)).status, 404)

  const enableOperation = randomUUID()
  const enabled = await shareMutation(value, original.id, 0, 'enable', enableOperation)
  assert.equal(enabled.status, 200); assert.equal(enabled.body.revision, 1)
  const first = enabled.body.share
  assert.equal(Buffer.from(first.token, 'base64url').length, 32)

  const stale = await shareMutation(value, original.id, 0, 'disable')
  assert.equal(stale.status, 409); assert.deepEqual(stale.body.current, enabled.body)
  const duplicateEnable = await shareMutation(value, original.id, 1, 'enable')
  assert.equal(duplicateEnable.status, 409); assert.deepEqual(duplicateEnable.body.current, enabled.body)

  const replaceOperation = randomUUID()
  const replaced = await shareMutation(value, original.id, 1, 'replace', replaceOperation)
  assert.equal(replaced.status, 200); assert.equal(replaced.body.revision, 2)
  const second = replaced.body.share
  assert.notEqual(second.token, first.token)
  assert.equal((await value.call('GET', `shared/${first.token}`)).status, 404)
  assert.deepEqual((await value.call('GET', `shared/${second.token}`)).body.document, original.document)
  assert.deepEqual((await shareMutation(value, original.id, 0, 'enable', enableOperation)).body, replaced.body)

  assert.throws(() => value.store.db.prepare("INSERT INTO shares(id,documentId,token,mode,revision,createdAt) VALUES (?,?,?,'latest',NULL,?)")
    .run(randomUUID(), original.id, randomBytes(32).toString('base64url'), Date.now()))

  const mutation = save(original, 'Published later')
  const updated = (await value.call('PUT', base, mutation)).body
  const publicLatest = await value.call('GET', `shared/${second.token}`, undefined, { origin: 'http://untrusted.test' })
  assert.equal(publicLatest.status, 200); assert.deepEqual(publicLatest.body, { name: original.name, revision: updated.revision, document: updated.document })
  assert.equal(publicLatest.headers.get('cache-control'), 'no-store'); assert.equal(publicLatest.headers.get('referrer-policy'), 'no-referrer'); assert.match(publicLatest.headers.get('x-robots-tag'), /noindex/)
  assert.equal(publicLatest.headers.get('access-control-allow-origin'), null)

  const disabled = await shareMutation(value, original.id, 2, 'disable')
  assert.equal(disabled.status, 200); assert.deepEqual(disabled.body, { revision: 3, share: null })
  assert.equal((await value.call('GET', `shared/${second.token}`)).status, 404)
  assert.deepEqual((await shareMutation(value, original.id, 1, 'replace', replaceOperation)).body, disabled.body)
  const replaceWhenDisabled = await shareMutation(value, original.id, 3, 'replace')
  assert.equal(replaceWhenDisabled.status, 409); assert.deepEqual(replaceWhenDisabled.body.current, disabled.body)
  assert.deepEqual((await shareMutation(value, original.id, 3, 'disable')).body, disabled.body)

  const reenabled = await shareMutation(value, original.id, 3, 'enable')
  assert.equal(reenabled.status, 200); assert.equal(reenabled.body.revision, 4)
  assert.notEqual(reenabled.body.share.token, first.token)
  assert.equal((await value.call('DELETE', base, { baseRevision: original.revision })).status, 409)
  assert.equal((await value.call('DELETE', base, { baseRevision: updated.revision })).status, 200)
  assert.equal((await value.call('GET', `shared/${reenabled.body.share.token}`)).status, 404)
  assert.equal(value.store.db.prepare('SELECT shareRevision FROM documents WHERE id=?').get(original.id).shareRevision, 5)
  for (const [method, suffix, body] of [['GET', '', undefined], ['PUT', '', mutation], ['PATCH', '', { name: 'Back' }], ['GET', '/assistant', undefined], ['PUT', '/assistant', { baseRevision: '0', tasks: [], operationId: randomUUID() }]]) {
    assert.equal((await value.call(method, base + suffix, body)).status, 410)
  }
  assert.equal((await value.call('POST', `${base}/shares`, { mode: 'latest' })).status, 404)
  assert.equal((await value.call('POST', 'documents', { id: original.id, name: 'Resurrection', document: original.document, operationId: randomUUID() })).status, 410)
  assert.deepEqual((await value.call('GET', 'documents')).body, { documents: [] })
  assert.equal((await value.call('GET', `documents/${randomUUID()}`)).status, 404)
})

test('legacy snapshot links are revoked during the single-latest transition without changing latest tokens', async t => {
  const value = await app(t), original = await create(value)
  const latest = (await shareMutation(value, original.id, 0, 'enable')).body.share
  await value.close()

  const legacy = new DatabaseSync(value.store.databasePath)
  legacy.exec('DROP INDEX active_share; ALTER TABLE documents DROP COLUMN shareRevision')
  const snapshotToken = randomBytes(32).toString('base64url')
  legacy.prepare("INSERT INTO shares(id,documentId,token,mode,revision,createdAt) VALUES (?,?,?,'snapshot',?,?)")
    .run(randomUUID(), original.id, snapshotToken, original.revision, Date.now())
  legacy.close()

  const restarted = await app(t, { root: value.root })
  assert.deepEqual((await restarted.call('GET', `documents/${original.id}/shares`)).body, { revision: 1, share: latest })
  assert.equal((await restarted.call('GET', `shared/${latest.token}`)).status, 200)
  assert.equal((await restarted.call('GET', `shared/${snapshotToken}`)).status, 404)
  assert.equal(restarted.store.db.prepare("SELECT count(*) AS n FROM shares WHERE documentId=? AND mode='snapshot' AND revokedAt IS NULL").get(original.id).n, 0)
  assert.equal(restarted.store.db.prepare("SELECT count(*) AS n FROM shares WHERE documentId=? AND mode='latest' AND revokedAt IS NULL").get(original.id).n, 1)
})

test('Notes round-trip through saves, validate as a notes array, affect retries, and stay out of public shares', async t => {
  const value = await app(t), doc = document()
  doc.authoring = { notes: ['Outline and unverified plan'], aiModel: 'private/model' }
  const original = await create(value, doc), base = `documents/${original.id}`
  assert.deepEqual((await value.call('GET', base)).body.document.authoring.notes, doc.authoring.notes)
  const latest = (await shareMutation(value, doc.id, 0, 'enable')).body.share

  const updatedDocument = { ...original.document, authoring: { notes: ['Updated working notes', 'Another outline', ''] } }
  const operation = { baseRevision: original.revision, document: updatedDocument, operationId: randomUUID() }
  const saved = await value.call('PUT', base, operation)
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.document.authoring.notes, updatedDocument.authoring.notes)
  assert.deepEqual((await value.call('GET', base)).body.document.authoring.notes, updatedDocument.authoring.notes)
  assert.equal((await value.call('PUT', base, { ...operation, document: { ...updatedDocument, authoring: { notes: ['Different retry input'] } } })).status, 409)
  for (const notes of [null, 1, { text: 'not plain text' }, ['Valid note', null], [1], [['Nested note']]]) {
    assert.equal((await value.call('PUT', base, {
      baseRevision: saved.body.revision, document: { ...updatedDocument, authoring: { notes } }, operationId: randomUUID(),
    })).status, 400)
  }

  const publicLatest = await value.call('GET', `shared/${latest.token}`)
  const { authoring: _authoring, ...publicUpdated } = updatedDocument
  assert.equal(Object.hasOwn(publicLatest.body.document, 'authoring'), false)
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

test('save validates V1, reads preserve unreadable old JSON, and all mutations enforce exact Origin', async t => {
  const value = await app(t); const original = await create(value); const base = `documents/${original.id}`
  const invalid = save(original, 'Bad'); invalid.document.version = 'bad'
  assert.equal((await value.call('PUT', base, invalid)).status, 400)
  assert.equal((await value.call('PUT', base, save(original, 'Bad origin'), { origin: 'https://mote.ylxdzsw.com.evil.test' })).status, 403)
  assert.equal((await value.call('PUT', `${base}/privacy`, { private: true, basePrivacyRevision: 0, operationId: randomUUID() }, { origin: 'https://mote.ylxdzsw.com.evil.test' })).status, 403)
  assert.equal((await value.call('PATCH', base, { name: 'Bad origin' }, { origin: '' })).status, 403)
  assert.equal((await value.call('DELETE', base, { baseRevision: original.revision }, { origin: 'null' })).status, 403)
  const link = (await shareMutation(value, original.id, 0, 'enable')).body.share
  const assistantOperation = { baseRevision: '0', tasks: [{ id: randomUUID(), candidate: { summary: 'Retained candidate' } }], operationId: randomUUID() }
  const assistant = await value.call('PUT', `${base}/assistant`, assistantOperation)
  assert.equal(assistant.status, 200)
  const old = { version: 'V0', id: original.id, floating: [], notes: 'Retain original bytes' }
  value.store.db.prepare('UPDATE revisions SET body=? WHERE revision=?').run(value.store.pack(old), original.revision)
  assert.deepEqual((await value.call('GET', base)).body.document, old)
  assert.equal((await value.call('PUT', base, save(original, 'Unsupported replacement'))).status, 400)
  assert.equal((await value.call('GET', `shared/${link.token}`)).status, 400)
  assert.equal((await shareMutation(value, original.id, 1, 'replace')).status, 400)
  assert.deepEqual((await value.call('GET', base)).body.document, old)
  assert.throws(() => value.store.workspaceDocument(original.id, original.id), { status: 400 })
  const removal = { baseRevision: assistant.body.revision, tasks: [], operationId: randomUUID() }
  const exactRemoval = JSON.stringify(removal)
  assert.equal((await value.call('PUT', `${base}/assistant`, removal)).status, 400)
  assert.equal((await value.call('PUT', `${base}/assistant`, removal)).status, 400)
  assert.equal(JSON.stringify(removal), exactRemoval)
  assert.deepEqual((await value.call('PUT', `${base}/assistant`, assistantOperation)).body, assistant.body)
  assert.equal((await value.call('PUT', `${base}/assistant`, { ...assistantOperation, tasks: [] })).status, 409)
  assert.deepEqual((await value.call('GET', `${base}/assistant`)).body, assistant.body)
  assert.equal(value.store.db.prepare('SELECT count(*) AS n FROM task_revocations WHERE documentId=?').get(original.id).n, 0)
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
  const base = creations[0].body.externalPath
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
  assert.equal((await restarted.call('GET', `${secondTask.body.externalPath}/document.json`)).status, 404)
  assert.equal((await restarted.call('GET', `ai/tasks/${second.id}`)).body.released, true)
  await readFile(path.join(restarted.manager.tasks.get(second.id).dir, 'input', 'document.json'))
})

test('cloud deletion is rechecked at candidate commit and survives restart without artifact cleanup', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath
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

test('external access pauses with document inactivity, survives restart, and resumes the same token only while authorized', async t => {
  const value = await app(t), original = await create(value), request = { ...portableRequest(original), workspaceRead: true }
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath
  assert.match(base, /^\/a\/[A-Za-z0-9_-]{22}$/)
  const proposed = submission(original.document)
  assert.equal((await value.call('POST', `${base}/submit`, proposed)).status, 200)
  const shared = (await shareMutation(value, original.id, 0, 'enable')).body.share
  const before = value.store.documentAccessUntil(original.id)
  assert.equal((await value.call('GET', `${base}/document.json`)).status, 200)
  assert.equal(value.store.documentAccessUntil(original.id), before)
  const staleAt = Date.now() - 25 * 60 * 60 * 1000
  value.store.db.prepare('UPDATE documents SET externalAccessAt=? WHERE id=?').run(staleAt, original.id)
  for (const resource of ['manifest.json', 'document.json', 'target.json', 'snapshot.png', 'candidates.json', 'candidates/C1.json', 'workspace-index.md']) {
    assert.equal((await value.call('GET', `${base}/${resource}`)).status, 423, resource)
  }
  assert.equal((await value.call('POST', `${base}/submit`, proposed)).status, 423)
  assert.equal((await value.call('POST', `${base}/candidates/C1/remove`, { operationId: randomUUID(), executorRevision: 0, candidateRevision: 1 })).status, 423)
  const pausedUntil = value.store.documentAccessUntil(original.id)
  assert.equal(pausedUntil < Date.now(), true)
  const paused = (await value.call('GET', `ai/tasks/${request.id}`)).body
  assert.equal(paused.accessPaused, true)
  assert.equal(paused.externalPath, base)
  assert.equal(paused.candidate.summary, proposed.candidate.summary)
  assert.equal((await value.call('GET', `shared/${shared.token}`)).status, 200)
  assert.equal((await value.call('GET', `documents/${original.id}/assistant`)).status, 200)
  assert.equal((await value.call('GET', `documents/${original.id}/privacy`)).status, 200)
  assert.equal((await value.call('GET', `documents/${original.id}`)).status, 200)
  assert.equal((await value.call('GET', `documents/${original.id}/shares`)).status, 200)
  assert.equal((await value.call('PATCH', `documents/${original.id}`, { name: 'Renamed from Files' })).status, 200)
  assert.equal(value.store.documentAccessUntil(original.id), pausedUntil)
  const shares = await value.call('GET', `documents/${original.id}/shares`)
  assert.equal((await shareMutation(value, original.id, shares.body.revision, 'disable')).status, 200)
  assert.equal(value.store.documentAccessUntil(original.id), pausedUntil)
  await value.close()
  const restarted = await app(t, { root: value.root })
  assert.equal((await restarted.call('GET', `${base}/document.json`)).status, 423)
  assert.equal((await restarted.call('GET', `documents/${original.id}/privacy`)).status, 200)
  assert.equal(restarted.store.documentAccessUntil(original.id), pausedUntil)
  const privacyMeta = restarted.store.privacyMeta.bind(restarted.store)
  restarted.store.privacyMeta = () => { throw new Error('simulated privacy read failure') }
  assert.equal((await restarted.call('GET', `documents/${original.id}/privacy?open=1`)).status, 500)
  assert.equal(restarted.store.documentAccessUntil(original.id), pausedUntil)
  restarted.store.privacyMeta = privacyMeta
  assert.equal((await restarted.call('GET', `documents/${original.id}/privacy?open=1`)).status, 200)
  assert.equal(restarted.store.documentAccessUntil(original.id) > Date.now(), true)
  assert.notEqual(restarted.store.documentAccessUntil(original.id), pausedUntil)
  assert.equal((await restarted.call('GET', `${base}/document.json`)).status, 200)
  const resumed = (await restarted.call('GET', `ai/tasks/${request.id}`)).body
  assert.equal(resumed.externalPath, base)
  assert.equal(resumed.accessPaused, false)
  assert.equal((await restarted.call('POST', `${base}/submit`, proposed)).body.candidateRevision, 1)
  assert.equal((await restarted.call('POST', `ai/tasks/${request.id}/release`, {})).status, 200)
  await restarted.call('GET', `documents/${original.id}`)
  assert.equal((await restarted.call('GET', `${base}/document.json`)).status, 404)
  const openedAt = restarted.store.db.prepare('SELECT externalAccessAt FROM documents WHERE id=?').get(original.id).externalAccessAt
  await privacyChange(restarted, original, true)
  await privacyChange(restarted, original, false)
  assert.equal(restarted.store.db.prepare('SELECT externalAccessAt FROM documents WHERE id=?').get(original.id).externalAccessAt, openedAt)
})

test('external submissions recheck document inactivity after asynchronous input loading', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath
  const load = value.manager.loadRequest.bind(value.manager)
  value.manager.loadRequest = async task => {
    const input = await load(task)
    value.store.db.prepare('UPDATE documents SET externalAccessAt=? WHERE id=?').run(Date.now() - 25 * 60 * 60 * 1000, original.id)
    return input
  }
  assert.equal((await value.call('POST', `${base}/submit`, submission(original.document))).status, 423)
  assert.equal(value.manager.tasks.get(request.id).meta.candidate, undefined)
})

test('Private revokes external context and delivery, preserves candidate/reservation, and keeps built-in generation available', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath
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
  assert.equal((await value.call('GET', `${fresh.body.externalPath}/document.json`)).status, 200)
})

test('privacy epochs revoke external grants across off/on cycles and restart even if task metadata cleanup fails', async t => {
  const value = await app(t), original = await create(value), request = portableRequest(original)
  await reservations(value, original, [request])
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath
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
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath
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
  const created = await value.call('POST', 'ai/tasks', request), base = created.body.externalPath
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
