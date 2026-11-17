import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAssistantRecovery, saveAssistantRecovery, type AssistantRecovery } from './storage'
import type { AITask, AssistantCloud } from './types'
import type { useDocumentHistory } from '../document/history'

// Only browser review state and unsent requests live here. Reservations are in
// document history; proposals are fetched independently from the task service.
export function useAssistantState(cloud: AssistantCloud | undefined, writable: boolean, history: ReturnType<typeof useDocumentHistory>) {
  const [views, setViews] = useState<Record<string, Partial<AITask>>>({})
  const [loaded, setLoaded] = useState(false), [warning, setWarning] = useState('')
  const [retry, setRetry] = useState(0)
  const current = useRef({ cloud, history })
  current.current = { cloud, history }
  const record = useRef<AssistantRecovery | undefined>(undefined)
  const writes = useRef(Promise.resolve())
  const mounted = useRef(true)
  const failed = useRef(false)
  const persist = useCallback(() => {
    const value = record.current
    if (!value) return Promise.resolve()
    const snapshot = structuredClone(value)
    writes.current = writes.current.catch(() => {}).then(() => saveAssistantRecovery(snapshot)).then(() => {
      failed.current = false
      if (mounted.current) setWarning('')
    }, error => {
      failed.current = true
      if (mounted.current) setWarning('Assistant requests could not be saved locally. Keep this tab open and retry.')
      throw error
    })
    void writes.current.catch(() => {})
    return writes.current
  }, [])
  const flushLocal = useCallback(async () => {
    for (;;) {
      const current = record.current
      if (failed.current) await persist()
      else await writes.current
      if (record.current === current) return
    }
  }, [persist])
  useEffect(() => {
    let active = true
    mounted.current = true
    setLoaded(false)
    record.current = undefined
    if (!cloud || !writable) { setLoaded(true); return }
    void (async () => {
      const saved = await loadAssistantRecovery(cloud.workingCopyId, cloud.documentId)
      if (!active) return
      // V5 views did not persist their protocol. Keep them recovery-only instead
      // of interpreting cached proposals or pending runs as the current protocol.
      const views = Object.fromEntries(Object.entries(saved?.views ?? {}).map(([id, view]) => [id,
        { ...view, protocol: view.protocol ?? 'mote-agent-v5' }]))
      // Leave legacy recovery records intact, without importing them into the
      // current task lifecycle or exposing a parallel task-history interface.
      record.current = { workingCopyId: cloud.workingCopyId, documentId: cloud.documentId,
        revision: null, tasks: [], dirty: false, archives: [], ...saved, views }
      setViews(views); setLoaded(true); setWarning('')
    })().catch(error => { if (active) { setWarning(`Assistant recovery could not be loaded: ${(error as Error).message}`); setLoaded(true) } })
    return () => {
      active = false; mounted.current = false
      if (current.current.cloud?.localSaved) collect(new Set(current.current.history.currentReservations().map(task => task.id)), false)
    }
  }, [cloud?.workingCopyId, cloud?.documentId, writable, retry, persist])
  function dirty(views: Record<string, Partial<AITask>>) {
    return !!record.current?.pending || !!record.current?.tasks.length && !!record.current.dirty
      || current.current.history.currentReservations().some(task => !!views[task.id]?.draftPrompt || !!views[task.id]?.pendingRun)
  }
  function collect(ids: Set<string>, notify = true) {
    const saved = record.current
    if (!saved) return
    const views = Object.keys(saved.views ?? {}).every(id => ids.has(id)) ? saved.views ?? {}
      : Object.fromEntries(Object.entries(saved.views ?? {}).filter(([id]) => ids.has(id)))
    const pending = dirty(views)
    if (views === saved.views && pending === saved.dirty) return
    record.current = { ...saved, views, dirty: pending }
    if (notify && views !== saved.views) setViews(views)
    void persist().catch(() => {})
  }
  useEffect(() => {
    // The persisted working copy must stop referencing a task before its cache
    // can be removed. Failed local saves retain the cache for recovery.
    if (loaded && cloud?.localSaved) collect(history.referencedTaskIds())
  })
  function update(id: string, patch: Partial<AITask>) {
    if (!record.current || !current.current.history.referencedTaskIds().has(id)) return
    const views = { ...record.current.views, [id]: { ...record.current.views?.[id], ...patch } }
    record.current = { ...record.current, views, dirty: dirty(views) }
    setViews(views); void persist()
  }
  return { views, loaded, warning, update, flushLocal, retry: () => { if (!record.current) setRetry(value => value + 1); else void persist() } }
}
