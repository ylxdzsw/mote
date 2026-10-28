import http from 'node:http'
import { execFile } from 'node:child_process'
import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { HttpError, MAX_BODY, MAX_RESULT, MAX_SCREENSHOT, PROD_ORIGIN, UUID, validateRequest, validateDocument } from './validation.mjs'
import { fakeRunner, muRunner, readSessionId, stopWorkerUnit, workerUnit } from './runner.mjs'
import { TranscriptJournal } from './transcript.mjs'
import { cloudApi } from './cloud-api.mjs'
import { storagePaths } from './storage-paths.mjs'
import { AGENT_PROTOCOL, TOKEN, counter, fingerprint, operationId, validateDelivery } from './agent-protocol.mjs'
import { localDelivery } from './submit.mjs'
import { WidgetScreenshots, WIDGET_BODY_LIMIT } from './widget-screenshot.mjs'

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url))
const DURABLE_EXPIRY = 253402300799999
const CANDIDATE_ID = /^C([1-9]\d*)$/
const EXTERNAL_SKILL = 'https://mote.ylxdzsw.com/skills/external/SKILL.md'
const execFileAsync = promisify(execFile)
const MODEL_PART = /^[^\s:@\u0000-\u001F\u007F-\u009F]+$/u
const MODEL_CATALOG_ERROR = 'Mu model suggestions are unavailable. Configure providers in Mu locally, or enter a model reference manually.'
const FAKE_MODELS = [
  { reference: 'fake', efforts: [] },
  { reference: 'openai/gpt-4o', efforts: ['low', 'medium', 'high'] },
  { reference: 'gpt-4o', efforts: ['low', 'medium', 'high'] },
  { reference: 'anthropic/claude-3-7-sonnet', efforts: ['low', 'medium', 'high', 'max'] },
  { reference: 'claude-3-7-sonnet', efforts: ['low', 'medium', 'high', 'max'] },
]

function configuredModels(status) {
  const providers = status?.available_models?.providers
  if (!Array.isArray(providers)) throw new Error('model catalog unavailable')
  const models = [], byReference = new Map()
  const add = (reference, efforts) => {
    if (typeof reference !== 'string' || reference.length > 256 || !MODEL_PART.test(reference)) return
    let entry = byReference.get(reference)
    if (!entry) { entry = { reference, efforts: [] }; byReference.set(reference, entry); models.push(entry) }
    for (const effort of efforts) if (!entry.efforts.includes(effort)) entry.efforts.push(effort)
  }
  for (const provider of providers) for (const model of Array.isArray(provider?.models) ? provider.models : []) {
    const efforts = Array.isArray(model?.supported_efforts)
      ? model.supported_efforts.filter(value => typeof value === 'string' && value.length <= 256 && MODEL_PART.test(value))
      : []
    add(model?.id, efforts)
    add(model?.model_id, efforts)
  }
  if (!models.length) throw new Error('model catalog unavailable')
  return { models }
}

