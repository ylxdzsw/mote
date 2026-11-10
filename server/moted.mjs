import http from 'node:http'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { HttpError, MAX_BODY, MAX_RESULT, MAX_SCREENSHOT, PROD_ORIGIN, UUID } from './validation.mjs'
import { fakeRunner, muRunner, readSessionId, stopWorkerUnit, workerUnit } from './runner.mjs'
import { TranscriptJournal } from './transcript.mjs'
import { DocumentEvents } from './document-events.mjs'
import { cloudApi } from './cloud-api.mjs'
import { storagePaths } from './storage-paths.mjs'
import { AGENT_PROTOCOL, PROPOSAL_SCHEMA_URL, TOKEN, fingerprint, operationId, validateProposalDelivery } from './agent-protocol.mjs'
import { localDelivery } from './submit.mjs'
import { WidgetScreenshots, WIDGET_BODY_LIMIT } from './widget-screenshot.mjs'

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url))
const VERSION_ID = /^V[1-9]\d*$/
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
  await fs.mkdir(directory, { recursive: true, mode })
  await fs.chmod(directory, mode)
}

async function regular(file, max, label) {
  try {
    const data = await fs.readFile(file)
    if (data.length > max) throw new Error(`${label} is too large`)
    return data
  } catch (error) {
    if (error.code === 'ENOENT') throw error
    throw new Error(`${label} could not be read`)
  }
}

