import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createMotedServer } from './moted.mjs'

const origin = 'http://localhost:5173'

function document(id, text) {
  return {
    id, version: 'V0', width: 960,
    margins: { top: 48, right: 48, bottom: 48, left: 48 },
    theme: {
      hue: 145,
      defaults: { family: 'sans', size: 16, color: 'ink', background: 'paper', weight: 400, lineHeight: '1.5em', spaceBefore: '0em', spaceAfter: '1em', letterSpacing: '0em' },
      blocks: {},
      palette: [
        { id: 'ink', name: 'Ink', strong: '#303830' },
        { id: 'muted', name: 'Muted', strong: '#687166' },
        { id: 'paper', name: 'Paper', strong: '#fffefa' },
      ],
    },
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text }] }] },
    floating: [],
  }
}

async function app(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-retrieval-test-'))
  const value = await createMotedServer({
    ...options, stateDir: root, backupDir: path.join(root, 'backups'), port: 0,
    useSystemd: false, defaultModel: 'fake', allowDirectTasks: false,
    env: {
      MOTED_FAKE_RUNNER: '1', MOTED_DEV_ORIGIN: origin,
      MOTED_SHARED_MU_DIR: path.join(root, 'unused-config'), MOTED_MU_ENV_SOURCE: '',
      MOTED_FAKE_DELAY_MS: '0', ...options.env,
    },
  })
  await value.start()
  t.after(async () => { await value.close(); await rm(root, { recursive: true, force: true }) })
  value.call = async (method, suffix, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${value.server.address().port}/api/${suffix}`, {
      method, headers: { origin, 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed, headers: response.headers }
  }
  return value
}

function address(value, suffix) { return `http://127.0.0.1:${value.server.address().port}${suffix}` }
function entryCount(markdown) { return (markdown.match(/^- id: /gm) || []).length }

async function agent(value, suffix, method = 'GET', body) {
  const response = await fetch(address(value, suffix), {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed, headers: response.headers }
}

async function socketGet(url, socketPath) {
  const endpoint = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request(endpoint, { socketPath, method: 'GET' }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }))
    })
    request.on('error', reject)
    request.end()
  })
}

async function createDocument(value, name, { private: isPrivate = false } = {}) {
  const id = randomUUID(), doc = document(id, `${name} body`)
  doc.notes = `${name} internal working notes`
  const result = await value.call('POST', 'documents', { id, name, document: doc, private: isPrivate, operationId: randomUUID() })
  assert.equal(result.status, 201, JSON.stringify(result.body))
  return result.body
}