async function mkdirSafe(directory, mode) {
  try {
    const stat = await fs.lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${directory} is not a directory`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await fs.mkdir(directory, { mode })
  }
  await fs.chmod(directory, mode)
}

async function regular(file, max, label) {
  let handle
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > max) throw new Error(`${label} is too large or not regular`)
    return await handle.readFile()
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`${label} must not be a symlink`)
    throw new Error(`${label} could not be read`)
  } finally { await handle?.close().catch(() => {}) }
}

async function writeAtomic(file, value, mode = 0o600) {
  const directory = path.dirname(file)
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('write directory is invalid')
  try { const old = await fs.lstat(file); if (old.isSymbolicLink()) throw new Error('destination must not be a symlink') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', mode)
    try { await handle.writeFile(value); await handle.chmod(mode); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, file)
    const parent = await fs.open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}

async function writeImmutable(file, value) { await writeAtomic(file, value, 0o444); await fs.chmod(file, 0o444) }

async function jsonFile(file, max, label) { return JSON.parse((await regular(file, max, label)).toString('utf8')) }

function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, ' ').slice(0, 512) || 'AI task failed' }
function allowedOrigin(env, origin) { return typeof origin === 'string' && (origin === PROD_ORIGIN || (env.MOTED_FAKE_RUNNER === '1' && origin === env.MOTED_DEV_ORIGIN)) }
function settled(promise, ms) { return new Promise(resolve => { const timer = setTimeout(() => resolve(false), ms); promise.then(() => { clearTimeout(timer); resolve(true) }, () => { clearTimeout(timer); resolve(true) }) }) }

const LOGGED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])

function routeTemplate(requestUrl) {
  let pathname
  try { pathname = new URL(requestUrl, 'http://moted.local').pathname } catch { return 'unmatched' }
  if (pathname === '/api/models' || pathname === '/api/settings' || pathname === '/api/indexing' || pathname === '/api/indexing/retry' || pathname === '/api/widgets/screenshot') return pathname
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] === 'a' && segments.length >= 2) return segments.length === 2 ? '/a/:token' : '/a/:token/:resource'
  if (segments[0] === 'api' && segments[1] === 'agent' && segments.length >= 3) return segments.length === 3 ? '/api/agent/:token' : '/api/agent/:token/:resource'
  if (segments[0] === 'api' && segments[1] === 'documents') {
    if (segments.length === 2) return '/api/documents'
    const resource = ['assistant', 'privacy', 'recovery', 'shares'].includes(segments[3]) ? segments[3] : ':resource'
    return `/api/documents/:id${segments.length > 3 ? `/${resource}` : ''}${segments.length > 4 ? '/:resource' : ''}`
  }
  if (segments[0] === 'api' && segments[1] === 'shared' && segments.length >= 3) return '/api/shared/:token'
  if (segments[0] === 'api' && segments[1] === 'ai' && segments[2] === 'tasks') {
    if (segments.length === 3) return '/api/ai/tasks'
    return segments.length === 4 ? '/api/ai/tasks/:id' : '/api/ai/tasks/:id/:action'
  }
  if (segments[0] === 's' && segments.length >= 2) return '/s/:token'
  return 'unmatched'
}

function safeErrorType(error) {
  try {
    if (error instanceof HttpError) return 'HttpError'
    for (const type of [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError]) if (error instanceof type) return type.name
    return error instanceof Error ? 'Error' : 'NonError'
  } catch { return 'Unknown' }
}

function safeErrorCode(error) {
  try { return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code) ? error.code : null } catch { return null }
}

function safeErrorFrames(error) {
  try {
    const stack = error instanceof Error ? error.stack : undefined
    if (typeof stack !== 'string') return []
    const heading = `${error.name}: ${error.message}`
    if (!stack.startsWith(heading)) return []
    const frames = []
    for (const line of stack.slice(heading.length).split('\n')) {
      const match = /(?:\(|\s)((?:file:\/\/\/|\/)[^()\s]+):(\d+):(\d+)\)?$/.exec(line)
      if (!match) continue
      let file = match[1]
      try { if (file.startsWith('file://')) file = fileURLToPath(file) } catch { continue }
      const relative = path.relative(SERVER_ROOT, file)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
      frames.push(`${relative}:${match[2]}:${match[3]}`)
      if (frames.length === 5) break
    }
    return frames
  } catch { return [] }
}

function logUnexpectedError(request, requestId, status, error) {
  const diagnostic = {
    level: 'error', event: 'http.unexpected_error', requestId,
    method: LOGGED_METHODS.has(request.method) ? request.method : 'OTHER',
    route: routeTemplate(request.url), status,
    errorType: safeErrorType(error), errorCode: safeErrorCode(error),
    frames: safeErrorFrames(error),
  }
  try { console.error(JSON.stringify(diagnostic)) } catch {}
}

function sendRequestError(request, response, error, origin, env, requestId) {
  const status = error instanceof HttpError ? error.status : 500
  if (status === 500) logUnexpectedError(request, requestId, status, error)
  send(response, status, {
    error: status === 500 ? 'internal server error' : safeError(error),
    ...(status === 500 ? { requestId } : {}),
    ...(status !== 500 && error instanceof HttpError && error.current !== undefined ? { current: error.current } : {}),
  }, origin, env)
}

async function readBody(request, limit = MAX_BODY) {
  if (Number(request.headers['content-length']) > limit) { request.resume(); throw new HttpError(413, 'request body is too large') }
  const chunks = []; let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > limit) { request.resume(); throw new HttpError(413, 'request body is too large') }; chunks.push(chunk) }
  if (!chunks.length) throw new HttpError(400, 'request body is required')
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'request body must be JSON') }
}

function responseHeaders(origin, env) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' }
  if (allowedOrigin(env, origin)) { headers['access-control-allow-origin'] = origin; headers.vary = 'Origin'; headers['access-control-allow-credentials'] = 'true' }
  return headers
}

function send(response, status, body, origin, env) { response.writeHead(status, responseHeaders(origin, env)); response.end(body === undefined ? '' : JSON.stringify(body)) }

function cursor(url, request) {
  const value = request.headers['last-event-id'] ?? url.searchParams.get('after')
  if (value === null || value === undefined || value === '') return null
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, 'event cursor must be a non-negative integer')
  return Number(value)
}

function sseFrame(event) {
  return `id: ${event.id}\nevent: transcript\ndata: ${JSON.stringify(event)}\n\n`
}

function waitDrain(response) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('SSE consumer is too slow')) }, 30000)
    const cleanup = () => { clearTimeout(timer); response.removeListener('drain', done); response.removeListener('close', failed); response.removeListener('error', failed) }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('SSE connection closed')) }
    response.once('drain', done); response.once('close', failed); response.once('error', failed)
  })
}

async function streamTranscript(task, response, origin, env, after, heartbeatMs) {
  const headers = responseHeaders(origin, env)
  headers['content-type'] = 'text/event-stream; charset=utf-8'
  headers['cache-control'] = 'no-store, no-transform'
  headers.connection = 'keep-alive'
  headers['x-accel-buffering'] = 'no'
  response.writeHead(200, headers); response.flushHeaders?.()
  let closed = false; let replaying = true; let writing = false; let unsubscribe = () => {}; let resolveClosed
  const closedPromise = new Promise(resolve => { resolveClosed = resolve })
  const queue = []
  let queuedBytes = 0
  let sent = after ?? -1
  let heartbeat
  const close = destroy => {
    if (closed) return
    closed = true; clearInterval(heartbeat); unsubscribe(); queue.length = 0; resolveClosed()
    if (destroy && !response.destroyed) response.destroy()
  }
  response.once('close', () => close(false)); response.once('error', () => close(false))
  const write = async value => {
    if (closed) return
    if (!response.write(value)) await waitDrain(response)
  }
  const writeEvent = async event => {
    if (event.id <= sent || closed) return
    await write(sseFrame(event)); sent = event.id
  }
  const pump = async () => {
    if (writing || replaying || closed) return
    writing = true
    try { while (queue.length && !closed) { const event = queue.shift(); queuedBytes -= Buffer.byteLength(event.text); await writeEvent(event) } } catch { close(true) }
    finally { writing = false }
  }
  const onEvent = event => {
    if (closed || event.id <= sent) return
    queuedBytes += Buffer.byteLength(event.text)
    if (queue.length >= 128 || queuedBytes > 512 * 1024) { close(true); return }
    queue.push(event); void pump()
  }
  const warning = message => { if (!closed && !response.write(`event: warning\ndata: ${JSON.stringify({ message })}\n\n`)) close(true) }
  unsubscribe = task.transcript.subscribe(onEvent, () => close(true), warning)
  try {
    if (task.transcript.warning) warning(task.transcript.warning)
    if (task.transcript.wasTruncated(after)) { await write('event: reset\ndata: {}\n\n'); after = null; sent = -1 }
    for (const event of task.transcript.replay(after)) await writeEvent(event)
    replaying = false
    await pump()
    if (closed) return closedPromise
    heartbeat = setInterval(() => { if (!closed && !response.write(': heartbeat\n\n')) close(true) }, heartbeatMs)
    heartbeat.unref?.()
  } catch { close(true) }
  return closedPromise
}

export async function loadCandidate(outputDir, document, target) {
  const { candidate, assets } = await localDelivery(outputDir)
  return validateDelivery(candidate, assets, document, target)
}

export class TaskManager {
  constructor(options = {}) {
    this.env = { ...process.env, ...(options.env || {}) }
    Object.assign(this, storagePaths(options, this.env))
    this.store = options.store
    this.allowDirectTasks = options.allowDirectTasks ?? this.env.MOTED_FAKE_RUNNER === '1'
    this.tasksDir = path.join(this.stateDir, 'tasks')
    this.sourcePath = path.resolve(options.sourcePath || this.env.MOTED_SOURCE_PATH || path.resolve(SERVER_ROOT, '..'))
    this.maxConcurrent = Math.max(1, Math.min(32, Number(options.maxConcurrent || this.env.MOTED_CONCURRENCY || 2)))
    const timeout = options.timeoutMs !== undefined ? Number(options.timeoutMs) : Number(this.env.MOTED_TASK_TIMEOUT_MS || 900000)
    this.timeoutMs = Math.max(options.timeoutMs !== undefined ? 10 : 10000, Math.min(86400000, Number.isFinite(timeout) ? timeout : 900000))
    this.transcriptOptions = {
      maxBytes: options.transcriptMaxBytes ?? this.env.MOTED_TRANSCRIPT_MAX_BYTES,
      maxEvents: options.transcriptMaxEvents ?? this.env.MOTED_TRANSCRIPT_MAX_EVENTS,
      maxEventText: options.transcriptMaxEventText ?? this.env.MOTED_TRANSCRIPT_MAX_EVENT_TEXT,
      maxPending: options.transcriptMaxPending ?? this.env.MOTED_TRANSCRIPT_MAX_PENDING,
    }
    this.heartbeatMs = Math.max(10, Number(options.transcriptHeartbeatMs || this.env.MOTED_TRANSCRIPT_HEARTBEAT_MS || 15000))
    this.useSystemd = options.useSystemd ?? ['1', 'true', 'yes'].includes((this.env.MOTED_USE_SYSTEMD || 'true').toLowerCase())
    this.runner = options.runner || (this.env.MOTED_FAKE_RUNNER === '1' ? fakeRunner : muRunner)
    this.creations = Promise.resolve()
    this.tasks = new Map(); this.queue = []; this.active = 0; this.operations = new WeakMap(); this.persistence = new WeakMap(); this.documentOperations = new Map(); this.closing = false
  }

  async init() {
    await mkdirSafe(this.stateDir, 0o711); await mkdirSafe(this.tasksDir, 0o700)
    for (const entry of await fs.readdir(this.tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue
      const dir = path.join(this.tasksDir, entry.name)
      await fs.chmod(dir, 0o700)
      let meta
      try { meta = await jsonFile(path.join(dir, 'meta.json'), MAX_BODY, 'task metadata') } catch { continue }
      if (!['queued', 'running', 'ready', 'stopped', 'error', 'waiting'].includes(meta.status)) continue
      const transcript = new TranscriptJournal(dir, this.transcriptOptions); await transcript.init()
      const task = { executions: new Set(), id: entry.name, dir, meta, generation: Number(meta.generation || 0), current: null, abandoned: false, transcript }
      this.tasks.set(task.id, task)
      if (this.supported(task)) {
        Object.assign(meta, { executor: meta.executor ?? 'builtin', executorRevision: meta.executorRevision ?? 0, candidateRevision: meta.candidateRevision ?? (meta.candidate ? 1 : 0) })
        meta.workspaceRead ??= false; meta.workspaceReadRevision ??= 0
        delete meta.builtinToken
        meta.expiresAt = DURABLE_EXPIRY
        meta.workerUnit ??= meta.unit
        if (meta.status === 'queued' || meta.status === 'running') {
          task.meta.status = 'stopped'; task.meta.progress = 'Stopped after moted restart'; task.meta.error = 'Service restarted; task was not rerun.'
        }
        delete meta.unit
        if (meta.documentId) {
          if (this.isActive(task)) this.store.bindTask(task.id, meta.documentId, meta.revision)
          else { meta.released = true; delete meta.externalToken }
        }
        await this.persist(task)
        await this.reconcilePrivacy(task)
        await this.rotateExternalGrant(task)
      }
      const recordedUnit = meta.workerUnit ?? meta.unit
      if (recordedUnit && this.useSystemd) {
        const unit = recordedUnit, controller = new AbortController()
        const current = { unit, controller, promise: stopWorkerUnit(unit, this.env) }
        task.executions.add(current)
        current.donePromise = current.promise.then(() => this.retireExecution(task, current), () => this.blockCleanup(task, current))
        void current.donePromise.catch(() => {})
      }
    }
  }

  async persist(task, meta = task.meta) {
    const json = JSON.stringify(meta)
    const pending = (this.persistence.get(task) ?? Promise.resolve()).catch(() => {}).then(() => writeAtomic(path.join(task.dir, 'meta.json'), json))
    this.persistence.set(task, pending)
    try { await pending } finally { if (this.persistence.get(task) === pending) this.persistence.delete(task) }
  }
  async mutate(task, action) {
    const operation = (this.operations.get(task) ?? Promise.resolve()).catch(() => {}).then(() => this.documentMutation(task.meta.documentId, async () => {
      if (this.tasks.get(task.id) !== task) throw new HttpError(404, 'task not found')
      this.assertSupported(task)
      await this.reconcilePrivacy(task)
      return action()
    }))
    this.operations.set(task, operation)
    try { return await operation } finally { if (this.operations.get(task) === operation) this.operations.delete(task) }
  }
  // Serialize policy changes with task commits, including their asynchronous file persistence.
  async documentMutation(id, action) {
    if (!id) return action()
    const operation = (this.documentOperations.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    this.documentOperations.set(id, operation)
    try { return await operation } finally { if (this.documentOperations.get(id) === operation) this.documentOperations.delete(id) }
  }
  externalAllowed(task) {
    try { if (task.meta.documentId) this.store.assertExternal(task.meta.documentId, task.meta.privacyRevision ?? 0); return true } catch { return false }
  }
  externalAccessUntil(task) {
    return task.meta.documentId ? this.store.documentAccessUntil(task.meta.documentId) : DURABLE_EXPIRY
  }
  async rotateExternalGrant(task) {
    if (task.meta.externalGrantVersion === 1 || task.meta.executor !== 'external' || !task.meta.externalToken
      || !this.isActive(task) || !this.externalAllowed(task)) return
    // Credential rollout only: unsupported inputs remain intact and unavailable.
    try { await this.loadRequest(task) } catch { return }
    const next = { ...task.meta, externalToken: crypto.randomBytes(16).toString('base64url'), externalGrantVersion: 1 }
    await this.persist(task, next)
    task.meta = next
  }
  async reconcilePrivacy(task) {
    if (!this.supported(task)) return
    if (task.meta.executor !== 'external' || !this.isActive(task) || this.externalAllowed(task)) return
    const next = { ...task.meta, executor: 'builtin', executorRevision: task.meta.executorRevision + 1, generation: task.generation + 1,
      workspaceRead: false, workspaceReadRevision: task.meta.workspaceReadRevision + 1,
      status: task.meta.candidate ? 'ready' : 'stopped', progress: 'External access revoked by document privacy; built-in agent available' }
    delete next.externalToken; delete next.builtinToken; delete next.unit; delete next.error
    await this.persist(task, next)
    task.meta = next
    this.invalidateRun(task)
  }
  candidateRecords(task) {
    if (Array.isArray(task.meta.candidates)) return task.meta.candidates
    return task.meta.candidate ? [{ id: 'C1', revision: 1, candidate: task.meta.candidate }] : []
  }
  candidateRecord(task, id) { return this.candidateRecords(task).find(record => record.id === id) }
  candidateVersion(task, id, revision) {
    const record = this.candidateRecord(task, id)
    if (!record) return undefined
    if (record.revision === revision) return { id: record.id, ...(record.label === undefined ? {} : { label: record.label }), revision: record.revision, candidate: record.candidate }
    const previous = record.history?.find(item => item.revision === revision)
    return previous ? { id: record.id, ...(previous.label === undefined ? {} : { label: previous.label }), revision: previous.revision, candidate: previous.candidate } : undefined
  }
  candidateOrder(task, records = this.candidateRecords(task)) {
    const ids = new Set(records.map(record => record.id))
    const saved = Array.isArray(task.meta.candidateOrder) ? task.meta.candidateOrder.filter(id => ids.has(id)) : []
    return [...saved, ...records.map(record => record.id).filter(id => !saved.includes(id))]
  }
  candidateNumberFloor(task, records = this.candidateRecords(task)) {
    const highest = records.reduce((max, record) => Math.max(max, Number(CANDIDATE_ID.exec(record.id)?.[1] || 0)), 0)
    return Math.max(Number.isSafeInteger(task.meta.nextCandidateNumber) ? task.meta.nextCandidateNumber : 1, highest + 1)
  }
  lastSubmissionRevision(task) {
    return Object.values(task.meta.submissionOperations ?? {}).reduce((max, operation) => {
      const revision = operation?.receipt?.candidateRevision
      return Number.isSafeInteger(revision) ? Math.max(max, revision) : max
    }, 0)
  }
  candidateAlias(task) {
    const records = this.candidateRecords(task)
    const latest = records.find(record => record.id === task.meta.latestCandidateId)
    if (latest) return latest.candidate
    const order = this.candidateOrder(task, records)
    return records.find(record => record.id === order.at(-1))?.candidate ?? task.meta.candidate
  }
  helperDirectory() {
    return path.join(this.sourcePath, 'public', 'skills', 'helpers')
  }
  view(task) {
    const supported = this.supported(task)
    const value = { id: task.id, protocol: task.meta.protocol, documentVersion: task.meta.documentVersion, status: supported ? task.meta.status : 'error', progress: task.meta.progress, expiresAt: DURABLE_EXPIRY, executor: task.meta.executor, executorRevision: task.meta.executorRevision, candidateRevision: task.meta.candidateRevision, workspaceRead: task.meta.workspaceRead, workspaceReadRevision: task.meta.workspaceReadRevision, released: !this.isActive(task) }
    if (!value.released && task.meta.executor === 'external' && task.meta.externalGrantVersion === 1 && this.externalAllowed(task)) value.externalPath = `/a/${task.meta.externalToken}`
    if (value.externalPath) {
      value.expiresAt = this.externalAccessUntil(task)
      value.accessPaused = value.expiresAt <= Date.now()
    }
    if (task.meta.documentId) Object.assign(value, { documentId: task.meta.documentId, baseRevision: task.meta.revision, revision: task.meta.revision })
    if (task.meta.error) value.error = task.meta.error
    if (!supported) { value.error = 'Unsupported task protocol or document version; original artifacts are retained for recovery.'; delete value.externalPath }
    if (supported) {
      value.candidates = this.candidateRecords(task)
      if (task.meta.candidateRef) value.candidateRef = task.meta.candidateRef
    }
    const candidate = this.candidateAlias(task)
    if (candidate) value.candidate = candidate
    return value
  }

  async loadRequest(task) {
    this.assertSupported(task)
    if (task.request) return task.request
    const document = validateDocument(await jsonFile(path.join(task.dir, 'input', 'document.json'), MAX_BODY, 'document snapshot'))
    let snapshot = undefined; try { const stat = await fs.lstat(path.join(task.dir, 'input', 'snapshot.png')); if (stat.isFile() && !stat.isSymbolicLink()) snapshot = true } catch {}
    task.request = { id: task.id, document, target: task.meta.target, prompt: task.meta.prompt, model: task.meta.model, snapshot }
    return task.request
  }

  async prepareScope(dir) {
    await mkdirSafe(path.join(dir, '.mu'), 0o700); await mkdirSafe(path.join(dir, '.mu', 'sessions'), 0o700); await mkdirSafe(path.join(dir, '.mu', 'objects'), 0o700)
    const shared = path.resolve(this.env.MOTED_SHARED_MU_DIR || '/root/.mu')
    try {
      const config = path.join(shared, 'config.jsonc'); const stat = await fs.lstat(config)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Mu config must be a regular file')
      const bridges = []
      const source = (await regular(config, 1024 * 1024, 'Mu config')).toString('utf8').replace(/("endpoint"\s*:\s*")http\+unix:\/\/([^/"\s]+)(\/[^"\s]*")/g, (_match, prefix, authority, suffix) => {
        const remote = decodeURIComponent(authority)
        if (!path.isAbsolute(remote)) throw new Error('Mu provider socket must be absolute')
        const local = path.join(dir, `provider-${bridges.length}.sock`)
        bridges.push({ remote, local })
        return `${prefix}http+unix://${encodeURIComponent(local)}${suffix}`
      })
      await writeImmutable(path.join(dir, '.mu', 'config.jsonc'), source)
      await writeImmutable(path.join(dir, 'input', 'providers.json'), JSON.stringify(bridges))
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (this.env.MOTED_MU_ENV_SOURCE) { await writeAtomic(path.join(dir, '.mu', '.env'), await regular(path.resolve(this.env.MOTED_MU_ENV_SOURCE), 1024 * 1024, 'Mu credential'), 0o600); await fs.chmod(path.join(dir, '.mu', '.env'), 0o600) }
    await writeImmutable(path.join(dir, '.mu', 'AGENTS.md'), `# Task-local Mu scope\nRead-only source: ${this.sourcePath}\nWritable scope is private /tmp and this task's output, .mu journals/objects, and cache/config directories. Supplied Mu configuration and credentials remain read-only.\nShared /root/.mu is read-only.\n`)
  }

  supported(task) { return task.meta.protocol === AGENT_PROTOCOL && task.meta.documentVersion === 1 }
  assertSupported(task) {
    if (!this.supported(task)) throw new HttpError(409, 'Unsupported task protocol or document version. Retained task artifacts require recovery; create a new V1 task to generate.')
  }
  assertActive(task) {
    if (task.meta.released || task.abandoned) throw new HttpError(410, 'reservation was released')
    if (task.meta.documentId) this.store.assertReservation(task.id, task.meta.documentId)
  }
  isActive(task) { try { this.assertActive(task); return true } catch { return false } }
  invalidateRun(task) {
    task.generation++; task.meta.generation = task.generation
    delete task.meta.builtinToken; delete task.meta.unit
    this.queue = this.queue.filter(value => value !== task)
    for (const current of task.executions) {
      current.controller.abort()
      // Never await completion while holding mutate: completion and submissions use it too.
      void this.terminate(task, current).catch(() => {})
    }
  }

  async switchExecutor(task, body) {
    this.assertActive(task)
    operationId(body?.operationId); counter(body.baseExecutorRevision, 'baseExecutorRevision')
    if (!['builtin', 'external'].includes(body.executor)) throw new HttpError(400, 'executor must be builtin or external')
    const privacy = body.executor === 'external' && task.meta.documentId ? this.store.assertExternal(task.meta.documentId) : undefined
    const digest = fingerprint(body), operations = task.meta.switchOperations ?? {}
    if (operations[body.operationId]) {
      if (operations[body.operationId] !== digest) throw new HttpError(409, 'operationId was already used for different input', this.view(task))
      return this.view(task)
    }
    if (task.meta.executorRevision !== body.baseExecutorRevision) throw new HttpError(409, 'executor revision conflict', this.view(task))
    const next = { ...task.meta, switchOperations: { ...operations, [body.operationId]: digest } }
    const changed = next.executor !== body.executor
    if (changed) {
      next.executor = body.executor; next.executorRevision++; next.generation = task.generation + 1
      next.workspaceRead = false; next.workspaceReadRevision++
      delete next.externalToken; delete next.builtinToken; delete next.unit; delete next.error
      if (body.executor === 'external') { next.externalToken = crypto.randomBytes(16).toString('base64url'); next.externalGrantVersion = 1; next.privacyRevision = privacy?.privacyRevision ?? 0 }
      next.status = body.executor === 'external' ? 'waiting' : next.candidate ? 'ready' : 'stopped'
      next.progress = body.executor === 'external' ? 'Waiting for external candidate' : 'Builtin selected; send a request to run'
    }
    await this.persist(task, next)
    task.meta = next
    if (changed) this.invalidateRun(task)
    return this.view(task)
  }

  async setWorkspaceRead(task, body) {
    this.assertActive(task)
    if (!task.meta.documentId) throw new HttpError(400, 'workspace reads require a cloud document reservation')
    operationId(body?.operationId); counter(body.baseWorkspaceReadRevision, 'baseWorkspaceReadRevision')
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean')
    const digest = fingerprint(body), operations = task.meta.workspaceReadOperations ?? {}
    if (operations[body.operationId]) {
      if (operations[body.operationId] !== digest) throw new HttpError(409, 'operationId was already used for different input', this.view(task))
      return this.view(task)
    }
    if (task.meta.workspaceReadRevision !== body.baseWorkspaceReadRevision) throw new HttpError(409, 'workspace-read revision conflict', this.view(task))
    const next = { ...task.meta, workspaceRead: body.enabled,
      workspaceReadRevision: task.meta.workspaceReadRevision + (body.enabled === task.meta.workspaceRead ? 0 : 1),
      workspaceReadOperations: { ...operations, [body.operationId]: digest } }
    await this.persist(task, next)
    task.meta = next
    return this.view(task)
  }

  async release(task) {
    // SQLite tombstone survives assistant reintroduction and task artifact cleanup failures.
    if (task.meta.documentId) this.store.revokeTask(task.id, task.meta.documentId)
    if (!task.meta.released) {
      task.meta.released = true; delete task.meta.externalToken
      this.invalidateRun(task)
      task.meta.status = task.meta.candidate ? 'ready' : 'stopped'; task.meta.progress = 'Reservation released; artifacts retained'
      delete task.meta.error
    }
    await this.persist(task)
    return this.view(task)
  }

  authorize(token, scope) {
    let task
    if (scope) {
      task = this.tasks.get(scope.taskId)
      if (!task || scope.token !== token || task.meta.executor !== 'builtin' || task.meta.builtinToken !== token || task.generation !== scope.generation || task.meta.executorRevision !== scope.executorRevision) throw new HttpError(404, 'agent grant not found')
    } else task = [...this.tasks.values()].find(task => task.meta.executor === 'external' && task.meta.externalToken === token)
    if (!task || !this.isActive(task)) throw new HttpError(404, 'agent grant not found')
    if (!scope && (task.meta.externalGrantVersion !== 1 || !this.externalAllowed(task))) throw new HttpError(404, 'agent grant not found')
    this.assertSupported(task)
    if (!scope && this.externalAccessUntil(task) <= Date.now()) throw new HttpError(423, 'External task access is paused. Ask the owner to reopen this document in Mote, then continue with the same task URL. Your task and candidates are retained.')
    return task
  }

  async submit(task, token, scope, body) {
    return this.mutate(task, async () => {
      this.authorize(token, scope)
      operationId(body?.operationId)
      const digest = fingerprint(body), operations = task.meta.submissionOperations ?? {}
      const previous = operations[body.operationId]
      if (previous) {
        if (previous.digest !== digest) throw new HttpError(409, 'operationId was already used for different input')
        return previous.receipt
      }
      counter(body.executorRevision, 'executorRevision'); counter(body.candidateRevision, 'candidateRevision')
      if (body.executorRevision !== task.meta.executorRevision) throw new HttpError(409, 'executor revision conflict')
      if (body.candidateId !== undefined && (typeof body.candidateId !== 'string' || !CANDIDATE_ID.test(body.candidateId))) throw new HttpError(400, 'candidateId must be a candidate ID such as C1')
      if (body.label !== undefined && (typeof body.label !== 'string' || [...body.label].length > 80)) throw new HttpError(400, 'label must be at most 80 characters')
      if (body.candidateRevision !== task.meta.candidateRevision) throw new HttpError(409, 'candidate revision conflict', { executorRevision: task.meta.executorRevision, candidateRevision: task.meta.candidateRevision })
      const request = await this.loadRequest(task)
      const candidate = validateDelivery(body.candidate, body.assets, request.document, task.meta.target)
      // Authorization is checked after all asynchronous reads and immediately at commit.
      this.authorize(token, scope)
      const candidates = this.candidateRecords(task).map(record => structuredClone(record))
      const nextNumber = this.candidateNumberFloor(task, candidates)
      let candidateId = body.candidateId
      let candidateRevision
      if (candidateId !== undefined) {
        const index = candidates.findIndex(record => record.id === candidateId)
        if (index < 0) throw new HttpError(409, 'candidate no longer exists')
        const current = candidates[index]
        candidateRevision = current.revision + 1
        const history = [...(current.history ?? []), { revision: current.revision, ...(current.label === undefined ? {} : { label: current.label }), candidate: current.candidate }]
        candidates[index] = { id: candidateId, ...(body.label === undefined ? current.label === undefined ? {} : { label: current.label } : { label: body.label }), revision: candidateRevision, candidate, history }
      } else {
        if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) throw new HttpError(409, 'candidate IDs are exhausted')
        candidateId = `C${nextNumber}`
        candidateRevision = 1
        candidates.push({ id: candidateId, ...(body.label === undefined ? {} : { label: body.label }), revision: candidateRevision, candidate })
      }
      const order = this.candidateOrder(task, this.candidateRecords(task)).filter(id => id !== candidateId)
      order.push(candidateId)
      const receipt = { taskId: task.id, executorRevision: task.meta.executorRevision, candidateRevision: task.meta.candidateRevision + 1, candidateId, revision: candidateRevision, status: 'ready' }
      const next = { ...task.meta, candidates, candidateOrder: order, nextCandidateNumber: body.candidateId === undefined ? nextNumber + 1 : nextNumber,
      latestCandidateId: candidateId, candidate, candidateRevision: receipt.candidateRevision,
      status: 'ready', progress: 'Candidate ready', submissionOperations: { ...operations, [body.operationId]: { digest, receipt } } }
      if (next.nextCandidateNumber === undefined) delete next.nextCandidateNumber
      delete next.error
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_BODY) throw new HttpError(413, 'Task candidate history is too large. Remove unwanted candidates before submitting more. Existing candidates are unchanged.')
      await this.persist(task, next)
      task.meta = next
      return receipt
    })
  }

  async removeCandidate(task, token, scope, candidateId, body) {
    return this.mutate(task, async () => {
      this.authorize(token, scope)
      if (!CANDIDATE_ID.test(candidateId)) throw new HttpError(404, 'candidate not found')
      operationId(body?.operationId)
      const digest = fingerprint({ candidateId, body }), operations = task.meta.candidateRemovalOperations ?? {}
      const previous = operations[body.operationId]
      if (previous) {
        if (previous.digest !== digest) throw new HttpError(409, 'operationId was already used for different input')
        return previous.receipt
      }
      counter(body.executorRevision, 'executorRevision'); counter(body.candidateRevision, 'candidateRevision')
      if (body.executorRevision !== task.meta.executorRevision) throw new HttpError(409, 'executor revision conflict')
      if (body.candidateRevision !== task.meta.candidateRevision) throw new HttpError(409, 'candidate revision conflict', { executorRevision: task.meta.executorRevision, candidateRevision: task.meta.candidateRevision })
      const candidates = this.candidateRecords(task).map(record => structuredClone(record))
      const nextCandidateNumber = this.candidateNumberFloor(task, candidates)
      if (!candidates.some(record => record.id === candidateId)) throw new HttpError(404, 'candidate not found')
      const order = this.candidateOrder(task, candidates).filter(id => id !== candidateId)
      const remaining = candidates.filter(record => record.id !== candidateId)
      const latestCandidateId = order.at(-1)
      const latest = remaining.find(record => record.id === latestCandidateId)
      this.authorize(token, scope)
      const receipt = { taskId: task.id, executorRevision: task.meta.executorRevision, candidateRevision: task.meta.candidateRevision + 1, candidateId, removed: true }
      const next = { ...task.meta, candidates: remaining, candidateOrder: order, nextCandidateNumber, latestCandidateId,
        candidateRevision: receipt.candidateRevision,
        candidateRemovalOperations: { ...operations, [body.operationId]: { digest, receipt } },
      }
      if (next.candidateRef?.candidateId === candidateId) delete next.candidateRef
      if (latest) next.candidate = latest.candidate
      else delete next.candidate
      if (!remaining.length && task.meta.status !== 'running') {
        next.status = task.meta.executor === 'external' ? 'waiting' : 'stopped'
        next.progress = 'Candidate removed'
      } else if (remaining.length && task.meta.status !== 'running') {
        next.status = 'ready'
        next.progress = 'Candidate removed'
      }
      await this.persist(task, next)
      task.meta = next
      return receipt
    })
  }

  async agentApi(request, response, scope, requestId = crypto.randomUUID()) {
    response.setHeader('x-request-id', requestId)
    try {
      const url = new URL(request.url, 'http://moted.local')
      const match = (scope ? /^\/api\/agent\/([A-Za-z0-9_-]{43})(?:\/(.*))?$/ : /^\/a\/([^/]+)(?:\/(.*))?$/).exec(url.pathname)
      if (!match || !scope && !TOKEN.test(match[1])) throw new HttpError(404, 'agent grant not found')
      const [, token, resource = ''] = match
      const task = this.authorize(token, scope), base = scope ? `http://moted.local/api/agent/${token}` : `/a/${token}`
      if (request.method === 'POST' && resource === 'submit') {
        const body = await readBody(request)
        send(response, 200, await this.submit(task, token, scope, body), undefined, this.env); return
      }
      const removal = /^candidates\/(C[1-9]\d*)\/remove$/.exec(resource)
      if (request.method === 'POST' && removal) {
        const body = await readBody(request)
        send(response, 200, await this.removeCandidate(task, token, scope, removal[1], body), undefined, this.env); return
      }
      if (request.method !== 'GET') throw new HttpError(404, 'not found')
      let data, type = 'text/plain; charset=utf-8', download = false
      const files = { 'document.json': MAX_BODY, 'target.json': MAX_RESULT, 'snapshot.png': MAX_SCREENSHOT }
      if (task.meta.guideVersion) Object.assign(files, { 'guide.md': MAX_RESULT, 'submit.mjs': MAX_RESULT, 'preview.mjs': MAX_RESULT, 'preview-harness.html': MAX_RESULT })
      const workspace = () => task.meta.workspaceRead && task.meta.documentId
        ? { 'workspace-index.md': `${base}/workspace-index.md`, 'workspace-document.json': `${base}/workspace-document.json` } : {}
      if (!resource) {
        await this.loadRequest(task)
        type = 'text/markdown; charset=utf-8'
        const names = ['manifest.json', ...Object.keys(files).filter(name => name !== 'snapshot.png' || task.request.snapshot), ...Object.keys(workspace()), 'instructions.md', 'candidate.json', 'candidates.json']
        data = `${this.instructions(task, scope)}\n\n## Task resources\n${names.map(name => `- [${name}](${base}/${name})`).join('\n')}\n`
      } else if (resource === 'manifest.json') {
        const input = await this.loadRequest(task)
        const skill = scope ? path.join(this.sourcePath, 'public', 'skills', 'builtin', 'SKILL.md') : EXTERNAL_SKILL
        const helperRoot = this.helperDirectory()
        data = JSON.stringify({ protocol: task.meta.protocol, documentVersion: task.meta.documentVersion, taskId: task.id, executor: task.meta.executor, executorRevision: task.meta.executorRevision, candidateRevision: task.meta.candidateRevision,
          ...(task.meta.guideVersion ? { guideVersion: task.meta.guideVersion } : {}), skill, helpers: scope ? helperRoot : 'https://mote.ylxdzsw.com/skills/helpers',
          ...(task.meta.candidateRef ? { candidateRef: task.meta.candidateRef } : {}),
          workspaceRead: task.meta.workspaceRead, workspaceReadRevision: task.meta.workspaceReadRevision,
          ...(!scope ? { expiresAt: this.externalAccessUntil(task) } : {}),
          resources: { ...Object.fromEntries(Object.keys(files).filter(name => name !== 'snapshot.png' || input.snapshot).map(name => [name, `${base}/${name}`])), ...workspace() }, instructions: `${base}/instructions.md`, candidate: `${base}/candidate.json`, candidates: `${base}/candidates.json`, removeCandidate: `${base}/candidates/{candidateId}/remove`, submit: `${base}/submit` })
        type = 'application/json; charset=utf-8'
      } else if (resource === 'instructions.md') { await this.loadRequest(task); data = this.instructions(task, scope); type = 'text/markdown; charset=utf-8' }
      else if (resource === 'workspace-index.md' || resource === 'workspace-document.json') {
        if (!task.meta.workspaceRead || !task.meta.documentId) throw new HttpError(404, 'workspace resource not found')
        if (resource === 'workspace-index.md') {
          data = this.store.workspaceIndex(task.meta.documentId); type = 'text/markdown; charset=utf-8'
        } else {
          const id = url.searchParams.get('id'), revision = url.searchParams.get('revision') ?? undefined
          if (!UUID.test(id ?? '') || revision !== undefined && !UUID.test(revision)) throw new HttpError(404, 'workspace resource not found')
          const source = this.store.workspaceDocument(task.meta.documentId, id, revision)
          data = JSON.stringify({ ...source, sourceUrl: `${PROD_ORIGIN}/d/${source.id}` }); type = 'application/json; charset=utf-8'
        }
      }
      else if (resource === 'candidate.json') {
        const candidate = this.candidateAlias(task)
        if (!candidate) throw new HttpError(404, 'no candidate')
        data = JSON.stringify(candidate); type = 'application/json; charset=utf-8'
      } else if (resource === 'candidates.json') {
        data = JSON.stringify(this.candidateRecords(task)); type = 'application/json; charset=utf-8'
      } else if (/^candidates\/C[1-9]\d*\.json$/.test(resource)) {
        const candidateId = resource.slice('candidates/'.length, -'.json'.length)
        const requested = url.searchParams.get('revision')
        let version
        if (requested === null) {
          const current = this.candidateRecord(task, candidateId)
          version = current && this.candidateVersion(task, candidateId, current.revision)
        } else {
          if (!/^\d+$/.test(requested) || !Number.isSafeInteger(Number(requested)) || Number(requested) < 1) throw new HttpError(400, 'revision must be a positive integer')
          version = this.candidateVersion(task, candidateId, Number(requested))
        }
        if (!version) throw new HttpError(404, 'candidate version not found')
        data = JSON.stringify(version); type = 'application/json; charset=utf-8'
      } else if (Object.hasOwn(files, resource)) {
        if (resource === 'snapshot.png' && !(await this.loadRequest(task)).snapshot) throw new HttpError(404, 'no snapshot')
        data = await regular(path.join(task.dir, 'input', resource), files[resource], resource)
        type = resource.endsWith('.json') ? 'application/json; charset=utf-8' : resource.endsWith('.md') ? 'text/markdown; charset=utf-8' : resource.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8'
        download = resource.endsWith('.mjs') || resource.endsWith('.html')
      } else throw new HttpError(404, 'not found')
      this.authorize(token, scope)
      response.writeHead(200, { ...responseHeaders(undefined, this.env), 'content-type': type, 'content-security-policy': "default-src 'none'; sandbox", ...(download ? { 'content-disposition': `attachment; filename="${resource}"` } : {}) })
      response.end(data)
    } catch (error) {
      sendRequestError(request, response, error, undefined, this.env, requestId)
    }
  }

  async openAgentSocket(task, current) {
    const scope = { taskId: task.id, generation: current.generation, executorRevision: task.meta.executorRevision, token: task.meta.builtinToken }
    const socketPath = path.join(task.dir, `a${current.generation}.sock`)
    try { const stat = await fs.lstat(socketPath); if (!stat.isSocket()) throw new Error('agent socket path is not a socket'); await fs.unlink(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const server = http.createServer((request, response) => { void this.agentApi(request, response, scope) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve() }) })
    current.closeSocket = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await fs.chmod(socketPath, 0o666)
    return { url: `http://moted.local/api/agent/${scope.token}`, socketPath, executorRevision: scope.executorRevision, candidateRevision: task.meta.candidateRevision }
  }

  instructions(task, scope) {
    const token = scope?.token ?? task.meta.externalToken
    const base = scope ? `/api/agent/${token}` : `/a/${token}`
    const linkBase = scope ? `http://moted.local${base}` : `${PROD_ORIGIN}${base}`
    const manifest = `${linkBase}/manifest.json`
    const input = path.join(task.dir, 'input')
    const output = scope ? path.join(task.dir, 'runs', String(scope.generation), 'output') : 'output'
    const skill = scope ? path.join(this.sourcePath, 'public', 'skills', 'builtin', 'SKILL.md') : EXTERNAL_SKILL
    const helpers = scope ? this.helperDirectory() : 'https://mote.ylxdzsw.com/skills/helpers'
    const submitHelper = scope ? path.join(helpers, 'submit.mjs') : `${helpers}/submit.mjs`
    const resource = name => scope ? path.join(input, name) : `${linkBase}/${name}`
    const records = this.candidateRecords(task)
    const refs = records.length ? records.map(record => `${record.id} revision ${record.revision}${record.label === undefined ? '' : ` label ${JSON.stringify(record.label)}`}`).join('; ') : 'none'
    const candidateRef = task.meta.candidateRef
      ? `\n${scope ? 'Request base' : 'Last built-in request base (not the current review selection)'}: ${task.meta.candidateRef.candidateId} revision ${task.meta.candidateRef.candidateVersion} (${linkBase}/candidates/${task.meta.candidateRef.candidateId}.json?revision=${task.meta.candidateRef.candidateVersion})`
      : ''
    const workspace = task.meta.workspaceRead && task.meta.documentId
      ? `enabled; ${linkBase}/workspace-index.md; ${linkBase}/workspace-document.json?id=DOCUMENT_ID[&revision=REVISION]`
      : 'disabled'
    const legacy = task.meta.guideVersion ? `\nArchived task guide: ${linkBase}/guide.md` : ''
    const socket = scope ? path.join(task.dir, `a${scope.generation}.sock`) : ''
    const submitCandidateArg = task.meta.candidateRef ? ` ${task.meta.candidateRef.candidateId}` : ''
    const transport = scope
      ? `Read ${resource('document.json')}, ${resource('target.json')}${task.request?.snapshot ? `, and ${resource('snapshot.png')}` : ''}. All http://moted.local resource URLs require Unix socket ${socket}. Fetch the manifest with \`curl --unix-socket '${socket}' '${linkBase}/manifest.json'\`. Write result.json and referenced PNG assets to ${output}.

Generate one operation UUID for this new payload, and retain it with the payload:

\`\`\`sh
operation=$(node -e 'console.log(require("node:crypto").randomUUID())')
printf '%s\\n' "$operation"
\`\`\`

Submit using that UUID. For a retry, reuse the same UUID and unchanged payload; do not rerun UUID generation:

\`\`\`sh
MOTED_AGENT_SOCKET='${socket}' node '${submitHelper}' '${linkBase}' '${output}' ${task.meta.executorRevision} ${task.meta.candidateRevision} "$operation"${submitCandidateArg}
\`\`\``
      : `Agent URL: ${linkBase}. Read the task resources from ${manifest}; write result.json and referenced PNG assets locally. Submit to ${linkBase}/submit using executorRevision ${task.meta.executorRevision} and candidateRevision ${task.meta.candidateRevision}; helper: ${submitHelper}.`
    return `# Mote task\n\nSkill: ${skill}\nShared helpers: ${helpers}\n${legacy ? `${legacy}\n` : ''}\nRequest: ${task.meta.prompt || 'none supplied'}${task.meta.feedback ? `\nPrevious feedback: ${task.meta.feedback}` : ''}\nTarget: ${resource('target.json')}\nDocument snapshot: ${resource('document.json')}${task.request?.snapshot ? `\nVisual snapshot: ${resource('snapshot.png')}` : ''}\nManifest: ${manifest}\nCandidates: ${refs}${candidateRef}\nWorkspace-read permission: ${workspace}\n\n${transport}\n`
  }

  async writePrompt(task, generation) {
    const run = path.join(task.dir, 'runs', String(generation)); const output = path.join(run, 'output')
    await mkdirSafe(run, 0o755); await mkdirSafe(output, 0o770)
    const promptText = this.instructions(task, { generation, token: task.meta.builtinToken })
    await writeImmutable(path.join(run, 'prompt.md'), promptText)
    return { promptPath: path.join(run, 'prompt.md'), outputDir: output }
  }

  create(body) {
    const pending = this.creations.catch(() => {}).then(() => this.documentMutation(body?.cloudDocumentId, () => this.createTask(body)))
    this.creations = pending
    return pending
  }

  async createTask(body) {
    const digest = fingerprint(body)
    if (body?.operationId !== undefined) operationId(body.operationId)
    else if (body?.executor === 'external' || body?.cloudDocumentId) throw new HttpError(400, 'operationId is required')
    const existing = this.tasks.get(body?.id)
    if (existing) {
      this.assertSupported(existing)
      if (body.operationId && existing.meta.createOperationId === body.operationId && existing.meta.createFingerprint === digest) { await this.reconcilePrivacy(existing); return this.view(existing) }
      throw new HttpError(409, 'task ID already exists', this.view(existing))
    }
    if (body?.operationId && [...this.tasks.values()].some(task => task.meta.createOperationId === body.operationId)) throw new HttpError(409, 'operationId was already used')
    if (body?.cloudDocumentId !== undefined) body = this.store.taskSnapshot(body)
    else if (!this.allowDirectTasks) throw new HttpError(400, 'cloudDocumentId and baseRevision are required')
    const request = validateRequest(body)
    const privacy = request.executor === 'external' && body.cloudDocumentId ? this.store.assertExternal(body.cloudDocumentId) : undefined
    const model = request.model || (request.executor === 'builtin' ? await this.resolveModel() : undefined)
    if (request.executor === 'builtin' && !model) throw new HttpError(400, 'Choose a model in Settings → Document or Settings → Workspace before generating.')
    const dir = path.join(this.tasksDir, request.id)
    try { await fs.mkdir(dir, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') throw new HttpError(409, 'task ID already exists'); throw error }
    try {
      for (const [name, mode] of [['input', 0o755], ['runs', 0o755], ['logs', 0o700], ['tmp', 0o700], ['.agent-browser', 0o700], ['.config', 0o700], ['.cache', 0o700]]) await mkdirSafe(path.join(dir, name), mode)
      await writeImmutable(path.join(dir, 'input', 'document.json'), JSON.stringify(request.document)); await writeImmutable(path.join(dir, 'input', 'target.json'), JSON.stringify(request.target)); await writeImmutable(path.join(dir, 'input', 'request.json'), JSON.stringify({ id: request.id, prompt: request.prompt, target: request.target, snapshot: request.snapshot ? 'snapshot.png' : undefined }))
      if (request.snapshot) await writeImmutable(path.join(dir, 'input', 'snapshot.png'), Buffer.from(request.snapshot.slice(request.snapshot.indexOf(',') + 1), 'base64'))
      const transcript = new TranscriptJournal(dir, this.transcriptOptions); await transcript.init()
      const external = request.executor === 'external'
      const task = { executions: new Set(), id: request.id, dir, request, generation: 0, current: null, abandoned: false, transcript, meta: {
        id: request.id, protocol: AGENT_PROTOCOL, documentVersion: request.document.version, executor: request.executor, executorRevision: 0, candidateRevision: 0,
        candidates: [], candidateOrder: [], nextCandidateNumber: 1,
        workspaceRead: request.workspaceRead, workspaceReadRevision: 0,
        createOperationId: body.operationId, createFingerprint: digest, switchOperations: {}, submissionOperations: {}, candidateRemovalOperations: {},
        ...(external ? { externalToken: crypto.randomBytes(16).toString('base64url'), externalGrantVersion: 1, privacyRevision: privacy?.privacyRevision ?? 0 } : {}),
        status: external ? 'waiting' : 'queued', progress: external ? 'Waiting for external candidate' : 'Queued', expiresAt: DURABLE_EXPIRY,
        generation: 0, attempt: external ? 0 : 1, model, prompt: request.prompt, target: request.target,
        ...(body.cloudDocumentId ? { documentId: body.cloudDocumentId, revision: body.baseRevision } : {}),
      } }
      if (request.prompt) await task.transcript.append(task.meta.attempt, 'request', request.prompt).catch(() => {})
      await this.persist(task)
      if (body.cloudDocumentId) this.store.bindTask(task.id, body.cloudDocumentId, body.baseRevision)
      this.tasks.set(task.id, task)
      if (!external) { this.queue.push(task); this.schedule() }
      return this.view(task)
    } catch (error) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); throw error }
  }

  schedule() {
    this.queue = this.queue.filter(task => !task.abandoned && task.meta.status === 'queued' && this.tasks.get(task.id) === task)
    while (!this.closing && this.active < this.maxConcurrent) {
      const index = this.queue.findIndex(task => task.executions.size === 0)
      if (index < 0) return
      const [task] = this.queue.splice(index, 1)
      this.active++; this.run(task).catch(() => {}).finally(() => { this.active--; this.schedule(); this.indexer?.wake() })
    }
  }

  async retireExecution(task, current) {
    if (this.supported(task)) await this.mutate(task, async () => {
      if (task.meta.workerUnit === current.unit) { delete task.meta.workerUnit; await this.persist(task) }
    }).catch(() => {})
    task.executions.delete(current)
    this.schedule()
  }

  async blockCleanup(task, current) {
    current.cleanupFailed = true
    if (!this.supported(task)) return
    // Keep the execution and workerUnit: a service restart must retry cleanup,
    // never assume an old process is gone and hand it a future generation's scope.
    await this.mutate(task, async () => {
      if (task.meta.executor !== 'builtin' || !this.isActive(task)) return
      task.meta.status = 'error'; task.meta.progress = 'Worker cleanup unconfirmed'
      task.meta.error = 'Worker cleanup could not be confirmed. Further built-in runs are paused until service recovery; manual editing and external handoff remain available.'
      await this.persist(task)
    }).catch(() => {})
  }

  async discoverSession(task) {
    const sessionId = await readSessionId(task.dir)
    if (sessionId) task.meta.sessionId = sessionId
    return sessionId
  }

  async terminate(task, current, waitForRun = false) {
    if (!current) return true
    current.controller.abort()
    const stop = current.stopPromise ??= Promise.resolve().then(() => current.stop?.()).catch(() => {})
    const limit = Math.min(10000, Math.max(100, this.timeoutMs))
    await settled(stop, limit)
    const stopped = await settled(current.promise || Promise.resolve(), limit)
    const completed = !waitForRun || await settled(current.donePromise, limit)
    return stopped && completed && !current.cleanupFailed
  }

  async run(task) {
    this.assertSupported(task)
    const generation = task.generation, attempt = task.meta.attempt
    const controller = new AbortController()
    let resolveDone, deadline
    const current = { unit: workerUnit(task.id, generation), generation, controller, promise: null, finished: false, stop: null, donePromise: new Promise(resolve => { resolveDone = resolve }) }
    task.executions.add(current)
    const context = {
      taskId: task.id, taskDir: task.dir, inputDir: path.join(task.dir, 'input'),
      target: task.meta.target, model: task.meta.model, generation, attempt,
      sessionId: task.meta.sessionId, candidateRef: task.meta.candidateRef, sourcePath: this.sourcePath, timeoutMs: this.timeoutMs,
      env: this.env, useSystemd: this.useSystemd, signal: controller.signal,
      dataDir: this.dataDir, backupDir: this.backupDir, tasksDir: this.tasksDir, stop: null,
      emitTranscript: (kind, text) => { if (task.generation === generation) void task.transcript.append(attempt, kind, text).catch(() => {}) },
      progress: message => { void this.mutate(task, async () => { if (task.generation === generation && this.isActive(task)) { task.meta.progress = String(message).slice(0, 256); await this.persist(task) } }).catch(() => {}) },
    }
    current.stop = () => context.stop?.()
    const authorized = () => task.generation === generation && task.meta.executor === 'builtin' && this.isActive(task)
    try {
      await this.mutate(task, async () => {
        if (!authorized() || task.meta.status !== 'queued') return
        // The scheduler reserves this task only after all previous run/cleanup promises end.
        await this.loadRequest(task); await this.discoverSession(task); await this.prepareScope(task.dir)
        if (!authorized()) return
        context.sessionId = task.meta.sessionId
        task.current = current; task.meta.status = 'running'; task.meta.progress = 'Running builtin agent'
        task.meta.unit = current.unit; task.meta.workerUnit = current.unit; task.meta.builtinToken = crypto.randomBytes(32).toString('base64url')
        await this.persist(task)
      })
      if (!authorized() || task.current !== current || controller.signal.aborted) return
      await this.loadRequest(task)
      context.agent = await this.openAgentSocket(task, current)
      Object.assign(context, await this.writePrompt(task, generation))
      if (!authorized() || controller.signal.aborted) return
      current.promise = Promise.resolve().then(() => this.runner(context))
      current.promise.then(() => { current.finished = true }, () => { current.finished = true })
      const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('worker timed out')), this.timeoutMs); deadline.unref?.() })
      const result = await Promise.race([current.promise, timeout])
      await this.mutate(task, async () => {
        if (!authorized()) return
        if (result?.sessionId) task.meta.sessionId = result.sessionId
        if (this.lastSubmissionRevision(task) <= context.agent.candidateRevision) throw new Error('Worker ended without submitting a candidate through the agent API')
        delete task.meta.builtinToken; delete task.meta.unit
        await this.persist(task)
      })
    } catch (error) {
      const sessionId = current.finished && !controller.signal.aborted ? await readSessionId(task.dir) : undefined
      await this.mutate(task, async () => {
        if (!authorized()) return
        if (sessionId) task.meta.sessionId = sessionId
        this.invalidateRun(task)
        const timedOut = error instanceof Error && error.message === 'worker timed out'
        task.meta.status = 'error'; task.meta.progress = timedOut ? 'Worker timed out' : 'Worker failed'
        task.meta.error = timedOut ? 'Worker timed out.' : safeError(error)
        await this.persist(task)
      }).catch(() => {})
      await this.terminate(task, current)
    } finally {
      clearTimeout(deadline)
      await current.closeSocket?.().catch(() => {})
      if (task.current === current) task.current = null
      const retire = async () => {
        if (context.cleanupFailed) await this.blockCleanup(task, current)
        else await this.retireExecution(task, current)
        resolveDone()
      }
      const cleanup = Promise.all([current.promise, current.stopPromise].map(promise => Promise.resolve(promise).catch(() => {})))
      if (current.finished || !current.promise) { await cleanup; await retire() }
      else void cleanup.then(retire)
    }
  }

  async stop(task, message = 'Stopped by client') {
    if (task.meta.executor !== 'builtin') throw new HttpError(409, 'only builtin execution can be stopped', this.view(task))
    if (task.meta.status === 'queued' || task.meta.status === 'running' || task.current) {
      this.invalidateRun(task)
      task.meta.status = task.meta.candidate ? 'ready' : 'stopped'; task.meta.progress = message
      await this.persist(task)
    }
    return this.view(task)
  }

  async revise(task, prompt, executorRevision, candidateId, candidateVersion) {
    await this.loadRequest(task)
    this.assertActive(task)
    counter(executorRevision, 'executorRevision')
    if (task.meta.executor !== 'builtin' || task.meta.executorRevision !== executorRevision) throw new HttpError(409, 'executor revision conflict', this.view(task))
    if ((candidateId === undefined) !== (candidateVersion === undefined)) throw new HttpError(400, 'candidateId and candidateVersion must be supplied together')
    if (candidateId !== undefined) {
      if (typeof candidateId !== 'string' || !CANDIDATE_ID.test(candidateId)) throw new HttpError(400, 'candidateId must be a candidate ID such as C1')
      counter(candidateVersion, 'candidateVersion')
      if (candidateVersion < 1) throw new HttpError(400, 'candidateVersion must be positive')
      if (!this.candidateVersion(task, candidateId, candidateVersion)) throw new HttpError(409, 'candidate revision is no longer available', this.view(task))
    }
    if ([...task.executions].some(current => current.cleanupFailed)) throw new HttpError(503, 'Worker cleanup is unconfirmed; service recovery is required before another built-in run.')
    const model = task.meta.model || await this.resolveModel()
    if (!model) throw new HttpError(400, 'Choose a model in Settings → Document or Settings → Workspace before generating.')
    const next = { ...task.meta, model, prompt, generation: task.generation + 1,
      status: 'queued', progress: task.executions.size ? 'Waiting for previous worker cleanup' : 'Queued revision', feedback: task.meta.error,
      attempt: Math.max(Number(task.meta.attempt || 0), task.transcript.maxAttempt) + 1 }
    if (candidateId === undefined) delete next.candidateRef
    else next.candidateRef = { candidateId, candidateVersion }
    delete next.builtinToken; delete next.unit; delete next.error
    await this.persist(task, next)
    task.meta = next
    this.invalidateRun(task)
    await task.transcript.append(next.attempt, 'request', prompt).catch(() => {})
    this.queue.push(task); this.schedule(); return this.view(task)
  }

  async resolveModel() {
    return this.store?.settings().models.builtin
  }

  async modelSuggestions() {
    if (this.env.MOTED_FAKE_RUNNER === '1') return structuredClone({ models: FAKE_MODELS })
    if (this.modelLookup) return this.modelLookup
    const lookup = (async () => {
      const shared = path.resolve(this.env.MOTED_SHARED_MU_DIR || '/root/.mu')
      const command = this.env.MOTED_MU_BIN || this.env.MOTED_MU || 'mu'
      try {
        const config = await fs.lstat(path.join(shared, 'config.jsonc'))
        if (config.isSymbolicLink() || !config.isFile() || config.size > 1024 * 1024) throw new Error('invalid Mu config')
      } catch { throw new HttpError(422, MODEL_CATALOG_ERROR) }
      let stdout
      try {
        ({ stdout } = await execFileAsync(command, ['status', '--json', '--include-models'], {
          cwd: '/',
          env: { PATH: this.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: path.dirname(shared), LANG: this.env.LANG || 'C.UTF-8', MU_CONFIG_DIR: shared },
          encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
        }))
      } catch { throw new HttpError(422, MODEL_CATALOG_ERROR) }
      try { return configuredModels(JSON.parse(stdout)) }
      catch { throw new HttpError(422, MODEL_CATALOG_ERROR) }
    })()
    this.modelLookup = lookup
    try { return await lookup } finally { if (this.modelLookup === lookup) this.modelLookup = undefined }
  }

  async remove(task) {
    await this.mutate(task, () => this.release(task))
    // Waiting is outside mutate; in-flight submission/completion must be able to finish.
    const stopped = await Promise.all([...task.executions].map(current => this.terminate(task, current, true)))
    if (stopped.some(value => !value)) throw new HttpError(409, 'worker is still stopping; revoked task artifacts retained')
    await this.mutate(task, async () => {
      await task.transcript.close()
      await fs.rm(task.dir, { recursive: true, force: false })
      this.tasks.delete(task.id)
    })
  }

  async reconcileReservations(documentId) {
    // Cloud revocation is already durable before this best-effort worker stop/metadata update.
    for (const task of this.tasks.values()) if (task.meta.documentId === documentId) {
      if (!this.isActive(task)) await this.mutate(task, () => this.release(task)).catch(() => {})
      else if (task.meta.executor === 'external' && !this.externalAllowed(task)) await this.mutate(task, () => {}).catch(() => {})
    }
  }

  async shutdown() {
    this.closing = true
    await this.creations.catch(() => {})
    for (const task of this.tasks.values()) {
      if (task.meta.executor === 'builtin') await this.mutate(task, () => this.stop(task, 'Stopped during server shutdown')).catch(() => {})
      await Promise.all([...task.executions].map(current => this.terminate(task, current, true)))
      await task.transcript.close()
    }
  }
}

