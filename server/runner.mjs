import { execFile, spawn, spawnSync } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import { finished } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import net from 'node:net'
import { deflateSync } from 'node:zlib'
import { storagePaths } from './storage-paths.mjs'
import { submitResult } from './submit.mjs'

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/

export function workerUnit(taskId, generation) { return `moted-${taskId}-${generation}` }

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function systemctl(args, env) {
  return new Promise((resolve, reject) => {
    execFile(env.MOTED_SYSTEMCTL || 'systemctl', args, { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8' },
      (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

async function confirmStopped(check) {
  for (const ms of [0, 250, 500, 1000, 2000, 4000]) {
    if (ms) await delay(ms)
    if (await check()) return
  }
  throw new Error('Worker cleanup could not be confirmed; further built-in runs are paused until service recovery.')
}

async function unitEmpty(unit, env) {
  const output = await systemctl(['show', '--property=LoadState', '--property=ActiveState', '--property=ControlGroup', unit], env).catch(() => '')
  const state = Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  if (state.LoadState !== 'not-found' && !['inactive', 'failed'].includes(state.ActiveState)) return false
  const group = state.ControlGroup || `/system.slice/${unit}.service`
  try { return /^populated 0$/m.test(await fs.readFile(`/sys/fs/cgroup${group}/cgroup.events`, 'utf8')) }
  catch (error) { return error.code === 'ENOENT' }
}

export async function stopWorkerUnit(unit, env, { immediate = false } = {}) {
  if (!/^moted-[0-9a-f-]+-\d+$/i.test(unit)) throw new Error('invalid worker unit')
  if (!immediate) {
    await systemctl(['kill', '--kill-who=all', '--signal=TERM', unit], env).catch(() => {})
    await delay(250)
  }
  await systemctl(['kill', '--kill-who=all', '--signal=KILL', unit], env).catch(() => {})
  await systemctl(['stop', '--job-mode=replace-irreversibly', unit], env).catch(() => {})
  // Failure is bounded, but must keep later generations fenced off.
  if (immediate) {
    if (!await unitEmpty(unit, env)) throw new Error('Worker cleanup could not be confirmed')
  } else await confirmStopped(() => unitEmpty(unit, env))
}

export async function stopWorkerProcessGroup(pid) {
  try { process.kill(-pid, 'SIGTERM') } catch (error) { if (error.code === 'ESRCH') return }
  await delay(250)
  try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code === 'ESRCH') return }
  await confirmStopped(() => {
    try { process.kill(-pid, 0) } catch (error) { if (error.code === 'ESRCH') return true }
    return false
  })
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }

async function childWait(command, args, options, onChild) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(command, args, options) } catch (error) { reject(error); return }
    try { onChild?.(child) } catch (error) { reject(error); return }
    child.on('error', reject)
    child.on('close', (code, signal) => code === 0 ? resolve({ code, signal }) : reject(new Error(`worker exited (${code ?? signal})`)))
  })
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = () => { clearTimeout(timer); reject(new Error('aborted')) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function textOf(node) { return (node?.content ?? []).filter(child => child.type === 'text').map(child => child.text || '').join('') }

export function fakePng(width, height) {
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    const header = Buffer.alloc(4), trailer = Buffer.alloc(4); header.writeUInt32BE(bytes.length); trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, data, trailer])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))])
}

