import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { paragraph, replaceMainContent, type FloatingObject, type MoteDocument } from '../document/model'
import { initializeDocument } from '../document/initialize'
import { reconcileObjectDeletions } from '../document/flow'
import { validateDocument } from '../document/validate'
import type { useDocumentHistory } from '../document/history'
import { compatibleTasks, currentPlacement, inactiveTaskReason, overlaps, permits, permitsEditor, paragraphSelection, reservedText, sameContent } from './reservations'
import { aiRequest, AIServiceError } from './api'
import { connectionSnapshot, retryConnection, useConnection } from '../cloud/connection'
import { useAssistantState } from './useAssistantState'
import type { AssistantState } from './cloudState'
import type { Area, AITarget, AITask, AssistantCloud, Executor, RemoteTask } from './types'
import { applySegmentCandidate, makeSegmentTarget, resolveSegmentRange, type SegmentContext } from './segments'
import { copySegment, type SegmentClipboard } from '../document/segment'
import { getSchema } from '@tiptap/core'
import { extensions } from '../editor/extensions'

const candidateCache = new WeakMap<object, WeakMap<object, Map<string, { context?: SegmentContext; result: MoteDocument }>>>()

function creationBody(task: AITask) {
  if (!task.creation || !task.snapshotDocument || !task.cloudDocumentId || !task.baseRevision) throw new Error('The original upload is not retained. Discard this reservation and create a new one; its uncertain input will not be replaced.')
  return { ...task.creation, id: task.id, document: task.snapshotDocument, cloudDocumentId: task.cloudDocumentId,
    baseRevision: task.baseRevision, target: task.target, workspaceRead: task.workspaceRead ?? false }
}

function memoizedCandidate(doc: MoteDocument, candidate: object, taskId: string, context: SegmentContext | undefined, create: () => MoteDocument) {
  let byCandidate = candidateCache.get(doc)
  if (!byCandidate) { byCandidate = new WeakMap(); candidateCache.set(doc, byCandidate) }
  let byTask = byCandidate.get(candidate)
  if (!byTask) { byTask = new Map(); byCandidate.set(candidate, byTask) }
  const previous = byTask.get(taskId)
  if (previous && previous.context === context) return previous.result
  const result = create()
  byTask.set(taskId, { context, result })
  return result
}

export function candidateDocument(doc: MoteDocument, task: AITask, candidate = task.candidate, context?: SegmentContext): MoteDocument {
  if (!candidate) throw new Error('This task has no complete candidate.')
  return memoizedCandidate(doc, candidate, task.id, task.target.kind === 'segment' ? context : undefined, () => {
    const target = task.target
    let result: MoteDocument
    if (target.kind === 'object') {
      const original = doc.floating.find(object => object.id === target.objectId)
      if (!original || !candidate.object || candidate.content || candidate.segment) throw new Error('The candidate must deliver exactly one floating object.')
      if (candidate.object.id !== target.objectId) throw new Error('A revision must retain the target object ID.')
      if (!target.isNew && original.kind !== 'drawing' && (candidate.object.kind ?? 'text') !== (original.kind ?? 'text')) throw new Error('A revision must retain the object kind.')
      result = { ...doc, floating: doc.floating.map(object => object === original ? currentPlacement(candidate.object!, original) : object) }
    } else if (target.kind === 'text') {
      if (!candidate.content?.length || candidate.object || candidate.segment || candidate.content.some(node => node.type !== 'paragraph')) throw new Error('The candidate must deliver paragraphs.')
      const blocks = doc.content.content!, first = blocks.findIndex(node => node.attrs?.id === target.blockIds[0])
      if (first < 0 || !reservedText(doc.content, target.blockIds)) throw new Error('The reserved text is no longer available.')
      const content = candidate.content.map((node, index) => ({ ...node, attrs: { ...node.attrs,
        id: target.blockIds[index] ?? crypto.randomUUID() } }))
      result = replaceMainContent(doc, { ...doc.content, content: [...blocks.slice(0, first), ...content, ...blocks.slice(first + target.blockIds.length)] })
    } else {
      if (!candidate.segment || candidate.object || candidate.content) throw new Error('The candidate must deliver exactly one V0 segment.')
      if (!context) throw new Error('Segment geometry is not available for this preview.')
      result = applySegmentCandidate(doc, target, candidate.segment, context)
    }
    validateDocument(result)
    return initializeDocument(structuredClone(result))
  })
}

