// Development uses a fake local service. Production has one explicit pre-release backend.
const base = import.meta.env.DEV ? '/api/ai' : 'https://mote.ylxdzsw.com/api/ai'
export class AIServiceError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export async function aiRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  if (response.status === 401 || response.status === 403) throw new AIServiceError('Sign in to the AI service, then retry. Your document has not changed.', response.status)
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new AIServiceError(error?.error ?? `AI service returned ${response.status}`, response.status)
  }
  return response.status === 204 ? undefined as T : response.json()
}
