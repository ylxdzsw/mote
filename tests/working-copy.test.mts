import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import type { WorkingRecord } from '../src/cloud/workingCopies.ts'
import type { CloudDocument } from '../src/cloud/api.ts'

// Transactional, structured-clone storage; browser integration covers real IndexedDB.
const rows = new Map<string, WorkingRecord>()
let failWrite = false
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
  open() {
    const request: any = {}
    queueMicrotask(() => {
      request.result = { transaction() {
        const writes = new Map<string, WorkingRecord>(), tx: any = {}
        tx.objectStore = () => ({
          put(record: WorkingRecord) { writes.set(record.key, structuredClone(record)); return { result: record.key } },
          get(key: string) { return { result: structuredClone(rows.get(key)) } },
          getAll() { return { result: structuredClone([...rows.values()]) } },
        })
        queueMicrotask(() => {
          if (writes.size && failWrite) { tx.error = new Error('Local storage unavailable'); tx.onabort(); return }
          for (const [key, record] of writes) rows.set(key, record)
          tx.oncomplete()
        })
        return tx
      } }
      request.onsuccess()
    })
    return request
  },
} })
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { WorkingCopy } = await server.ssrLoadModule('/src/cloud/WorkingCopy.ts')
const { createCopyRecord, saveWorkingCopy, forkWorkingCopy } = await server.ssrLoadModule('/src/cloud/workingCopies.ts')
const { createBlankDocument } = await server.ssrLoadModule('/src/document/model.ts')
const { retryConnection } = await server.ssrLoadModule('/src/cloud/connection.ts')
const originalFetch = globalThis.fetch
after(async () => { globalThis.fetch = originalFetch; delete (globalThis as any).indexedDB; await server.close() })

const cloud = new Map<string, CloudDocument>(), operations = new Map<string, { body: string; result: CloudDocument }>()
const calls: { path: string; method: string; body: any }[] = []
let loseCreate = false, failPrivacy = false, duringCreate: (() => void) | undefined
globalThis.fetch = async (input, options) => {
  const path = String(input), method = options?.method ?? 'GET', body = options?.body ? JSON.parse(String(options.body)) : undefined
  calls.push({ path, method, body })
  if (path === '/api/settings') return Response.json({ revision: 0, models: { builtin: '', indexing: '' }, indexingEnabled: false })
  if (path.endsWith('/shares')) return Response.json({ share: null, revision: 0 })
  if (method === 'POST') {
    const stored = [...rows.values()].find(record => record.meta.id === body.id)
    assert.deepEqual(stored?.pendingCreate, body, 'creation is durable before POST')
    const old = operations.get(body.operationId)
    if (old) assert.equal(JSON.stringify(body), old.body, 'uncertain creation body is immutable')
    const result = old?.result ?? { id: body.id, document: body.document, name: body.name, revision: '1', private: body.private ?? false,
      privacyRevision: 0, createdAt: 1, updatedAt: 1 }
    if (!old) { cloud.set(body.id, result); operations.set(body.operationId, { body: JSON.stringify(body), result }) }
    duringCreate?.(); duringCreate = undefined
    if (loseCreate) { loseCreate = false; throw new TypeError('response lost') }
    return Response.json(result)
  }
  const id = path.split('/')[3], current = cloud.get(id)!
  if (path.endsWith('/privacy')) {
    if (failPrivacy) throw new TypeError('privacy unavailable')
    if (method === 'PUT') {
      assert.equal(body.basePrivacyRevision, current.privacyRevision)
      cloud.set(id, { ...current, private: body.private, privacyRevision: current.privacyRevision + 1 })
    }
    return Response.json(cloud.get(id))
  }
  if (method === 'PUT') {
    assert.equal(body.baseRevision, current.revision)
    cloud.set(id, { ...current, document: body.document, revision: String(Number(current.revision) + 1) })
  }
  return Response.json(cloud.get(id))
}

function draft(privateDocument = false): WorkingRecord {
  return createCopyRecord(createBlankDocument(), 'Imported', 'test-session', privateDocument)
}
function edited(record: WorkingRecord, text: string) {
  return { ...record.document, authoring: { notes: [text] } }
}
function reload(key: string) {
  const record = structuredClone(rows.get(key)!)
  // Object identity is not a document revision, including after independent decoding.
  if (record.pendingCreate) record.pendingCreate.document = structuredClone(record.pendingCreate.document)
  return new WorkingCopy(record)
}
async function reset() {
  rows.clear(); cloud.clear(); operations.clear(); calls.length = 0
  loseCreate = false; failPrivacy = false; failWrite = false; duringCreate = undefined
  await retryConnection(); calls.length = 0
}