export async function createMotedServer(options = {}) {
  // Worker delivery checks import loadCandidate without needing SQLite's 22.12 flag.
  const { CloudStore } = await import('./cloud-store.mjs')
  const { DocumentIndexer } = await import('./indexer.mjs')
  const manager = new TaskManager(options)
  const store = await CloudStore.open(options, manager.env); manager.store = store
  const indexer = new DocumentIndexer(manager, options.indexing)
  manager.indexer = indexer
  try { await manager.init(); await indexer.init() } catch (error) { await indexer.shutdown(); await manager.shutdown(); store.close(); throw error }
  const screenshots = new WidgetScreenshots(manager.env)
  const server = http.createServer(async (request, response) => {
    const requestId = crypto.randomUUID()
    response.setHeader('x-request-id', requestId)
    const origin = request.headers.origin
    try {
      const url = new URL(request.url, 'http://moted.local')
      if (url.pathname.startsWith('/a/')) { await manager.agentApi(request, response, undefined, requestId); return }
      if (url.pathname === '/api/widgets/screenshot') {
        if (!allowedOrigin(manager.env, origin)) throw new HttpError(403, 'origin is not allowed')
        if (request.method !== 'POST') throw new HttpError(404, 'not found')
        const client = new AbortController()
        const disconnected = () => { if (!response.writableFinished) client.abort() }
        response.once('close', disconnected)
        try {
          const result = await screenshots.capture(async signal => {
            const abort = () => request.destroy()
            signal.addEventListener('abort', abort, { once: true })
            try { signal.throwIfAborted(); return await readBody(request, WIDGET_BODY_LIMIT) }
            finally { signal.removeEventListener('abort', abort) }
          }, client.signal)
          send(response, 200, result, origin, manager.env); return
        } finally { response.removeListener('close', disconnected) }
      }
      if (url.pathname === '/api/models') {
        if (request.method !== 'GET') throw new HttpError(404, 'not found')
        send(response, 200, await manager.modelSuggestions(), origin, manager.env); return
      }
      if (url.pathname === '/api/settings') {
        if (request.method !== 'GET' && !allowedOrigin(manager.env, origin)) throw new HttpError(403, 'origin is not allowed')
        if (!['GET', 'PUT'].includes(request.method)) throw new HttpError(404, 'not found')
        const settings = request.method === 'GET' ? store.settings() : store.putSettings(await readBody(request))
        if (request.method === 'PUT') indexer.wake()
        send(response, 200, settings, origin, manager.env); return
      }
      if (url.pathname === '/api/indexing' || url.pathname === '/api/indexing/retry') {
        if (request.method !== 'GET' && !allowedOrigin(manager.env, origin)) throw new HttpError(403, 'origin is not allowed')
        if (url.pathname === '/api/indexing' && request.method === 'GET') { send(response, 200, indexer.status(), origin, manager.env); return }
        if (url.pathname === '/api/indexing/retry' && request.method === 'POST') { await indexer.retry(); send(response, 200, indexer.status(), origin, manager.env); return }
        throw new HttpError(404, 'not found')
      }
      if (url.pathname === '/api/documents' || url.pathname.startsWith('/api/documents/') || url.pathname.startsWith('/api/shared/')) {
        if (request.method !== 'GET' && !allowedOrigin(manager.env, origin)) throw new HttpError(403, 'origin is not allowed')
        const privacyChange = request.method === 'PUT' && /^\/api\/documents\/[^/]+\/privacy$/.test(url.pathname)
        const privacyBody = privacyChange ? await readBody(request) : undefined
        const result = privacyChange
          ? await manager.documentMutation(url.pathname.split('/')[3], () => cloudApi(store, request, url.pathname, async () => privacyBody))
          : await cloudApi(store, request, url.pathname, readBody)
        if (request.method !== 'GET' && url.pathname.startsWith('/api/documents/')) await manager.reconcileReservations(url.pathname.split('/')[3])
        if (request.method !== 'GET') indexer.wake()
        send(response, result.status, result.body, origin, manager.env); return
      }
      if (url.pathname === '/api/ai' || url.pathname.startsWith('/api/ai/')) {
        if (request.method === 'OPTIONS') { if (!allowedOrigin(manager.env, origin)) throw new HttpError(403, 'origin is not allowed'); response.writeHead(204, responseHeaders(origin, manager.env)); response.end(); return }
        const base = '/api/ai'; const suffix = url.pathname.slice(base.length).replace(/^\//, '')
        if (suffix !== 'tasks' && !suffix.startsWith('tasks/')) throw new HttpError(404, 'not found')
        const parts = suffix.split('/'); const id = parts[1]; const action = parts[2]
        if (parts.length > 3 || id && !UUID.test(id)) throw new HttpError(404, 'not found')
        if (request.method !== 'GET' && !allowedOrigin(manager.env, origin)) throw new HttpError(403, 'origin is not allowed')
        if (request.method === 'POST' && suffix === 'tasks') { send(response, 202, await manager.create(await readBody(request)), origin, manager.env); return }
        if (request.method === 'GET' && id && action === 'events') {
          const task = manager.tasks.get(id); if (!task) throw new HttpError(404, 'task not found')
          await streamTranscript(task, response, origin, manager.env, cursor(url, request), manager.heartbeatMs); return
        }
        if (request.method === 'GET' && id && !action) { const task = manager.tasks.get(id); if (!task) throw new HttpError(404, 'task not found'); send(response, 200, manager.supported(task) ? await manager.mutate(task, () => manager.view(task)) : manager.view(task), origin, manager.env); return }
        const task = manager.tasks.get(id); if (!task) throw new HttpError(404, 'task not found')
        if (request.method === 'POST' && action === 'stop') { await manager.mutate(task, () => manager.stop(task)); send(response, 200, manager.view(task), origin, manager.env); return }
        if (request.method === 'POST' && action === 'executor') { const body = await readBody(request); send(response, 200, await manager.mutate(task, () => manager.switchExecutor(task, body)), origin, manager.env); return }
        if (request.method === 'POST' && action === 'workspace-read') { const body = await readBody(request); send(response, 200, await manager.mutate(task, () => manager.setWorkspaceRead(task, body)), origin, manager.env); return }
        if (request.method === 'POST' && action === 'release') { send(response, 200, await manager.mutate(task, () => manager.release(task)), origin, manager.env); return }
        if (request.method === 'DELETE' && !action) { await manager.remove(task); send(response, 200, { ok: true }, origin, manager.env); return }
        if (request.method === 'POST' && action === 'revise') { const body = await readBody(request); if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new HttpError(400, 'prompt must be a non-empty string'); if (body.prompt.length > 32768) throw new HttpError(413, 'prompt is too large'); send(response, 202, await manager.mutate(task, () => manager.revise(task, body.prompt, body.executorRevision, body.candidateId, body.candidateVersion)), origin, manager.env); return }
        throw new HttpError(404, 'not found')
      }
      throw new HttpError(404, 'not found')
    } catch (error) { sendRequestError(request, response, error, origin, manager.env, requestId) }
  })
  let closing
  return { manager, store, indexer, screenshots, server, async start() { const socket = options.socketPath ?? (manager.env.MOTED_SOCKET || (options.port !== undefined || manager.env.MOTED_FAKE_RUNNER === '1' ? null : '/run/moted/moted.sock')); if (socket) { await mkdirSafe(path.dirname(socket), 0o755); try { const stat = await fs.lstat(socket); if (!stat.isSocket()) throw new Error('configured socket path is not a socket'); await fs.unlink(socket) } catch (error) { if (error.code !== 'ENOENT') throw error } await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { server.removeListener('error', reject); resolve() }) }) } else { const host = options.host || manager.env.MOTED_HOST || '127.0.0.1'; const port = options.port ?? Number(manager.env.MOTED_PORT || 8787); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve() }) }) } return server.address() }, close() { return closing ??= (async () => { await Promise.all([screenshots.shutdown(), indexer.shutdown(), manager.shutdown()]); await new Promise(resolve => server.close(() => resolve())); store.close() })() } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createMotedServer()
  await app.start()
  process.once('SIGTERM', () => app.close().then(() => process.exit(0)))
  process.once('SIGINT', () => app.close().then(() => process.exit(0)))
}