async function saveDocument(value, envelope, text) {
  const doc = document(envelope.id, text)
  doc.notes = envelope.document.notes
  const result = await value.call('PUT', `documents/${envelope.id}`, {
    baseRevision: envelope.revision, document: doc, operationId: randomUUID(),
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
}

const target = () => ({ kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: false, area: { x: 48, y: 48, width: 200, height: 40 } })

async function createTask(value, own, { executor = 'external', workspaceRead, id = randomUUID() } = {}) {
  const selectedTarget = target()
  const task = { id, cloudDocumentId: own.id, baseRevision: own.revision, document: own.document, executor, target: selectedTarget, operationId: randomUUID() }
  if (executor === 'builtin') { task.prompt = 'Inspect authorized workspace sources'; task.model = 'fake' }
  if (workspaceRead !== undefined) task.workspaceRead = workspaceRead
  const reservation = await value.call('PUT', `documents/${own.id}/assistant`, {
    baseRevision: '0', tasks: [{ id, target: selectedTarget, baseRevision: own.revision }], operationId: randomUUID(),
  })
  assert.equal(reservation.status, 200, JSON.stringify(reservation.body))
  const created = await value.call('POST', 'ai/tasks', task)
  assert.equal(created.status, 202, JSON.stringify(created.body))
  return created.body
}

async function setPrivate(value, id, enabled) {
  const current = await value.call('GET', `documents/${id}/privacy`)
  assert.equal(current.status, 200)
  return value.call('PUT', `documents/${id}/privacy`, {
    private: enabled, basePrivacyRevision: current.body.privacyRevision, operationId: randomUUID(),
  })
}

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    const result = predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for scoped runner requests')
}

test('external workspace reads require opt-in and obey live source privacy, deletion, CAS, and executor revocation', async t => {
  const value = await app(t, { runner: async () => ({}) })
  const publicSource = await createDocument(value, 'Retrieval public source')
  const publicHistorical = publicSource.revision
  const publicCurrent = await saveDocument(value, publicSource, 'Public source current revision marker')
  const privateSource = await createDocument(value, 'Retrieval private source', { private: true })
  const deletedSource = await createDocument(value, 'Retrieval deleted source')
  const destination = await createDocument(value, 'External destination')
  const task = await createTask(value, destination)
  assert.equal(task.workspaceRead, false)
  assert.equal(task.workspaceReadRevision, 0)
  const base = task.externalPath

  for (const suffix of [
    '/workspace-index.md',
    `/workspace-document.json?id=${publicSource.id}`,
    `/workspace-document.json?id=${publicSource.id}&revision=${publicHistorical}`,
  ]) assert.equal((await agent(value, base + suffix)).status, 404)
  assert.equal((await agent(value, base + '/workspace-index.md', 'POST', { enabled: true })).status, 404)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${publicSource.id}`, 'PUT', { document: publicSource.document })).status, 404)
  let authoritative = await value.call('GET', `ai/tasks/${task.id}`)
  assert.equal(authoritative.body.workspaceRead, false)
  assert.equal(authoritative.body.workspaceReadRevision, 0)

  const enable = { enabled: true, baseWorkspaceReadRevision: 0, operationId: randomUUID() }
  const enabled = await value.call('POST', `ai/tasks/${task.id}/workspace-read`, enable)
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body))
  assert.equal(enabled.body.workspaceRead, true)
  assert.equal(enabled.body.workspaceReadRevision, 1)
  assert.deepEqual((await value.call('POST', `ai/tasks/${task.id}/workspace-read`, enable)).body, enabled.body)
  const stale = await value.call('POST', `ai/tasks/${task.id}/workspace-read`, {
    enabled: false, baseWorkspaceReadRevision: 0, operationId: randomUUID(),
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.current.workspaceRead, true)
  assert.equal(stale.body.current.workspaceReadRevision, 1)

  const indexPath = `${base}/workspace-index.md`
  const index = await agent(value, indexPath)
  assert.equal(index.status, 200)
  assert.match(index.headers.get('cache-control'), /no-store/)
  assert.match(index.body, /Retrieval public source/)
  assert.match(index.body, /External destination/)
  assert.equal(entryCount(index.body), 3)
  for (const marker of [privateSource.id, 'Retrieval private source', 'Retrieval private source body']) assert.equal(index.body.includes(marker), false)
  const currentRead = await agent(value, `${base}/workspace-document.json?id=${publicSource.id}`)
  const historicalRead = await agent(value, `${base}/workspace-document.json?id=${publicSource.id}&revision=${publicHistorical}`)
  assert.equal(currentRead.status, 200)
  assert.deepEqual(currentRead.body.document, publicCurrent.document)
  assert.equal(historicalRead.status, 200)
  assert.deepEqual(historicalRead.body.document, publicSource.document)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${privateSource.id}`)).status, 404)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${randomUUID()}`)).status, 404)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${deletedSource.id}`)).status, 200)

  assert.equal(value.store.workspaceDocument(task.documentId, publicSource.id, publicHistorical).revision, publicHistorical)
  assert.throws(() => value.store.workspaceDocument(task.documentId, privateSource.id), error => error.status === 404)

  assert.equal((await setPrivate(value, publicSource.id, true)).status, 200)
  const privateIndex = await agent(value, indexPath)
  assert.equal(privateIndex.status, 200)
  assert.equal(entryCount(privateIndex.body), 2)
  for (const marker of [publicSource.id, 'Retrieval public source', 'Public source current revision marker']) assert.equal(privateIndex.body.includes(marker), false)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${publicSource.id}`)).status, 404)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${publicSource.id}&revision=${publicHistorical}`)).status, 404)
  assert.throws(() => value.store.workspaceDocument(task.documentId, publicSource.id, publicHistorical), error => error.status === 404)

  assert.equal((await setPrivate(value, publicSource.id, false)).status, 200)
  const restoredIndex = await agent(value, indexPath)
  assert.match(restoredIndex.body, /Retrieval public source/)
  assert.equal(entryCount(restoredIndex.body), 3)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${publicSource.id}&revision=${publicHistorical}`)).status, 200)
  const beforeDelete = await agent(value, indexPath)
  assert.match(beforeDelete.body, /Retrieval deleted source/)
  assert.equal((await value.call('DELETE', `documents/${deletedSource.id}`, { baseRevision: deletedSource.revision })).status, 200)
  const afterDelete = await agent(value, indexPath)
  assert.equal(afterDelete.body.includes(deletedSource.id), false)
  assert.equal(afterDelete.body.includes('Retrieval deleted source'), false)
  assert.equal(entryCount(afterDelete.body), 2)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${deletedSource.id}`)).status, 404)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${deletedSource.id}&revision=${deletedSource.revision}`)).status, 404)

  const disable = { enabled: false, baseWorkspaceReadRevision: 1, operationId: randomUUID() }
  const disabled = await value.call('POST', `ai/tasks/${task.id}/workspace-read`, disable)
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.workspaceRead, false)
  assert.deepEqual((await value.call('POST', `ai/tasks/${task.id}/workspace-read`, disable)).body, disabled.body)
  assert.equal((await agent(value, indexPath)).status, 404)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${publicSource.id}`)).status, 404)

  const reenabled = await value.call('POST', `ai/tasks/${task.id}/workspace-read`, {
    enabled: true, baseWorkspaceReadRevision: disabled.body.workspaceReadRevision, operationId: randomUUID(),
  })
  assert.equal(reenabled.status, 200)
  const switched = await value.call('POST', `ai/tasks/${task.id}/executor`, {
    executor: 'builtin', baseExecutorRevision: task.executorRevision, operationId: randomUUID(),
  })
  assert.equal(switched.status, 200)
  assert.equal(switched.body.workspaceRead, false)
  assert.equal(switched.body.workspaceReadRevision, reenabled.body.workspaceReadRevision + 1)
  assert.equal((await agent(value, `${base}/workspace-index.md`)).status, 404)
})

