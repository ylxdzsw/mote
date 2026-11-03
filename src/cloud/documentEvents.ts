import { useEffect } from 'react'
import { connectionFailed, isRecord, useConnection } from './connection'

export interface TranscriptEntry { id: number; attempt: number; kind: 'request' | 'stdout' | 'stderr'; text: string }
export type DocumentUpdate =
  | { kind: 'ready' | 'document' | 'privacy' | 'assistant' | 'deleted' }
  | { kind: 'task' | 'transcript-closed'; taskId: string }
  | { kind: 'transcript'; taskId: string; entry: TranscriptEntry }
  | { kind: 'transcript-warning'; taskId: string; message: string }

const listeners = new Map<string, Set<(event: DocumentUpdate) => void>>()
export function subscribeDocumentUpdates(documentId: string, listener: (event: DocumentUpdate) => void) {
  let subscribers = listeners.get(documentId)
  if (!subscribers) { subscribers = new Set(); listeners.set(documentId, subscribers) }
  subscribers.add(listener)
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(documentId) }
}

function validUpdate(value: unknown): value is DocumentUpdate {
  if (!isRecord(value)) return false
  if (['ready', 'document', 'privacy', 'assistant', 'deleted'].includes(String(value.kind))) return true
  if (typeof value.taskId !== 'string') return false
  if (value.kind === 'task' || value.kind === 'transcript-closed') return true
  if (value.kind === 'transcript-warning') return typeof value.message === 'string'
  const entry = value.entry
  return value.kind === 'transcript' && isRecord(entry) && Number.isSafeInteger(entry.id) && Number(entry.id) > 0
    && Number.isSafeInteger(entry.attempt) && Number(entry.attempt) > 0
    && ['request', 'stdout', 'stderr'].includes(String(entry.kind)) && typeof entry.text === 'string'
}

// The mounted working copy owns the connection; consumers only subscribe.
export function useDocumentStream(documentId: string, enabled: boolean) {
  const connection = useConnection()
  useEffect(() => {
    if (!enabled || connection.offline) return
    const source = new EventSource(`/api/documents/${documentId}/events`, { withCredentials: true })
    const interrupted = () => {
      source.close()
      connectionFailed('Document updates were interrupted. Local changes and AI requests are retained. Retry the connection to resume updates.')
    }
    source.onerror = interrupted
    source.addEventListener('update', event => {
      let value: unknown
      try { value = JSON.parse((event as MessageEvent).data) } catch { interrupted(); return }
      if (!validUpdate(value)) { interrupted(); return }
      if (value.kind === 'deleted') { source.onerror = null; source.close() }
      for (const listener of listeners.get(documentId) ?? []) listener(value)
    })
    return () => { source.onerror = null; source.close() }
  }, [documentId, enabled, connection.offline, connection.revision])
}
