import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let state = { offline: typeof navigator !== 'undefined' && navigator.onLine === false, reason: '', checking: false, revision: 0 }
let failures = 0
let probe: Promise<boolean> | undefined
const publish = (patch: Partial<typeof state>) => {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
export const connectionSnapshot = () => state
export const subscribeConnection = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useConnection = () => useSyncExternalStore(subscribeConnection, connectionSnapshot)
export function connectionFailed(reason = 'Connection interrupted. Local changes and AI requests are retained.') {
  failures++
  publish({ offline: true, reason })
}
if (typeof window !== 'undefined') window.addEventListener('offline', () => connectionFailed())

export class RequestError extends Error {
  readonly status: number
  readonly detail?: Record<string, unknown>
  constructor(message: string, status: number, detail?: Record<string, unknown>) { super(message); this.status = status; this.detail = detail }
}
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export async function requestJSON<T>(path: string, method: string, body: unknown, valid: (value: unknown) => boolean,
  options: { probe?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  if (state.offline && !options.probe) throw new RequestError(state.reason || 'Offline. Retry the connection to continue syncing.', 0)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  try {
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) })
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) throw new Error('unexpected response')
    const value: unknown = await response.json()
    if (!response.ok) {
      if (!isRecord(value) || typeof value.error !== 'string') throw new Error('unexpected response')
      if (response.status >= 500) throw new Error('service unavailable')
      throw new RequestError(value.error, response.status, value)
    }
    if (!valid(value)) throw new Error('unexpected response')
    return value as T
  } catch (error) {
    if (error instanceof RequestError || options.signal?.aborted && !timeout.aborted) throw error
    const message = timeout.aborted ? 'Connection timed out. Local changes and AI requests are retained.'
      : 'Could not reach Mote or received an unexpected response. Check your connection or Wi-Fi sign-in, then retry.'
    connectionFailed(message)
    throw new RequestError(message, 0)
  }
}

// A small authenticated read verifies Mote, even when the current document is
// clean, conflicted, or deleted. Never retry generation as a connectivity probe.
export function retryConnection(): Promise<boolean> {
  if (probe) return probe
  publish({ checking: true })
  const generation = failures
  probe = requestJSON('/api/settings', 'GET', undefined, value => isRecord(value) && Number.isSafeInteger(value.revision)
    && isRecord(value.models) && typeof value.models.builtin === 'string' && typeof value.models.indexing === 'string'
    && typeof value.indexingEnabled === 'boolean', { probe: true })
    .then(() => true, error => error instanceof RequestError && (error.status === 401 || error.status === 403))
    .then(reachable => {
      if (reachable && generation === failures) publish({ offline: false, reason: '', revision: state.revision + 1 })
      return reachable && generation === failures
    }).finally(() => { probe = undefined; publish({ checking: false }) })
  return probe
}
