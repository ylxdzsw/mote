import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createMotedServer } from './moted.mjs'
import { DOCUMENT_VERSION } from '../shared/document.mjs'

const origin = 'http://localhost:5173'

function document(id, text) {
  return {
    id, format: 'mote', version: DOCUMENT_VERSION, language: 'en', page: { width: 960, margins: { top: 48, right: 48, bottom: 48, left: 48 } },
    theme: {
      appearance: { mode: 'light', primaryHue: 145, secondaryHue: 260 }, autospace: true, justifyText: false, firstLineIndent: false,
      defaults: { family: 'sans', size: 16, color: 'gray1', weight: 400, lineHeight: { value: 1.5, unit: 'ratio' }, spaceBefore: { value: 0, unit: 'em' }, spaceAfter: { value: 1, unit: 'em' }, letterSpacing: { value: 0, unit: 'em' } },
      paragraphs: {}, objects: {}, flow: {},
    },
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text }] }] },
    objects: [],
  }
}

async function app(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-retrieval-test-'))
  const value = await createMotedServer({
    ...options, stateDir: root, backupDir: path.join(root, 'backups'), port: 0,
    useSystemd: false,
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
  doc.authoring = { notes: [`${name} internal working notes`] }
  const result = await value.call('POST', 'documents', { id, name, document: doc, private: isPrivate, operationId: randomUUID() })
  assert.equal(result.status, 201, JSON.stringify(result.body))
  return result.body
}

async function saveDocument(value, envelope, text) {
  const doc = document(envelope.id, text)
  doc.authoring = envelope.document.authoring
  const result = await value.call('PUT', `documents/${envelope.id}`, {
    baseRevision: envelope.revision, document: doc, operationId: randomUUID(),
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
}

const target = () => ({ kind: 'text', blockIds: ['block-1'], selection: { from: 1, to: 3 }, insert: false, area: { x: 48, y: 48, width: 200, height: 40 } })

async function createTask(value, own, { workspaceRead = false, markup, id = randomUUID() } = {}) {
  const reservation = { id, documentId: own.id, target: target(), original: own.document.content.content, workspaceRead, ...(markup === undefined ? {} : { markup }) }
  const saved = await value.call('PUT', `documents/${own.id}`, { baseRevision: own.revision, document: own.document, reservations: [reservation], operationId: randomUUID() })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const created = await value.call('GET', `ai/tasks/${id}`)
  assert.equal(created.status, 200, JSON.stringify(created.body))
  return created.body
}

async function changeReservation(value, ownId, patch) {
  const saved = value.store.get(ownId)
  const result = await value.call('PUT', `documents/${ownId}`, { baseRevision: saved.revision, document: saved.document,
    reservations: saved.reservations.map(item => ({ ...item, ...patch })), operationId: randomUUID() })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
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

async function setArchived(value, envelope, archived = true) {
  const result = await value.call('PUT', `documents/${envelope.id}/archive`, {
    archived, baseArchiveRevision: envelope.archiveRevision, operationId: randomUUID(),
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
}


test('public task resources use current reservation permission and latest workspace content', async t => {
  const value = await app(t), own = await createDocument(value, 'Own'), source = await createDocument(value, 'Source')
  const hidden = await createDocument(value, 'Private source', { private: true })
  const task = await createTask(value, own)
  const base = task.externalPath
  assert.equal((await agent(value, `${base}/workspace-index.md`)).status, 404)
  await changeReservation(value, own.id, { workspaceRead: true })
  const description = await agent(value, base)
  assert.equal(description.status, 200)
  assert.equal(description.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(description.body.workspaceRead, true)
  assert.ok(description.body.resources['workspace-index.md'])
  let index = await agent(value, `${base}/workspace-index.md`)
  assert.equal(index.status, 200)
  assert.equal(index.body.includes(hidden.id), false)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${hidden.id}`)).status, 404)
  const updated = await saveDocument(value, source, 'Latest source')
  const read = await agent(value, `${base}/workspace-document.json?id=${source.id}&revision=${source.revision}`)
  assert.equal(read.body.revision, updated.revision)
  assert.deepEqual(read.body.document, updated.document)
  await setPrivate(value, source.id, true)
  assert.equal((await agent(value, `${base}/workspace-document.json?id=${source.id}`)).status, 404)
  index = await agent(value, `${base}/workspace-index.md`)
  assert.equal(index.body.includes(source.id), false)
  await changeReservation(value, own.id, { workspaceRead: false })
  assert.equal((await agent(value, `${base}/workspace-index.md`)).status, 404)
  assert.equal((await agent(value, `${base}/document.json`)).status, 200)
  assert.equal((await agent(value, base)).body.workspaceRead, false)
  assert.equal('workspace-index.md' in (await agent(value, base)).body.resources, false)
  for (const resource of ['manifest.json', 'instructions.md', 'target.json']) assert.equal((await agent(value, `${base}/${resource}`)).status, 404)
  for (const action of ['executor', 'workspace-read', 'release']) assert.equal((await value.call('POST', `ai/tasks/${task.id}/${action}`, { operationId: randomUUID() })).status, 404)
  assert.equal((await agent(value, base)).status, 200)
})

test('task description rereads the latest saved reservation markup without starting execution', async t => {
  let runs = 0
  const value = await app(t, { runner: async () => { runs++; return {} } })
  const own = await createDocument(value, 'Markup')
  const markup = {
    x: -48, y: -120, width: 960, height: 1200,
    strokes: [{ points: [[0, 0], [960, 1200]], color: 'primary', width: 3 }],
    labels: [{ x: 24, y: 32, text: 'Current note', color: 'gray1', size: 18 }],
  }
  const task = await createTask(value, own, { markup }), base = task.externalPath
  const taskState = value.manager.tasks.get(task.id)
  assert.equal(task.protocol, 'mote-agent-v7')
  assert.deepEqual((await agent(value, base)).body.markup, markup)
  const latest = { ...markup, y: -160, labels: [{ ...markup.labels[0], text: 'Updated note' }] }
  await changeReservation(value, own.id, { markup: latest })
  assert.deepEqual((await agent(value, base)).body.markup, latest)
  assert.equal(taskState.meta.status, 'waiting')
  assert.equal(taskState.meta.generation, 0)
  assert.equal(runs, 0)
})

test('canonical descriptions expose scoped metadata and segment measurements without reservation originals', async t => {
  let context, finish
  const finished = new Promise(resolve => { finish = resolve })
  const value = await app(t, { runner: async input => { context = input; await finished; return {} } })
  t.after(() => finish())
  const own = await createDocument(value, 'Descriptor')
  own.document.objects.push({ id: 'secret-object', kind: 'image', src: 'data:image/svg+xml,%3Csvg%2F%3E', alt: 'Current figure',
    layout: { width: 3, placement: { type: 'float', anchorId: 'block-1', x: 1, y: 2 } } })
  const id = randomUUID(), expiresAt = Date.now() + 60_000
  const targetScope = {
    kind: 'segment', range: { start: { index: 0, offset: 0 }, end: { index: 1, offset: 0 } },
    blockIds: ['block-1'], objectIds: ['secret-object'], area: { x: 48, y: 48, width: 200, height: 40 },
    selectedText: 'private selected text', bookmarks: {
      start: { blockId: 'block-1', offset: 0 }, end: { blockId: 'block-1', offset: 0, after: true },
    },
  }
  const reservation = {
    id, documentId: own.id, target: targetScope, workspaceRead: true, expiresAt,
    original: {
      version: 1, type: 'segment', content: [{ type: 'paragraph', attrs: { id: 'block-1' }, content: [{ type: 'text', text: 'private original text' }] }],
      objects: [{ id: 'secret-object', kind: 'image', src: 'private original object' }],
      geometry: { 'secret-object': { x: 1, y: 2, width: 3, height: 4, content: 'must not copy' } },
    anchorTops: { 'block-1': 12, 'secret-block': 24 }, originTop: 8, private: 'must not copy',
    },
    snapshotDocument: { ...own.document, authoring: { notes: ['private snapshot notes'] } },
  }
  const saved = await value.call('PUT', `documents/${own.id}`, {
    baseRevision: own.revision, document: own.document, reservations: [reservation], operationId: randomUUID(),
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const task = (await value.call('GET', `ai/tasks/${id}`)).body
  const base = task.externalPath
  const publicReply = await agent(value, base)
  assert.equal(publicReply.status, 200)
  const description = publicReply.body
  assert.equal(description.protocol, 'mote-agent-v7')
  assert.equal(description.taskId, id)
  assert.equal(description.request, null)
  const expectedTarget = structuredClone(targetScope)
  delete expectedTarget.selectedText
  assert.deepEqual(description.target, expectedTarget)
  assert.equal(description.target.selectedText, undefined)
  assert.deepEqual(description.geometry, {
    geometry: { 'secret-object': { x: 1, y: 2, width: 3, height: 4 } },
    anchorTops: { 'block-1': 12 }, originTop: 8,
  })
  assert.equal(description.workspaceRead, true)
  assert.equal(description.expiresAt, expiresAt)
  assert.equal(description.documentMeta.id, own.id)
  assert.equal(description.resources['document.json'], `${base}/document.json`)
  assert.equal(description.resources['workspace-document.json'], `${base}/workspace-document.json`)
  assert.equal(description.versions, `${base}/versions.json`)
  assert.equal(description.version, `${base}/versions/{versionId}.json`)
  assert.equal(description.submit, `${base}/submit`)
  assert.equal('original' in description, false)
  assert.equal('snapshotDocument' in description, false)
  assert.doesNotMatch(JSON.stringify(description), /private selected text|private original text|private original object|private snapshot notes|must not copy/)

  const revise = await value.call('POST', `ai/tasks/${id}/revise`, { prompt: 'Improve this scope', model: 'fake', operationId: randomUUID() })
  assert.equal(revise.status, 202)
  await waitFor(() => context)
  const socketReply = await socketGet(context.agent.url, context.agent.socketPath)
  assert.equal(socketReply.status, 200)
  const socketDescription = JSON.parse(socketReply.body)
  const prompt = await readFile(context.promptPath, 'utf8')
  const promptDescription = JSON.parse(prompt.split('\n\n# Run-local execution details')[0])
  assert.deepEqual(promptDescription, socketDescription)
  assert.equal(socketDescription.request, 'Improve this scope')
  assert.equal(socketDescription.target.selectedText, undefined)
  for (const resource of ['manifest.json', 'instructions.md', 'target.json']) {
    assert.equal((await agent(value, `${base}/${resource}`)).status, 404)
    assert.equal((await socketGet(`${context.agent.url}/${resource}`, context.agent.socketPath)).status, 404)
  }
  finish()
})

test('Private denies every public resource while trusted task socket retains own access and excludes other Private documents', async t => {
  let context, finish
  const finished = new Promise(resolve => { finish = resolve })
  const value = await app(t, { runner: async input => { context = input; await finished; return {} } })
  t.after(() => finish())
  const own = await createDocument(value, 'Own'), other = await createDocument(value, 'Other private', { private: true })
  const task = await createTask(value, own, { workspaceRead: true }), base = task.externalPath
  assert.equal((await value.call('POST', `ai/tasks/${task.id}/revise`, { prompt: 'Read', model: 'fake', operationId: randomUUID() })).status, 202)
  await waitFor(() => context)
  const internal = resource => socketGet(`${context.agent.url}/${resource}`, context.agent.socketPath)
  assert.equal(new URL(context.agent.url).pathname.split('/').at(-1), base.split('/').at(-1))
  await setPrivate(value, own.id, true)
  for (const resource of ['', 'document.json', 'manifest.json', 'target.json', 'instructions.md', 'versions.json', 'workspace-index.md']) assert.equal((await agent(value, `${base}/${resource}`)).status, 403)
  assert.equal((await agent(value, `${base}/submit`, 'POST', { operationId: randomUUID() })).status, 403)
  assert.equal((await internal('document.json')).status, 200)
  assert.equal((await internal(`workspace-document.json?id=${own.id}`)).status, 200)
  assert.equal((await internal(`workspace-document.json?id=${other.id}`)).status, 404)
  assert.equal((await socketGet('http://moted.local/api/documents', context.agent.socketPath)).status, 404)
  await changeReservation(value, own.id, { workspaceRead: false })
  assert.equal((await internal('workspace-index.md')).status, 404)
  assert.equal((await internal('document.json')).status, 200)
  await setPrivate(value, own.id, false)
  assert.equal((await agent(value, `${base}/versions.json`)).status, 200)
  assert.equal((await value.call('GET', `ai/tasks/${task.id}`)).body.externalPath, base)
  finish()
})

test('flat concurrent submissions are durable retries and do not read document or original reservation content', async t => {
  const value = await app(t), own = await createDocument(value, 'Concurrent'), task = await createTask(value, own)
  const base = task.externalPath
  const payloads = Array.from({ length: 6 }, (_, index) => ({ operationId: randomUUID(), label: `Option ${index}`, candidate: { summary: `Proposal ${index}`, content: own.document.content.content } }))
  const load = value.manager.loadRequest
  value.manager.loadRequest = () => { throw new Error('submission must not load task input') }
  const replies = await Promise.all(payloads.map(payload => agent(value, `${base}/submit`, 'POST', payload)))
  value.manager.loadRequest = load
  assert.ok(replies.every(reply => reply.status === 200), JSON.stringify(replies))
  assert.deepEqual(replies.map(reply => reply.body.versionId).sort(), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'])
  for (let index = 0; index < payloads.length; index++) assert.deepEqual((await agent(value, `${base}/submit`, 'POST', payloads[index])).body, replies[index].body)
  assert.equal((await agent(value, `${base}/submit`, 'POST', { ...payloads[0], label: 'Different' })).status, 409)
  const versions = (await agent(value, `${base}/versions.json`)).body
  assert.equal(versions.length, 6)
  assert.deepEqual(Object.keys(versions[0]).sort(), ['candidate', 'id', 'label'])
  assert.equal(value.store.get(own.id).document.content.content[0].content[0].text, 'Concurrent body')
})

test('revise is retry-safe and independent of external delivery; stop keeps late socket submission authorized', async t => {
  const contexts = [], releases = []
  const value = await app(t, { runner: async context => { contexts.push(context); await new Promise(resolve => releases.push(resolve)); return {} } })
  t.after(() => releases.forEach(resolve => resolve()))
  const own = await createDocument(value, 'Workers'), task = await createTask(value, own), base = task.externalPath
  const revise = { prompt: 'First run', model: 'fake', operationId: randomUUID() }
  assert.equal((await value.call('POST', `ai/tasks/${task.id}/revise`, revise)).status, 202)
  await waitFor(() => contexts.length === 1)
  assert.equal((await value.call('POST', `ai/tasks/${task.id}/revise`, revise)).status, 202)
  assert.equal(contexts.length, 1)
  const current = contexts[0]
  const candidate = { summary: 'Late inert proposal', content: own.document.content.content }
  const external = await agent(value, `${base}/submit`, 'POST', { operationId: randomUUID(), candidate })
  assert.equal(external.status, 200)
  assert.equal(value.manager.tasks.get(task.id).meta.status, 'running')
  assert.equal((await value.call('POST', `ai/tasks/${task.id}/stop`, {})).status, 200)
  const saved = value.store.get(own.id)
  await saveDocument(value, saved, 'Edited while worker stops')
  const { agentRequest } = await import('./submit.mjs')
  const late = await agentRequest(`${current.agent.url}/submit`, { socketPath: current.agent.socketPath, body: { operationId: randomUUID(), candidate } })
  assert.deepEqual(late, { taskId: task.id, versionId: 'V2', status: 'ready' })
  const second = { prompt: 'Second run', model: 'fake', operationId: randomUUID(), selectedVersion: 'V2' }
  assert.equal((await value.call('POST', `ai/tasks/${task.id}/revise`, second)).status, 202)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(contexts.length, 1, 'old filesystem writer must finish before next run')
  releases[0]()
  await waitFor(() => contexts.length === 2)
  assert.equal(contexts[1].agent.url, current.agent.url)
  assert.equal(contexts[1].document.content.content[0].content[0].text, 'Edited while worker stops')
  assert.equal(value.store.get(own.id).document.content.content[0].content[0].text, 'Edited while worker stops')
  releases[1]()
})

test('authorization happens at HTTP opening; an already opened inert submission may finish after release', async t => {
  const value = await app(t), own = await createDocument(value, 'Opening'), task = await createTask(value, own)
  const credential = value.store.credential(task.id)
  let entered, resume
  const opened = new Promise(resolve => { entered = resolve })
  const paused = new Promise(resolve => { resume = resolve })
  const ensure = value.manager.ensure.bind(value.manager)
  value.manager.ensure = async id => { const result = await ensure(id); entered(); await paused; return result }
  const pending = agent(value, `${task.externalPath}/submit`, 'POST', { operationId: randomUUID(), candidate: { summary: 'Opened earlier', content: own.document.content.content } })
  await opened
  await changeReservation(value, own.id, { released: true })
  resume()
  assert.equal((await pending).status, 200)
  value.manager.ensure = ensure
  assert.equal((await agent(value, `${task.externalPath}/versions.json`)).status, 410)
  await changeReservation(value, own.id, { released: false })
  assert.equal(value.store.credential(task.id).token, credential.token)
  assert.equal((await agent(value, `${task.externalPath}/versions.json`)).body.length, 1)
})


test('execution reaches a terminal state when its task expires without another document save', async t => {
  let context, finish
  const finished = new Promise(resolve => { finish = resolve })
  const value = await app(t, { runner: async input => { context = input; await finished; return {} } })
  t.after(() => finish())
  const own = await createDocument(value, 'Expiry'), task = await createTask(value, own)
  await changeReservation(value, own.id, { expiresAt: Date.now() + 60_000 })
  assert.equal((await value.call('POST', `ai/tasks/${task.id}/revise`, { prompt: 'Work', model: 'fake', operationId: randomUUID() })).status, 202)
  await waitFor(() => context)
  const clock = Date.now, expiry = clock() + 120_000
  Date.now = () => expiry
  try {
    finish()
    await waitFor(() => value.manager.tasks.get(task.id).executions.size === 0)
    assert.equal(value.manager.tasks.get(task.id).meta.status, 'error')
  } finally { Date.now = clock }
  await changeReservation(value, own.id, { expiresAt: Date.now() + 60_000 })
  assert.equal((await value.call('GET', `ai/tasks/${task.id}`)).body.status, 'error')
})
