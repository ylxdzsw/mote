import type { AssistantCloudState, AITask } from './types'

const base = '/api/ai'
export function transcriptSource(id: string, after: number) {
  return new EventSource(`${base}/tasks/${id}/events?after=${after}`, { withCredentials: true })
}
export class AIServiceError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export async function aiRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return request(`${base}${path}`, method, body)
}
export function assistantRequest(documentId: string, body?: { baseRevision: string; tasks: AITask[]; operationId: string }) {
  return request<AssistantCloudState>(`/api/documents/${encodeURIComponent(documentId)}/assistant`, body ? 'PUT' : 'GET', body)
}
async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method, credentials: 'include', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  if (response.status === 401 || response.status === 403) throw new AIServiceError('Workspace access is unavailable. Sign in to Mote again, then retry. Your working copy is retained.', response.status)
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new AIServiceError(error?.error ?? `AI service returned ${response.status}`, response.status)
  }
  return response.status === 204 ? undefined as T : response.json()
}