async function writeAtomic(file, value, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', mode)
    try { await handle.writeFile(value); await handle.chmod(mode); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, file)
    const directory = await fs.open(path.dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
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
    const resource = ['assistant', 'privacy', 'archive', 'recovery', 'shares', 'events', 'open'].includes(segments[3]) ? segments[3] : ':resource'
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
    ...(status !== 500 && error?.schemaUrl !== undefined ? { schemaUrl: error.schemaUrl } : {}),
    ...(status !== 500 && error?.path !== undefined ? { path: error.path } : {}),
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
  const value = request?.headers['last-event-id'] ?? url.searchParams.get('after')
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

function streamDocument(events, id, response, origin, env, heartbeatMs) {
  const headers = { ...responseHeaders(origin, env), 'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' }
  let closed = false, ending = false, writing = false, queuedBytes = 0, heartbeat
  const queue = []
  const close = destroy => {
    if (closed) return
    closed = true; clearInterval(heartbeat); unsubscribe(); queue.length = 0
    if (destroy) response.destroy()
  }
  const pump = async () => {
    if (writing || closed) return
    writing = true
    try {
      while (queue.length && !closed) {
        const frame = queue.shift(); queuedBytes -= Buffer.byteLength(frame)
        if (!response.write(frame)) await waitDrain(response)
      }
      if (ending && !closed) { close(false); response.end() }
    } catch { close(true) }
    finally { writing = false }
  }
  const enqueue = frame => {
    if (closed || ending) return
    queuedBytes += Buffer.byteLength(frame)
    if (queue.length >= 128 || queuedBytes > 512 * 1024) { close(true); return }
    queue.push(frame); void pump()
  }
  const unsubscribe = events.subscribe(id,
    update => enqueue(`event: update\ndata: ${JSON.stringify(update)}\n\n`),
    () => { ending = true; clearInterval(heartbeat); void pump() })
  response.once('close', () => close(false)); response.once('error', () => close(true))
  response.writeHead(200, headers); response.flushHeaders?.()
  enqueue('event: update\ndata: {"kind":"ready"}\n\n')
  if (closed) return
  heartbeat = setInterval(() => enqueue(': heartbeat\n\n'), heartbeatMs)
  heartbeat.unref?.()
}

export async function loadCandidate(outputDir) {
  const { candidate, assets } = await localDelivery(outputDir)
  return validateProposalDelivery(candidate, assets)
}

export class TaskManager {
  constructor(options = {}) {
    this.env = { ...process.env, ...(options.env || {}) }
    Object.assign(this, storagePaths(options, this.env))
    this.store = options.store
    this.documentEvents = new DocumentEvents()
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
      this.addTask(task)
      if (this.supported(task)) {
        meta.workerUnit ??= meta.unit
        if (meta.status === 'queued' || meta.status === 'running') {
          task.meta.status = 'stopped'; task.meta.progress = 'Stopped after moted restart'; task.meta.error = 'Service restarted; task was not rerun.'
        }
        delete meta.unit
        await this.persist(task)
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
    const pending = (this.persistence.get(task) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await writeAtomic(path.join(task.dir, 'meta.json'), json)
      task.meta = meta
      if (this.tasks.get(task.id) === task) this.taskUpdate(task)
    })
    this.persistence.set(task, pending)
    try { await pending } finally { if (this.persistence.get(task) === pending) this.persistence.delete(task) }
  }
  taskUpdate(task) { this.documentEvents.publish(task.meta.documentId, { kind: 'task', taskId: task.id }) }
  addTask(task) {
    this.tasks.set(task.id, task)
    const publish = update => this.documentEvents.publish(task.meta.documentId, { ...update, taskId: task.id })
    task.transcript.subscribe(entry => publish({ kind: 'transcript', entry }),
      () => {}, message => publish({ kind: 'transcript-warning', message }))
    this.taskUpdate(task)
    for (const entry of task.transcript.replay(null)) publish({ kind: 'transcript', entry })
    if (task.transcript.warning) publish({ kind: 'transcript-warning', message: task.transcript.warning })
  }
  async mutate(task, action) {
    const operation = (this.operations.get(task) ?? Promise.resolve()).catch(() => {}).then(() => this.documentMutation(task.meta.documentId, async () => {
      if (this.tasks.get(task.id) !== task) throw new HttpError(404, 'task not found')
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
    try { this.store.assertExternal(task.meta.documentId); return true } catch { return false }
  }
  helperDirectory() {
    return path.join(this.sourcePath, 'public', 'skills', 'helpers')
  }
  view(task) {
    let reservation
    try { reservation = this.store.reservation(task.id, task.meta.documentId) } catch {}
    const supported = this.supported(task)
    const value = { id: task.id, protocol: task.meta.protocol, status: supported ? task.meta.status : 'error', progress: task.meta.progress,
      versions: task.meta.versions ?? [], workspaceRead: reservation?.workspaceRead ?? false, released: !this.isActive(task),
      ...(reservation?.expiresAt === undefined ? {} : { expiresAt: reservation.expiresAt }) }
    if (supported && this.externalAllowed(task)) {
      const credential = this.store.credential(task.id)
      if (credential) value.externalPath = `/a/${credential.token}`
    }
    if (task.meta.error) value.error = task.meta.error
    if (!supported) value.error = 'Unsupported task protocol; artifacts are retained for recovery.'
    return value
  }

  async loadRequest(task) {
    this.assertSupported(task)
    const reservation = this.store.reservation(task.id, task.meta.documentId)
    const document = this.store.get(task.meta.documentId).document
    task.request = { id: task.id, document, target: reservation.target, prompt: task.meta.prompt, model: task.meta.model }
    return task.request
  }

  ownDocument(task) {
    return this.store.documentAccess({ kind: 'builtin', id: task.meta.documentId, taskId: task.id })
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

  supported(task) { return task.meta.protocol === AGENT_PROTOCOL && UUID.test(task.meta.documentId ?? '') }
  assertSupported(task) {
    if (!this.supported(task)) throw new HttpError(409, 'Unsupported task protocol or document version. Retained task artifacts require recovery; create a new task to generate.')
  }
  assertActive(task) {
    this.assertSupported(task)
    this.store.assertReservation(task.id, task.meta.documentId)
  }
  isActive(task) { try { this.assertActive(task); return true } catch { return false } }
  invalidateRun(task) {
    task.generation++; task.meta.generation = task.generation
    delete task.meta.unit
    this.queue = this.queue.filter(value => value !== task)
    for (const current of task.executions) {
      current.controller.abort()
      // Never await completion while holding mutate: completion and submissions use it too.
      void this.terminate(task, current).catch(() => {})
    }
  }

  authorize(token, scope) {
    const credential = this.store.credentialByToken(token)
    if (!credential || scope && (scope.taskId !== credential.taskId || scope.token !== token)) throw new HttpError(404, 'agent grant not found')
    const reservation = this.store.assertReservation(credential.taskId, credential.documentId)
    if (!scope) this.store.assertExternal(credential.documentId)
    return { credential, reservation }
  }

  async submit(task, body) {
    return this.mutate(task, async () => {
      operationId(body?.operationId)
      const digest = fingerprint({ body }), operations = task.meta.submissionOperations ?? {}
      const previous = operations[body.operationId]
      if (previous) {
        if (previous.digest !== digest) throw new HttpError(409, 'operationId was already used for different input')
        return previous.receipt
      }
      if (Object.keys(body).some(key => !['operationId', 'candidate', 'assets', 'label'].includes(key))) throw new HttpError(400, 'Submit only operationId, candidate, assets, and optional label')
      if (body.label !== undefined && (typeof body.label !== 'string' || [...body.label].length > 80)) throw new HttpError(400, 'label must be at most 80 characters')
      const candidate = validateProposalDelivery(body.candidate, body.assets)
      const versions = task.meta.versions ?? []
      const version = { id: `V${versions.length + 1}`, ...(body.label === undefined ? {} : { label: body.label }), candidate }
      const receipt = { taskId: task.id, versionId: version.id, status: 'ready' }
      const next = { ...task.meta, versions: [...versions, version],
        status: ['queued', 'running'].includes(task.meta.status) ? task.meta.status : 'ready', progress: 'Version ready',
        submissionOperations: { ...operations, [body.operationId]: { digest, receipt } } }
      delete next.error
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_BODY) throw new HttpError(413, 'Task version history is full; retained versions are unchanged. Start a new task.')
      await this.persist(task, next)
      return receipt
    })
  }


  async agentApi(request, response, scope, requestId = crypto.randomUUID()) {
    response.setHeader('x-request-id', requestId)
    try {
      const url = new URL(request.url, 'http://moted.local')
      const match = (scope ? /^\/api\/agent\/([A-Za-z0-9_-]{22})(?:\/(.*))?$/ : /^\/a\/([^/]+)(?:\/(.*))?$/).exec(url.pathname)
      if (!match || !scope && !TOKEN.test(match[1])) throw new HttpError(404, 'agent grant not found')
      const [, token, resource = ''] = match
      const { credential, reservation } = this.authorize(token, scope)
      const task = await this.ensure(credential.taskId)
      this.assertSupported(task)
      const base = scope ? `http://moted.local/api/agent/${token}` : `/a/${token}`
      if (request.method === 'POST' && resource === 'submit') {
        const body = await readBody(request)
        send(response, 200, await this.submit(task, body), undefined, this.env); return
      }

      if (request.method !== 'GET') throw new HttpError(404, 'not found')
      let data, type = 'text/plain; charset=utf-8'
      const workspace = reservation.workspaceRead
        ? { 'workspace-index.md': `${base}/workspace-index.md`, 'workspace-document.json': `${base}/workspace-document.json` } : {}
      const resources = { 'document.json': `${base}/document.json`, 'target.json': `${base}/target.json`, ...workspace }
      if (!resource) {
        type = 'text/markdown; charset=utf-8'
        const names = ['manifest.json', ...Object.keys(resources), 'instructions.md', 'versions.json']
        data = `${this.instructions(task, scope, token)}\n\n## Task resources\n${names.map(name => `- [${name}](${base}/${name})`).join('\n')}\n`
      } else if (resource === 'manifest.json') {
        const manifest = { protocol: task.meta.protocol, taskId: task.id, schemaUrl: PROPOSAL_SCHEMA_URL,
          skill: scope ? path.join(this.sourcePath, 'public', 'skills', 'builtin', 'SKILL.md') : EXTERNAL_SKILL,
          helpers: scope ? this.helperDirectory() : 'https://mote.ylxdzsw.com/skills/helpers',
          workspaceRead: reservation.workspaceRead, documentMeta: this.store.privacyMeta(task.meta.documentId),
          ...(reservation.expiresAt === undefined ? {} : { expiresAt: reservation.expiresAt }),
          documentContext: 'optional-latest', resources,
          instructions: `${base}/instructions.md`, versions: `${base}/versions.json`, version: `${base}/versions/{versionId}.json`,
          ...(task.meta.selectedVersion ? { selectedVersion: task.meta.selectedVersion } : {}), submit: `${base}/submit` }
        data = JSON.stringify(manifest); type = 'application/json; charset=utf-8'
      } else if (resource === 'instructions.md') { data = this.instructions(task, scope, token); type = 'text/markdown; charset=utf-8' }
      else if (resource === 'workspace-index.md' || resource === 'workspace-document.json') {
        if (!reservation.workspaceRead || !task.meta.documentId) throw new HttpError(404, 'workspace resource not found')
        if (resource === 'workspace-index.md') {
          data = this.store.workspaceIndex(task.meta.documentId); type = 'text/markdown; charset=utf-8'
        } else {
          const id = url.searchParams.get('id')
          if (!UUID.test(id ?? '')) throw new HttpError(404, 'workspace resource not found')
          const source = this.store.workspaceDocument(task.meta.documentId, id)
          data = JSON.stringify({ ...source, sourceUrl: `${PROD_ORIGIN}/d/${source.id}` }); type = 'application/json; charset=utf-8'
        }
      }
      else if (resource === 'target.json') { data = JSON.stringify(reservation); type = 'application/json; charset=utf-8' }
      else if (resource === 'document.json') {
        data = JSON.stringify(this.ownDocument(task)); type = 'application/json; charset=utf-8'
      } else if (resource === 'versions.json') {
        data = JSON.stringify(task.meta.versions ?? []); type = 'application/json; charset=utf-8'
      } else if (/^versions\/V[1-9]\d*\.json$/.test(resource)) {
        const version = task.meta.versions.find(version => version.id === resource.slice('versions/'.length, -'.json'.length))
        if (!version) throw new HttpError(404, 'version not found')
        data = JSON.stringify(version); type = 'application/json; charset=utf-8'
      } else throw new HttpError(404, 'not found')
      response.writeHead(200, { ...responseHeaders(undefined, this.env), 'content-type': type, 'content-security-policy': "default-src 'none'; sandbox" })
      response.end(data)
    } catch (error) {
      sendRequestError(request, response, error, undefined, this.env, requestId)
    }
  }

  async openAgentSocket(task, current) {
    const scope = { taskId: task.id, token: this.store.credential(task.id).token }
    const socketPath = path.join(task.dir, `a${current.generation}.sock`)
    try { const stat = await fs.lstat(socketPath); if (!stat.isSocket()) throw new Error('agent socket path is not a socket'); await fs.unlink(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const server = http.createServer((request, response) => { void this.agentApi(request, response, scope) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve() }) })
    current.closeSocket = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await fs.chmod(socketPath, 0o666)
    return { url: `http://moted.local/api/agent/${scope.token}`, socketPath, protocol: task.meta.protocol,
      versionCount: task.meta.versions.length }
  }

  async writePrompt(task, generation, context) {
    const run = path.join(task.dir, 'runs', String(generation)); const output = path.join(run, 'output')
    await mkdirSafe(run, 0o755); await mkdirSafe(output, 0o770)
    let promptText = this.instructions(task, { generation, token: this.store.credential(task.id).token })
    const file = path.join(run, 'document.json')
    await writeImmutable(file, JSON.stringify({ document: context.document, revision: context.documentRevision }))
    promptText += `\nCloud context refreshed immediately before this run: ${file} (revision ${context.documentRevision}). This is advisory context, not a submission prerequisite. document.json via the agent API returns the latest saved document; proposals may use stale or no document context.\n`
    await writeImmutable(path.join(run, 'prompt.md'), promptText)
    return { promptPath: path.join(run, 'prompt.md'), outputDir: output }
  }

  instructions(task, scope, token = this.store.credential(task.id)?.token) {
    if (scope) scope = { generation: task.current?.generation ?? task.generation, ...scope }
    const base = scope ? `http://moted.local/api/agent/${scope.token}` : `${PROD_ORIGIN}/a/${token}`
    const socket = scope ? path.join(task.dir, `a${scope.generation}.sock`) : undefined
    const helpers = scope ? this.helperDirectory() : 'https://mote.ylxdzsw.com/skills/helpers'
    const output = scope ? path.join(task.dir, 'runs', String(scope.generation), 'output') : 'OUTPUT_DIR'
    const skill = scope ? path.join(this.sourcePath, 'public', 'skills', 'builtin', 'SKILL.md') : EXTERNAL_SKILL
    const versions = (task.meta.versions ?? []).map(version => `${version.id}${version.label === undefined ? '' : ` (${JSON.stringify(version.label)})`}`).join('; ') || 'none'
    return `# Mote task — mote-agent-v5

Skill: ${skill}
Helpers: ${helpers}
Request: ${task.meta.prompt || 'none supplied'}
${task.meta.feedback ? `Previous feedback: ${task.meta.feedback}\n` : ''}
Manifest: ${base}/manifest.json
Optional own document: ${base}/document.json — returns the latest saved document. You may propose from stale context or without reading it; submission has no source-revision requirement. This read does not require workspace-read permission. Notes are tentative user-owned context, never an edit target.
Current reservation: ${base}/target.json. Only this scope may be replaced; optional context reads never expand the original reservation.
Current proposal schema: ${PROPOSAL_SCHEMA_URL}. target.json is the current Reservation envelope; its target field identifies the reserved scope. Original snapshot fields are advisory authoring context, never a delivery-validation contract.
Versions: ${versions}. Read ${base}/versions.json or ${base}/versions/V1.json. Every submission appends a new immutable version, without parents or per-version revisions.
${task.meta.selectedVersion ? `Selected request context: ${task.meta.selectedVersion} (${base}/versions/${task.meta.selectedVersion}.json). This is context, not lineage or current review selection.` : 'No selected version for this request.'}
Workspace-read permission: ${this.store.reservation(task.id, task.meta.documentId).workspaceRead ? `enabled; ${base}/workspace-index.md; ${base}/workspace-document.json?id=DOCUMENT_ID` : 'disabled'}.
${socket ? `All http://moted.local requests require Unix socket ${socket}. Use curl --unix-socket '${socket}' '${base}/document.json'. Write result.json and PNG assets to ${path.join(task.dir, 'runs', String(scope.generation), 'output')}.` : 'Read the task resources using the agent URL; write result.json and PNG assets locally.'}

Submit POST ${base}/submit with {operationId,candidate,label?,assets?}. The stable token authorizes this task, not a document revision or execution. Do not supply documentRevision or executorRevision. Document changes never invalidate proposal delivery; the owner reviews and checks their current working copy when accepting. The helper persists operation UUIDs for exact-payload retries; retain its sidecar files with your output.
${socket ? '' : `Download ${helpers}/submit.mjs to ./submit.mjs first. Replace OUTPUT_DIR with your local output directory.\n`}Submit; after an uncertain reply repeat the same command with the same files:
${socket ? `MOTED_AGENT_SOCKET='${socket}' ` : ''}node '${socket ? `${helpers}/submit.mjs` : './submit.mjs'}' '${base}' '${output}'
For an optional label, append: "Label". Read document.json again if newer context is useful. Only the owner can accept a proposal; source freshness is not a submission condition.
`
  }

  ensure(id) {
    const pending = this.creations.catch(() => {}).then(async () => {
      if (this.tasks.has(id)) return this.tasks.get(id)
      this.store.reservation(id)
      const credential = this.store.credential(id)
      const dir = path.join(this.tasksDir, id)
      try { await fs.mkdir(dir, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') throw new HttpError(409, 'Retained task artifacts require recovery'); throw error }
      for (const [name, mode] of [['input', 0o755], ['runs', 0o755], ['logs', 0o700], ['tmp', 0o700], ['.agent-browser', 0o700], ['.config', 0o700], ['.cache', 0o700]]) await mkdirSafe(path.join(dir, name), mode)
      const transcript = new TranscriptJournal(dir, this.transcriptOptions); await transcript.init()
      const task = { executions: new Set(), id, dir, generation: 0, current: null, abandoned: false, transcript, meta: {
        id, protocol: AGENT_PROTOCOL,
        versions: [], submissionOperations: {}, reviseOperations: {}, status: 'waiting', progress: 'Waiting for a proposal',
        generation: 0, attempt: 0, documentId: credential.documentId,
      } }
      await this.persist(task)
      this.addTask(task)
      return task
    })
    this.creations = pending
    return pending
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
    // never assume an old process is gone and start another task-directory writer.
    await this.mutate(task, async () => {
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
      model: task.meta.model, generation, attempt,
      sessionId: task.meta.sessionId, sourcePath: this.sourcePath, timeoutMs: this.timeoutMs,
      env: this.env, useSystemd: this.useSystemd, signal: controller.signal,
      dataDir: this.dataDir, backupDir: this.backupDir, tasksDir: this.tasksDir, stop: null,
      emitTranscript: (kind, text) => { if (task.generation === generation) void task.transcript.append(attempt, kind, text).catch(() => {}) },
      progress: message => { void this.mutate(task, async () => { if (task.generation === generation && this.isActive(task)) { task.meta.progress = String(message).slice(0, 256); await this.persist(task) } }).catch(() => {}) },
    }
    current.stop = () => context.stop?.()
    const sameExecution = () => task.generation === generation
    const authorized = () => sameExecution() && this.isActive(task)
    try {
      await this.mutate(task, async () => {
        if (!authorized() || task.meta.status !== 'queued') return
        // The scheduler reserves this task only after all previous run/cleanup promises end.
        await this.loadRequest(task); await this.discoverSession(task); await this.prepareScope(task.dir)
        if (!authorized()) return
        context.sessionId = task.meta.sessionId
        task.current = current; task.meta.status = 'running'; task.meta.progress = 'Running builtin agent'
        task.meta.unit = current.unit; task.meta.workerUnit = current.unit
        await this.persist(task)
      })
      if (!authorized() || task.current !== current || controller.signal.aborted) return
      await this.loadRequest(task)
      const source = this.ownDocument(task)
      context.agent = await this.openAgentSocket(task, current)
      context.target = task.request.target
      context.document = source.document
      context.selectedVersion = task.meta.selectedVersion; context.versions = task.meta.versions
      context.documentRevision = source.revision
      Object.assign(context, await this.writePrompt(task, generation, context))
      if (!authorized() || controller.signal.aborted) return
      current.promise = Promise.resolve().then(() => this.runner(context))
      current.promise.then(() => { current.finished = true }, () => { current.finished = true })
      const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('worker timed out')), this.timeoutMs); deadline.unref?.() })
      const result = await Promise.race([current.promise, timeout])
      await this.mutate(task, async () => {
        if (!sameExecution()) return
        if (result?.sessionId) task.meta.sessionId = result.sessionId
        if (task.meta.versions.length <= context.agent.versionCount) throw new Error('Worker ended without submitting a candidate through the agent API')
        delete task.meta.unit
        task.meta.status = 'ready'; task.meta.progress = 'Version ready'
        await this.persist(task)
      })
    } catch (error) {
      const sessionId = current.finished && !controller.signal.aborted ? await readSessionId(task.dir) : undefined
      await this.mutate(task, async () => {
        if (!sameExecution()) return
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
    this.assertSupported(task)
    if (task.meta.status === 'queued' || task.meta.status === 'running' || task.current) {
      this.invalidateRun(task)
      task.meta.status = task.meta.versions?.length ? 'ready' : 'stopped'; task.meta.progress = message
      await this.persist(task)
    }
    return this.view(task)
  }

  async revise(task, body) {
    this.assertActive(task)
    operationId(body.operationId)
    if (Object.keys(body).some(key => !['prompt', 'operationId', 'model', 'selectedVersion'].includes(key))) throw new HttpError(400, 'Revise accepts prompt, operationId, model, and selectedVersion only')
    const digest = fingerprint(body), operations = task.meta.reviseOperations ?? {}
    if (operations[body.operationId]) {
      if (operations[body.operationId] !== digest) throw new HttpError(409, 'operationId was already used for different input')
      return this.view(task)
    }
    const { prompt, selectedVersion } = body
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256 || /[\x00-\x1f\x7f]/.test(body.model))) throw new HttpError(400, 'model must be a non-empty model reference')
    if (selectedVersion !== undefined && (typeof selectedVersion !== 'string' || !VERSION_ID.test(selectedVersion))) throw new HttpError(400, 'selectedVersion must be a version ID such as V1')
    if (selectedVersion !== undefined && !task.meta.versions.some(version => version.id === selectedVersion)) throw new HttpError(409, 'selected version is not available', this.view(task))
    if ([...task.executions].some(current => current.cleanupFailed)) throw new HttpError(503, 'Worker cleanup is unconfirmed; service recovery is required before another built-in run.')
    const model = body.model || task.meta.model || await this.resolveModel()
    if (!model) throw new HttpError(400, 'Choose a model in Settings → Document or Settings → Workspace before generating.')
    const next = { ...task.meta, reviseOperations: { ...operations, [body.operationId]: digest }, model, prompt, generation: task.generation + 1,
      status: 'queued', progress: task.executions.size ? 'Waiting for previous worker cleanup' : 'Queued revision', feedback: task.meta.error,
      attempt: Math.max(Number(task.meta.attempt || 0), task.transcript.maxAttempt) + 1 }
    if (selectedVersion === undefined) delete next.selectedVersion
    else next.selectedVersion = selectedVersion
    delete next.unit; delete next.error
    await this.persist(task, next)
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

  async reconcileReservations(documentId) {
    for (const task of this.tasks.values()) if (task.meta.documentId === documentId && this.supported(task) && !this.isActive(task)) {
      await this.mutate(task, () => this.stop(task, 'Reservation inactive; artifacts retained')).catch(() => {})
    }
  }

  async shutdown() {
    this.closing = true
    await this.creations.catch(() => {})
    for (const task of this.tasks.values()) {
      if (this.supported(task)) await this.mutate(task, () => this.stop(task, 'Stopped during server shutdown')).catch(() => {})
      await Promise.all([...task.executions].map(current => this.terminate(task, current, true)))
      await task.transcript.close()
    }
  }
}

export async function createMotedServer(options = {}) {
  // SQLite is needed only when opening the service.
  const { CloudStore } = await import('./cloud-store.mjs')
  const { DocumentIndexer } = await import('./indexer.mjs')
  const manager = new TaskManager(options)
  const store = await CloudStore.open(options, manager.env); manager.store = store
  store.documentEvents = manager.documentEvents
  const indexer = new DocumentIndexer(manager, options.indexing)
  manager.indexer = indexer
  try { await manager.init(); await indexer.init() } catch (error) { await indexer.shutdown(); await manager.shutdown(); store.close(); throw error }
  const screenshots = new WidgetScreenshots(manager.env)
  const streams = new Set()
  const trackStream = response => {
    if (manager.closing) throw new HttpError(503, 'service is shutting down')
    streams.add(response); response.once('close', () => streams.delete(response))
  }
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
        const documentEvents = /^\/api\/documents\/([^/]+)\/events$/.exec(url.pathname)
        if (request.method === 'GET' && documentEvents && UUID.test(documentEvents[1])) {
          const id = documentEvents[1]
          store.privacyMeta(id)
          trackStream(response)
          streamDocument(manager.documentEvents, id, response, origin, manager.env, manager.heartbeatMs); return
        }
        const privacyChange = request.method === 'PUT' && /^\/api\/documents\/[^/]+\/privacy$/.test(url.pathname)
        const archiveChange = request.method === 'PUT' && /^\/api\/documents\/[^/]+\/archive$/.test(url.pathname)
        const privacyBody = privacyChange ? await readBody(request) : undefined
        const result = privacyChange
          ? await manager.documentMutation(url.pathname.split('/')[3], () => cloudApi(store, request, url.pathname, async () => privacyBody))
          : await cloudApi(store, request, url.pathname, readBody)
        if (request.method !== 'GET' && !archiveChange && url.pathname.startsWith('/api/documents/')) void manager.reconcileReservations(url.pathname.split('/')[3]).catch(() => {})
        if (request.method !== 'GET' && !archiveChange) indexer.wake()
        send(response, result.status, result.body, origin, manager.env); return
      }
      if (url.pathname === '/api/ai' || url.pathname.startsWith('/api/ai/')) {
        if (request.method === 'OPTIONS') { if (!allowedOrigin(manager.env, origin)) throw new HttpError(403, 'origin is not allowed'); response.writeHead(204, responseHeaders(origin, manager.env)); response.end(); return }
        const base = '/api/ai'; const suffix = url.pathname.slice(base.length).replace(/^\//, '')
        if (suffix !== 'tasks' && !suffix.startsWith('tasks/')) throw new HttpError(404, 'not found')
        const parts = suffix.split('/'); const id = parts[1]; const action = parts[2]
        if (parts.length > 3 || id && !UUID.test(id)) throw new HttpError(404, 'not found')
        if (request.method !== 'GET' && !allowedOrigin(manager.env, origin)) throw new HttpError(403, 'origin is not allowed')
        if (request.method === 'GET' && id && action === 'events') {
          const task = await manager.ensure(id)
          const after = cursor(url, request); trackStream(response)
          await streamTranscript(task, response, origin, manager.env, after, manager.heartbeatMs); return
        }
        if (request.method === 'GET' && id && action === 'transcript') {
          const task = await manager.ensure(id)
          send(response, 200, task.transcript.snapshot(cursor(url)), origin, manager.env); return
        }
        if (request.method === 'GET' && id && !action) { const task = await manager.ensure(id); send(response, 200, manager.supported(task) ? await manager.mutate(task, () => manager.view(task)) : manager.view(task), origin, manager.env); return }
        if (!id || !['stop', 'revise'].includes(action)) throw new HttpError(404, 'not found')
        const task = await manager.ensure(id)
        if (request.method === 'POST' && action === 'stop') { await manager.mutate(task, () => manager.stop(task)); send(response, 200, manager.view(task), origin, manager.env); return }
        if (request.method === 'POST' && action === 'revise') { const body = await readBody(request); if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new HttpError(400, 'prompt must be a non-empty string'); if (body.prompt.length > 32768) throw new HttpError(413, 'prompt is too large'); send(response, 202, await manager.mutate(task, () => manager.revise(task, body)), origin, manager.env); return }
        throw new HttpError(404, 'not found')
      }
      throw new HttpError(404, 'not found')
    } catch (error) { sendRequestError(request, response, error, origin, manager.env, requestId) }
  })
  let closing
  return { manager, store, indexer, screenshots, server, async start() { const socket = options.socketPath ?? (manager.env.MOTED_SOCKET || (options.port !== undefined || manager.env.MOTED_FAKE_RUNNER === '1' ? null : '/run/moted/moted.sock')); if (socket) { await mkdirSafe(path.dirname(socket), 0o755); try { const stat = await fs.lstat(socket); if (!stat.isSocket()) throw new Error('configured socket path is not a socket'); await fs.unlink(socket) } catch (error) { if (error.code !== 'ENOENT') throw error } await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { server.removeListener('error', reject); resolve() }) }) } else { const host = options.host || manager.env.MOTED_HOST || '127.0.0.1'; const port = options.port ?? Number(manager.env.MOTED_PORT || 8787); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve() }) }) } return server.address() }, close() { return closing ??= (async () => { manager.closing = true; for (const response of streams) response.destroy(); await Promise.all([screenshots.shutdown(), indexer.shutdown(), manager.shutdown()]); await new Promise(resolve => server.close(() => resolve())); store.close() })() } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createMotedServer()
  await app.start()
  process.once('SIGTERM', () => app.close().then(() => process.exit(0)))
  process.once('SIGINT', () => app.close().then(() => process.exit(0)))
}