export async function fakeRunner(context) {
  context.progress('Fake runner is preparing a candidate')
  const delay = Math.max(0, Number(context.env.MOTED_FAKE_DELAY_MS || 15))
  const transcript = (kind, text) => context.emitTranscript?.(kind, text)
  transcript('stdout', '\u001b[36m[mote fake]\u001b[0m starting candidate\n')
  await wait(delay, context.signal)
  const document = await readJson(path.join(context.inputDir, 'document.json'))
  const candidate = { summary: `Fake candidate for ${context.target.kind} target.` }
  transcript('stdout', `attempt ${context.attempt}: reading target\n`)
  await wait(delay, context.signal)
  if (context.target.kind === 'object') {
    candidate.object = structuredClone(document.floating.find(object => object.id === context.target.objectId))
    if (candidate.object?.kind === 'html') {
      candidate.object.screenshot = `data:image/png;base64,${fakePng(Math.round(candidate.object.width), Math.round(candidate.object.height)).toString('base64')}`
      candidate.object.html = '<button id="mote-fake-button" type="button">AI draft: 0</button><script>document.querySelector("button").addEventListener("click", event => { event.currentTarget.textContent = `AI draft: ${Number(event.currentTarget.textContent.split(\": \")[1] || 0) + 1}` })</script>'
    } else if (candidate.object?.kind === 'code') {
      candidate.object.source = `AI draft\n${candidate.object.source}`
    } else if (candidate.object?.kind === 'drawing') {
      const { id, anchorId, x, y, width, height, placement, centered } = candidate.object
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 480 320"><rect x="40" y="100" width="140" height="100" rx="12" fill="#e8eef7" stroke="#425f87" stroke-width="2"/><path d="M180 150h100m-12-8 12 8-12 8" fill="none" stroke="#425f87" stroke-width="2"/><rect x="280" y="100" width="160" height="100" rx="12" fill="#f6edde" stroke="#875a35" stroke-width="2"/><text x="110" y="156" text-anchor="middle" font-family="sans-serif" font-size="18">Sketch</text><text x="360" y="156" text-anchor="middle" font-family="sans-serif" font-size="18">AI figure</text></svg>`
      candidate.object = { id, anchorId, x, y, width, placement, centered, kind: 'image', src: `data:image/svg+xml,${encodeURIComponent(svg)}`, alt: 'Fake sketch-to-figure candidate' }
    } else if ((candidate.object?.kind ?? 'text') === 'text' && candidate.object.content?.content?.[0]) {
      const first = candidate.object.content.content[0]
      candidate.object.content = { ...candidate.object.content, content: [{ ...first, content: [{ type: 'text', text: `AI draft: ${textOf(first) || 'generated note'}` }] }, ...candidate.object.content.content.slice(1)] }
    }
  } else if (context.target.kind === 'segment') {
    const prefix = `fake-segment-${context.taskId}`
    const paragraphId = `${prefix}-paragraph`
    const flowId = `${prefix}-flow`
    const figureId = `${prefix}-figure`
    const drawingWidth = Math.min(180, document.width - document.margins.left - document.margins.right)
    const x = document.margins.left
    const content = [
      { type: 'paragraph', attrs: { id: paragraphId, semantic: 'body' }, content: [{ type: 'text', text: 'AI draft: a composed segment' }] },
      { type: 'flow', attrs: { id: flowId, objectId: figureId } },
    ]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${drawingWidth}" height="64" viewBox="0 0 480 320"><rect x="40" y="70" width="400" height="180" rx="18" fill="#e8eef7" stroke="#425f87" stroke-width="5"/><path d="M90 205l90-80 70 55 78-65 62 90" fill="none" stroke="#425f87" stroke-width="9"/></svg>`
    const figure = { id: figureId, kind: 'image', anchorId: flowId, x: 0, y: 0, width: drawingWidth, placement: 'flow', src: `data:image/svg+xml,${encodeURIComponent(svg)}`, alt: 'AI figure', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: `${prefix}-caption` }, content: [{ type: 'text', text: 'AI figure' }] }] } } }
    candidate.segment = { version: 'V0', type: 'segment', content, floating: [figure], geometry: {
      [figureId]: { x, y: 28, width: drawingWidth, height: 64 },
    }, anchorTops: { [paragraphId]: 0, [flowId]: 28 }, originTop: 0 }
  } else {
    const blocks = []
    const visit = node => { if (node?.attrs?.id && context.target.blockIds.includes(node.attrs.id)) blocks.push(structuredClone(node)); node.content?.forEach(visit) }
    visit(document.content)
    const first = blocks.findIndex(node => node.type === 'paragraph')
    if (first >= 0) blocks[first] = { ...blocks[first], content: [{ type: 'text', text: `AI draft: ${textOf(blocks[first]) || 'generated note'}` }] }
    candidate.content = blocks
  }
  transcript('stderr', '\u001b[33m[mote fake warning]\u001b[0m no model call made\n')
  await wait(delay, context.signal)
  transcript('stdout', 'candidate written\n')
  await fs.writeFile(path.join(context.outputDir, 'result.json'), JSON.stringify(candidate), { flag: 'wx', mode: 0o660 })
  await submitResult(context)
  return { sessionId: context.sessionId || `fake-${context.taskId}` }
}

