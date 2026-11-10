import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { localDelivery, submitResult } from './submit.mjs'

const helper = fileURLToPath(new URL('./submit.mjs', import.meta.url))
const execute = promisify(execFile)

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mote-submit-test-'))
  const outputDir = path.join(root, 'output')
  await fs.mkdir(outputDir)
  await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify({ content: [], screenshotPath: 'shot.png' }))
  await fs.writeFile(path.join(outputDir, 'shot.png'), 'image')
  const value = {
    root, outputDir, bodies: [], headers: [], identities: [], manifestReads: 0,
    manifest: { protocol: 'mote-agent-v5', taskId: randomUUID() },
    receipt: {}, dropResponse: false,
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url.endsWith('/manifest.json')) {
        value.manifestReads++
        response.end(JSON.stringify(value.manifest))
        return
      }
      assert.ok(request.url.endsWith('/submit'))
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      value.bodies.push(body); value.headers.push(request.headers)
      const names = (await fs.readdir(outputDir)).filter(name => name.endsWith('.uuid'))
      value.identities.push(await Promise.all(names.map(async name => ({
        name, text: await fs.readFile(path.join(outputDir, name), 'utf8'), mode: (await fs.stat(path.join(outputDir, name))).mode & 0o777,
      }))))
      if (value.errorResponse) { response.statusCode = 400; response.end(JSON.stringify(value.errorResponse)); return }
      if (value.dropResponse) { value.dropResponse = false; response.destroy(); return }
      const { taskId } = value.manifest
      response.end(JSON.stringify({ taskId, versionId: 'V1', status: 'ready', ...value.receipt }))
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }) })
  value.base = `http://127.0.0.1:${server.address().port}/a/secret-token`
  value.context = { outputDir, taskId: value.manifest.taskId, agent: { url: value.base, protocol: 'untrusted', executorRevision: 99, documentRevision: 'untrusted', documentVersion: 1 } }
  value.cli = (...args) => execute(process.execPath, [helper, value.base, outputDir, ...args], { env: { ...process.env, MOTED_AGENT_SOCKET: '' } })
  return value
}

test('CLI persists a private identity before submission and reuses it after response loss and process restart', async t => {
  const value = await fixture(t)
  value.dropResponse = true
  await assert.rejects(value.cli('Proposal'))
  const { stdout } = await value.cli('Proposal')
  assert.deepEqual(Object.keys(JSON.parse(stdout)).sort(), ['status', 'taskId', 'versionId'])
  assert.equal(value.manifestReads, 2)
  assert.deepEqual(value.bodies[0], value.bodies[1])
  assert.deepEqual(Object.keys(value.bodies[0]).sort(), ['assets', 'candidate', 'label', 'operationId'])
  assert.deepEqual(Object.keys(value.bodies[0].assets), ['shot.png'])
  const [identity] = value.identities[0]
  assert.match(identity.name, /^\.mote-submit-[0-9a-f]{64}\.uuid$/)
  assert.equal(identity.text, `${value.bodies[0].operationId}\n`)
  assert.equal(identity.mode, 0o600)
  assert.ok(value.headers.every(headers => headers['user-agent'] === 'Mote-agent/v5'))
  assert.equal((await fs.readdir(value.outputDir)).some(name => name.endsWith('.tmp')), false)
})

test('concurrent processes share one identity; payload, image, label and base changes get new identities', async t => {
  const value = await fixture(t)
  await Promise.all(Array.from({ length: 4 }, () => value.cli()))
  assert.equal(new Set(value.bodies.map(body => body.operationId)).size, 1)
  const original = value.bodies[0].operationId
  await submitResult(value.context)
  assert.equal(value.bodies.at(-1).operationId, original)
  await submitResult({ ...value.context, agent: { ...value.context.agent, label: '' } })
  await submitResult({ ...value.context, agent: { ...value.context.agent, url: `${value.base}-different` } })
  await fs.writeFile(path.join(value.outputDir, 'shot.png'), 'changed-image')
  await submitResult(value.context)
  await fs.writeFile(path.join(value.outputDir, 'result.json'), JSON.stringify({ content: [], summary: 'changed', screenshotPath: 'shot.png' }))
  await submitResult(value.context)
  assert.equal(new Set(value.bodies.map(body => body.operationId)).size, 5)
  assert.equal(value.manifestReads, value.bodies.length)
})

