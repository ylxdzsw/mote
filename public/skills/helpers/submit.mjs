// Standalone, downloadable Node.js helper; no Mote checkout or agent runtime needed.
import http from 'node:http'
import https from 'node:https'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export async function localDelivery(directory) {
  const root = await fs.realpath(directory)
  const read = async (name, max) => {
    if (!name || name.includes(':') || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Asset must be a relative output path')
    let file = root
    for (const part of name.split('/')) { file = path.join(file, part); if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Output must not contain symlinks') }
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) throw new Error('Output is not a bounded regular file'); return await handle.readFile() } finally { await handle.close() }
  }
  const candidate = JSON.parse(await read('result.json', 8 * 1024 * 1024))
  const value = candidate
  const names = [...(value.screenshotPath === undefined ? [] : [value.screenshotPath]), ...Object.values(value.screenshotPaths ?? {})]
  const assets = Object.fromEntries(await Promise.all([...new Set(names)].map(async name => [name, `data:image/png;base64,${(await read(name, 10 * 1024 * 1024)).toString('base64')}`])))
  return { candidate, assets }
}

export function agentRequest(url, { socketPath, body } = {}) {
  const endpoint = new URL(url)
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Agent URL must use HTTP(S)')
  const data = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = (endpoint.protocol === 'https:' ? https : http).request(endpoint, { socketPath, method: data === undefined ? 'GET' : 'POST', headers: { 'user-agent': 'Mote-agent/v5', ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject)
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks))
          if (response.statusCode !== 200) {
            const message = body?.error || `HTTP ${response.statusCode}`
            const schemaUrl = body?.schemaUrl
            const error = new Error(schemaUrl && !message.includes(schemaUrl) ? `${message} Schema: ${schemaUrl}` : message)
            error.status = response.statusCode; error.current = body?.current; error.schemaUrl = schemaUrl; error.path = body?.path
            reject(error)
          }
          else resolve(body)
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(120000, () => request.destroy(new Error('Agent request timed out')))
    request.on('error', reject); request.end(data)
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function deliveryIdentity(root, base, payload) {
  const fingerprint = createHash('sha256').update(JSON.stringify([base, payload])).digest('hex')
  const file = path.join(root, `.mote-submit-${fingerprint}.uuid`)
  const read = async () => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== 37) throw new Error(`Invalid submission identity: ${file}`)
      const text = await handle.readFile('utf8')
      if (text.length !== 37 || text[36] !== '\n' || !UUID.test(text.slice(0, 36))) throw new Error(`Invalid submission identity: ${file}`)
      return text.slice(0, 36)
    } finally { await handle.close() }
  }
  let operationId
  try { operationId = await read() } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (operationId === undefined) {
    const temporary = path.join(root, `.mote-submit-${randomUUID()}.tmp`)
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${randomUUID()}\n`)
      await handle.sync()
      // Publish a complete identity without replacing a concurrent caller's winner.
      try { await fs.link(temporary, file) } catch (error) { if (error.code !== 'EEXIST') throw error }
    } finally { await handle.close(); await fs.unlink(temporary) }
    operationId = await read()
  }
  // Every caller makes the directory entry durable before sending, including a link-race loser.
  const directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
  return operationId
}

export async function submitResult(context, operationId) {
  const { socketPath, label } = context.agent
  const url = context.agent.url.replace(/\/$/, '')
  const manifest = await agentRequest(`${url}/manifest.json`, { socketPath })
  if (manifest?.protocol !== 'mote-agent-v5') throw new Error('Unsupported agent protocol')
  const { taskId } = manifest
  if (typeof taskId !== 'string' || !UUID.test(taskId) || (context.taskId !== undefined && context.taskId !== taskId)) throw new Error('Invalid agent manifest')
  if (label !== undefined && typeof label !== 'string') throw new Error('Label must be a string')
  const root = await fs.realpath(context.outputDir)
  const payload = { ...await localDelivery(root), ...(label === undefined ? {} : { label }) }
  operationId ??= await deliveryIdentity(root, url, payload)
  if (typeof operationId !== 'string' || !UUID.test(operationId)) throw new Error('Invalid operation UUID')
  const body = { operationId, ...payload }
  const receipt = await agentRequest(`${url}/submit`, { socketPath, body })
  if (receipt?.status !== 'ready' || receipt.taskId !== taskId
    || typeof receipt.versionId !== 'string' || !/^V[1-9]\d*$/.test(receipt.versionId)) throw new Error('Invalid submission receipt')
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, directory, label] = process.argv.slice(2)
  if (!base || !directory || process.argv.length > 5) throw new Error('Usage: node submit.mjs BASE OUTPUT [LABEL] (optional MOTED_AGENT_SOCKET)')
  console.log(JSON.stringify(await submitResult({ outputDir: directory, agent: { url: base, socketPath: process.env.MOTED_AGENT_SOCKET, ...(label === undefined ? {} : { label }) } })))
}
