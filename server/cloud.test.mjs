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
import { MAX_BODY, PROD_ORIGIN } from './validation.mjs'

const origin = 'http://localhost:5173'
const image = 'data:image/png;base64,iVBORw0KGgo='
function document(id = randomUUID(), value = 'Hello') {
  return { id, format: 'mote', version: 6, language: 'en', page: { width: 960, margins: { top: 48, right: 48, bottom: 48, left: 48 } },
    theme: { appearance: { mode: 'light', primaryHue: 145, secondaryHue: 260 }, autospace: true, defaults: { family: 'sans', size: 16, color: 'gray1', weight: 400, lineHeight: { value: 1.5, unit: 'ratio' }, spaceBefore: { value: 0, unit: 'em' }, spaceAfter: { value: 1, unit: 'em' }, letterSpacing: { value: 0, unit: 'em' } }, paragraphs: {}, objects: {}, flow: {} },
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text: value }] }] },
    objects: [{ id: 'image-1', kind: 'image', src: image, alt: 'test', layout: { width: 100, placement: { type: 'float', anchorId: 'block-1', x: 0, y: 0 } } }],
  }
}
async function app(t, options = {}) {
  const root = options.root || await mkdtemp(path.join(os.tmpdir(), 'mote-cloud-test-'))
  if (!options.root) t.after(() => rm(root, { recursive: true, force: true }))
  const value = await createMotedServer({ ...options, stateDir: root, backupDir: path.join(root, 'backups'), port: 0, useSystemd: false, env: { MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: origin, MOTED_SHARED_MU_DIR: path.join(root, 'unused-config'), MOTED_MU_ENV_SOURCE: '', MOTED_FAKE_DELAY_MS: '0', ...options.env } })
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

test('model suggestions whitelist Mu catalog fields, preserve arbitrary settings and share only concurrent lookups', async t => {
  const value = await app(t, { workspaceModel: '', env: { MOTED_MU_BIN: '/not-installed-mu' } })
  const fake = await value.call('GET', 'models')
  assert.equal(fake.status, 200)
  assert.equal(fake.headers.get('cache-control'), 'no-store')
  assert.deepEqual(fake.body, { models: [
    { reference: 'fake', efforts: [] },
    { reference: 'openai/gpt-4o', efforts: ['low', 'medium', 'high'] },
    { reference: 'gpt-4o', efforts: ['low', 'medium', 'high'] },
    { reference: 'anthropic/claude-3-7-sonnet', efforts: ['low', 'medium', 'high', 'max'] },
    { reference: 'claude-3-7-sonnet', efforts: ['low', 'medium', 'high', 'max'] },
  ] })

  const shared = path.join(value.root, 'catalog-config'), calls = path.join(value.root, 'catalog-calls'), bin = path.join(value.root, 'configured-mu')
  await mkdir(shared)
  await writeFile(path.join(shared, 'config.jsonc'), '{}')
  const status = {
    model: { id: 'selected/session-secret' },
    endpoint: 'https://private.endpoint.invalid', api_key: 'private-key', stdout: 'private stdout',
    available_models: { providers: [
      { id: 'vendor', endpoint: 'https://provider.endpoint.invalid', api_key_env: 'PRIVATE_TOKEN', models: [
        { id: 'vendor/model-a', model_id: 'model-a', supported_efforts: ['low', 'high', 'bad\neffort'], replay_key: 'private-replay-key', credentials: 'private-credential' },
      ] },
      { id: 'other', models: [
        { id: 'other/model-b', model_id: 'model-b', supported_efforts: ['medium', 'xhigh'] },
      ] },
    ] },
  }
  const encoded = JSON.stringify(status)
  await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.env.MU_CONFIG_DIR + String.fromCharCode(10))\nsetTimeout(() => process.stdout.write(${JSON.stringify(encoded)}), 80)\n`, { mode: 0o700 })
  value.manager.env.MOTED_FAKE_RUNNER = '0'
  delete value.manager.env.MOTED_MU_BIN
  value.manager.env.MOTED_MU = bin
  value.manager.env.MOTED_SHARED_MU_DIR = shared

  assert.equal((await value.call('GET', 'settings')).status, 200)
  const models = { builtin: 'not-in-catalog/custom:high', indexing: 'also-unknown' }
  const saved = await value.call('PUT', 'settings', { baseRevision: 0, models }, { origin: PROD_ORIGIN })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.models, models)
  await assert.rejects(readFile(calls), { code: 'ENOENT' })

  const [first, second] = await Promise.all([value.call('GET', 'models'), value.call('GET', 'models')])
  const expected = { models: [
    { reference: 'vendor/model-a', efforts: ['low', 'high'] },
    { reference: 'model-a', efforts: ['low', 'high'] },
    { reference: 'other/model-b', efforts: ['medium', 'xhigh'] },
    { reference: 'model-b', efforts: ['medium', 'xhigh'] },
  ] }
  for (const response of [first, second]) {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(response.body, expected)
    assert.deepEqual(Object.keys(response.body.models[0]).sort(), ['efforts', 'reference'])
    assert.doesNotMatch(JSON.stringify(response.body), /private|endpoint|stdout|selected\/session|credentials|replay/i)
  }
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), [shared])

  assert.deepEqual((await value.call('GET', 'models')).body, expected)
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), [shared, shared])
})

test('model catalog timeout returns a bounded actionable 422 without exposing Mu output', async t => {
  const value = await app(t, { workspaceModel: '', env: { MOTED_FAKE_RUNNER: '0' } })
  const shared = path.join(value.root, 'catalog-config'), bin = path.join(value.root, 'slow-mu')
  await mkdir(shared)
  await writeFile(path.join(shared, 'config.jsonc'), '{}')
  await writeFile(bin, `#!${process.execPath}\nprocess.stderr.write('private endpoint and key')\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
  value.manager.env.MOTED_SHARED_MU_DIR = shared
  value.manager.env.MOTED_MU_BIN = bin
  const started = Date.now()
  const response = await value.call('GET', 'models')
  assert.equal(response.status, 422)
  assert.equal(response.body.error, 'Mu model suggestions are unavailable. Configure providers in Mu locally, or enter a model reference manually.')
  assert.doesNotMatch(JSON.stringify(response.body), /private endpoint|key/i)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.ok(Date.now() - started < 5000)
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
  assert.deepEqual(Object.keys(conflict.current).sort(), ['archiveRevision', 'archived', 'createdAt', 'id', 'name', 'privacyRevision', 'private', 'revision', 'updatedAt'])
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
    id: original.id, name: original.name, revision: original.revision, createdAt: original.createdAt, updatedAt: original.updatedAt, private: false, privacyRevision: 0, archived: false, archiveRevision: 0,
  })
  assert.deepEqual(value.store.assertExternal(original.id), (await value.call('GET', `${base}/privacy`)).body)

  const enable = { private: true, basePrivacyRevision: 0, operationId: randomUUID() }
  const enabled = await value.call('PUT', `${base}/privacy`, enable)
  assert.equal(enabled.status, 200); assert.equal(enabled.body.private, true); assert.equal(enabled.body.privacyRevision, 1)
  assert.throws(() => value.store.assertExternal(original.id), error => error.status === 403)
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
  assert.equal(restarted.store.assertExternal(original.id).private, false)
  assert.deepEqual((await restarted.call('PUT', `${base}/privacy`, enable)).body, enabled.body)
  assert.equal((await restarted.call('GET', `${base}/privacy`)).body.privacyRevision, 2)
})