async function prepareWorkerPaths(context) {
  if (!context.useSystemd) return
  const user = context.env.MOTED_WORKER_USER || 'mote-ai'
  const uidResult = spawnSync('id', ['-u', user], { encoding: 'utf8' })
  const gidResult = spawnSync('id', ['-g', user], { encoding: 'utf8' })
  const uid = Number(uidResult.stdout?.trim()); const gid = Number(gidResult.stdout?.trim())
  if (uidResult.status !== 0 || gidResult.status !== 0 || !Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) throw new Error('configured AI worker must be an existing non-root user')
  await fs.chown(context.taskDir, 0, gid); await fs.chmod(context.taskDir, 0o750)
  const directories = [path.join(context.taskDir, '.mu'), path.join(context.taskDir, '.mu', 'sessions'), path.join(context.taskDir, '.mu', 'objects'), path.join(context.taskDir, 'tmp'), path.join(context.taskDir, '.agent-browser'), path.join(context.taskDir, '.config'), path.join(context.taskDir, '.cache'), context.outputDir]
  for (const directory of directories) await fs.chown(directory, uid, gid)
  const credential = path.join(context.taskDir, '.mu', '.env')
  await fs.chown(credential, uid, gid).then(() => fs.chmod(credential, 0o400)).catch(error => { if (error.code !== 'ENOENT') throw error })
}

export function workerStorageProperties(context) {
  const defaults = storagePaths({}, context.env)
  const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
  const tasksDir = context.tasksDir || path.dirname(context.taskDir)
  return [
    // Each worker sees only its own bind-mounted task, never sibling sessions.
    `TemporaryFileSystem=${quote(tasksDir)}:ro,mode=0711`,
    `InaccessiblePaths=${quote(context.dataDir || defaults.dataDir)} -${quote(context.backupDir || defaults.backupDir)} -/etc/nginx`,
    `InaccessiblePaths=-${quote(context.env.MOTED_SOCKET || '/run/moted/moted.sock')}`,
  ]
}

export async function readSessionId(taskDir) {
  try {
    const scope = path.join(taskDir, '.mu')
    const target = path.resolve(scope, await fs.readlink(path.join(scope, 'current-session')))
    const id = path.basename(target, '.jsonl')
    if (path.dirname(target) !== path.join(scope, 'sessions') || !target.endsWith('.jsonl') || !SAFE_SESSION.test(id)) return
    const stat = await fs.lstat(target)
    return stat.isFile() && !stat.isSymbolicLink() ? id : undefined
  } catch { return undefined }
}

// Only endpoints from the administrator's Mu config are relayed, never a request URL.
async function providerBridges(taskDir) {
  const definitions = await readJson(path.join(taskDir, 'input', 'providers.json'))
  const servers = [], sockets = new Set()
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    const results = await Promise.allSettled(servers.map(async ({ server, local }) => {
      await new Promise(resolve => server.close(resolve))
      await fs.rm(local, { force: true })
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
  try {
    for (const { remote, local } of definitions) {
      if (path.dirname(local) !== taskDir) throw new Error('Invalid provider bridge path')
      await fs.rm(local, { force: true })
      const server = net.createServer(client => {
        const upstream = net.createConnection(remote)
        for (const socket of [client, upstream]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) }
        client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy())
        client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy())
        client.pipe(upstream).pipe(client)
      })
      servers.push({ server, local })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(local, resolve) })
      await fs.chmod(local, 0o666)
    }
    return close
  } catch (error) { await close(); throw error }
}

