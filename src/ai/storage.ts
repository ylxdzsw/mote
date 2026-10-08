import type { AITask } from './types'

export interface AssistantArchive { id: string; label: string; tasks: AITask[] }
export interface AssistantRecovery {
  workingCopyId: string
  documentId: string
  revision: string | null
  tasks: AITask[]
  dirty: boolean
  pending?: { baseRevision: string; tasks: AITask[]; operationId: string }
  archives: AssistantArchive[]
}

let database: Promise<IDBDatabase> | undefined
function open() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mote-ai', 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('tasks')) request.result.createObjectStore('tasks', { keyPath: 'id' })
      if (!request.result.objectStoreNames.contains('workingCopies')) request.result.createObjectStore('workingCopies', { keyPath: ['workingCopyId', 'documentId'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(error => { database = undefined; throw error })
}
export async function loadAssistantRecovery(workingCopyId: string, documentId: string): Promise<AssistantRecovery | undefined> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workingCopies'), request = tx.objectStore('workingCopies').get([workingCopyId, documentId])
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
export async function saveAssistantRecovery(record: AssistantRecovery) {
  const db = await open()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('workingCopies', 'readwrite')
    tx.objectStore('workingCopies').put(record)
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
export async function loadTasks(): Promise<AITask[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks'), request = tx.objectStore('tasks').getAll()
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
