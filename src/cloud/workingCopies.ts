import type { DocumentLanguage, MoteDocument } from '../document/model'
import type { DocumentMeta } from './api'
import { loadAssistantRecovery, saveAssistantRecovery } from '../ai/storage'

export interface PendingSave {
  operationId: string
  baseRevision: string
  document: MoteDocument
}
export interface WorkingRecord {
  key: string
  session: string
  meta: DocumentMeta
  document: MoteDocument
  dirty: boolean
  updatedAt: number
  pending?: PendingSave
  draft?: boolean
  draftDefaults?: { mode: 'light' | 'dark'; language: DocumentLanguage }
  pendingCreate?: { id: string; operationId: string; name: string; document: MoteDocument; private?: boolean }
  pendingPrivacy?: { private: boolean; basePrivacyRevision: number; baseShareRevision?: number; operationId: string }
}

let database: Promise<IDBDatabase> | undefined
function open() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mote-cloud', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('copies', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(error => { database = undefined; throw error })
}
async function transaction<T>(write: boolean, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('copies', write ? 'readwrite' : 'readonly')
    const request = action(tx.objectStore('copies'))
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = tx.onerror = () => reject(tx.error ?? request.error)
  })
}
export const listWorkingCopies = () => transaction<WorkingRecord[]>(false, store => store.getAll())
export const loadWorkingCopy = (key: string) => transaction<WorkingRecord | undefined>(false, store => store.get(key))
export const saveWorkingCopy = (copy: WorkingRecord) => transaction(true, store => store.put(copy))
export const deleteWorkingCopy = (key: string) => transaction(true, store => store.delete(key))

export async function forkWorkingCopy(record: WorkingRecord, session: string) {
  const key = `${session}:${record.meta.id}`
  if (key !== record.key) {
    const existing = await loadAssistantRecovery(key, record.meta.id)
    if (existing && (existing.dirty || existing.pending || existing.archives.length)) {
      throw new Error('This tab already has local assistant work for that document. Open a new tab to recover this copy.')
    }
    const assistant = await loadAssistantRecovery(record.key, record.meta.id)
    if (assistant) await saveAssistantRecovery({ ...assistant, workingCopyId: key })
  }
  const fork = { ...record, key, session }
  await saveWorkingCopy(fork)
  return fork
}

let session: Promise<string> | undefined
export function workingSession() {
  return session ??= (async () => {
    let stored: string | null = null
    try { stored = sessionStorage.getItem('mote-cloud-session') } catch { /* Storage failure is reported by the working-copy writer. */ }
    let id = stored ?? crypto.randomUUID()
    if (navigator.locks) {
      const acquire = (name: string) => new Promise<boolean>((resolve, reject) => {
        void navigator.locks.request(`mote-tab:${name}`, { ifAvailable: true }, async lock => {
          resolve(!!lock)
          if (lock) await new Promise<void>(() => {})
        }).catch(reject)
      })
      if (!await acquire(id)) { id = crypto.randomUUID(); await acquire(id) }
    } else {
      // Without locks, always fork rather than let duplicated tabs overwrite local recovery.
      id = crypto.randomUUID()
    }
    try { sessionStorage.setItem('mote-cloud-session', id) } catch { /* IndexedDB remains authoritative for recovery. */ }
    return id
  })()
}