test('creation identity, privacy, and copy recovery', async t => {
  await t.test('Settings Private creates a blank draft privately, without a follow-up PUT', async () => {
    await reset()
    const record = draft(); delete record.pendingCreate; record.dirty = false
    const copy = new WorkingCopy(record)
    await copy.setPrivate(true, () => { throw new Error('draft cannot have a public link') })
    assert.deepEqual(calls.map(call => call.method), ['POST'])
    assert.equal(calls[0].body.private, true)
    assert.equal(copy.getSnapshot().record.meta.private, true)
    assert.equal(copy.getSnapshot().privacy.pending, undefined)
    assert.equal(rows.get(record.key)?.pendingPrivacy, undefined)
  })

  await t.test('import/private create response loss replays after reload, with no spurious content save', async () => {
    for (const privateDocument of [false, true]) {
      await reset()
      const record = draft(privateDocument), copy = new WorkingCopy(record)
      loseCreate = true
      assert.equal(await copy.sync(), null)
      const recovered = reload(record.key)
      assert.ok(await recovered.sync())
      assert.equal(cloud.size, 1)
      assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), [record.pendingCreate, record.pendingCreate])
      assert.equal(calls.filter(call => call.method === 'PUT').length, 0)
      assert.equal(recovered.getSnapshot().record.meta.private, privateDocument)
    }
  })

  await t.test('lost Settings Private creation is confirmed after reload at privacy revision zero', async () => {
    await reset()
    const record = draft(); delete record.pendingCreate
    const copy = new WorkingCopy(record)
    loseCreate = true
    await copy.setPrivate(true, () => true)
    const recovered = reload(record.key)
    await recovered.retryPrivacy()
    assert.equal(recovered.getSnapshot().privacy.pending, undefined)
    assert.equal(recovered.getSnapshot().record.meta.private, true)
    assert.equal(calls.filter(call => call.method === 'PUT').length, 0)
  })

  await t.test('an already-uncertain nonprivate body stays unchanged before newer edits and privacy drain', async () => {
    await reset()
    const record = draft(), copy = new WorkingCopy(record)
    loseCreate = true
    await copy.sync()
    const recovered = reload(record.key)
    recovered.update(edited(record, 'newer local work'))
    await recovered.setPrivate(true, () => true)
    assert.equal(cloud.size, 1)
    assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), [record.pendingCreate, record.pendingCreate])
    assert.equal(cloud.get(record.meta.id)?.private, true)
    assert.deepEqual(cloud.get(record.meta.id)?.document.authoring?.notes, ['newer local work'])
    assert.equal(recovered.getSnapshot().privacy.pending, undefined)
  })

  await t.test('Save as copy retains a single private target across response loss, reload, and edits', async () => {
    await reset()
    const source = draft(true); delete source.pendingCreate; delete source.draft; source.meta.private = true
    await saveWorkingCopy(source)
    const copy = new WorkingCopy(source)
    loseCreate = true
    const first = copy.saveAs('Copy'), duplicate = copy.saveAs('Duplicate click')
    assert.equal(first, duplicate)
    assert.equal(await first, null)
    const recovered = reload(source.key)
    recovered.update(edited(source, 'after failure'))
    duringCreate = () => recovered.update(edited(source, 'during retry'))
    const result = await recovered.saveAs('Retry name')
    assert.ok(result)
    assert.equal(cloud.size, 1)
    assert.equal(result.private, true)
    assert.equal(result.name, 'Copy')
    assert.deepEqual(result.document.authoring?.notes, ['during retry'])
    assert.deepEqual(rows.get(source.key)?.document.authoring?.notes, ['during retry'])
    assert.equal(rows.get(source.key)?.meta.id, source.meta.id)
    assert.equal(rows.get(source.key)?.pendingCopy, undefined)
    const posts = calls.filter(call => call.method === 'POST')
    assert.equal(posts.length, 2)
    assert.deepEqual(posts[0].body, posts[1].body)
  })

  await t.test('separately edited recovery is not overwritten by Save as copy retry', async () => {
    await reset()
    const source = draft(); delete source.pendingCreate; delete source.draft
    await saveWorkingCopy(source)
    const copy = new WorkingCopy(source)
    loseCreate = true
    await copy.saveAs('Copy')
    const key = rows.get(source.key)!.pendingCopy!.key, target = rows.get(key)!
    rows.set(key, { ...target, document: edited(target, 'separate recovery edit') })
    assert.equal(await reload(source.key).saveAs('Retry'), null)
    assert.deepEqual(rows.get(key)?.document.authoring?.notes, ['separate recovery edit'])
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  })

  await t.test('recovering in another tab forks the pending target without changing its operation', async () => {
    await reset()
    const source = draft(); delete source.pendingCreate; delete source.draft
    await saveWorkingCopy(source)
    loseCreate = true
    await new WorkingCopy(source).saveAs('Copy')
    const original = structuredClone(rows.get(source.key)!), originalTarget = structuredClone(rows.get(original.pendingCopy!.key)!)
    const fork = await forkWorkingCopy(original, 'another-session')
    assert.equal(fork.pendingCopy.key, `another-session:${originalTarget.meta.id}`)
    assert.ok(await new WorkingCopy(fork).saveAs('Retry'))
    assert.deepEqual(rows.get(source.key), original)
    assert.deepEqual(rows.get(originalTarget.key), originalTarget)
    assert.equal(cloud.size, 1)
  })

  await t.test('local write failure sends no create, and privacy failure explains connectivity only once', async () => {
    await reset()
    const record = draft(), copy = new WorkingCopy(record)
    failWrite = true
    assert.equal(await copy.sync(), null)
    assert.equal(calls.length, 0)
    failWrite = false
    assert.ok(await copy.sync())
    failPrivacy = true
    await copy.setPrivate(true, () => true)
    const error = copy.getSnapshot().privacy.error
    assert.equal(error.split('Could not reach Mote').length - 1, 1)
    assert.match(error, /Check the server or retry/)
    assert.ok(copy.getSnapshot().privacy.pending)
  })
})
