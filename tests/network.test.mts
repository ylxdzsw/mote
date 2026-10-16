import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionSnapshot, requestJSON, RequestError, retryConnection } from '../src/cloud/connection.ts'

test('invalid network replies pause requests until a validated read reconnects; writes are never replayed by the probe', async () => {
  const original = globalThis.fetch
  const settings = { revision: 1, models: { builtin: '', indexing: '' }, indexingEnabled: false }
  const calls: { path: string; method?: string }[] = []
  let reply = () => Promise.resolve(Response.json(settings))
  globalThis.fetch = async (path, options) => {
    calls.push({ path: String(path), method: options?.method })
    assert.equal(options?.redirect, 'error')
    assert.equal(options?.cache, 'no-store')
    return reply()
  }
  const valid = (value: unknown) => !!value && typeof value === 'object' && 'revision' in value
  const offline = (error: unknown) => error instanceof RequestError && error.status === 0
  try {
    for (const response of [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('<html>Wi-Fi login</html>', { headers: { 'Content-Type': 'text/html' } })),
      () => Promise.resolve(new Response('<html>Login</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })),
      () => Promise.resolve(new Response('{', { headers: { 'Content-Type': 'application/json' } })),
      () => Promise.resolve(Response.json({ unrelated: true })),
      () => Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })),
    ]) {
      reply = response
      await assert.rejects(requestJSON('/api/documents/test', 'PUT', { operationId: 'retained' }, valid), offline)
      assert.equal(connectionSnapshot().offline, true)
      const count = calls.length
      await assert.rejects(requestJSON('/api/ai/tasks', 'POST', {}, valid), offline)
      assert.equal(calls.length, count)
      reply = () => Promise.resolve(Response.json({ login: true }))
      assert.equal(await retryConnection(), false)
      assert.equal(connectionSnapshot().offline, true)
      reply = () => Promise.resolve(Response.json(settings))
      const revision = connectionSnapshot().revision
      const first = retryConnection(), second = retryConnection()
      assert.equal(first, second)
      assert.equal(await first, true)
      assert.equal(connectionSnapshot().offline, false)
      assert.equal(connectionSnapshot().revision, revision + 1)
      assert.deepEqual(calls.slice(count), [
        { path: '/api/settings', method: 'GET' }, { path: '/api/settings', method: 'GET' },
      ])
    }
    for (const status of [401, 403, 404, 409, 410, 429]) {
      reply = () => Promise.resolve(Response.json({ error: 'authoritative API error' }, { status }))
      await assert.rejects(requestJSON('/api/documents/test', 'GET', undefined, valid), error => error instanceof RequestError && error.status === status)
      assert.equal(connectionSnapshot().offline, false)
    }
  } finally { globalThis.fetch = original }
})
