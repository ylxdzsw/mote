import type { AITask } from './types'

let database: Promise<IDBDatabase> | undefined
function open() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mote-ai', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('tasks', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(error => { database = undefined; throw error })
}
export async function loadTasks(): Promise<AITask[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks'), request = tx.objectStore('tasks').getAll()
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
export async function storeTask(task: AITask | string) {
  const db = await open()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tasks', 'readwrite'), store = tx.objectStore('tasks')
    if (typeof task === 'string') store.delete(task); else store.put(task)
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