test('builtin scoped socket allows own Private retrieval, denies other Private sources, and never exposes general APIs', async t => {
  const scopeOwnIds = new Map(), observations = new Map()
  const value = await app(t, {
    runner: async context => {
      if (!scopeOwnIds.has(context.taskId)) return {}
      const get = resource => socketGet(new URL(resource.startsWith('/') ? resource : `${context.agent.url}/${resource}`, context.agent.url).href, context.agent.socketPath)
      const result = {
        own: await get('document.json'),
        index: await get('workspace-index.md'),
        ownWorkspace: await get(`workspace-document.json?id=${scopeOwnIds.get(context.taskId)}`),
        publicWorkspace: await get(`workspace-document.json?id=${publicSource.id}`),
        privateWorkspace: await get(`workspace-document.json?id=${privateSource.id}`),
        generalDocuments: await get('/api/documents'),
        generalTask: await get(`/api/ai/tasks/${context.taskId}`),
      }
      observations.set(context.taskId, result)
      return {}
    },
  })
  const publicSource = await createDocument(value, 'Builtin public source')
  const privateSource = await createDocument(value, 'Builtin unrelated Private', { private: true })
  const optedOutOwn = await createDocument(value, 'Builtin opted-out own')
  const optedOutId = randomUUID()
  scopeOwnIds.set(optedOutId, optedOutOwn.id)
  const optedOut = await createTask(value, optedOutOwn, { executor: 'builtin', id: optedOutId })
  assert.equal(optedOut.id, optedOutId)
  assert.equal(optedOut.workspaceRead, false)
  assert.equal(optedOut.workspaceReadRevision, 0)

  const privateOwn = await createDocument(value, 'Builtin own Private', { private: true })
  const privateTaskId = randomUUID()
  scopeOwnIds.set(privateTaskId, privateOwn.id)
  const privateTask = await createTask(value, privateOwn, { executor: 'builtin', workspaceRead: true, id: privateTaskId })
  assert.equal(privateTask.id, privateTaskId)
  assert.equal(privateTask.workspaceRead, true)
  assert.equal(privateTask.workspaceReadRevision, 0)

  const optedOutAccess = await waitFor(() => observations.get(optedOut.id))
  assert.equal(optedOutAccess.own.status, 200)
  assert.deepEqual(JSON.parse(optedOutAccess.own.body), optedOutOwn.document)
  assert.equal(optedOutAccess.index.status, 404)
  assert.equal(optedOutAccess.ownWorkspace.status, 404)
  assert.equal(optedOutAccess.generalDocuments.status, 404)
  assert.equal(optedOutAccess.generalTask.status, 404)

  const privateAccess = await waitFor(() => observations.get(privateTask.id))
  assert.equal(privateAccess.own.status, 200)
  assert.deepEqual(JSON.parse(privateAccess.own.body), privateOwn.document)
  assert.equal(privateAccess.index.status, 200)
  assert.match(privateAccess.index.body, /Builtin own Private/)
  assert.match(privateAccess.index.body, /Builtin public source/)
  assert.equal(entryCount(privateAccess.index.body), 3)
  for (const marker of [privateSource.id, 'Builtin unrelated Private', 'Builtin unrelated Private body']) assert.equal(privateAccess.index.body.includes(marker), false)
  assert.equal(privateAccess.ownWorkspace.status, 200)
  assert.deepEqual(JSON.parse(privateAccess.ownWorkspace.body).document, privateOwn.document)
  assert.equal(privateAccess.publicWorkspace.status, 200)
  assert.deepEqual(JSON.parse(privateAccess.publicWorkspace.body).document, publicSource.document)
  assert.equal(privateAccess.privateWorkspace.status, 404)
  assert.equal(privateAccess.generalDocuments.status, 404)
  assert.equal(privateAccess.generalTask.status, 404)

  assert.deepEqual(value.store.workspaceDocument(privateOwn.id, privateOwn.id).document, privateOwn.document)
  assert.throws(() => value.store.workspaceDocument(privateOwn.id, privateSource.id), error => error.status === 404)
})
