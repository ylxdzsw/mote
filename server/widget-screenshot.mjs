import http from 'node:http'
import net from 'node:net'
import { Resolver } from 'node:dns/promises'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { HttpError } from './validation.mjs'
import { fakePng, stopWorkerUnit, workerUnit } from './runner.mjs'

export const WIDGET_BODY_LIMIT = 2 * 1024 * 1024
const MAX_SOURCE = 1024 * 1024, MAX_PNG = 10 * 1024 * 1024
const blocked = new net.BlockList()
for (const range of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3']) {
  const [address, bits] = range.split('/'); blocked.addSubnet(address, Number(bits))
}
export const publicIPv4 = address => net.isIPv4(address) && !blocked.check(address)

export function widgetInput(body) {
  if (!body || typeof body.html !== 'string') throw new HttpError(400, 'html must be a string')
  if (Buffer.byteLength(body.html) > MAX_SOURCE) throw new HttpError(413, 'widget HTML exceeds 1 MiB')
  if (![body.width, body.height].every(n => Number.isFinite(n) && n >= 1 && n <= 2048)) throw new HttpError(400, 'widget dimensions must be between 1 and 2048 pixels')
  const width = Math.round(body.width), height = Math.round(body.height)
  if (width * height > 2 * 1024 * 1024) throw new HttpError(413, 'widget area exceeds 2 megapixels')
  return { html: body.html, width, height }
}

export function resourceHost(authority) {
  if (!/^[a-zA-Z0-9.-]+:443$/.test(authority)) throw new Error('Only public TLS connections on port 443 are supported')
  return new URL(`https://${authority}`).hostname
}

export async function publicAddress(hostname, resolver) {
  const addresses = net.isIPv4(hostname) ? [hostname] : await resolver.resolve4(hostname)
  if (!addresses.length || !addresses.every(publicIPv4)) throw new Error('Resource address is not public IPv4')
  return addresses[0]
}