export async function muRunner(context) {
  const unit = workerUnit(context.taskId, context.generation)
  await prepareWorkerPaths(context)
  if (context.signal.aborted) throw new Error('aborted')
  const mu = context.env.MOTED_MU_BIN || 'mu'
  const muArgs = context.sessionId
    ? ['--trap', 'off', '-o', 'concise', '-s', context.sessionId, context.promptPath]
    : ['--trap', 'off', '-o', 'concise', '-m', context.model, context.promptPath]
  const environment = {
    PATH: context.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: context.env.LANG || 'C.UTF-8',
    HOME: context.taskDir,
    TMPDIR: '/tmp',
    XDG_CONFIG_HOME: path.join(context.taskDir, '.config'),
    XDG_CACHE_HOME: path.join(context.taskDir, '.cache'),
    AGENT_BROWSER_EXECUTABLE_PATH: context.env.MOTED_BROWSER_EXECUTABLE || '/usr/bin/chromium',
    AGENT_BROWSER_NAMESPACE: context.taskId.slice(0, 8),
    AGENT_BROWSER_SESSION: 'figure',
    AGENT_BROWSER_SOCKET_DIR: '/tmp/ab',
    AGENT_BROWSER_DOWNLOAD_PATH: context.outputDir,
    MOTED_TASK_ID: context.taskId,
    MOTED_INPUT_DIR: context.inputDir,
    MOTED_OUTPUT_DIR: context.outputDir,
    MOTED_SOURCE_PATH: context.sourcePath,
    MOTED_AGENT_SOCKET: context.agent?.socketPath || '',
    MOTED_AGENT_URL: context.agent?.url || '',
  }
  let command = mu
  let args = muArgs
  let spawnOptions = { cwd: context.taskDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
  if (context.useSystemd) {
    command = context.env.MOTED_SYSTEMD_RUN || 'systemd-run'
    const property = value => `--property=${value}`
    args = ['--quiet', '--pipe', '--wait', '--collect', '--unit', unit, '--service-type=exec', property('KillMode=control-group'), property('RemainAfterExit=no'), property(`RuntimeMaxSec=${Math.ceil(context.timeoutMs / 1000)}`), property(`CPUQuota=${context.env.MOTED_CPU_QUOTA || '200%'}`), property(`MemoryMax=${context.env.MOTED_MEMORY_MAX || '2G'}`), property(`TasksMax=${context.env.MOTED_TASKS_MAX || '256'}`), property('NoNewPrivileges=yes'), property('CapabilityBoundingSet='), property('AmbientCapabilities='), property('ProtectSystem=strict'), property('ProtectHome=read-only'), property('PrivateTmp=yes'), property('PrivatePIDs=yes'), property('PrivateDevices=yes'), property('ProtectControlGroups=yes'), property('ProtectKernelTunables=yes'), property('ProtectKernelModules=yes'), property('ProtectHostname=yes'), property('RestrictSUIDSGID=yes'), property('LockPersonality=yes'), property(`BindReadOnlyPaths=${context.taskDir}`), property(`BindReadOnlyPaths=${context.sourcePath}`), property(`ReadOnlyPaths=${path.join(context.taskDir, 'input')}`), property(`ReadOnlyPaths=${context.promptPath}`), property('ReadOnlyPaths=/root/.mu'), property(`BindPaths=${path.join(context.taskDir, '.mu')}`), property(`BindPaths=${path.join(context.taskDir, 'tmp')}`), property(`BindPaths=${path.join(context.taskDir, '.config')}`), property(`BindPaths=${path.join(context.taskDir, '.cache')}`), property(`BindPaths=${path.join(context.taskDir, '.agent-browser')}`), property(`BindPaths=${context.outputDir}`), property(`ReadOnlyPaths=${path.join(context.taskDir, '.mu', 'config.jsonc')}`), property(`ReadOnlyPaths=${path.join(context.taskDir, '.mu', 'AGENTS.md')}`), property(`ReadOnlyPaths=-${path.join(context.taskDir, '.mu', '.env')}`), property('InaccessiblePaths=-/run/dbus -/run/systemd -/run/docker.sock -/var/run/docker.sock -/run/moted -/run/user -/root/.mu/.env'), property(`WorkingDirectory=${context.taskDir}`), `--uid=${context.env.MOTED_WORKER_USER || 'mote-ai'}`]
    args.push(...workerStorageProperties(context).map(property))
    for (const [key, value] of Object.entries(environment)) args.push(`--setenv=${key}=${value}`)
    args.push('--', mu, ...muArgs)
    spawnOptions = { cwd: context.taskDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
  }
  const configuredLogLimit = Number(context.env.MOTED_LOG_MAX_BYTES)
  const logLimit = Math.max(1024, Number.isFinite(configuredLogLimit) && configuredLogLimit > 0 ? configuredLogLimit : 1024 * 1024)
  const configuredLogTotal = Number(context.env.MOTED_LOG_TOTAL_MAX_BYTES)
  const logTotalLimit = Math.max(logLimit * 2, Number.isFinite(configuredLogTotal) && configuredLogTotal > 0 ? configuredLogTotal : 4 * 1024 * 1024)
  const stdout = await boundedLog(path.join(context.taskDir, 'logs', `${context.generation}.stdout.log`), logLimit)
  const stderr = await boundedLog(path.join(context.taskDir, 'logs', `${context.generation}.stderr.log`), logLimit)
  let child
  let stopPromise
  const stopWorker = () => stopPromise ??= (async () => {
    if (context.useSystemd) await stopWorkerUnit(unit, context.env)
    else if (child?.pid) await stopWorkerProcessGroup(child.pid)
  })().catch(error => { context.cleanupFailed = true; throw error })
  context.stop = stopWorker
  const onAbort = () => { void stopWorker().catch(() => {}) }
  context.signal.addEventListener('abort', onAbort, { once: true })
  if (context.signal.aborted) onAbort()
  let failure
  let closeBridges = async () => {}
  try {
    closeBridges = await providerBridges(context.taskDir)
    if (context.signal.aborted) throw new Error('aborted')
    await childWait(command, args, spawnOptions, value => {
      child = value
      context.onWorkerStart?.(value.pid, unit)
      capture(value.stdout, stdout, 'stdout', context.emitTranscript)
      capture(value.stderr, stderr, 'stderr', context.emitTranscript)
    })
  } catch (error) { failure = error }
  finally {
    // Even normal main-process exit can leave browser/background descendants.
    // The runner promise covers their death AND all shared provider/log cleanup.
    try { await stopWorker() } catch (error) { failure ??= error }
    try { await closeBridges() } catch (error) { failure ??= error }
    stdout.end(); stderr.end()
    await Promise.all([stdout.done, stderr.done])
    await trimLogs(path.join(context.taskDir, 'logs'), logTotalLimit, context.generation)
    context.signal.removeEventListener('abort', onAbort)
  }
  const sessionId = await readSessionId(context.taskDir)
  if (failure) { if (sessionId) failure.sessionId = sessionId; throw failure }
  return { sessionId, unit }
}

async function boundedLog(file, maxBytes) {
  let existing = 0
  try { existing = (await fs.stat(file)).size } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing > maxBytes) { await fs.truncate(file, maxBytes); existing = maxBytes }
  let written = Math.min(existing, maxBytes)
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const remaining = maxBytes - written
      if (remaining <= 0) { callback(); return }
      const output = chunk.subarray(0, remaining)
      written += output.length
      callback(null, output)
    },
  })
  const output = createWriteStream(file, { flags: 'a', mode: 0o600 })
  output.on('error', () => { limiter.unpipe(output); limiter.resume() })
  limiter.done = Promise.all([finished(limiter).catch(() => {}), finished(output).catch(() => {})])
  limiter.pipe(output)
  return limiter
}

function capture(source, log, kind, emitTranscript) {
  if (!source) return
  const decoder = new StringDecoder('utf8')
  source.pipe(log)
  source.on('data', chunk => {
    const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (text) emitTranscript?.(kind, text)
  })
  source.on('end', () => {
    const text = decoder.end()
    if (text) emitTranscript?.(kind, text)
  })
}

async function trimLogs(directory, maxBytes, currentGeneration) {
  const entries = []
  for (const name of await fs.readdir(directory)) {
    const match = /^(\d+)\.(stdout|stderr)\.log$/.exec(name)
    if (!match) continue
    const file = path.join(directory, name); const stat = await fs.stat(file)
    if (stat.isFile()) entries.push({ file, generation: Number(match[1]), size: stat.size })
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of entries.sort((a, b) => a.generation - b.generation || a.file.localeCompare(b.file))) {
    if (total <= maxBytes || entry.generation === currentGeneration) continue
    await fs.rm(entry.file, { force: true }); total -= entry.size
  }
}
