// Standalone, downloadable Node.js helper; no Mote checkout or agent runtime needed.
import http from 'node:http'
import https from 'node:https'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
  const value = candidate.candidate ?? candidate
  const names = [...(value.screenshotPath === undefined ? [] : [value.screenshotPath]), ...Object.values(value.screenshotPaths ?? {})]
  const assets = Object.fromEntries(await Promise.all([...new Set(names)].map(async name => [name, `data:image/png;base64,${(await read(name, 10 * 1024 * 1024)).toString('base64')}`])))
  return { candidate, assets }
}

export function agentRequest(url, { socketPath, body } = {}) {
  const endpoint = new URL(url)
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Agent URL must use HTTP(S)')
  const data = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = (endpoint.protocol === 'https:' ? https : http).request(endpoint, { socketPath, method: data === undefined ? 'GET' : 'POST', headers: { 'user-agent': 'Mote-agent/v1', ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject)
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks))
          if (response.statusCode !== 200) { const error = new Error(body?.error || `HTTP ${response.statusCode}`); error.status = response.statusCode; error.current = body?.current; reject(error) }
          else resolve(body)
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(120000, () => request.destroy(new Error('Agent request timed out')))
    request.on('error', reject); request.end(data)
  })
}

export async function submitResult(context, operationId = randomUUID()) {
  const { url, socketPath, executorRevision, candidateRevision } = context.agent
  const delivery = await localDelivery(context.outputDir)
  const receipt = await agentRequest(`${url}/submit`, { socketPath, body: { operationId, executorRevision, candidateRevision, ...delivery } })
  if (receipt?.status !== 'ready' || typeof receipt.taskId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.taskId)
    || (context.taskId !== undefined && receipt.taskId !== context.taskId)
    || !Number.isSafeInteger(receipt.executorRevision) || receipt.executorRevision < 0 || receipt.executorRevision !== executorRevision
    || !Number.isSafeInteger(receipt.candidateRevision) || receipt.candidateRevision < 1 || receipt.candidateRevision !== candidateRevision + 1) throw new Error('Invalid submission receipt')
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, directory, executor, candidate, operation] = process.argv.slice(2)
  if (!base || !directory || !/^\d+$/.test(executor ?? '') || !/^\d+$/.test(candidate ?? '') || !operation) throw new Error('Usage: node submit.mjs AGENT_BASE_URL OUTPUT_DIR EXECUTOR_REVISION CANDIDATE_REVISION OPERATION_UUID (optional MOTED_AGENT_SOCKET)')
  console.log(JSON.stringify(await submitResult({ outputDir: directory, agent: { url: base.replace(/\/$/, ''), socketPath: process.env.MOTED_AGENT_SOCKET, executorRevision: Number(executor), candidateRevision: Number(candidate) } }, operation)))
}
