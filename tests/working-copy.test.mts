import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import type { WorkingRecord } from '../src/cloud/workingCopies.ts'
import type { Reservation } from '../src/ai/types.ts'
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
const { mergeDocumentMeta, normalizeDocumentMeta } = await server.ssrLoadModule('/src/cloud/api.ts')
const { createCopyRecord, saveWorkingCopy, forkWorkingCopy } = await server.ssrLoadModule('/src/cloud/workingCopies.ts')
const { createBlankDocument } = await server.ssrLoadModule('/src/document/model.ts')
const { connectionSnapshot, retryConnection } = await server.ssrLoadModule('/src/cloud/connection.ts')
const originalFetch = globalThis.fetch
after(async () => { globalThis.fetch = originalFetch; delete (globalThis as any).indexedDB; await server.close() })

const cloud = new Map<string, CloudDocument>(), operations = new Map<string, { body: string; result: CloudDocument }>()
const calls: { path: string; method: string; body: any }[] = []
let loseCreate = false, loseSave = false, failPrivacy = false, duringCreate: (() => void) | undefined, duringSave: (() => void) | undefined
globalThis.fetch = async (input, options) => {
  const path = String(input), pathname = new URL(path, 'http://moted.local').pathname
  const method = options?.method ?? 'GET', body = options?.body ? JSON.parse(String(options.body)) : undefined
  calls.push({ path, method, body })
  if (pathname === '/api/settings') return Response.json({ revision: 0, models: { builtin: '', indexing: '' }, indexingEnabled: false })
  if (pathname.endsWith('/shares')) return Response.json({ share: null, revision: 0 })
  if (method === 'POST') {
    const stored = [...rows.values()].find(record => record.meta.id === body.id)
    assert.deepEqual(stored?.pendingCreate, body, 'creation is durable before POST')
    const old = operations.get(body.operationId)
    if (old) assert.equal(JSON.stringify(body), old.body, 'uncertain creation body is immutable')
    const result = old?.result ?? { id: body.id, document: body.document, reservations: body.reservations ?? [], name: body.name, revision: '1', private: body.private ?? false,
      privacyRevision: 0, archived: false, archiveRevision: 0, createdAt: 1, updatedAt: 1 }
    if (!old) { cloud.set(body.id, result); operations.set(body.operationId, { body: JSON.stringify(body), result }) }
    duringCreate?.(); duringCreate = undefined
    if (loseCreate) { loseCreate = false; throw new TypeError('response lost') }
    return Response.json(result)
  }
  const id = pathname.split('/')[3], current = cloud.get(id)!
  if (pathname.endsWith('/privacy')) {
    if (failPrivacy) throw new TypeError('privacy unavailable')
    if (method === 'PUT') {
      assert.equal(body.basePrivacyRevision, current.privacyRevision)
      cloud.set(id, { ...current, private: body.private, privacyRevision: current.privacyRevision + 1 })
    }
    return Response.json(cloud.get(id))
  }
  if (method === 'PUT') {
    const stored = [...rows.values()].find(record => record.meta.id === id)
    assert.deepEqual(stored?.pending, body, 'both fields and retry identity are durable before PUT')
    const old = operations.get(body.operationId)
    if (old) assert.equal(JSON.stringify(body), old.body, 'uncertain save body is immutable')
    else if (body.baseRevision !== current.revision) return Response.json({ error: 'Conflict', current }, { status: 409 })
    const result = old?.result ?? { ...current, document: body.document, reservations: body.reservations ?? current.reservations,
      revision: String(Number(current.revision) + 1) }
    if (!old) { cloud.set(id, result); operations.set(body.operationId, { body: JSON.stringify(body), result }) }
    duringSave?.(); duringSave = undefined
    if (loseSave) { loseSave = false; throw new TypeError('save response lost') }
    return Response.json(result)
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
  loseCreate = false; loseSave = false; failPrivacy = false; failWrite = false; duringCreate = undefined; duringSave = undefined
  await retryConnection(); calls.length = 0
}

test('privacy refresh validates current document metadata', async () => {
  await reset()
  const record = draft()
  delete record.draft; delete record.pendingCreate
  record.dirty = false; record.meta.revision = '1'
  cloud.set(record.meta.id, { ...record.meta, document: record.document })
  const copy = new WorkingCopy(record)
  await copy.refreshPrivacy()
  assert.equal(calls.find(call => call.method === 'GET')?.path, `/api/documents/${record.meta.id}/privacy`)
  assert.equal(connectionSnapshot().offline, false)
})

test('archive metadata refresh preserves local content and cannot be rolled back by stale save metadata', async () => {
  await reset()
  const record = draft()
  delete record.draft; delete record.pendingCreate
  record.meta.revision = '1'
  const copy = new WorkingCopy(record), document = copy.getSnapshot().record.document
  const archived = { ...record.meta, archived: true, archiveRevision: 1 }
  cloud.set(record.meta.id, { ...archived, document: record.document })
  await copy.refreshPrivacy()
  assert.equal(copy.getSnapshot().record.document, document)
  assert.equal(copy.getSnapshot().record.dirty, true)
  assert.equal(copy.getSnapshot().epoch, 0)
  assert.deepEqual(copy.getSnapshot().record.meta, archived)
  const merged = mergeDocumentMeta(archived, { ...record.meta, revision: '2', private: true, privacyRevision: 1 })
  assert.equal(merged.revision, '2')
  assert.equal(merged.private, true)
  assert.equal(merged.archived, true)
  assert.equal(merged.archiveRevision, 1)
  assert.equal(normalizeDocumentMeta({ ...record.meta, archived: undefined, archiveRevision: undefined }).archived, false)
  const freshCopy = createCopyRecord(document, 'Copy', 'test-session')
  assert.equal(freshCopy.meta.archived, false)
  assert.equal(freshCopy.meta.archiveRevision, 0)
  assert.equal('archived' in freshCopy.document, false)
})

test('stream deletion stays final across in-flight reads, saves, and local preservation', async () => {
  for (const operation of ['read', 'save', 'adopt']) {
    await reset()
    const record = draft()
    delete record.draft; delete record.pendingCreate
    record.dirty = operation === 'save'; record.meta.revision = '1'
    cloud.set(record.meta.id, { ...record.meta, document: record.document })
    const copy = new WorkingCopy(record), original = record.document
    const incoming = { ...record.meta, revision: '2', document: edited(record, 'Remote content') }
    let started!: () => void, release!: () => void
    const requested = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetch = globalThis.fetch
    try {
      if (operation === 'adopt') copy.preserveAssistant = async () => { started(); await gate }
      else {
        if (operation === 'read') cloud.set(record.meta.id, incoming)
        globalThis.fetch = async (input, options) => {
          const response = await fetch(input, options)
          if (String(input) === `/api/documents/${record.meta.id}`) { started(); await gate }
          return response
        }
      }
      const pending = operation === 'save' ? copy.sync() : operation === 'read' ? copy.checkRemote() : copy.adopt(incoming)
      await requested
      copy.remoteDeleted(); release(); await pending
      assert.equal(copy.getSnapshot().deleted, true, operation)
      assert.equal(copy.getSnapshot().record.document, original, operation)
      assert.equal(copy.getSnapshot().epoch, 0, operation)
    } finally { globalThis.fetch = fetch }
  }
})

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


function reservation(record: WorkingRecord): Reservation {
  return { id: crypto.randomUUID(), documentId: record.meta.id, workspaceRead: false, original: [],
    target: { kind: 'text', blockIds: [record.document.content.content![0].attrs!.id], selection: { from: 1, to: 1 },
      insert: false, area: { x: 0, y: 0, width: 200, height: 40 } } }
}
function savedRecord() {
  const record = draft()
  delete record.draft; delete record.pendingCreate
  record.dirty = false; record.meta.revision = '1'
  record.reservations = [reservation(record)]
  cloud.set(record.meta.id, { ...record.meta, document: record.document, reservations: record.reservations })
  return record
}

test('local acceptance retains prior edits and releases atomically through ordinary CAS', async () => {
  for (const stale of [false, true]) {
    await reset()
    const record = savedRecord(), copy = new WorkingCopy(record)
    const prior = edited(record, 'Prior dirty notes')
    copy.update(prior)
    const accepted = { ...prior, page: { ...prior.page, width: prior.page.width + 20 } }
    const released = [{ ...record.reservations[0], released: true }]
    if (stale) cloud.set(record.meta.id, { ...cloud.get(record.meta.id)!, revision: '2' })
    copy.update(accepted, released)
    assert.equal(calls.length, 0, 'local acceptance needs no preflight')
    assert.equal(copy.getSnapshot().record.document, accepted)
    assert.equal(copy.getSnapshot().record.reservations, released)
    const result = await copy.sync()
    assert.deepEqual(calls.map(call => call.method), ['PUT'])
    assert.deepEqual(calls[0].body.document.authoring.notes, ['Prior dirty notes'])
    assert.deepEqual(calls[0].body.reservations, released)
    if (stale) {
      assert.equal(result, null)
      assert.equal(copy.getSnapshot().conflict.revision, '2')
      assert.equal(copy.getSnapshot().record.document, accepted)
      assert.equal(copy.getSnapshot().record.reservations, released)
      assert.equal(copy.getSnapshot().record.dirty, true)
      assert.ok(await copy.overwrite())
      assert.equal(calls.at(-1)!.body.baseRevision, '2')
      assert.deepEqual(calls.at(-1)!.body.reservations, released)
    } else assert.equal(copy.getSnapshot().record.dirty, false)
    assert.deepEqual(cloud.get(record.meta.id)?.reservations, released)
    assert.equal('reservations' in cloud.get(record.meta.id)!.document, false)
  }
})

test('uncertain save replays both fields unchanged after reload before draining newer edits', async () => {
  await reset()
  const record = savedRecord(), copy = new WorkingCopy(record)
  const released = [{ ...record.reservations[0], released: true }]
  copy.update(edited(record, 'Accepted'), released)
  loseSave = true
  assert.equal(await copy.sync(), null)
  const first = calls.find(call => call.method === 'PUT')!.body
  const recovered = reload(record.key)
  assert.deepEqual(recovered.getSnapshot().record.reservations, released)
  recovered.update(record.document, record.reservations)
  const newer = [{ ...record.reservations[0], title: 'During save', workspaceRead: true }]
  duringSave = () => recovered.update(edited(record, 'Typed during save'), newer)
  assert.ok(await recovered.sync())
  const puts = calls.filter(call => call.method === 'PUT')
  assert.deepEqual(puts[1].body, first)
  assert.notEqual(puts[2].body.operationId, first.operationId)
  assert.equal(puts[2].body.baseRevision, '2')
  assert.deepEqual(cloud.get(record.meta.id)?.reservations, newer)
  assert.deepEqual(cloud.get(record.meta.id)?.document.authoring?.notes, ['Typed during save'])
  assert.equal(recovered.getSnapshot().record.dirty, false)
})

test('reservation-only blank draft creates and drains edits during creation', async () => {
  await reset()
  const record = draft(); delete record.pendingCreate; record.dirty = false
  const copy = new WorkingCopy(record), reserved = [reservation(record)]
  copy.update(record.document, reserved)
  assert.equal(copy.getSnapshot().record.dirty, true)
  const released = [{ ...reserved[0], released: true }]
  duringCreate = () => copy.update(record.document, released)
  assert.ok(await copy.sync())
  assert.deepEqual(calls.map(call => call.method), ['POST', 'PUT'])
  assert.deepEqual(calls[0].body.reservations, reserved)
  assert.deepEqual(calls[1].body.reservations, released)
  assert.deepEqual(reload(record.key).getSnapshot().record.reservations, released)
})

test('clean adoption brings reservations; dirty reservation edits resist remote refresh', async () => {
  await reset()
  const record = savedRecord(), copy = new WorkingCopy(record)
  const remote = { ...cloud.get(record.meta.id)!, revision: '2', document: edited(record, 'Remote'),
    reservations: [{ ...record.reservations[0], title: 'Remote task' }] }
  cloud.set(record.meta.id, remote)
  await copy.checkRemote()
  assert.deepEqual(copy.getSnapshot().record.reservations, remote.reservations)
  assert.deepEqual(copy.getSnapshot().record.document, remote.document)
  const local = [{ ...remote.reservations[0], workspaceRead: true }]
  copy.update(copy.getSnapshot().record.document, local)
  cloud.set(record.meta.id, { ...remote, revision: '3', reservations: [] })
  await copy.checkRemote()
  assert.equal(copy.getSnapshot().record.reservations, local)
  assert.equal(copy.getSnapshot().record.meta.revision, '2')
  assert.equal(await copy.discard(), true)
  assert.deepEqual(copy.getSnapshot().record.reservations, [])
})

test('Save as copy drops task identities but retains original reservations', async () => {
  await reset()
  const record = savedRecord(), copy = new WorkingCopy(record)
  const result = await copy.saveAs('No task identity')
  assert.ok(result)
  assert.deepEqual(result.reservations, [])
  assert.deepEqual(rows.get(record.key)?.reservations, record.reservations)
  assert.deepEqual(copy.getSnapshot().record.reservations, record.reservations)
})

test('early sync debounces 650ms, preserves errors, and cancels on cleanup', async t => {
  await reset()
  const record = savedRecord(), copy = new WorkingCopy(record)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let syncs = 0
  copy.sync = async (retainDraft: boolean) => { assert.equal(retainDraft, true); syncs++; return null }
  const request = copy.requestEarlySync
  copy.remoteDeleted()
  const error = copy.getSnapshot().error
  request()
  t.mock.timers.tick(500)
  request()
  t.mock.timers.tick(649)
  assert.equal(syncs, 0)
  assert.equal(copy.getSnapshot().error, error)
  t.mock.timers.tick(1)
  assert.equal(syncs, 1)
  request(); copy.cancelEarlySync()
  t.mock.timers.tick(650)
  assert.equal(syncs, 1)
})


test('edits during acknowledgment persistence drain before ordinary sync finishes', async () => {
  await reset()
  const record = savedRecord(), copy = new WorkingCopy(record)
  copy.update(edited(record, 'Accepted'), [{ ...record.reservations[0], released: true }])
  let changed = false
  const unsubscribe = copy.subscribe(() => {
    const state = copy.getSnapshot()
    if (!changed && state.record.meta.revision === '2' && state.local === 'saving') {
      changed = true
      copy.update(state.record.document, [{ ...record.reservations[0], workspaceRead: true }])
    }
  })
  await copy.sync()
  unsubscribe()
  assert.equal(changed, true)
  assert.equal(copy.getSnapshot().record.dirty, false)
  assert.equal(cloud.get(record.meta.id)?.reservations?.[0].workspaceRead, true)
  assert.equal(cloud.get(record.meta.id)?.reservations?.[0].released, undefined)
  assert.equal(calls.filter(call => call.method === 'PUT').length, 2)
})