test('archive metadata is independent, durable, retry-safe, and leaves content, indexing and sharing alone', async t => {
  const value = await app(t), original = await create(value), base = `documents/${original.id}`
  assert.equal(original.archived, false); assert.equal(original.archiveRevision, 0)
  const share = (await shareMutation(value, original.id, 0, 'enable')).body
  const stream = await documentUpdates(value, original.id)
  t.after(stream.cancel)
  const indexDocuments = value.store.indexDocuments()
  let wakes = 0, reconciliations = 0
  const wake = value.indexer.wake, reconcile = value.manager.reconcileReservations
  value.indexer.wake = () => { wakes++ }
  value.manager.reconcileReservations = async () => { reconciliations++ }
  const archive = { archived: true, baseArchiveRevision: 0, operationId: randomUUID() }
  assert.equal((await value.call('PUT', `${base}/archive`, archive, { origin: 'https://other.invalid' })).status, 403)
  for (const invalid of [{ archived: 'true' }, { baseArchiveRevision: -1 }, { baseArchiveRevision: 0.5 }, { operationId: 'invalid' }]) {
    assert.equal((await value.call('PUT', `${base}/archive`, { ...archive, ...invalid })).status, 400)
  }
  const enabled = await value.call('PUT', `${base}/archive`, archive)
  const { document: native, reservations: _reservations, ...meta } = original
  assert.equal(enabled.status, 200)
  assert.deepEqual(enabled.body, { ...meta, archived: true, archiveRevision: 1 })
  assert.equal(enabled.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await value.call('PUT', `${base}/archive`, archive)).body, enabled.body)
  assert.equal((await value.call('PUT', `${base}/archive`, { ...archive, archived: false })).status, 409)
  const conflict = await value.call('PUT', `${base}/archive`, { ...archive, operationId: randomUUID() })
  assert.equal(conflict.status, 409); assert.deepEqual(conflict.body.current, enabled.body)
  assert.deepEqual((await value.call('PUT', `${base}/archive`, { ...archive, baseArchiveRevision: 1, operationId: randomUUID() })).body, enabled.body)
  await until(() => stream.messages.length === 2)
  assert.deepEqual(stream.messages, [{ kind: 'ready' }, { kind: 'document' }])
  assert.equal(wakes, 0); assert.equal(reconciliations, 0)
  value.indexer.wake = wake; value.manager.reconcileReservations = reconcile
  assert.deepEqual(value.store.indexDocuments(), indexDocuments)
  assert.equal(value.store.db.prepare('SELECT count(*) AS n FROM revisions').get().n, 1)
  assert.deepEqual(value.store.get(original.id).document, native)
  assert.deepEqual(value.store.shares(original.id), share)
  assert.equal((await value.call('GET', `/api/shared/${share.share.token}`)).status, 200)
  assert.equal(value.store.assertExternal(original.id).archived, true)
  assert.deepEqual((await value.call('GET', 'documents')).body.documents, [enabled.body])
  const stale = await value.call('PUT', base, save(original, 'Stale archive view', { archived: false, archiveRevision: 0 }))
  assert.equal(stale.status, 200); assert.equal(stale.body.archived, true); assert.equal(stale.body.archiveRevision, 1)
  const copy = await create(value, { ...native, id: randomUUID() })
  assert.equal(copy.archived, false); assert.equal(copy.archiveRevision, 0)
  await value.close()
  const restarted = await app(t, { root: value.root })
  assert.equal(restarted.store.privacyMeta(original.id).archived, true)
  const restored = await restarted.call('PUT', `${base}/archive`, { archived: false, baseArchiveRevision: 1, operationId: randomUUID() })
  assert.equal(restored.status, 200); assert.equal(restored.body.archiveRevision, 2)
  assert.equal(restored.body.revision, stale.body.revision); assert.equal(restored.body.updatedAt, stale.body.updatedAt)
  const renamed = await restarted.call('PATCH', base, { name: 'Renamed after unarchive' })
  assert.deepEqual((await restarted.call('PUT', `${base}/archive`, archive)).body, renamed.body)
  assert.equal(restarted.store.privacyMeta(original.id).archived, false)
  assert.equal(restarted.store.privacyMeta(original.id).archiveRevision, 2)
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
  for (const [method, suffix, body] of [['GET', '', undefined], ['PUT', '', mutation], ['PATCH', '', { name: 'Back' }], ['GET', '/assistant', undefined]]) {
    assert.equal((await value.call(method, base + suffix, body)).status, 410)
  }
  assert.equal((await value.call('POST', `${base}/shares`, { mode: 'latest' })).status, 404)
  assert.equal((await value.call('POST', 'documents', { id: original.id, name: 'Resurrection', document: original.document, operationId: randomUUID() })).status, 410)
  assert.deepEqual((await value.call('GET', 'documents')).body, { documents: [] })
  assert.equal((await value.call('GET', `documents/${randomUUID()}`)).status, 404)
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


test('saves validate incoming documents, reads preserve unsupported data, and mutations enforce exact Origin', async t => {
  const value = await app(t); const original = await create(value); const base = `documents/${original.id}`
  const invalid = save(original, 'Bad'); invalid.document.version = 'bad'
  assert.equal((await value.call('PUT', base, invalid)).status, 400)
  assert.equal((await value.call('PUT', base, save(original, 'Bad origin'), { origin: 'https://mote.ylxdzsw.com.evil.test' })).status, 403)
  assert.equal((await value.call('PUT', `${base}/privacy`, { private: true, basePrivacyRevision: 0, operationId: randomUUID() }, { origin: 'https://mote.ylxdzsw.com.evil.test' })).status, 403)
  assert.equal((await value.call('PATCH', base, { name: 'Bad origin' }, { origin: '' })).status, 403)
  assert.equal((await value.call('DELETE', base, { baseRevision: original.revision }, { origin: 'null' })).status, 403)
  const link = (await shareMutation(value, original.id, 0, 'enable')).body.share
  const old = { version: 'V0', id: original.id, floating: [], notes: 'Retain original bytes' }
  value.store.db.prepare('UPDATE revisions SET body=? WHERE revision=?').run(value.store.pack(old), original.revision)
  assert.deepEqual((await value.call('GET', base)).body.document, old)
  assert.equal((await value.call('GET', `shared/${link.token}`)).status, 400)
  assert.throws(() => value.store.workspaceDocument(original.id, original.id), { status: 400 })
  // Restore valid content for subsequent mutation tests
  const restored = await value.call('PUT', base, save(original, 'Restored from V0'))
  assert.equal(restored.status, 200)
  assert.equal(MAX_BODY, 128 * 1024 * 1024)
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

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('document update did not arrive')
}
async function documentUpdates(value, id) {
  const response = await fetch(`http://127.0.0.1:${value.server.address().port}/api/documents/${id}/events`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  const reader = response.body.getReader(), messages = [], decoder = new TextDecoder()
  const done = (async () => {
    let buffer = ''
    while (true) {
      const next = await reader.read(); if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2)
        if (frame.startsWith('event: update\n')) messages.push(JSON.parse(frame.slice('event: update\ndata: '.length)))
      }
    }
  })().catch(() => {})
  await until(() => messages.length > 0)
  assert.deepEqual(messages[0], { kind: 'ready' })
  return { messages, done, cancel: () => reader.cancel().catch(() => {}) }
}

test('document streams deliver only committed scoped changes and end after deletion', { timeout: 8000 }, async t => {
  const value = await app(t, { transcriptHeartbeatMs: 10 }), original = await create(value), other = await create(value)
  const base = `documents/${original.id}`
  const missing = await value.call('GET', `documents/${randomUUID()}/events`)
  assert.equal(missing.status, 404); assert.match(missing.headers.get('content-type'), /^application\/json/)
  const stream = await documentUpdates(value, original.id), isolated = await documentUpdates(value, other.id)
  t.after(stream.cancel); t.after(isolated.cancel)
  await value.call('GET', base); await value.call('GET', `${base}/privacy`); await value.call('GET', `${base}/assistant`)
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.deepEqual(stream.messages, [{ kind: 'ready' }])
  assert.equal((await value.call('PATCH', `documents/${other.id}`, { name: 'Other document' })).status, 200)
  await until(() => isolated.messages.length === 2)
  const remember = value.store.remember
  value.store.remember = () => { throw new Error('fake rollback after update') }
  assert.throws(() => value.store.put(original.id, save(original, 'Rolled back')))
  value.store.remember = remember
  assert.equal(value.store.get(original.id).revision, original.revision)
  const operation = save(original, 'Committed')
  const saved = await value.call('PUT', base, operation)
  assert.equal(saved.status, 200)
  await until(() => stream.messages.length === 2)
  assert.equal((await value.call('PUT', base, operation)).status, 200)
  assert.equal((await value.call('PUT', base, save(original, 'Conflict'))).status, 409)
  assert.equal((await value.call('PATCH', base, { name: 'Renamed' })).status, 200)
  assert.equal((await value.call('PUT', `${base}/privacy`, { private: true, basePrivacyRevision: 0, operationId: randomUUID() })).status, 200)
  await until(() => stream.messages.length === 4)
  assert.deepEqual(stream.messages.map(message => message.kind), ['ready', 'document', 'document', 'privacy'])
  assert.deepEqual(isolated.messages, [{ kind: 'ready' }, { kind: 'document' }])
  assert.equal((await value.call('DELETE', base, { baseRevision: saved.body.revision })).status, 200)
  await stream.done
  assert.deepEqual(stream.messages.at(-1), { kind: 'deleted' })
  const deleted = await value.call('GET', `${base}/events`)
  assert.equal(deleted.status, 410); assert.match(deleted.headers.get('content-type'), /^application\/json/)
})






const reservation = doc => ({ id: randomUUID(), documentId: doc.id, workspaceRead: false, original: doc.content.content,
  target: { kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: false, area: { x: 48, y: 48, width: 200, height: 40 } } })

test('reservations and content commit under one CAS, preserve omission, and roll back credentials on invalid saves', async t => {
  const value = await app(t), other = await app(t, { root: value.root })
  const doc = document(), item = reservation(doc)
  const original = (await value.call('POST', 'documents', { id: doc.id, name: 'Reserved', document: doc, reservations: [item], operationId: randomUUID() })).body
  assert.deepEqual(original.reservations, [item])
  assert.equal(value.manager.tasks.size, 0)
  const token = value.store.credential(item.id).token
  const left = save(original, 'Left', { reservations: [{ ...item, workspaceRead: true }] })
  const right = save(original, 'Right', { reservations: [{ ...item, released: true }] })
  const responses = await Promise.all([value.call('PUT', `documents/${doc.id}`, left), other.call('PUT', `documents/${doc.id}`, right)])
  assert.deepEqual(responses.map(item => item.status).sort(), [200, 409])
  let current = value.store.get(doc.id)
  const winner = responses.find(result => result.status === 200).body
  assert.deepEqual(current, winner)
  assert.equal(current.reservations[0].workspaceRead, current.document.content.content[0].content[0].text === 'Left')
  const omitted = await value.call('PUT', `documents/${doc.id}`, save(current, 'Non-editor save'))
  assert.equal(omitted.status, 200)
  assert.deepEqual(omitted.body.reservations, current.reservations)
  current = omitted.body
  const invalid = { ...item, id: randomUUID(), target: { ...item.target, blockIds: ['missing'] } }
  assert.equal((await value.call('PUT', `documents/${doc.id}`, save(current, 'Invalid', { reservations: [invalid] }))).status, 400)
  assert.equal(value.store.credential(invalid.id), undefined)
  assert.deepEqual(value.store.get(doc.id), current)
  assert.equal((await value.call('PUT', `documents/${doc.id}`, save(current, 'Overlap', { reservations: [item, { ...item, id: randomUUID() }] }))).status, 400)
  assert.equal((await value.call('PUT', `documents/${doc.id}`, save(current, 'Runtime leak', { reservations: [{ ...item, versions: [] }] }))).status, 400)
  assert.equal(value.store.credential(item.id).token, token)
  assert.deepEqual(value.store.envelope(value.store.row(doc.id), original.revision).reservations, [item])
})

test('release and undo restore the same durable token without document-side runtime state', async t => {
  const value = await app(t), doc = document(), item = reservation(doc)
  let saved = value.store.create({ id: doc.id, name: 'Undo', document: doc, reservations: [item], operationId: randomUUID() })
  const task = (await value.call('GET', `ai/tasks/${item.id}`)).body
  assert.equal(task.status, 'waiting')
  assert.equal(task.protocol, 'mote-agent-v5')
  assert.equal('executor' in task, false)
  const token = value.store.credential(item.id).token
  const proposal = { operationId: randomUUID(), candidate: { summary: 'Independent proposal', content: doc.content.content } }
  const receipt = await value.call('POST', `${task.externalPath}/submit`, proposal)
  assert.deepEqual(receipt.body, { taskId: item.id, versionId: 'V1', status: 'ready' })
  const release = save(saved, 'Applied', { reservations: [{ ...item, released: true }] })
  saved = (await value.call('PUT', `documents/${doc.id}`, release)).body
  assert.equal((await value.call('GET', `${task.externalPath}/versions.json`)).status, 410)
  const undo = save(saved, 'Undo', { reservations: [item] })
  saved = (await value.call('PUT', `documents/${doc.id}`, undo)).body
  assert.equal((await value.call('GET', `ai/tasks/${item.id}`)).body.externalPath, task.externalPath)
  assert.deepEqual((await value.call('POST', `${task.externalPath}/submit`, proposal)).body, receipt.body)
  assert.equal(saved.document.reservations, undefined)
  assert.equal(saved.reservations[0].token, undefined)
  assert.equal((await value.call('DELETE', `ai/tasks/${item.id}`)).status, 404)
  await value.close()
  const reopened = await app(t, { root: value.root })
  assert.equal(reopened.store.credential(item.id).token, token)
  assert.equal((await reopened.call('GET', `ai/tasks/${item.id}`)).body.versions.length, 1)
  assert.deepEqual((await reopened.call('PUT', `documents/${doc.id}`, undo)).body, saved)
  assert.equal(reopened.manager.active, 0)
})

test('legacy assistant records remain recoverable but cannot mutate current reservations', async t => {
  const value = await app(t), saved = await create(value)
  const artifacts = [{ id: randomUUID(), protocol: 'mote-agent-v4', candidate: { summary: 'recover' } }]
  value.store.db.prepare('UPDATE documents SET tasks=? WHERE id=?').run(value.store.pack(artifacts), saved.id)
  assert.deepEqual((await value.call('GET', `documents/${saved.id}/assistant`)).body.tasks, artifacts)
  assert.equal((await value.call('PUT', `documents/${saved.id}/assistant`, { baseRevision: '0', tasks: [], operationId: randomUUID() })).status, 404)
  assert.deepEqual(value.store.get(saved.id).reservations, [])
})

test('revise retries survive restart without automatic execution and expiry is reversible reservation state', async t => {
  let runs = 0
  const value = await app(t, { runner: async () => { runs++; throw new Error('intentional worker failure') } })
  const doc = document(), item = reservation(doc)
  let saved = value.store.create({ id: doc.id, name: 'Retry', document: doc, reservations: [item], operationId: randomUUID() })
  const task = (await value.call('GET', `ai/tasks/${item.id}`)).body
  const operation = { prompt: 'Run once', model: 'fake', operationId: randomUUID() }
  assert.equal((await value.call('POST', `ai/tasks/${item.id}/revise`, operation)).status, 202)
  await until(() => runs === 1 && value.manager.tasks.get(item.id).executions.size === 0)
  assert.equal((await value.call('POST', `ai/tasks/${item.id}/revise`, operation)).status, 202)
  assert.equal(runs, 1)
  await value.close()
  const reopened = await app(t, { root: value.root, runner: async () => { runs++ } })
  assert.equal((await reopened.call('POST', `ai/tasks/${item.id}/revise`, operation)).status, 202)
  assert.equal(runs, 1)
  assert.equal((await reopened.call('POST', `ai/tasks/${item.id}/revise`, { ...operation, prompt: 'Changed retry' })).status, 409)
  saved = (await reopened.call('PUT', `documents/${doc.id}`, save(saved, 'Expired', { reservations: [{ ...item, expiresAt: 1 }] }))).body
  assert.equal((await reopened.call('GET', `${task.externalPath}/manifest.json`)).status, 410)
  assert.equal((await reopened.call('GET', `ai/tasks/${item.id}`)).body.released, true)
  await reopened.call('PUT', `documents/${doc.id}`, save(saved, 'Reactivated', { reservations: [item] }))
  assert.equal((await reopened.call('GET', `${task.externalPath}/manifest.json`)).status, 200)
  assert.equal((await reopened.call('GET', `ai/tasks/${item.id}`)).body.externalPath, task.externalPath)
})