test('v5 proposals use only task ID and protocol from the manifest to check receipts', async t => {
  const value = await fixture(t)
  const operationId = randomUUID()
  const receipt = await submitResult(value.context, operationId)
  assert.deepEqual(Object.keys(receipt).sort(), ['status', 'taskId', 'versionId'])
  assert.equal(value.bodies[0].operationId, operationId)
  assert.deepEqual(Object.keys(value.bodies[0]).sort(), ['assets', 'candidate', 'operationId'])
  await submitResult(value.context)
  const firstOperationId = value.bodies[1].operationId
  value.manifest.documentRevision = 'a different, stale document revision'
  value.manifest.documentVersion = 999
  value.manifest.executorRevision = -1
  await submitResult({ ...value.context, agent: { ...value.context.agent, documentRevision: 'unavailable', documentVersion: 0 } })
  assert.equal(value.bodies.at(-1).operationId, firstOperationId)
  for (const receipt of [
    { taskId: randomUUID() }, { versionId: 'C1' }, { status: 'waiting' },
  ]) {
    value.receipt = receipt
    await assert.rejects(submitResult(value.context), /Invalid submission receipt/)
  }
  const submitted = value.bodies.length
  await assert.rejects(submitResult({ ...value.context, taskId: randomUUID() }), /Invalid agent manifest/)
  value.manifest.protocol = 'mote-agent-v3'
  await assert.rejects(submitResult(value.context), /Unsupported agent protocol/)
  value.manifest.protocol = 'mote-agent-v5'
  value.manifest.taskId = 'invalid'
  await assert.rejects(submitResult(value.context), /Invalid agent manifest/)
  assert.equal(value.bodies.length, submitted)
})

test('corrupt or symlinked identities fail without replacing the identity or sending', async t => {
  const value = await fixture(t)
  await submitResult(value.context)
  const file = path.join(value.outputDir, value.identities[0][0].name)
  await fs.writeFile(file, 'uncertain prior submission')
  await assert.rejects(submitResult(value.context), /Invalid submission identity/)
  assert.equal(await fs.readFile(file, 'utf8'), 'uncertain prior submission')
  const outside = path.join(value.root, 'outside.uuid')
  await fs.rename(file, outside)
  await fs.symlink(outside, file)
  await assert.rejects(submitResult(value.context), { code: 'ELOOP' })
  assert.equal(value.bodies.length, 1)
  assert.equal(await fs.readFile(outside, 'utf8'), 'uncertain prior submission')
})

test('local delivery remains bounded and refuses symlinked and traversing assets', async t => {
  const value = await fixture(t)
  const image = path.join(value.outputDir, 'shot.png')
  await fs.rename(image, path.join(value.root, 'outside.png'))
  await fs.symlink('../outside.png', image)
  await assert.rejects(localDelivery(value.outputDir), /symlinks/)
  await fs.writeFile(path.join(value.outputDir, 'result.json'), JSON.stringify({ screenshotPath: '../outside.png' }))
  await assert.rejects(localDelivery(value.outputDir), /relative output path/)
  await fs.truncate(path.join(value.outputDir, 'result.json'), 8 * 1024 * 1024 + 1)
  await assert.rejects(localDelivery(value.outputDir), /bounded regular file/)
})

test('downloadable and server helpers are identical', async () => {
  assert.deepEqual(await fs.readFile(helper), await fs.readFile(new URL('../public/skills/helpers/submit.mjs', import.meta.url)))
})

test('helper preserves schema URL and path in server validation errors', async t => {
  const value = await fixture(t)
  value.errorResponse = { error: 'Invalid proposal', schemaUrl: 'https://mote.ylxdzsw.com/skills/proposal-schema.json', path: 'object.layout' }
  await assert.rejects(submitResult(value.context), error => {
    assert.equal(error.schemaUrl, value.errorResponse.schemaUrl)
    assert.equal(error.path, value.errorResponse.path)
    assert.ok(error.message.includes(value.errorResponse.schemaUrl))
    return true
  })
  await assert.rejects(value.cli(), error => {
    assert.ok(error.stderr.includes(value.errorResponse.schemaUrl))
    return true
  })
})
