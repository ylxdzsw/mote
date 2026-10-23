// Runs only inside the disposable systemd root/network namespace. No imports
// from the service, environment secrets, saved documents, or browser profiles.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { widgetHarness } from './widget-harness.mjs'

const { html, width, height } = JSON.parse(await readFile('/input.json', 'utf8'))
const proxy = net.createServer(client => {
  const upstream = net.connect('/broker.sock')
  client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy())
  client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy())
  client.pipe(upstream).pipe(client)
})
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
const browser = spawn('/usr/bin/chromium', [
  `--proxy-server=http://127.0.0.1:${proxy.address().port}`, '--proxy-bypass-list=<-loopback>',
  '--headless', '--remote-debugging-pipe', '--user-data-dir=/tmp/profile',
  '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--disable-extensions', '--disable-breakpad', '--disable-crash-reporter',
  '--disable-gpu', '--disable-features=MediaRouter', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
let id = 0, buffer = ''
const pending = new Map()
const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const key = ++id; pending.set(key, { resolve, reject })
  browser.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
})
browser.on('error', error => { for (const p of pending.values()) p.reject(error) })
browser.on('exit', () => { for (const p of pending.values()) p.reject(new Error('Browser exited')) })
browser.stdio[3].on('error', () => {})
browser.stdio[4].setEncoding('utf8')
browser.stdio[4].on('data', chunk => {
  buffer += chunk
  if (buffer.length > 16 * 1024 * 1024) process.exit(1)
  let end
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
    if (message.id) {
      const p = pending.get(message.id); pending.delete(message.id)
      if (message.error) p?.reject(new Error(message.error.message)); else p?.resolve(message.result)
    }
  }
})

try {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  const page = (method, params) => call(method, params, sessionId)
  await page('Page.enable')
  await page('Network.enable')
  await page('Network.setCacheDisabled', { cacheDisabled: true })
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  await page('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  await page('Browser.setDownloadBehavior', { behavior: 'deny' })
  const harness = widgetHarness(await readFile('/preview-harness.html', 'utf8'), { html, width, height })
  const { frameTree } = await page('Page.getFrameTree')
  await page('Page.setDocumentContent', { frameId: frameTree.frame.id, html: harness })
  // Wait for the fresh iframe's load, then a short animation/font settling
  // interval. Arbitrary applications cannot have a universal 'ready' signal.
  for (let i = 0; i < 80; i++) {
    const { result } = await page('Runtime.evaluate', { expression: 'window.captureLoaded === true', returnByValue: true })
    if (result.value) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
  const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await new Promise((resolve, reject) => process.stdout.write(Buffer.from(data, 'base64'), error => error ? reject(error) : resolve()))
} finally { await call('Browser.close').catch(() => {}); browser.kill(); proxy.close() }
