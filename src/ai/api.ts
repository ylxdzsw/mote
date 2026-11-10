import type { AssistantCloudState } from './types'
import { isRecord, requestJSON, RequestError } from '../cloud/connection'
import type { TranscriptEntry } from '../cloud/documentEvents'

const base = '/api/ai'
export interface TranscriptHistory { events: TranscriptEntry[]; reset: boolean; warning: string }
function validVersionFields(value: Record<string, unknown>): boolean {
  if (value.versions !== undefined) {
    if (!Array.isArray(value.versions)) return false
    const ids = new Set<string>()
    for (const version of value.versions) {
      if (!isRecord(version) || typeof version.id !== 'string' || !/^V[1-9]\d*$/.test(version.id) || ids.has(version.id)
        || version.label !== undefined && typeof version.label !== 'string' || !isRecord(version.candidate)) return false
      ids.add(version.id)
    }
  }
  if (value.selectedVersion !== undefined && typeof value.selectedVersion !== 'string') return false
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt))) return false
  if (value.candidateNotice !== undefined && typeof value.candidateNotice !== 'string') return false
  return true
}
export class AIServiceError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export async function aiRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return request(`${base}${path}`, method, body)
}
function validTranscriptEntry(value: unknown): value is TranscriptEntry {
  return isRecord(value) && Number.isSafeInteger(value.id) && Number(value.id) > 0
    && Number.isSafeInteger(value.attempt) && Number(value.attempt) > 0
    && ['request', 'stdout', 'stderr'].includes(String(value.kind)) && typeof value.text === 'string'
}
export async function transcriptRequest(id: string, after: number): Promise<TranscriptHistory> {
  const url = `${base}/tasks/${encodeURIComponent(id)}/transcript?after=${after}`
  try {
    return await requestJSON<TranscriptHistory>(url, 'GET', undefined, value => isRecord(value)
      && Array.isArray(value.events) && value.events.every(validTranscriptEntry)
      && typeof value.reset === 'boolean' && typeof value.warning === 'string')
  } catch (error) {
    if (!(error instanceof RequestError)) throw error
    throw new AIServiceError(error.status === 401 || error.status === 403
      ? 'Workspace access is unavailable. Sign in to Mote again, then retry. Your working copy is retained.' : error.message, error.status)
  }
}
export function assistantRequest(documentId: string) {
  return request<AssistantCloudState>(`/api/documents/${encodeURIComponent(documentId)}/assistant`, 'GET')
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
          && (task.protocol !== 'mote-agent-v5' || validVersionFields(task)))
      if (method === 'DELETE') return value.ok === true
      const id = url.split('/')[4]
      if (id && value.id !== id) return false
      return value.protocol === 'mote-agent-v5' && typeof value.id === 'string' && ['queued', 'running', 'ready', 'stopped', 'error', 'waiting'].includes(String(value.status))
        && typeof value.progress === 'string' && typeof value.workspaceRead === 'boolean'
        && validVersionFields(value)
    })
  } catch (error) {
    if (!(error instanceof RequestError)) throw error
    throw new AIServiceError(error.status === 401 || error.status === 403
      ? 'Workspace access is unavailable. Sign in to Mote again, then retry. Your working copy is retained.' : error.message, error.status)
  }
}
