import { useEffect, useRef, useState } from 'react'
import { assistantRequest } from './api'
import { AssistantState } from './cloudState'
import { loadAssistantRecovery, loadTasks, saveAssistantRecovery } from './storage'
import type { AITask, AssistantCloud } from './types'

export function useAssistantState(cloud: AssistantCloud | undefined, writable: boolean) {
  const [tasks, setTasks] = useState<AITask[]>([]), state = useRef(tasks)
  const [loaded, setLoaded] = useState(false), [error, setError] = useState('')
  const [tick, render] = useState(0)
  const engine = useRef<AssistantState | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setLoaded(false); state.current = []; setTasks([]); engine.current = null
    if (!cloud || !writable) { setLoaded(true); return }
    const { workingCopyId, documentId } = cloud
    void (async () => {
      const saved = await loadAssistantRecovery(workingCopyId, documentId)
      const legacy = saved ? [] : await loadTasks()
      if (!active) return
      const current = new AssistantState(saved ?? { workingCopyId, documentId, revision: null, tasks: [], dirty: false,
        archives: legacy.length ? [{ id: crypto.randomUUID(), label: 'Earlier browser task recovery', tasks: legacy }] : [] }, {
        get: () => assistantRequest(documentId), put: body => assistantRequest(documentId, body), save: saveAssistantRecovery,
        changed: () => {
          if (!active) return
          state.current = current.record.tasks; setTasks(state.current); render(tick => tick + 1)
        },
      })
      engine.current = current; state.current = current.record.tasks; setTasks(state.current)
      await current.initialize()
      if (!active) return
      // A preparing token is process-local, but its input/request ID is durable.
      current.replace(current.record.tasks.map(task => task.status === 'preparing' && task.preparingCopyId === workingCopyId ? { ...task, status: 'error',
        error: 'Request confirmation was interrupted. Retry to recover the existing execution, or discard.' } : task))
      setLoaded(true); setError('')
    })().catch(error => { if (active) { setError(`AI task recovery is unavailable: ${(error as Error).message}`); setLoaded(true) } })
    return () => { active = false }
  }, [cloud?.workingCopyId, cloud?.documentId, writable, retry])

  useEffect(() => {
    if (!loaded || !writable) return
    const current = engine.current
    if (!current?.ready || current.conflict || current.warning || !current.record.dirty && !current.record.pending) return
    const timer = window.setTimeout(() => { void current.flush() }, 650)
    return () => window.clearTimeout(timer)
  }, [tasks, loaded, writable, tick])
  useEffect(() => {
    if (!loaded || !writable) return
    const timer = window.setInterval(() => {
      const current = engine.current
      if (!current) return
      void (current.ready ? current.record.dirty || current.record.pending ? current.flush() : current.refresh() : current.initialize())
    }, 5000)
    return () => window.clearInterval(timer)
  }, [loaded, writable])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const current = engine.current
      if (current?.record.dirty || current?.record.pending || current?.localWarning) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  return { tasks, state, loaded, engine,
    replace: (tasks: AITask[]) => engine.current?.replace(tasks),
    warning: error || engine.current?.localWarning || engine.current?.warning || (!cloud ? 'Open a cloud document to use the assistant.' : ''),
    conflict: engine.current?.conflict ?? null,
    archives: engine.current?.record.archives ?? [],
    retry: () => { const current = engine.current; if (!current) setRetry(value => value + 1); else void (current.ready ? current.flush() : current.initialize()) },
  }
}
