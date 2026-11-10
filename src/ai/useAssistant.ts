import { DOCUMENT_VERSIONS, validateObject, validateContent } from '../../shared/document.mjs'
import { useEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { paragraph, replaceMainContent, type FloatingObject, type MoteDocument } from '../document/model'
import { initializeDocument } from '../document/initialize'
import { reconcileObjectDeletions } from '../document/flow'
import { validateDocument } from '../document/validate'
import type { useDocumentHistory } from '../document/history'
import { compatibleTasks, currentPlacement, inactiveTaskReason, overlaps, permits, permitsEditor, reservedText, sameContent } from './reservations'
import { aiRequest, AIServiceError } from './api'
import { candidateVersions, reconcileCandidateState, selectedCandidateVersion } from './candidates'
import { connectionSnapshot, retryConnection, useConnection } from '../cloud/connection'
import { subscribeDocumentUpdates } from '../cloud/documentEvents'
import { useAssistantState } from './useAssistantState'
import type { Area, AITarget, AITask, AssistantCloud, RemoteTask, Reservation } from './types'
import { applySegmentCandidate, makeSegmentTarget, resolveSegmentRange, type SegmentContext } from './segments'
import { copySegment, type SegmentClipboard } from '../document/segment'

const candidateCache = new WeakMap<object, WeakMap<object, Map<string, { context?: SegmentContext; result: MoteDocument }>>>()

function previewFailure(error: unknown) {
  return { preview: false, error: `Preview unavailable. Your original content is unchanged and the candidate is retained. Try Preview again or download the task JSON for recovery. ${error instanceof Error ? error.message : String(error)}` }
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

export function candidateDocument(doc: MoteDocument, task: AITask, candidate = selectedCandidateVersion(task)?.candidate, context?: SegmentContext): MoteDocument {
  const documentVersion = doc.version
  if (task.protocol !== 'mote-agent-v5' || !DOCUMENT_VERSIONS.includes(documentVersion ?? 0)) throw new Error('Unsupported task version. The candidate is retained for recovery.')
  if (!candidate) throw new Error('This task has no complete candidate.')
  const incompatible = inactiveTaskReason(task, doc)
  if (incompatible) throw new Error(incompatible)
  return memoizedCandidate(doc, candidate, `${task.id}:${documentVersion}`, task.target.kind === 'segment' ? context : undefined, () => {
    const target = task.target
    let result: MoteDocument
    if (target.kind === 'object') {
      const original = doc.objects.find(object => object.id === target.objectId)
      if (!original || !candidate.object || candidate.content || candidate.segment) throw new Error('The candidate must deliver exactly one floating object.')
      validateObject(candidate.object, { version: documentVersion })
      if (candidate.object.id !== target.objectId) throw new Error('A revision must retain the target object ID.')
      if (!target.isNew && original.kind !== 'drawing' && candidate.object.kind !== original.kind) throw new Error('A revision must retain the object kind.')
      result = { ...doc, objects: doc.objects.map(object => object === original ? currentPlacement(candidate.object!, original) : object) }
    } else if (target.kind === 'text') {
      if (!candidate.content?.length || candidate.object || candidate.segment || candidate.content.some(node => node.type !== 'paragraph')) throw new Error('The candidate must deliver paragraphs.')
      validateContent({ type: 'doc', content: candidate.content })
      const blocks = doc.content.content!, first = blocks.findIndex(node => node.attrs?.id === target.blockIds[0])
      if (first < 0 || !reservedText(doc.content, target.blockIds)) throw new Error('The reserved text is no longer available.')
      const content = candidate.content.map((node, index) => ({ ...node, attrs: { ...node.attrs,
        id: target.blockIds[index] ?? crypto.randomUUID() } }))
      result = replaceMainContent(doc, { ...doc.content, content: [...blocks.slice(0, first), ...content, ...blocks.slice(first + target.blockIds.length)] })
    } else {
      if (!candidate.segment || candidate.object || candidate.content) throw new Error('The candidate must deliver exactly one V1 segment.')
      if (!context) throw new Error('Segment geometry is not available for this preview.')
      candidate.segment.objects.forEach(object => validateObject(object, { version: documentVersion }))
      result = applySegmentCandidate(doc, target, candidate.segment, context)
    }
    validateDocument(result)
    return initializeDocument(structuredClone(result))
  })
}

export function useAssistant(history: ReturnType<typeof useDocumentHistory>, writable: boolean, withoutObject: (id: string) => FloatingObject[] | undefined, objectArea: (id: string) => Area, segmentContext?: () => SegmentContext | undefined, cloud?: AssistantCloud) {
  const connection = useConnection()
  const persistence = useAssistantState(cloud, writable)
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [runs, setRuns] = useState<Record<string, number>>({})
  const [access, setAccess] = useState<Record<string, RemoteTask>>({})
  const [statusIssues, setStatusIssues] = useState<Record<string, string>>({})
  const preparing = useRef(new Map<string, symbol>())
  const mounted = useRef(true)
  const current = useRef({ history, cloud, persistence })
  current.current = { history, cloud, persistence }
  const update = (id: string, patch: Partial<AITask>) => current.current.persistence.update(id, patch)
  const asTask = (reservation: Reservation): AITask => ({ protocol: 'mote-agent-v5', status: 'draft', progress: '', prompt: '',
    submitted: false, preview: false, ...current.current.persistence.views[reservation.id], ...reservation })
  const allTasks = history.reservations.map(asTask)
  const activeTasks = (doc = current.current.history.doc!) => compatibleTasks(current.current.history.currentReservations().map(asTask), doc)
  const tasks = compatibleTasks(allTasks, history.doc!)
  const getTask = (id: string) => {
    const reservation = current.current.history.currentReservations().find(item => item.id === id)
    return reservation && asTask(reservation)
  }
  const inactiveReason = (task: AITask) => inactiveTaskReason(task, current.current.history.doc!)
  const openTask = (id: string) => { setActiveId(id); setOpen(true); history.boundary() }
  const followSelection = () => setActiveId(null)
  const warn = (allowed: boolean) => {
    if (!allowed) setNotice('That change would edit another reserved region. Accept or discard its task first.')
    return allowed
  }
  history.guard.current = (before, after) => warn(permits(activeTasks(before), before, after))
  history.guardState.current = (before, beforeReservations, after, afterReservations) => {
    // History may restore/release a reservation, but cannot edit a different
    // reservation that remains active on both sides of the transaction.
    const retained = beforeReservations.filter(task => !task.released && afterReservations.some(next => next.id === task.id && !next.released))
    return warn(permits(compatibleTasks(retained.map(asTask), before), before, after))
  }
  history.guardEditor.current = (id, before, after) => permitsEditor(activeTasks(), id, before, after)
  history.lockedBlocks.current = Object.fromEntries(tasks.flatMap(task => task.target.kind === 'text' || task.target.kind === 'segment' ? task.target.blockIds.map(id => [id, task.id]) : []))
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; preparing.current.clear() } }, [])

  function receive(remote: RemoteTask) {
    const task = getTask(remote.id)
    if (!task || remote.protocol !== 'mote-agent-v5') return
    setAccess(value => ({ ...value, [remote.id]: remote }))
    if ((remote.versions?.length ?? 0) < (task.versions?.length ?? 0)) return
    update(task.id, { status: remote.status, progress: remote.progress, error: remote.error,
      ...reconcileCandidateState(task, remote) })
    setStatusIssues(value => ({ ...value, [task.id]: '' }))
  }
  const fetchStatus = useRef<(id?: string) => void>(() => {})
  const ids = allTasks.map(task => task.id).join(',')
  useEffect(() => {
    if (!persistence.loaded || !cloud || cloud.draft || connection.offline) return
    let active = true, fetching = false
    const wanted = new Set<string>()
    async function drain() {
      if (fetching) return
      fetching = true
      try {
        while (active && wanted.size) {
          const id = wanted.values().next().value!
          wanted.delete(id)
          try {
            const remote = await aiRequest<RemoteTask>(`/tasks/${id}`)
            if (active && !preparing.current.has(id)) receive(remote)
          } catch (error) {
            if (!active || error instanceof AIServiceError && error.status === 404) continue
            setStatusIssues(value => ({ ...value, [id]: (error as Error).message }))
          }
        }
      } finally { fetching = false }
    }
    function refresh(id?: string) {
      for (const task of current.current.history.currentReservations()) if (!id || task.id === id) wanted.add(task.id)
      void drain()
    }
    fetchStatus.current = refresh
    const unsubscribe = subscribeDocumentUpdates(cloud.documentId, event => {
      if (event.kind === 'ready' || event.kind === 'document' || event.kind === 'privacy') refresh()
      else if (event.kind === 'task') refresh(event.taskId)
    })
    refresh()
    return () => { active = false; unsubscribe(); fetchStatus.current = () => {} }
  }, [persistence.loaded, cloud?.documentId, cloud?.workingCopyId, cloud?.revision, cloud?.draft, connection.offline, connection.revision, ids])

  function reserve(target: AITarget, snapshot = current.current.history.doc!) {
    if (!persistence.loaded || !writable || !cloud || cloud.documentId !== snapshot.id) return
    if (target.kind === 'text' && !reservedText(snapshot.content, target.blockIds)) { setNotice('Select consecutive paragraphs without crossing a space or Flow object.'); return }
    if (target.kind === 'segment') {
      const range = resolveSegmentRange(snapshot, target)
      if (!range) { setNotice('The selected section is no longer available.'); return }
      const fresh = makeSegmentTarget(snapshot, range, target.area)
      if (!sameContent(fresh.blockIds, target.blockIds) || !sameContent(fresh.objectIds, target.objectIds)) { setNotice('The selected section changed.'); return }
      target = fresh
    }
    const overlapping = activeTasks(snapshot).find(task => overlaps(task.target, target, snapshot))
    if (overlapping) { openTask(overlapping.id); return }
    let original: FloatingObject | JSONContent[] | SegmentClipboard
    let segmentOriginalBlocks: JSONContent[] | undefined, segmentOriginalObjects: FloatingObject[] | undefined
    if (target.kind === 'object') {
      const objectId = target.objectId
      const object = snapshot.objects.find(object => object.id === objectId)
      if (!object) return
      original = structuredClone(object)
      target = { ...target, area: objectArea(object.id).width ? objectArea(object.id) : target.area }
    } else if (target.kind === 'text') {
      const { blockIds } = target
      original = structuredClone(snapshot.content.content!.filter(node => blockIds.includes(node.attrs?.id)))
    } else {
      const { blockIds, objectIds } = target
      const context = segmentContext?.() ?? { anchors: [], geometry: {} }
      original = copySegment(snapshot, target.range, context.anchors, context.geometry, true)
      segmentOriginalBlocks = structuredClone(snapshot.content.content!.filter(node => blockIds.includes(node.attrs?.id)))
      segmentOriginalObjects = structuredClone(snapshot.objects.filter(object => objectIds.includes(object.id)))
    }
    const reservation: Reservation = { id: crypto.randomUUID(), documentId: snapshot.id, target, original,
      documentVersion: snapshot.version, createdAt: Date.now(), workspaceRead: false,
      ...(segmentOriginalBlocks && { segmentOriginalBlocks }), ...(segmentOriginalObjects && { segmentOriginalObjects }) }
    history.setState(snapshot, [...history.currentReservations(), reservation])
    openTask(reservation.id); setNotice('')
    return asTask(reservation)
  }
  function setProperties(id: string, patch: Pick<Reservation, 'workspaceRead'> | Pick<Reservation, 'expiresAt'>) {
    const task = getTask(id)
    if (!writable || !task || task.released) return
    history.setReservations(history.currentReservations().map(item => item.id === id ? { ...item, ...patch } : item))
  }
  const release = (ids: string[]) => history.currentReservations().map(task => ids.includes(task.id) ? { ...task, released: true } : task)
  function discard(id: string) {
    if (!writable || !getTask(id) || getTask(id)!.released) return
    history.setState(history.doc!, release([id]))
    update(id, { preview: false }); setActiveId(null)
  }
  function accept(id: string) {
    const task = getTask(id), selected = task && selectedCandidateVersion(task)
    if (!writable || !task || !selected || inactiveReason(task)) return
    try {
      const document = history.doc!
      const next = candidateDocument(document, task, selected.candidate, segmentContext?.())
      if (!permits(activeTasks().filter(other => other.id !== id), document, next)) throw new Error('This proposal would change another reserved region.')
      history.setState(next, release([id]))
      update(id, { preview: false, error: undefined, candidateNotice: undefined })
      setActiveId(null)
      if (task.target.kind === 'object') {
        const objectId = task.target.objectId
        setRuns(value => ({ ...value, [objectId]: (value[objectId] ?? 0) + 1 }))
      }
    } catch (error) { update(id, { error: (error as Error).message, preview: false }) }
  }
  function selectVersion(id: string, selectedVersion: string) {
    const task = getTask(id)
    if (!task || !candidateVersions(task).some(version => version.id === selectedVersion)) return
    update(id, { selectedVersion, candidateNotice: undefined, preview: !task.released, error: undefined })
  }
  async function start(id: string, prompt: string) {
    const task = getTask(id), connection = current.current.cloud
    if (!writable || !connection || !task || task.released || preparing.current.has(id) || !task.pendingRun && !prompt.trim()) return
    const attempt = Symbol(); preparing.current.set(id, attempt)
    const valid = () => mounted.current && preparing.current.get(id) === attempt && !getTask(id)?.released
    const operation = task.pendingRun ?? { operationId: crypto.randomUUID(), prompt,
      ...(history.doc?.authoring?.aiModel?.trim() ? { model: history.doc.authoring.aiModel.trim() } : {}),
      ...(selectedCandidateVersion(task) ? { selectedVersion: selectedCandidateVersion(task)!.id } : {}) }
    update(id, { pendingRun: operation, status: 'preparing', progress: 'Publishing task…', error: undefined })
    connection.earlySync()
    try {
      await persistence.flushLocal()
      // Publishing a reservation is ordinary sync, not a generation-context fence.
      const saved = await connection.sync()
      if (!valid()) return
      if (!saved || !saved.reservations?.some(item => item.id === id && !item.released)) throw new Error('The task is not yet saved to the cloud. Resolve document sync, then retry the request.')
      const remote = await aiRequest<RemoteTask>(`/tasks/${id}/revise`, 'POST', operation)
      if (!mounted.current || preparing.current.get(id) !== attempt) return
      update(id, { pendingRun: undefined, prompt: operation.prompt, submitted: true,
        ...(getTask(id)?.draftPrompt === operation.prompt ? { draftPrompt: '' } : {}) })
      receive(remote)
    } catch (error) {
      if (valid()) update(id, { status: 'error', progress: '', error: (error as Error).message,
        ...(error instanceof AIServiceError && [400, 422].includes(error.status) ? { pendingRun: undefined } : {}) })
    } finally {
      if (preparing.current.get(id) === attempt) preparing.current.delete(id)
      if (mounted.current) fetchStatus.current(id)
    }
  }
  async function stop(id: string) {
    preparing.current.delete(id)
    try {
      const remote = await aiRequest<RemoteTask>(`/tasks/${id}/stop`, 'POST')
      if (mounted.current) { update(id, { pendingRun: undefined }); receive(remote) }
    } catch (error) { if (mounted.current) update(id, { error: (error as Error).message }) }
  }
  function deleteObjects(objects: FloatingObject[]) {
    const removed = activeTasks().filter(task => task.target.kind === 'object' && !objects.some(object => object.id === (task.target as Extract<AITarget, { kind: 'object' }>).objectId))
    const next = reconcileObjectDeletions(history.doc!, objects, segmentContext?.())
    if (!warn(permits(activeTasks().filter(task => !removed.includes(task)), history.doc!, next))) return false
    history.setState(next, release(removed.map(task => task.id)))
    return true
  }
  function deleteTarget(id: string) {
    const task = getTask(id)
    if (!writable || !task || inactiveReason(task)) return
    if (task.target.kind === 'object') {
      deleteObjects(withoutObject(task.target.objectId) ?? history.doc!.objects.filter(object => object.id !== (task.target as Extract<AITarget, { kind: 'object' }>).objectId))
      return
    }
    try {
      let next: MoteDocument
      if (task.target.kind === 'segment') next = applySegmentCandidate(history.doc!, task.target, null, segmentContext?.() ?? { anchors: [], geometry: {} })
      else {
        const ids = task.target.blockIds, content = history.doc!.content.content!.filter(node => !ids.includes(node.attrs?.id))
        next = replaceMainContent(history.doc!, { ...history.doc!.content, content: content.length ? content : [paragraph('')] })
      }
      if (!warn(permits(activeTasks().filter(other => other.id !== id), history.doc!, next))) return
      history.setState(next, release([id])); setActiveId(null)
    } catch (error) { setNotice((error as Error).message) }
  }
  function checkStatus(id: string) {
    if (connectionSnapshot().offline) { void retryConnection(); return }
    fetchStatus.current(id)
  }
  return { tasks, allTasks, loaded: persistence.loaded, open, setOpen, activeId, openTask, followSelection,
    offline: connection.offline, notice: persistence.warning || notice, setNotice, reserve, start, stop, discard, accept, selectVersion, update,
    runs, deleteObjects, deleteTarget, inactiveReason, privateDocument: cloud?.privateDocument ?? false,
    externalBlocked: cloud?.externalBlocked ?? false,
    agentLink: (task: AITask) => !cloud?.externalBlocked && !task.released && access[task.id]?.externalPath
      ? new URL(access[task.id].externalPath!, window.location.origin).href : undefined,
    setWorkspaceRead: (id: string, enabled: boolean) => setProperties(id, { workspaceRead: enabled }),
    setExpiration: (id: string, expiresAt?: number) => setProperties(id, { expiresAt }),
    permissionPending: (task: AITask) => !access[task.id] || access[task.id].workspaceRead !== task.workspaceRead || access[task.id].expiresAt !== task.expiresAt,
    previewFailed: (id: string, error: unknown) => update(id, previewFailure(error)),
    missingRemote: (id: string) => setStatusIssues(value => ({ ...value, [id]: 'Execution details are unavailable. Retained proposals can still be reviewed.' })),
    statusIssue: (id: string) => statusIssues[id], checkStatus,
    flushLocal: persistence.flushLocal, cloudWarning: persistence.warning, retryCloud: persistence.retry,
    archives: persistence.archives, discardArchive: persistence.discardArchive,
    lockedIds: new Set(tasks.flatMap(task => task.target.kind === 'object' ? [task.target.objectId] : task.target.kind === 'segment' ? task.target.objectIds : [])) }
}