// CONNECT is a byte tunnel, not a general fetch/forward proxy. Resolve once,
// validate every answer, then connect to the numeric IPv4 (no second DNS lookup).
// Chromium verifies TLS inside its namespace. Redirects to other authorities
// require a new validated tunnel; same-authority traffic stays pinned to this IP.
// The host's own addresses are excluded even when publicly routed.
export async function resourceBroker(socket, signal) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 })
  const sockets = new Set(), own = new Set(Object.values(os.networkInterfaces()).flat().map(item => item.address))
  let requests = 0, active = 0, bytes = 0
  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: 5000, requestTimeout: 5000 }, (_request, response) => { response.writeHead(403); response.end() })
  server.on('connection', client => { sockets.add(client); client.on('close', () => sockets.delete(client)); client.setTimeout(10000, () => client.destroy()); client.on('error', () => {}) })
  server.on('connect', async (request, client, head) => {
    if (++requests > 64 || active >= 8 || signal.aborted) { client.destroy(); return }
    active++
    client.once('close', () => active--)
    try {
      const address = await publicAddress(resourceHost(request.url), resolver)
      if (signal.aborted || client.destroyed || own.has(address)) { client.destroy(); return }
      const upstream = net.connect({ host: address, port: 443, family: 4 })
      sockets.add(upstream)
      upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
      upstream.on('error', () => client.destroy())
      client.once('close', () => upstream.destroy())
      upstream.setTimeout(5000, () => upstream.destroy())
      const count = chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) for (const socket of sockets) socket.destroy() }
      upstream.on('data', count); client.on('data', count); count(head)
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
    } catch { client.destroy() }
  })
  server.maxConnections = 12
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  await fs.chmod(socket, 0o666)
  return async () => { resolver.cancel(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
}

export class WidgetScreenshots {
  constructor(env = process.env) { this.env = env; this.active = new Set(); this.closed = false; this.blocked = false }

  async capture(readInput, signal) {
    if (this.closed || this.blocked) throw new HttpError(422, 'Widget capture is unavailable; service recovery is required')
    if (this.active.size >= 2) throw new HttpError(429, 'Widget capture is busy; try again shortly')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const job = { controller }; this.active.add(job)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 25000)
    job.done = (async () => {
      const input = widgetInput(await readInput(controller.signal))
      controller.signal.throwIfAborted()
      const png = this.env.MOTED_FAKE_RUNNER === '1' ? fakePng(input.width * 2, input.height * 2) : await this.run(input, controller)
      controller.signal.throwIfAborted()
      if (png.length > MAX_PNG || png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== input.width * 2 || png.readUInt32BE(20) !== input.height * 2) throw new Error('Invalid capture output')
      return { screenshot: `data:image/png;base64,${png.toString('base64')}` }
    })()
    try { return await job.done }
    catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(422, timedOut ? 'Widget capture timed out' : controller.signal.aborted ? 'Widget capture canceled' : 'Widget capture failed')
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(job) }
  }

  async run(input, controller) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mote-widget-'))
    const root = path.join(directory, 'root'), unit = workerUnit(crypto.randomUUID(), 0)
    let closeBroker, launched = false
    try {
      await fs.mkdir(root); await fs.chmod(root, 0o755)
      for (const name of ['usr', 'etc', 'tmp', 'run', 'dev', 'proc']) {
        const directory = path.join(root, name)
        await fs.mkdir(directory); await fs.chmod(directory, 0o755)
      }
      for (const name of ['bin', 'lib', 'lib64']) await fs.symlink(name === 'bin' ? 'usr/bin' : 'usr/lib', path.join(root, name))
      await fs.writeFile(path.join(root, 'input.json'), JSON.stringify(input), { mode: 0o644 })
      await fs.chmod(path.join(root, 'input.json'), 0o644)
      for (const name of ['widget-capture.mjs', 'widget-harness.mjs', 'preview-harness.html']) {
        await fs.copyFile(new URL(name, import.meta.url), path.join(root, name)); await fs.chmod(path.join(root, name), 0o644)
      }
      closeBroker = await resourceBroker(path.join(root, 'broker.sock'), controller.signal)
      controller.signal.throwIfAborted()
      const properties = [
        `RootDirectory=${root}`, 'MountAPIVFS=yes', 'DynamicUser=yes', 'PrivateUsers=yes', 'PrivateNetwork=yes',
        'PrivatePIDs=yes', 'PrivateDevices=yes', 'ProtectSystem=strict', 'ProtectHome=yes',
        'BindReadOnlyPaths=/usr /etc/fonts /etc/ssl/certs /etc/ca-certificates/extracted', 'TemporaryFileSystem=/tmp:rw,size=256M /run:rw,size=16M',
        'WorkingDirectory=/tmp', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'AmbientCapabilities=',
        'ProtectControlGroups=yes', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectHostname=yes',
        'RestrictSUIDSGID=yes', 'LockPersonality=yes', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
        'KillMode=control-group', 'TimeoutStopSec=2', 'RuntimeMaxSec=25', 'CPUQuota=200%', 'MemoryMax=1G',
        'MemorySwapMax=0', 'TasksMax=256', 'LimitCORE=0', 'UMask=0077',
      ]
      const png = await new Promise((resolve, reject) => {
        const child = spawn('systemd-run', ['--quiet', '--pipe', '--wait', '--collect', `--unit=${unit}`, '--service-type=exec', ...properties.map(value => `--property=${value}`), '/usr/bin/env', '-i', 'PATH=/usr/bin', 'HOME=/tmp', 'LANG=C.UTF-8', '/usr/bin/node', '/widget-capture.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin' } })
        launched = true
        let size = 0; const chunks = []
        const abort = () => { child.kill('SIGKILL'); reject(new Error('Capture aborted')) }
        controller.signal.addEventListener('abort', abort, { once: true })
        child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_PNG) { child.kill('SIGKILL'); reject(new HttpError(413, 'Widget screenshot exceeds 10 MiB')); return }; chunks.push(chunk) })
        child.stderr.resume()
        child.on('error', reject)
        child.on('close', code => { controller.signal.removeEventListener('abort', abort); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('Capture worker failed')) })
      })
      return png
    } finally {
      await closeBroker?.()
      // Keep admission fenced if the process tree cannot be proven gone. Never
      // delete a live root underneath a worker or fall back to an unsafe browser.
      try { if (launched) await stopWorkerUnit(unit, {}, { immediate: true }) }
      catch (error) { this.blocked = true; throw error }
      await fs.rm(directory, { recursive: true, force: true })
    }
  }

  async shutdown() { this.closed = true; for (const job of this.active) job.controller.abort(); await Promise.allSettled([...this.active].map(job => job.done)) }
}
