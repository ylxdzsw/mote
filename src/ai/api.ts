import type { AssistantCloudState, AITask } from './types'
import { isRecord, requestJSON, RequestError } from '../cloud/connection'

const base = '/api/ai'
function validCandidate(value: unknown): boolean {
  return isRecord(value)
}
function validCandidateFields(value: Record<string, unknown>): boolean {
  if (value.candidateRevision !== undefined && (!Number.isSafeInteger(value.candidateRevision) || Number(value.candidateRevision) < 0)) return false
  if (value.candidate !== undefined && value.candidate !== null && !validCandidate(value.candidate)) return false
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates)) return false
    const ids = new Set<string>()
    for (const candidate of value.candidates) {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || !candidate.id || ids.has(candidate.id)
        || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 0
        || candidate.label !== undefined && typeof candidate.label !== 'string' || !validCandidate(candidate.candidate)) return false
      ids.add(candidate.id)
      if (candidate.history !== undefined) {
        if (!Array.isArray(candidate.history)) return false
        const revisions = new Set<number>([Number(candidate.revision)])
        for (const version of candidate.history) {
          if (!isRecord(version) || !Number.isSafeInteger(version.revision) || Number(version.revision) < 0
            || revisions.has(Number(version.revision)) || version.label !== undefined && typeof version.label !== 'string'
            || !validCandidate(version.candidate)) return false
          revisions.add(Number(version.revision))
        }
      }
    }
  }
  if (value.accessPaused !== undefined && typeof value.accessPaused !== 'boolean') return false
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt))) return false
  if (value.selectedCandidate !== undefined && (!isRecord(value.selectedCandidate) || typeof value.selectedCandidate.id !== 'string'
    || !Number.isSafeInteger(value.selectedCandidate.revision) || Number(value.selectedCandidate.revision) < 0)) return false
  if (value.candidateNotice !== undefined && typeof value.candidateNotice !== 'string') return false
  return true
}
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
  try {
    return await requestJSON<T>(url, method, body, value => {
      if (!isRecord(value)) return false
      if (url.endsWith('/assistant')) return typeof value.revision === 'string' && Array.isArray(value.tasks)
        && value.tasks.every(task => isRecord(task) && typeof task.id === 'string' && typeof task.documentId === 'string'
          && isRecord(task.target) && ['object', 'text', 'segment'].includes(String(task.target.kind))
          && ['draft', 'preparing', 'queued', 'running', 'ready', 'stopped', 'error', 'waiting'].includes(String(task.status))
          && typeof task.submitted === 'boolean' && typeof task.prompt === 'string' && typeof task.progress === 'string'
          && validCandidateFields(task))
      if (method === 'DELETE') return value.ok === true
      const id = url.split('/')[4]
      if (id && value.id !== id) return false
      return typeof value.id === 'string' && ['queued', 'running', 'ready', 'stopped', 'error', 'waiting'].includes(String(value.status))
        && typeof value.progress === 'string' && typeof value.workspaceRead === 'boolean' && Number.isSafeInteger(value.workspaceReadRevision)
        && validCandidateFields(value)
    })
  } catch (error) {
    if (!(error instanceof RequestError)) throw error
    throw new AIServiceError(error.status === 401 || error.status === 403
      ? 'Workspace access is unavailable. Sign in to Mote again, then retry. Your working copy is retained.' : error.message, error.status)
  }
}