export function useAssistant(history: ReturnType<typeof useDocumentHistory>, writable: boolean, withoutObject: (id: string) => FloatingObject[] | undefined, objectArea: (id: string) => Area, segmentContext?: () => SegmentContext | undefined, cloud?: AssistantCloud) {
  const connection = useConnection()
  const persistence = useAssistantState(cloud, writable)
  const { tasks: savedTasks, state, loaded } = persistence
  const privateDocument = cloud?.privateDocument ?? false
  const externalBlocked = cloud?.externalBlocked ?? false
  const [notice, setNotice] = useState('')
  const [statusIssues, setStatusIssues] = useState<Record<string, { message: string; paused: boolean }>>({})
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [runs, setRuns] = useState<Record<string, number>>({})
  const [access, setAccess] = useState<Record<string, { executor: Executor; revision: number; path?: string }>>({})
  const [workspaceAccess, setWorkspaceAccess] = useState<Record<string, { enabled: boolean; revision: number }>>({})
  const workspaceAccessRef = useRef<Record<string, { enabled: boolean; revision: number }>>({})
  const [workspaceReadIssues, setWorkspaceReadIssues] = useState<Record<string, string>>({})
  const [workspaceReadOperations, setWorkspaceReadOperations] = useState<Record<string, boolean>>({})
  const currentDoc = useRef(history.doc!), bypass = useRef(false)
  const mounted = useRef(true)
  const preparations = useRef(new Map<string, symbol>())
  const mutations = useRef(new Map<string, number>())
  const discarded = useRef(new Set<string>())
  const acceptanceAttempts = useRef(new Set<string>())
  const checkStatusRef = useRef<(id: string) => void>(() => {})
  const cloudRef = useRef(cloud)
  cloudRef.current = cloud
  currentDoc.current = history.doc!
  const allTasks = useMemo(() => savedTasks.map(task => {
    if (!task.submitted && !task.requestSent) return task
    const current = workspaceAccess[task.id]
    const confirmed = !!current && current.revision === (task.workspaceReadRevision ?? -1)
      && current.enabled === (task.workspaceRead ?? false) && !task.pendingWorkspaceRead
    return task.workspaceReadConfirmed === confirmed ? task : { ...task, workspaceReadConfirmed: confirmed }
  }), [savedTasks, workspaceAccess])
  const tasks = compatibleTasks(allTasks, currentDoc.current)
  const activeTasks = (doc = currentDoc.current) => compatibleTasks(state.current, doc)
  const inactiveReason = (task: AITask) => inactiveTaskReason(task, currentDoc.current)
    ?? (!activeTasks().some(active => active.id === task.id) ? 'Another task reserves this target. This copy is retained for inspection and cannot lock or change the document.' : null)
  function openTask(id: string) { setActiveId(id); setOpen(true) }
  function markMutation(id: string) { mutations.current.set(id, (mutations.current.get(id) ?? 0) + 1) }
  function update(id: string, patch: Partial<AITask>) {
    if (!mounted.current) return
    persistence.replace(state.current.map(task => {
      if (task.id !== id) return task
      return { ...task, ...(patch.candidate ? { preview: true } : {}), ...patch }
    }))
  }
  function setWorkspaceReadIssue(id: string, message?: string) {
    setWorkspaceReadIssues(current => {
      if (!message) {
        if (!(id in current)) return current
        const next = { ...current }; delete next[id]; return next
      }
      if (current[id] === message) return current
      return { ...current, [id]: message }
    })
  }
  function setWorkspaceReadOperation(id: string, active: boolean) {
    setWorkspaceReadOperations(current => {
      if (!!current[id] === active) return current
      const next = { ...current }
      if (active) next[id] = true
      else delete next[id]
      return next
    })
  }
  function receive(remote: RemoteTask, patch: Partial<AITask> = {}) {
    const task = state.current.find(task => task.id === remote.id)
    if (!task) return
    const incomingWorkspace = {
      enabled: typeof remote.workspaceRead === 'boolean' ? remote.workspaceRead : false,
      revision: Number.isSafeInteger(remote.workspaceReadRevision) && remote.workspaceReadRevision >= 0 ? remote.workspaceReadRevision : 0,
    }
    const previousWorkspace = workspaceAccessRef.current[task.id]
    const workspaceFresh = !previousWorkspace || incomingWorkspace.revision > previousWorkspace.revision
      || incomingWorkspace.revision === previousWorkspace.revision && incomingWorkspace.enabled === previousWorkspace.enabled
    const effectiveWorkspace = workspaceFresh ? incomingWorkspace : previousWorkspace
    if (workspaceFresh && (!previousWorkspace || previousWorkspace.revision !== incomingWorkspace.revision || previousWorkspace.enabled !== incomingWorkspace.enabled)) {
      const next = { ...workspaceAccessRef.current, [task.id]: incomingWorkspace }
      workspaceAccessRef.current = next
      setWorkspaceAccess(next)
    }
    const pending = task.pendingWorkspaceRead
    const workspaceChangeObserved = !!pending && effectiveWorkspace.revision > pending.baseWorkspaceReadRevision
    const workspacePatch: Partial<AITask> = effectiveWorkspace ? {
      workspaceRead: effectiveWorkspace.enabled, workspaceReadRevision: effectiveWorkspace.revision,
      ...(workspaceChangeObserved ? { pendingWorkspaceRead: undefined } : {}),
    } : {}
    if ((remote.executorRevision ?? 0) < (task.executorRevision ?? 0)
      || (remote.candidateRevision ?? 0) < (task.candidateRevision ?? 0)) {
      if (Object.keys(workspacePatch).length && !sameContent(task, { ...task, ...workspacePatch })) update(task.id, workspacePatch)
      if (workspaceChangeObserved && pending) setWorkspaceReadIssue(task.id,
        effectiveWorkspace.enabled === pending.enabled ? `Workspace reads ${pending.enabled ? 'enabled' : 'disabled'} for this task.` : 'Workspace access changed elsewhere. The current server setting is shown.')
      return
    }
    const { externalPath, candidate, workspaceRead: _workspaceRead, workspaceReadRevision: _workspaceReadRevision, ...rest } = remote
    setAccess(current => {
      const next = { executor: remote.executor ?? 'builtin', revision: remote.executorRevision ?? 0,
        path: cloudRef.current?.externalBlocked ? undefined : externalPath }
      return sameContent(current[task.id], next) ? current : { ...current, [task.id]: next }
    })
    const next: Partial<AITask> = { error: undefined, ...rest, submitted: true, ...patch, ...workspacePatch }
    if (candidate && !sameContent(task.candidate, candidate)) next.candidate = candidate
    if (!sameContent(task, { ...task, ...next })) update(task.id, next)
    if (workspaceChangeObserved && pending) setWorkspaceReadIssue(task.id,
      effectiveWorkspace.enabled === pending.enabled ? `Workspace reads ${pending.enabled ? 'enabled' : 'disabled'} for this task.` : 'Workspace access changed elsewhere. The current server setting is shown.')
  }
  const executorBusy = (task: AITask) => !!task.pendingExecutor || !!(task.submitted && !task.remoteMissing
    && (!access[task.id] || access[task.id].revision !== (task.executorRevision ?? 0) || access[task.id].executor !== (task.executor ?? 'builtin')))
  function workspaceReadKnown(task: AITask) {
    if (!task.submitted && !task.requestSent) return true
    const known = workspaceAccessRef.current[task.id]
    return !!known && known.revision === (task.workspaceReadRevision ?? -1) && known.enabled === (task.workspaceRead ?? false)
  }
  function workspaceReadBlocked(task: AITask) {
    return !!task.pendingWorkspaceRead || !!workspaceReadOperations[task.id] || !!task.submitted && !workspaceReadKnown(task)
  }
  function workspaceReadState(task: AITask) {
    const pending = task.pendingWorkspaceRead
    if (!task.submitted && !task.requestSent) return { known: true, enabled: task.workspaceRead ?? false, pending }
    const known = workspaceAccess[task.id]
    const matches = !!known && known.revision === (task.workspaceReadRevision ?? -1) && known.enabled === (task.workspaceRead ?? false)
    return { known: matches, enabled: known?.enabled ?? false, pending }
  }
  const agentLink = (task: AITask) => !externalBlocked && !task.released && !task.remoteMissing && task.executor === 'external' && !executorBusy(task) && access[task.id]?.path
    ? new URL(access[task.id].path!, window.location.origin).href : undefined
  function unrestricted(action: () => void) {
    bypass.current = true
    try { history.boundary(); action(); history.boundary() } finally { bypass.current = false }
  }
  history.guard.current = (before, after) => {
    const allowed = bypass.current || permits(activeTasks(before), before, after)
    if (!allowed) setNotice('That change would edit a reserved region. Accept or discard its AI task first.')
    return allowed
  }
  history.guardEditor.current = (id, before, after) => bypass.current || permitsEditor(activeTasks(), id, before, after)
  history.lockedBlocks.current = Object.fromEntries(tasks.flatMap(task => task.target.kind === 'text' || task.target.kind === 'segment' ? task.target.blockIds.map(id => [id, task.id]) : []))

  useEffect(() => {
    mounted.current = true
    setAccess({})
    workspaceAccessRef.current = {}
    setWorkspaceAccess({}); setWorkspaceReadIssues({}); setWorkspaceReadOperations({})
    return () => { mounted.current = false; preparations.current.clear() }
  }, [cloud?.documentId, cloud?.workingCopyId, writable])
  useEffect(() => {
    if (externalBlocked) setAccess(current => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, { executor: item.executor, revision: item.revision }])))
  }, [externalBlocked])
  useEffect(() => {
    if (!externalBlocked) return
    for (const task of state.current) {
      if (task.documentId === cloudRef.current?.documentId && !task.submitted && !task.requestSent && task.pendingExecutor?.executor === 'external') {
        rejectPrivateExternalDraft(task.id)
      }
    }
  }, [externalBlocked, allTasks])
  useEffect(() => {
    setActiveId(current => allTasks.some(task => task.id === current) ? current : allTasks[0]?.id ?? null)
  }, [allTasks])

  useEffect(() => {
    if (!writable || !loaded) { checkStatusRef.current = () => {}; setStatusIssues({}); return }
    setStatusIssues({})
    let active = true, pending = false, authPaused = false
    const failures = new Map<string, number>(), paused = new Set<string>(), nextAt = new Map<string, number>(), requested = new Set<string>()
    const authPausedTasks = new Set<string>()
    const awaitingResult = (task: AITask) => (!task.pendingExecutor || privateDocument && (task.executor === 'external' || task.pendingExecutor.executor === 'external'))
      && !task.acceptance && !task.remoteMissing
      && (task.submitted || task.requestSent)
    function setIssue(id: string, value?: { message: string; paused: boolean }) {
      setStatusIssues(current => {
        if (!value) {
          if (!current[id]) return current
          const next = { ...current }; delete next[id]; return next
        }
        if (current[id]?.message === value.message && current[id]?.paused === value.paused) return current
        return { ...current, [id]: value }
      })
    }
    async function checkTask(task: AITask) {
      const mutation = mutations.current.get(task.id)
      const valid = () => active && mutations.current.get(task.id) === mutation && !preparations.current.has(task.id)
        && state.current.some(current => current.id === task.id && awaitingResult(current))
      try {
        const remote = await aiRequest<RemoteTask>(`/tasks/${task.id}`)
        if (!valid()) return
        failures.delete(task.id); paused.delete(task.id)
        nextAt.set(task.id, Date.now() + (['queued', 'running', 'waiting'].includes(remote.status) ? 1200 : 10_000)); setIssue(task.id)
        if (remote.candidate && !inactiveReason(task)) {
          try { candidateDocument(currentDoc.current, task, remote.candidate, segmentContext?.()) }
          catch (error) { receive(remote, { status: 'error', error: `Candidate retained for recovery: ${(error as Error).message}` }); return }
        }
        receive(remote, { creation: undefined, ...(privateDocument ? { pendingExecutor: undefined } : {}) })
      } catch (error) {
        if (!valid()) return
        const current = state.current.find(item => item.id === task.id)
        if (error instanceof AIServiceError && error.status === 404) {
          // requestSent is persisted before POST: another device can observe
          // the claim before the execution exists. Keep it recoverable.
          if (current?.submitted) { setIssue(task.id); missingRemote(task.id); return }
          if (privateDocument && current?.requestSent && current.creation?.executor === 'external') { setIssue(task.id); rejectPrivateExternalDraft(task.id); return }
        }
        const message = (error as Error).message
        if (error instanceof AIServiceError && (error.status === 401 || error.status === 403)) {
          authPaused = true
          for (const current of state.current.filter(awaitingResult)) {
            paused.add(current.id); authPausedTasks.add(current.id)
            setIssue(current.id, { message: `${message} Status checks have stopped. Sign in, then choose Check status. Generation was not retried.`, paused: true })
          }
          return
        }
        if (error instanceof AIServiceError && error.status >= 400 && error.status < 500 && error.status !== 404 && error.status !== 429) {
          paused.add(task.id)
          setIssue(task.id, { message: `Status checks paused: ${message} Choose Check status to try again. Generation was not retried.`, paused: true })
          return
        }
        const count = (failures.get(task.id) ?? 0) + 1
        failures.set(task.id, count)
        if (count >= 4) {
          paused.add(task.id)
          setIssue(task.id, { message: `Status checks paused after ${count} consecutive failures: ${message} Choose Check status to try again. Generation was not retried.`, paused: true })
        } else {
          const delay = Math.min(60_000, 10_000 * 2 ** (count - 1))
          nextAt.set(task.id, Date.now() + delay)
          setIssue(task.id, { message: `Status check failed (${count}/4): ${message} Retrying status in ${delay / 1000}s. Generation was not retried.`, paused: false })
        }
      }
    }
    async function poll() {
      if (pending || !active || authPaused || connectionSnapshot().offline) return
      pending = true
      const now = Date.now()
      const due = state.current.filter(task => awaitingResult(task) && !preparations.current.has(task.id)
        && !paused.has(task.id) && (requested.has(task.id) || (nextAt.get(task.id) ?? 0) <= now))
      for (const task of due) {
        requested.delete(task.id)
        if (!active || authPaused || connectionSnapshot().offline) break
        await checkTask(task)
      }
      pending = false
    }
    const checkStatus = (id: string) => {
      if (connectionSnapshot().offline) { void retryConnection(); return }
      const task = state.current.find(item => item.id === id)
      if (!task || !awaitingResult(task) || preparations.current.has(id)) return
      if (authPaused) {
        authPaused = false
        for (const pausedId of authPausedTasks) {
          paused.delete(pausedId); failures.delete(pausedId); nextAt.set(pausedId, 0)
          setIssue(pausedId, { message: 'Checking status…', paused: false })
        }
        authPausedTasks.clear()
      }
      failures.delete(id); paused.delete(id); nextAt.set(id, 0); requested.add(id)
      setIssue(id, { message: 'Checking status…', paused: false })
      void poll()
    }
    checkStatusRef.current = checkStatus
    void poll()
    const timer = window.setInterval(() => void poll(), 1000)
    return () => {
      active = false; window.clearInterval(timer)
      if (checkStatusRef.current === checkStatus) checkStatusRef.current = () => {}
    }
  }, [loaded, writable, cloud?.documentId, cloud?.workingCopyId, privateDocument, connection.offline, connection.revision])

  function reserve(target: AITarget, snapshot = currentDoc.current) {
    if (!loaded || !writable || !cloud || cloud.documentId !== snapshot.id || !persistence.engine.current?.ready) { setNotice('Connect this working copy to its cloud document before starting an AI task.'); return }
    if (target.kind === 'text' && !reservedText(snapshot.content, target.blockIds)) { setNotice('Select consecutive paragraphs without crossing a space or Flow object.'); return }
    if (target.kind === 'segment') {
      const range = resolveSegmentRange(snapshot, target)
      if (!range) { setNotice('The selected segment is no longer available.'); return }
      const fresh = makeSegmentTarget(snapshot, range, target.area)
      if (!sameContent(fresh.blockIds, target.blockIds) || !sameContent(fresh.objectIds, target.objectIds)) { setNotice('The selected segment changed.'); return }
      target = fresh
    }
    const overlapping = activeTasks(snapshot).find(task => overlaps(task.target, target, snapshot))
    if (overlapping) { openTask(overlapping.id); return }
    let original: FloatingObject | JSONContent[] | SegmentClipboard
    let segmentOriginalBlocks: JSONContent[] | undefined
    let segmentOriginalObjects: FloatingObject[] | undefined
    if (target.kind === 'object') original = structuredClone(snapshot.floating.find(object => object.id === target.objectId)!)
    else if (target.kind === 'text') original = structuredClone(snapshot.content.content!.filter(node => target.blockIds.includes(node.attrs?.id)))
    else {
      const context = segmentContext?.() ?? { anchors: [], geometry: {} }
      original = copySegment(snapshot, target.range, context.anchors, context.geometry)
      segmentOriginalBlocks = structuredClone(snapshot.content.content!.filter(node => target.blockIds.includes(node.attrs?.id)))
      segmentOriginalObjects = structuredClone(snapshot.floating.filter(object => target.objectIds.includes(object.id)))
    }
    const task: AITask = { id: crypto.randomUUID(), documentId: snapshot.id, target, prompt: '', createdAt: Date.now(),
      original,
      snapshotDocument: structuredClone(snapshot), status: 'draft', progress: '', submitted: false, preview: false,
      workspaceRead: false, workspaceReadRevision: 0 }
    if (segmentOriginalBlocks) task.segmentOriginalBlocks = segmentOriginalBlocks
    if (segmentOriginalObjects) task.segmentOriginalObjects = segmentOriginalObjects
    persistence.replace([...state.current, task]); openTask(task.id); setNotice(''); history.boundary()
    return task
  }
  function missingRemote(id: string) {
    update(id, { status: 'error', remoteMissing: true, progress: '', error: 'This AI session is no longer available. Accept any complete candidate or discard this reservation, then start a new revision from the context panel.' })
  }
  function rejectPrivateExternalDraft(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!task || task.submitted) return
    preparations.current.delete(id)
    update(id, { executor: 'builtin', pendingExecutor: undefined, status: 'draft', progress: '',
      error: 'External handoff was blocked while Private was enabled or being confirmed. The reservation is ready for the built-in agent.',
      requestSent: false, creation: undefined, cloudDocumentId: undefined, baseRevision: undefined,
      preparingCopyId: undefined })
  }

  async function start(id: string, prompt: string, executor: Executor = 'builtin') {
    let task = state.current.find(task => task.id === id)
    const connection = cloudRef.current, store = persistence.engine.current
    if (executor === 'external' && cloudRef.current?.externalBlocked) {
      if (task && !task.submitted && !task.requestSent && task.pendingExecutor?.executor === 'external') rejectPrivateExternalDraft(id)
      setNotice('External handoff is unavailable while this document is private.'); return
    }
    if (!writable || !connection || !store?.ready || store.conflict) { setNotice('Resolve cloud task saving before sending a request.'); return }
    if (!task || inactiveReason(task) || task.remoteMissing || preparations.current.has(id)) return
    if (workspaceReadBlocked(task)) { setNotice('Confirm the workspace-read setting before continuing. Refresh status or retry the pending permission change.'); return }
    let knownNotCreated = !task.submitted && !task.requestSent
    if (executor === 'builtin' && ((task.executor ?? 'builtin') !== 'builtin' || executorBusy(task) || !prompt.trim() || ['running', 'queued', 'preparing'].includes(task.status))) return
    // Resizing is allowed before the first request. Freeze the current object,
    // not the dimensions from when the reservation was first drawn.
    if (!task.submitted && !task.requestSent && task.target.kind === 'object') {
      const objectId = task.target.objectId
      task = { ...task, original: structuredClone(currentDoc.current.floating.find(object => object.id === objectId)!) }
      update(id, { original: task.original })
    }
    const run = Symbol()
    markMutation(id)
    preparations.current.set(id, run)
    const preparing = () => mounted.current && persistence.engine.current === store && preparations.current.get(id) === run
      && state.current.some(task => task.id === id && task.status === 'preparing')
    update(id, { status: 'preparing', preparingCopyId: connection.workingCopyId,
      ...(executor === 'builtin' ? { prompt: task.creation?.prompt ?? prompt, draftPrompt: task.creation ? task.draftPrompt : '', title: task.title || prompt.trim().split('\n')[0].slice(0, 60), preview: false } : {}),
      error: undefined, progress: 'Saving document and preparing snapshot…' })
    try {
      let remote: RemoteTask
      if (!task.submitted && task.requestSent) {
        try {
          remote = await aiRequest<RemoteTask>(`/tasks/${id}`)
          if (preparing()) receive(remote, { pendingExecutor: undefined, creation: undefined })
          return
        } catch (error) {
          if (!(error instanceof AIServiceError) || error.status !== 404) throw error
          if (!preparing()) return
          knownNotCreated = true
          if (executor === 'external' && cloudRef.current?.privateDocument) { rejectPrivateExternalDraft(id); return }
          if (executor === 'external' && cloudRef.current?.externalBlocked) throw new Error('Confirm the privacy setting before retrying external access.')
          knownNotCreated = false
          remote = await aiRequest('/tasks', 'POST', creationBody(task))
        }
      }
      else if (task.submitted) {
        if (!await store.flush()) throw new Error('Save or resolve the cloud assistant state before revising.')
        if (!preparing()) return
        remote = await aiRequest(`/tasks/${id}/revise`, 'POST', { prompt, executorRevision: task.executorRevision })
      } else {
        const saved = await connection.sync()
        if (!preparing()) return
        if (!saved) throw new Error('The document could not be saved to the cloud. Resolve its sync status, then retry.')
        const snapshotDocument = structuredClone(saved.document)
        if (snapshotDocument.id !== connection.documentId || !sameContent(snapshotDocument, currentDoc.current)) {
          throw new Error('The working copy changed while saving. Retry with the current document after resolving any sync conflict.')
        }
        const stale = inactiveTaskReason(task, snapshotDocument)
        if (stale) throw new Error(stale)
        let target = task.target, original = task.original
        let segmentOriginalBlocks = task.segmentOriginalBlocks, segmentOriginalObjects = task.segmentOriginalObjects
        const context = segmentContext?.()
        if (target.kind === 'object') {
          const objectId = target.objectId
          original = structuredClone(snapshotDocument.floating.find(object => object.id === objectId)!)
          target = { ...target, area: objectArea(objectId) }
        } else if (target.kind === 'segment') {
          const range = resolveSegmentRange(snapshotDocument, target)
          if (!range || !context) throw new Error('The reserved segment geometry is not available. Retry after the document finishes rendering.')
          target = makeSegmentTarget(snapshotDocument, range, { ...target.area, width: snapshotDocument.width })
          original = copySegment(snapshotDocument, range, context.anchors, context.geometry)
          const { blockIds, objectIds } = target
          segmentOriginalBlocks = structuredClone(snapshotDocument.content.content!.filter(node => blockIds.includes(node.attrs?.id)))
          segmentOriginalObjects = structuredClone(snapshotDocument.floating.filter(object => objectIds.includes(object.id)))
        } else {
          const node = getSchema(extensions(true)).nodeFromJSON(snapshotDocument.content)
          const { blockIds } = target
          let from = 0, to = 0
          node.forEach((child, position) => {
            if (child.attrs.id === blockIds[0]) from = position + 1
            if (child.attrs.id === blockIds.at(-1)) to = position + child.nodeSize - 1
          })
          const selection = paragraphSelection(node, from, to)
          if (!selection || !sameContent(selection.blockIds, blockIds)) throw new Error('The selected paragraphs changed. Start a new request for the current selection.')
          const first = context?.anchors.find(anchor => anchor.id === blockIds[0]), last = context?.anchors.find(anchor => anchor.id === blockIds.at(-1))
          const area = first && last ? { x: snapshotDocument.margins.left, y: first.top,
            width: snapshotDocument.width - snapshotDocument.margins.left - snapshotDocument.margins.right,
            height: (last.bottom ?? last.top) - first.top } : target.area
          target = { ...target, ...selection, area }
          original = structuredClone(snapshotDocument.content.content!.filter(block => blockIds.includes(block.attrs?.id)))
        }
        const input = { snapshotDocument, original, target, segmentOriginalBlocks, segmentOriginalObjects,
          cloudDocumentId: connection.documentId, baseRevision: saved.revision }
        task = { ...task, ...input }; update(id, input)
        const { exportPng } = await import('../document/png')
        const blob = await exportPng(snapshotDocument)
        const snapshot = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob)
        })
        if (!preparing()) return
        const model = snapshotDocument.aiModel?.trim()
        const creation = { executor, operationId: task.pendingExecutor?.operationId ?? task.id, prompt,
          ...(model ? { model } : {}), snapshot }
        if (executor === 'external' && cloudRef.current?.externalBlocked) { rejectPrivateExternalDraft(id); return }
        task = { ...task, requestSent: true, creation }
        update(id, { requestSent: true, creation })
        if (!await store.flush()) throw new Error('The request is retained locally. Resolve cloud assistant saving before generating.')
        if (!preparing()) return
        if (executor === 'external' && cloudRef.current?.externalBlocked) { rejectPrivateExternalDraft(id); return }
        knownNotCreated = false
        remote = await aiRequest('/tasks', 'POST', creationBody(task))
      }
      if (!preparing()) {
        if (discarded.current.has(id)) void cleanup(id, store)
        else if (mounted.current && state.current.some(task => task.id === id && task.status === 'stopped')) void aiRequest(`/tasks/${id}/stop`, 'POST').catch(() => {})
        return
      }
      receive(remote, { pendingExecutor: undefined, creation: undefined })
    } catch (error) {
      if (preparing()) {
        if (executor === 'external' && cloudRef.current?.privateDocument && knownNotCreated && !task.submitted) rejectPrivateExternalDraft(id)
        else if (task.submitted && error instanceof AIServiceError && error.status === 404) missingRemote(id)
        else if (connectionSnapshot().offline) update(id, { status: task.requestSent || task.submitted ? 'waiting' : 'draft',
          progress: 'Offline · request retained. Waiting for reconnection.', error: undefined })
        else update(id, { status: 'error', progress: 'Request failed', error: (error as Error).message })
      }
    }
    finally {
      if (preparations.current.get(id) === run) { preparations.current.delete(id); checkStatusRef.current(id) }
    }
  }

  async function stop(id: string) {
    const task = state.current.find(task => task.id === id)
    const store = persistence.engine.current
    if (!writable || !task || task.pendingExecutor || task.executor === 'external') return
    const run = Symbol()
    markMutation(id)
    preparations.current.set(id, run)
    update(id, { status: 'stopped', progress: 'Stopping…' })
    if (!task.submitted && !task.requestSent) { preparations.current.delete(id); update(id, { progress: 'Stopped' }); return }
    try {
      const remote = await aiRequest<RemoteTask>(`/tasks/${id}/stop`, 'POST')
      if (store === persistence.engine.current && state.current.some(task => task.id === id && task.status === 'stopped')) receive(remote)
    } catch (error) {
      if (store === persistence.engine.current && state.current.some(task => task.id === id && task.status === 'stopped')) update(id, { error: (error as Error).message, progress: 'Stop was not confirmed. The request and any result are retained.' })
    } finally {
      if (preparations.current.get(id) === run) { preparations.current.delete(id); checkStatusRef.current(id) }
    }
  }

  async function switchExecutor(id: string, executor: Executor) {
    let task = state.current.find(task => task.id === id)
    const store = persistence.engine.current
    if (!writable || !task || executor === 'external' && cloudRef.current?.externalBlocked || !store?.ready || store.conflict || inactiveReason(task) || task.remoteMissing || task.released || preparations.current.has(id) || workspaceReadBlocked(task)) return
    if (!task.pendingExecutor && (task.executor ?? 'builtin') === executor) return
    if (task.pendingExecutor && task.pendingExecutor.executor !== executor) return
    if (!task.submitted && !task.requestSent && !task.pendingExecutor && task.target.kind === 'object') {
      const objectId = task.target.objectId
      task = { ...task, original: structuredClone(currentDoc.current.floating.find(object => object.id === objectId)!) }
      update(id, { original: task.original })
    }
    const pending = task.pendingExecutor ?? { executor, operationId: crypto.randomUUID(), baseExecutorRevision: task.submitted ? task.executorRevision ?? 0 : undefined }
    markMutation(id)
    update(id, { pendingExecutor: pending, error: undefined, progress: 'Confirming agent access…',
      ...(!task.submitted && !task.requestSent ? { workspaceRead: false } : {}) })
    const run = Symbol()
    preparations.current.set(id, run)
    const current = () => mounted.current && persistence.engine.current === store && preparations.current.get(id) === run
      && state.current.some(task => task.id === id)
    try {
      if (!await store.flush()) throw new Error('Resolve cloud assistant saving before switching agents.')
      if (!current()) return
      if (!task.submitted && task.requestSent) {
        try {
          const remote = await aiRequest<RemoteTask>(`/tasks/${id}`)
          if (!current()) return
          receive(remote, { creation: undefined })
          task = state.current.find(task => task.id === id)!
        } catch (error) {
          if (!(error instanceof AIServiceError) || error.status !== 404) throw error
          if (!current()) return
          if (executor === 'external' && cloudRef.current?.privateDocument) { rejectPrivateExternalDraft(id); return }
          if (executor === 'external' && cloudRef.current?.externalBlocked) throw new Error('Confirm the privacy setting before retrying external access.')
          const remote = await aiRequest<RemoteTask>('/tasks', 'POST', creationBody(task))
          if (!current()) { if (discarded.current.has(id)) void cleanup(id, store); return }
          receive(remote, { creation: undefined })
          task = state.current.find(task => task.id === id)!
        }
      }
      if (!task.submitted) {
        preparations.current.delete(id)
        if (executor === 'external' && cloudRef.current?.externalBlocked) {
          update(id, { pendingExecutor: undefined, error: 'External handoff is unavailable while this document is private.', progress: '' })
          return
        }
        await start(id, '', 'external')
        return
      }
      const operation = { ...pending, baseExecutorRevision: pending.baseExecutorRevision ?? task.executorRevision ?? 0 }
      update(id, { pendingExecutor: operation })
      if (!await store.flush()) throw new Error('Resolve cloud assistant saving before switching agents.')
      if (!current()) return
      if (executor === 'external' && cloudRef.current?.externalBlocked) {
        update(id, { pendingExecutor: undefined, error: 'External handoff is unavailable while this document is private.', progress: '' })
        return
      }
      const remote = await aiRequest<RemoteTask>(`/tasks/${id}/executor`, 'POST', operation)
      if (!current()) { if (discarded.current.has(id)) void cleanup(id, store); return }
      receive(remote, { pendingExecutor: undefined })
    } catch (error) {
      if (!current()) return
      if (error instanceof AIServiceError && error.status === 409) {
        try {
          const remote = await aiRequest<RemoteTask>(`/tasks/${id}`)
          if (current()) receive(remote, { pendingExecutor: undefined, error: 'Agent access changed in another working copy. The current server choice is shown; choose again if needed.' })
        } catch (recoveryError) {
          if (current()) update(id, { error: `Agent switch was not confirmed: ${(recoveryError as Error).message}`, progress: 'Retry confirmation before continuing.' })
        }
      } else update(id, { error: `Agent switch was not confirmed: ${(error as Error).message}`, progress: 'Retry confirmation before continuing.' })
    } finally {
      if (preparations.current.get(id) === run) { preparations.current.delete(id); checkStatusRef.current(id) }
    }
  }
  async function retryExecutor(id: string) {
    const task = state.current.find(task => task.id === id)
    if (task?.pendingExecutor) await switchExecutor(id, task.pendingExecutor.executor)
  }

  async function sendWorkspaceRead(id: string, operation: NonNullable<AITask['pendingWorkspaceRead']>) {
    const task = state.current.find(task => task.id === id), store = persistence.engine.current
    if (!writable || !task || task.pendingWorkspaceRead?.operationId !== operation.operationId || preparations.current.has(id)) return
    if (!store?.ready) { setWorkspaceReadIssue(id, 'AI task recovery is not ready. Retry the same workspace-read change when it is available.'); return }
    markMutation(id)
    const run = Symbol()
    preparations.current.set(id, run)
    setWorkspaceReadOperation(id, true)
    setWorkspaceReadIssue(id, 'Saving the pending permission change before contacting the task…')
    const current = () => mounted.current && persistence.engine.current === store && preparations.current.get(id) === run
      && state.current.some(task => task.id === id && task.pendingWorkspaceRead?.operationId === operation.operationId)
    try {
      if (!await store.flush()) throw new Error('Resolve AI task saving before changing workspace-read access.')
      if (!current()) return
      const remote = await aiRequest<RemoteTask>(`/tasks/${id}/workspace-read`, 'POST', operation)
      if (!current()) return
      receive(remote)
      const after = state.current.find(task => task.id === id)
      if (after?.pendingWorkspaceRead?.operationId === operation.operationId) {
        setWorkspaceReadIssue(id, 'The server response did not confirm the permission change. Refresh status or retry this same operation.')
      }
    } catch (error) {
      if (!current()) return
      setWorkspaceReadIssue(id, `Workspace-read change is unconfirmed: ${(error as Error).message} Refresh status or retry the same operation; it has been retained.`)
    } finally {
      if (preparations.current.get(id) === run) {
        preparations.current.delete(id); setWorkspaceReadOperation(id, false); checkStatusRef.current(id)
      }
    }
  }

  async function setWorkspaceRead(id: string, enabled: boolean) {
    const task = state.current.find(task => task.id === id)
    if (!writable || !task || preparations.current.has(id) || task.pendingExecutor || task.pendingWorkspaceRead || inactiveReason(task)) return
    if (!task.submitted && !task.requestSent) {
      update(id, { workspaceRead: enabled })
      setWorkspaceReadIssue(id)
      return
    }
    if (!workspaceReadKnown(task)) {
      setWorkspaceReadIssue(id, 'Refresh the server permission status before changing workspace reads.')
      return
    }
    const current = workspaceAccessRef.current[id]
    if (!current || current.enabled === enabled) return
    const operation = { enabled, baseWorkspaceReadRevision: current.revision, operationId: crypto.randomUUID() }
    update(id, { pendingWorkspaceRead: operation })
    setWorkspaceReadIssue(id, `Confirming ${enabled ? 'enabled' : 'disabled'} workspace reads…`)
    await sendWorkspaceRead(id, operation)
  }

  async function retryWorkspaceRead(id: string) {
    const task = state.current.find(task => task.id === id), operation = task?.pendingWorkspaceRead
    if (!operation || preparations.current.has(id)) return
    await sendWorkspaceRead(id, operation)
  }

  async function refreshWorkspaceRead(id: string) {
    const task = state.current.find(task => task.id === id), store = persistence.engine.current
    if (!task || (!task.submitted && !task.requestSent) || preparations.current.has(id)) return
    const run = Symbol()
    preparations.current.set(id, run)
    setWorkspaceReadOperation(id, true)
    setWorkspaceReadIssue(id, 'Refreshing server permission status…')
    const current = () => mounted.current && persistence.engine.current === store && preparations.current.get(id) === run
      && state.current.some(task => task.id === id)
    try {
      const remote = await aiRequest<RemoteTask>(`/tasks/${id}`)
      if (!current()) return
      receive(remote)
      const latest = state.current.find(task => task.id === id)
      if (latest?.pendingWorkspaceRead) setWorkspaceReadIssue(id, 'Server status refreshed. The saved permission change remains unconfirmed; retry the same operation.')
      else if (workspaceReadKnown(latest!)) setWorkspaceReadIssue(id)
    } catch (error) {
      if (current()) setWorkspaceReadIssue(id, `Could not refresh workspace-read status: ${(error as Error).message}`)
    } finally {
      if (preparations.current.get(id) === run) {
        preparations.current.delete(id); setWorkspaceReadOperation(id, false)
      }
    }
  }

  async function cleanup(id: string, store: AssistantState) {
    try { await aiRequest(`/tasks/${id}/release`, 'POST') }
    catch (error) {
      if (!(error instanceof AIServiceError && error.status === 404) && mounted.current) setNotice('Agent access revocation was not confirmed. Reconnect to finish releasing this reservation.')
    }
    // The document (for acceptance) and the assistant removal must both be
    // durable before deleting the only execution artifact. Uncertain cleanup
    // leaks a retained artifact rather than losing a result.
    if (!await store.flush() || store.record.tasks.some(task => task.id === id)
      || store.record.archives.some(archive => archive.tasks.some(task => task.id === id))) return
    try { await aiRequest(`/tasks/${id}`, 'DELETE') }
    catch (error) {
      if (!(error instanceof AIServiceError && error.status === 404) && mounted.current) setNotice('The task was released, but execution cleanup was not confirmed. The server artifact is retained.')
    }
  }
  function forget(id: string) {
    markMutation(id)
    preparations.current.delete(id)
    const task = state.current.find(task => task.id === id)
    const index = state.current.findIndex(task => task.id === id)
    discarded.current.add(id)
    persistence.replace(state.current.filter(task => task.id !== id))
    setActiveId(current => current === id ? (state.current[index] ?? state.current[index - 1])?.id ?? null : current)
    if (!state.current.length) setOpen(false)
    const store = persistence.engine.current
    if (store && (task?.submitted || task?.requestSent)) void cleanup(id, store)
  }
  function discard(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!writable || !task) return
    const inactive = inactiveReason(task)
    forget(id)
    if (inactive) return
    const target = task.target
    if (target.kind === 'segment') return
    unrestricted(() => history.setDoc(doc => {
      if (!doc) return doc
      if (target.kind === 'object' && target.isNew) return { ...doc, floating: withoutObject(target.objectId) ?? doc.floating.filter(object => object.id !== target.objectId) }
      if (target.kind === 'text' && target.insert) {
        const content = doc.content.content!.filter(node => !target.blockIds.includes(node.attrs?.id))
        return replaceMainContent(doc, { ...doc.content, content: content.length ? content : [paragraph('')] })
      }
      return doc
    }))
  }
  function accept(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!writable || !cloud || !task?.candidate || executorBusy(task) || workspaceReadBlocked(task) || inactiveReason(task) || ['running', 'queued', 'preparing'].includes(task.status)) return
    try {
      const next = candidateDocument(currentDoc.current, task, task.candidate, segmentContext?.())
      if (!permits(activeTasks().filter(other => other.id !== id), currentDoc.current, next)) throw new Error('This result would affect another reserved region. Resolve that task first.')
      unrestricted(() => history.setDoc(next))
      markMutation(id)
      update(id, { acceptance: { workingCopyId: cloud.workingCopyId, document: next }, preview: false, error: undefined })
      if (task.submitted || task.requestSent) void aiRequest(`/tasks/${id}/release`, 'POST').catch(error => {
        if (mounted.current) update(id, { error: `Agent access revocation is pending: ${(error as Error).message}` })
      })
      setNotice('Applied locally. The AI result is retained until the accepted document is saved to the cloud.')
      if (task.target.kind === 'object') {
        const objectId = task.target.objectId
        setRuns(current => ({ ...current, [objectId]: (current[objectId] ?? 0) + 1 }))
      }
    } catch (error) { update(id, { error: (error as Error).message }) }
  }
  async function syncAcceptance(id: string) {
    const task = state.current.find(task => task.id === id), connection = cloudRef.current, store = persistence.engine.current
    if (!task?.acceptance || !connection || task.acceptance.workingCopyId !== connection.workingCopyId) return
    try {
      const saved = await connection.sync()
      if (!mounted.current || store !== persistence.engine.current || !state.current.some(current => current.id === id && sameContent(current.acceptance, task.acceptance))) return
      if (!saved || !sameContent(saved.document, task.acceptance.document)) {
        update(id, { error: 'The exact accepted document has not been confirmed in the cloud. The working copy may have changed or conflicted. Your original input and candidate are retained below.' }); return
      }
      forget(id); setNotice('Accepted document saved to the cloud.')
    } catch (error) {
      if (mounted.current && store === persistence.engine.current) update(id, { error: `The result is retained: ${(error as Error).message}` })
    }
  }
  useEffect(() => {
    // Parent effects first copy the committed history document into its sync
    // controller. Calling sync during this hook's effect would save the old doc.
    const timer = window.setTimeout(() => {
      for (const task of allTasks) if (task.acceptance?.workingCopyId === cloud?.workingCopyId && task.acceptance && !acceptanceAttempts.current.has(task.id)) {
        acceptanceAttempts.current.add(task.id); void syncAcceptance(task.id)
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [allTasks, cloud?.workingCopyId])
  function abandonAll() { for (const task of [...state.current]) if (task.documentId === currentDoc.current.id) forget(task.id) }
  function deleteObjects(floating: FloatingObject[]) {
    const removed = activeTasks().filter(task => task.target.kind === 'object' && !floating.some(object => object.id === (task.target as Extract<AITarget, { kind: 'object' }>).objectId))
    const next = reconcileObjectDeletions(currentDoc.current, floating, segmentContext?.())
    if (!permits(activeTasks().filter(task => !removed.includes(task)), currentDoc.current, next)) {
      setNotice('That deletion would change another reserved region. Accept or discard its AI task first.'); return false
    }
    for (const task of removed) forget(task.id)
    history.boundary(); history.setDoc(next); history.boundary()
    return true
  }
  function deleteTarget(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!writable || !task || inactiveReason(task)) return
    if (task.target.kind === 'object') {
      deleteObjects(withoutObject(task.target.objectId) ?? currentDoc.current.floating.filter(object => object.id !== (task.target as Extract<AITarget, { kind: 'object' }>).objectId))
      return
    }
    if (task.target.kind === 'segment') {
      if (!task.target.blockIds.length && !task.target.objectIds.length) { forget(id); return }
      try {
        const next = applySegmentCandidate(currentDoc.current, task.target, null, segmentContext?.() ?? { anchors: [], geometry: {} })
        if (!permits(activeTasks().filter(other => other.id !== id), currentDoc.current, next)) {
          setNotice('That deletion would change another reserved region. Resolve that task first.'); return
        }
        forget(id)
        if (sameContent(next, currentDoc.current)) return
        history.boundary(); history.setDoc(next); history.boundary()
      } catch (error) { setNotice((error as Error).message) }
      return
    }
    const ids = task.target.blockIds
    const content = currentDoc.current.content.content!.filter(node => !ids.includes(node.attrs?.id))
    const next = replaceMainContent(currentDoc.current, { ...currentDoc.current.content, content: content.length ? content : [paragraph('')] })
    if (!permits(activeTasks().filter(other => other.id !== id), currentDoc.current, next)) {
      setNotice('That deletion would change another reserved region. Accept or discard its AI task first.'); return
    }
    forget(id); history.boundary(); history.setDoc(next); history.boundary()
  }
  return { tasks, allTasks, loaded, open, setOpen, activeId, openTask, offline: connection.offline, notice: persistence.warning || notice, setNotice, reserve, start, stop, discard, accept, update, abandonAll, runs, deleteObjects, deleteTarget, missingRemote,
    switchExecutor, retryExecutor, executorBusy, agentLink, privateDocument, externalBlocked,
    workspaceReadState, workspaceReadBlocked, setWorkspaceRead, retryWorkspaceRead, refreshWorkspaceRead,
    workspaceReadWorking: (id: string) => !!workspaceReadOperations[id],
    workspaceReadIssue: (id: string) => workspaceReadIssues[id],
    executorWorking: (task: AITask) => !!task.pendingExecutor && preparations.current.has(task.id),
    inactiveReason, syncAcceptance, canSyncAcceptance: (task: AITask) => !!cloud && task.acceptance?.workingCopyId === cloud.workingCopyId,
    cloudWarning: persistence.warning, cloudConflict: persistence.conflict, archives: persistence.archives,
    statusIssue: (id: string) => connection.offline ? { message: 'Offline · AI request retained. Waiting for reconnection to check the result.', paused: false } : statusIssues[id], checkStatus: (id: string) => checkStatusRef.current(id),
    retryCloud: persistence.retry, resolveCloudConflict: (choice: 'local' | 'cloud') => { void persistence.engine.current?.resolve(choice) },
    discardArchive: (id: string) => persistence.engine.current?.discardArchive(id),
    lockedIds: new Set(tasks.flatMap(task => task.target.kind === 'object' ? [task.target.objectId] : task.target.kind === 'segment' ? task.target.objectIds : [])) }
}
