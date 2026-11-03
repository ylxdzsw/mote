import { useCallback, useEffect, useRef, useState } from 'react'
import { assistantRequest } from './api'
import { AssistantState } from './cloudState'
import { loadAssistantRecovery, loadTasks, saveAssistantRecovery } from './storage'
import type { AITask, AssistantCloud } from './types'
import { useConnection } from '../cloud/connection'
import { subscribeDocumentUpdates } from '../cloud/documentEvents'

export function useAssistantState(cloud: AssistantCloud | undefined, writable: boolean) {
  const latestCloud = useRef(cloud)
  latestCloud.current = cloud
  const connection = useConnection()
  const [tasks, setTasks] = useState<AITask[]>([]), state = useRef(tasks)
  const [loaded, setLoaded] = useState(false), [error, setError] = useState('')
  const [tick, render] = useState(0)
  const engine = useRef<AssistantState | null>(null)
  const [retry, setRetry] = useState(0)
  const recoveredConnection = useRef(0)
  const refreshRequested = useRef(false)
  const flushLocal = useCallback(async () => { await engine.current?.flushLocal() }, [])
  useEffect(() => {
    let active = true
    refreshRequested.current = false
    setLoaded(false); state.current = []; setTasks([]); engine.current = null
    if (!cloud || !writable) { setLoaded(true); return }
    const { workingCopyId, documentId } = cloud
    void (async () => {
      const saved = await loadAssistantRecovery(workingCopyId, documentId)
      const legacy = saved ? [] : await loadTasks()
      if (!active) return
      const current = new AssistantState(saved ?? { workingCopyId, documentId, revision: cloud.draft ? '0' : null, tasks: [], dirty: false,
        archives: legacy.length ? [{ id: crypto.randomUUID(), label: 'Earlier browser task recovery', tasks: legacy }] : [] }, {
        get: () => assistantRequest(documentId), put: async body => {
          if (latestCloud.current?.draft && !await latestCloud.current.sync()) throw new Error('Add content or change document settings before saving this draft’s AI tasks.')
          return assistantRequest(documentId, body)
        }, save: saveAssistantRecovery,
        changed: () => {
          if (!active) return
          state.current = current.record.tasks; setTasks(state.current); render(tick => tick + 1)
        },
      })
      engine.current = current; state.current = current.record.tasks; setTasks(state.current)
      // New cloud documents start at assistant revision 0. Keep reservations on
      // this device until content/settings or a submitted request create the document.
      if (cloud.draft) current.ready = true
      else await current.initialize()
      if (!active) return
      // A preparing token is process-local, but its input/request ID is durable.
      current.replace(current.record.tasks.map(task => task.status === 'preparing' && task.preparingCopyId === workingCopyId ? { ...task,
        status: task.requestSent || task.submitted ? 'waiting' : 'draft',
        progress: task.requestSent || task.submitted ? 'Waiting to confirm the request.' : '',
        error: task.requestSent || task.submitted ? undefined : 'Preparation was interrupted before sending. Send when ready.' } : task))
      setLoaded(true); setError('')
    })().catch(error => { if (active) { setError(`AI task recovery is unavailable: ${(error as Error).message}`); setLoaded(true) } })
    return () => { active = false }
  }, [cloud?.workingCopyId, cloud?.documentId, writable, retry])

  useEffect(() => {
    if (!loaded || !writable || cloud?.draft || connection.offline) return
    const current = engine.current
    if (!current?.ready || current.busy || current.conflict || current.warning || current.localWarning || !current.record.dirty && !current.record.pending) return
    const timer = window.setTimeout(() => { void current.flush() }, 650)
    return () => window.clearTimeout(timer)
  }, [tasks, loaded, writable, tick, connection.offline, cloud?.draft])
  useEffect(() => {
    if (!loaded || !writable || cloud?.draft || connection.offline || connection.revision === recoveredConnection.current) return
    const current = engine.current
    if (!current || current.busy || current.conflict || current.localWarning) return
    recoveredConnection.current = connection.revision
    if (!current.ready) void current.initialize()
    else if (current.record.dirty || current.record.pending) void current.flush()
    else void current.refresh()
  }, [loaded, writable, connection.offline, connection.revision, tick, cloud?.draft])
  useEffect(() => {
    if (!writable || !cloud || cloud.draft) return
    return subscribeDocumentUpdates(cloud.documentId, event => {
      if (event.kind !== 'ready' && event.kind !== 'assistant') return
      refreshRequested.current = true; render(tick => tick + 1)
    })
  }, [writable, cloud?.documentId, cloud?.draft])
  useEffect(() => {
    const current = engine.current
    if (!refreshRequested.current || !loaded || !writable || cloud?.draft || connection.offline || !current
      || current.busy || current.warning || current.localWarning || current.conflict || current.record.dirty || current.record.pending) return
    refreshRequested.current = false
    if (!current.ready) void current.initialize()
    else void current.refresh()
  }, [loaded, writable, cloud?.draft, connection.offline, tick])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const current = engine.current
      if (current?.record.dirty || current?.record.pending || current?.localWarning) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  return { tasks, state, loaded, engine, flushLocal,
    replace: (tasks: AITask[]) => engine.current?.replace(tasks),
    warning: error || engine.current?.localWarning || engine.current?.warning || (!cloud ? 'Open a cloud document to use the assistant.' : ''),
    conflict: engine.current?.conflict ?? null,
    archives: engine.current?.record.archives ?? [],
    retry: () => {
      const current = engine.current
      if (!current) setRetry(value => value + 1)
      else if (latestCloud.current?.draft) { if (current.record.tasks.length) void latestCloud.current.sync() }
      else if (!current.ready) void current.initialize()
      else if (current.record.dirty || current.record.pending) void current.flush()
      else void current.refresh()
    },
  }
}
