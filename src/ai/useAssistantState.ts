import { useCallback, useEffect, useRef, useState } from 'react'
import { assistantRequest } from './api'
import { loadAssistantRecovery, loadTasks, saveAssistantRecovery, type AssistantRecovery } from './storage'
import type { AITask, AssistantCloud } from './types'

// Only browser review state and unsent requests live here. Reservations are in
// document history; proposals are fetched independently from the task service.
export function useAssistantState(cloud: AssistantCloud | undefined, writable: boolean) {
  const [views, setViews] = useState<Record<string, Partial<AITask>>>({})
  const [loaded, setLoaded] = useState(false), [warning, setWarning] = useState('')
  const [retry, setRetry] = useState(0)
  const [archives, setArchives] = useState<AssistantRecovery['archives']>([])
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
    if (!cloud || !writable) { setLoaded(true); return }
    void (async () => {
      const saved = await loadAssistantRecovery(cloud.workingCopyId, cloud.documentId)
      const legacy = saved ? [] : await loadTasks()
      let retained = saved?.archives ?? []
      if (saved?.tasks.length) retained = [...retained, { id: 'retired-local', label: 'Earlier local task recovery', tasks: saved.tasks }]
      if (legacy.length) retained = [...retained, { id: 'retired-browser', label: 'Earlier browser task recovery', tasks: legacy }]
      if (!active) return
      const current: AssistantRecovery = { workingCopyId: cloud.workingCopyId, documentId: cloud.documentId,
        revision: null, tasks: [], dirty: saved?.dirty ?? false, archives: retained, views: saved?.views ?? {} }
      record.current = current
      setViews(current.views!); setArchives(retained); setLoaded(true); setWarning('')
      // Retired cloud artifacts are optional recovery, never a dependency of
      // current document editing or browser proposal/request state.
      if (!saved && !cloud.draft) void assistantRequest(cloud.documentId).then(remote => {
        if (!active || !remote.tasks.length || !record.current) return
        record.current = { ...record.current, archives: [...record.current.archives,
          { id: 'retired-cloud', label: 'Earlier cloud task recovery', tasks: remote.tasks }] }
        setArchives(record.current.archives); void persist()
      }).catch(() => {})
    })().catch(error => { if (active) { setWarning(`Assistant recovery could not be loaded: ${(error as Error).message}`); setLoaded(true) } })
    return () => { active = false; mounted.current = false }
  }, [cloud?.workingCopyId, cloud?.documentId, writable, retry, persist])
  function update(id: string, patch: Partial<AITask>) {
    if (!record.current) return
    const views = { ...record.current.views, [id]: { ...record.current.views?.[id], ...patch } }
    record.current = { ...record.current, views, dirty: Object.values(views).some(view => !!view.draftPrompt || !!view.pendingRun) }
    setViews(views); void persist()
  }
  function discardArchive(id: string) {
    if (!record.current) return
    record.current = { ...record.current, archives: record.current.archives.filter(item => item.id !== id) }
    setArchives(record.current.archives); void persist()
  }
  return { views, loaded, warning, archives, update, discardArchive, flushLocal, retry: () => { if (!record.current) setRetry(value => value + 1); else void persist() } }
}
