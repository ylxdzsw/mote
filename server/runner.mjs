import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import { finished } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import net from 'node:net'

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/

export function workerUnit(taskId, generation) { return `moted-${taskId}-${generation}` }

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
      candidate.object.html = '<button id="mote-fake-button" type="button">AI draft: 0</button><script>document.querySelector("button").addEventListener("click", event => { event.currentTarget.textContent = `AI draft: ${Number(event.currentTarget.textContent.split(\": \")[1] || 0) + 1}` })</script>'
    } else if ((candidate.object?.kind ?? 'text') === 'text' && candidate.object.content?.content?.[0]) {
      const first = candidate.object.content.content[0]
      candidate.object.content = { ...candidate.object.content, content: [{ ...first, content: [{ type: 'text', text: `AI draft: ${textOf(first) || 'generated note'}` }] }, ...candidate.object.content.content.slice(1)] }
    }
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
  return { sessionId: context.sessionId || `fake-${context.taskId}` }
}

export function configuredModel(env, cwd) {
  if (env.MOTED_MU_DEFAULT_MODEL) return env.MOTED_MU_DEFAULT_MODEL
  const result = spawnSync(env.MOTED_MU_BIN || 'mu', ['status', '--json'], { cwd, env, encoding: 'utf8', timeout: 5000 })
  if (result.status !== 0) return undefined
  try { return JSON.parse(result.stdout).model.canonical } catch { return undefined }
}

async function prepareWorkerPaths(context) {
  if (!context.useSystemd) return
  const user = context.env.MOTED_WORKER_USER || 'mote-ai'
  const uidResult = spawnSync('id', ['-u', user], { encoding: 'utf8' })
  const gidResult = spawnSync('id', ['-g', user], { encoding: 'utf8' })
  const uid = Number(uidResult.stdout?.trim()); const gid = Number(gidResult.stdout?.trim())
  if (uidResult.status !== 0 || gidResult.status !== 0 || !Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) throw new Error('configured AI worker must be an existing non-root user')
  const directories = [path.join(context.taskDir, '.mu'), path.join(context.taskDir, '.mu', 'sessions'), path.join(context.taskDir, '.mu', 'objects'), path.join(context.taskDir, 'tmp'), path.join(context.taskDir, '.agent-browser'), path.join(context.taskDir, '.config'), path.join(context.taskDir, '.cache'), context.outputDir]
  for (const directory of directories) await fs.chown(directory, uid, gid)
  const credential = path.join(context.taskDir, '.mu', '.env')
  await fs.chown(credential, uid, gid).then(() => fs.chmod(credential, 0o400)).catch(error => { if (error.code !== 'ENOENT') throw error })
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
    await Promise.all(servers.map(async ({ server, local }) => {
      await new Promise(resolve => server.close(resolve))
      await fs.rm(local, { force: true })
    }))
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
  }
  let command = mu
  let args = muArgs
  let spawnOptions = { cwd: context.taskDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
  if (context.useSystemd) {
    command = context.env.MOTED_SYSTEMD_RUN || 'systemd-run'
    const property = value => `--property=${value}`
    args = ['--quiet', '--pipe', '--wait', '--collect', '--unit', unit, '--service-type=exec', property('KillMode=control-group'), property('RemainAfterExit=no'), property(`RuntimeMaxSec=${Math.ceil(context.timeoutMs / 1000)}`), property(`CPUQuota=${context.env.MOTED_CPU_QUOTA || '200%'}`), property(`MemoryMax=${context.env.MOTED_MEMORY_MAX || '2G'}`), property(`TasksMax=${context.env.MOTED_TASKS_MAX || '256'}`), property('NoNewPrivileges=yes'), property('CapabilityBoundingSet='), property('AmbientCapabilities='), property('ProtectSystem=strict'), property('ProtectHome=read-only'), property('PrivateTmp=yes'), property('PrivatePIDs=yes'), property('PrivateDevices=yes'), property('ProtectControlGroups=yes'), property('ProtectKernelTunables=yes'), property('ProtectKernelModules=yes'), property('ProtectHostname=yes'), property('RestrictSUIDSGID=yes'), property('LockPersonality=yes'), property(`BindReadOnlyPaths=${context.taskDir}`), property(`BindReadOnlyPaths=${context.sourcePath}`), property(`ReadOnlyPaths=${path.join(context.taskDir, 'input')}`), property(`ReadOnlyPaths=${context.promptPath}`), property('ReadOnlyPaths=/root/.mu'), property(`BindPaths=${path.join(context.taskDir, '.mu')}`), property(`BindPaths=${path.join(context.taskDir, 'tmp')}`), property(`BindPaths=${path.join(context.taskDir, '.config')}`), property(`BindPaths=${path.join(context.taskDir, '.cache')}`), property(`BindPaths=${path.join(context.taskDir, '.agent-browser')}`), property(`BindPaths=${context.outputDir}`), property(`ReadOnlyPaths=${path.join(context.taskDir, '.mu', 'config.jsonc')}`), property(`ReadOnlyPaths=${path.join(context.taskDir, '.mu', 'AGENTS.md')}`), property(`ReadOnlyPaths=-${path.join(context.taskDir, '.mu', '.env')}`), property('InaccessiblePaths=-/run/dbus -/run/systemd -/run/docker.sock -/var/run/docker.sock -/run/moted -/run/user -/root/.mu/.env'), property(`WorkingDirectory=${context.taskDir}`), `--uid=${context.env.MOTED_WORKER_USER || 'mote-ai'}`]
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
    if (context.useSystemd) {
      await childWait(context.env.MOTED_SYSTEMCTL || 'systemctl', ['kill', '--kill-who=all', '--signal=TERM', unit], { stdio: 'ignore' }).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 250))
      await childWait(context.env.MOTED_SYSTEMCTL || 'systemctl', ['kill', '--kill-who=all', '--signal=KILL', unit], { stdio: 'ignore' }).catch(() => {})
      await childWait(context.env.MOTED_SYSTEMCTL || 'systemctl', ['stop', '--job-mode=replace-irreversibly', unit], { stdio: 'ignore' }).catch(() => {})
    } else if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      await new Promise(resolve => setTimeout(resolve, 250))
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
  })()
  context.stop = stopWorker
  const onAbort = () => { void stopWorker() }
  context.signal.addEventListener('abort', onAbort, { once: true })
  if (context.signal.aborted) void stopWorker()
  let failure
  let closeBridges = async () => {}
  try {
    closeBridges = await providerBridges(context.taskDir)
    if (context.signal.aborted) throw new Error('aborted')
    await childWait(command, args, spawnOptions, value => {
      child = value
      capture(value.stdout, stdout, 'stdout', context.emitTranscript)
      capture(value.stderr, stderr, 'stderr', context.emitTranscript)
    })
  } catch (error) { failure = error }
  finally {
    await closeBridges()
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
