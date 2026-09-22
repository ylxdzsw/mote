import { useEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { DEFAULT_AI_MODEL, paragraph, replaceMainContent, type FloatingObject, type MoteDocument } from '../document/model'
import { initializeDocument } from '../document/initialize'
import { validateDocument } from '../document/validate'
import type { useDocumentHistory } from '../document/history'
import { currentPlacement, overlaps, permits, permitsEditor, reservedObjectContent, reservedText, sameContent, segmentReservationIntact } from './reservations'
import { aiRequest, AIServiceError } from './api'
import { loadTasks, storeTask } from './storage'
import type { Area, AITarget, AITask, RemoteTask } from './types'
import { applySegmentCandidate, makeSegmentTarget, resolveSegmentRange, type SegmentContext } from './segments'
import { copySegment, type SegmentClipboard } from '../document/segment'

const candidateCache = new WeakMap<object, WeakMap<object, Map<string, { context?: SegmentContext; result: MoteDocument }>>>()

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
      if (!target.isNew && (candidate.object.kind ?? 'text') !== (original.kind ?? 'text')) throw new Error('A revision must retain the object kind.')
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

export function useAssistant(history: ReturnType<typeof useDocumentHistory>, writable: boolean, withoutObject: (id: string) => FloatingObject[] | undefined, objectArea: (id: string) => Area, segmentContext?: () => SegmentContext | undefined) {
  const [tasks, setTasks] = useState<AITask[]>([])
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [runs, setRuns] = useState<Record<string, number>>({})
  const state = useRef(tasks), currentDoc = useRef(history.doc!), bypass = useRef(false)
  const mounted = useRef(true)
  const preparations = useRef(new Map<string, symbol>())
  currentDoc.current = history.doc!
  function openTask(id: string) { setActiveId(id); setOpen(true) }
  function save(task: AITask) { void storeTask(task).catch(() => setNotice('AI task recovery could not be saved. Keep this tab open until you accept or discard.')) }
  function update(id: string, patch: Partial<AITask>) {
    if (!mounted.current) return
    state.current = state.current.map(task => {
      if (task.id !== id) return task
      const next = { ...task, ...(patch.candidate ? { preview: true } : {}), ...patch }; save(next); return next
    })
    setTasks(state.current)
  }
  function unrestricted(action: () => void) {
    bypass.current = true
    try { history.boundary(); action(); history.boundary() } finally { bypass.current = false }
  }
  history.guard.current = (before, after) => {
    const allowed = bypass.current || permits(state.current, before, after)
    if (!allowed) setNotice('That change would edit a reserved region. Accept or discard its AI task first.')
    return allowed
  }
  history.guardEditor.current = (id, before, after) => bypass.current || permitsEditor(state.current, id, before, after)
  history.lockedBlocks.current = Object.fromEntries(tasks.flatMap(task => task.target.kind === 'text' || task.target.kind === 'segment' ? task.target.blockIds.map(id => [id, task.id]) : []))

  useEffect(() => {
    mounted.current = true
    let active = true
    if (!writable) { setLoaded(true); return }
    void loadTasks().then(saved => {
      if (!active) return
      const doc = currentDoc.current
      const retained = saved.filter(task => {
        const valid = task.documentId === doc.id && task.expiresAt > Date.now() && (task.target.kind === 'object'
          ? sameContent(reservedObjectContent(task, doc.floating.find(object => object.id === (task.target as Extract<AITarget, { kind: 'object' }>).objectId) ?? {} as never), reservedObjectContent(task, task.original as never))
          : task.target.kind === 'segment' ? segmentReservationIntact(task, doc)
          : sameContent(reservedText(doc.content, task.target.blockIds), reservedText({ type: 'doc', content: task.original as JSONContent[] }, task.target.blockIds)))
        if (!valid) { void storeTask(task.id); if (task.submitted || task.requestSent) void aiRequest(`/tasks/${task.id}`, 'DELETE').catch(() => {}) }
        return valid
      }).map(task => task.status === 'preparing' ? { ...task, status: 'error' as const, error: 'Generation was interrupted before confirmation. Retry or discard.' } : task)
        .sort((a, b) => (a.createdAt ?? a.expiresAt) - (b.createdAt ?? b.expiresAt))
      state.current = retained; setTasks(retained); setActiveId(retained[0]?.id ?? null); setLoaded(true)
    }).catch(() => { if (active) { setNotice('AI task recovery is unavailable. Reload before starting AI tasks.'); setLoaded(true) } })
    return () => { active = false; mounted.current = false }
  }, [writable])

  useEffect(() => {
    if (!writable || !loaded) return
    let active = true, pending = false
    async function poll() {
      if (pending) return
      pending = true
      await Promise.all(state.current.filter(task => task.submitted && ['queued', 'running'].includes(task.status)).map(async task => {
        try {
          const remote = await aiRequest<RemoteTask>(`/tasks/${task.id}`)
          if (!active || !state.current.some(current => current.id === task.id && ['queued', 'running'].includes(current.status))) return
          if (remote.candidate) {
            try { candidateDocument(currentDoc.current, task, remote.candidate, segmentContext?.()) }
            catch (error) { update(task.id, { status: 'error', error: `Invalid candidate: ${(error as Error).message}` }); return }
          }
          update(task.id, { error: undefined, ...remote })
        } catch (error) {
          if (active) {
            if (error instanceof AIServiceError && error.status === 404) missingRemote(task.id)
            else update(task.id, { error: (error as Error).message })
          }
        }
      }))
      pending = false
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1200)
    return () => { active = false; window.clearInterval(timer) }
  }, [loaded, writable])

  function reserve(target: AITarget, snapshot = currentDoc.current) {
    if (!loaded || !writable) return
    if (target.kind === 'text' && !reservedText(snapshot.content, target.blockIds)) { setNotice('Select consecutive paragraphs without crossing a space.'); return }
    if (target.kind === 'segment') {
      const range = resolveSegmentRange(snapshot, target)
      if (!range) { setNotice('The selected segment is no longer available.'); return }
      const fresh = makeSegmentTarget(snapshot, range, target.area)
      if (!sameContent(fresh.blockIds, target.blockIds) || !sameContent(fresh.objectIds, target.objectIds)) { setNotice('The selected segment changed.'); return }
      target = fresh
    }
    const overlapping = state.current.find(task => overlaps(task.target, target, snapshot))
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
      snapshotDocument: structuredClone(snapshot), status: 'draft', progress: '', submitted: false, preview: false, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }
    if (segmentOriginalBlocks) task.segmentOriginalBlocks = segmentOriginalBlocks
    if (segmentOriginalObjects) task.segmentOriginalObjects = segmentOriginalObjects
    state.current = [...state.current, task]; setTasks(state.current); save(task); openTask(task.id); setNotice(''); history.boundary()
    return task
  }
  function missingRemote(id: string) {
    update(id, { status: 'error', remoteMissing: true, progress: '', error: 'This AI session is no longer available. Accept any complete candidate or discard this reservation, then use the toolbar to start again.' })
  }

  async function start(id: string, prompt: string) {
    let task = state.current.find(task => task.id === id)
    if (!task || task.remoteMissing || !prompt.trim() || ['running', 'queued', 'preparing'].includes(task.status)) return
    const run = Symbol()
    preparations.current.set(id, run)
    const preparing = () => preparations.current.get(id) === run && state.current.some(task => task.id === id && task.status === 'preparing')
    update(id, { status: 'preparing', prompt, draftPrompt: '', title: task.title || prompt.trim().split('\n')[0].slice(0, 60), error: undefined, preview: false, progress: 'Preparing full document snapshot…' })
    try {
      let remote: RemoteTask
      if (!task.submitted && (task.status === 'error' || task.requestSent)) {
        try {
          remote = await aiRequest<RemoteTask>(`/tasks/${id}`)
          if (preparing()) update(id, { ...remote, submitted: true, snapshotDocument: undefined })
          return
        } catch (error) {
          if (!(error instanceof AIServiceError) || error.status !== 404) throw error
          if (!preparing()) return
          task = { ...task, requestSent: false }; update(id, { requestSent: false })
        }
      }
      if (task.submitted) remote = await aiRequest(`/tasks/${id}/revise`, 'POST', { prompt })
      else {
        if (!task.requestSent && task.target.kind === 'object') {
          const objectId = task.target.objectId
          const snapshotDocument = structuredClone(currentDoc.current)
          const original = snapshotDocument.floating.find(object => object.id === objectId)!
          const target = { ...task.target, area: objectArea(objectId) }
          task = { ...task, snapshotDocument, original, target }
          update(id, { snapshotDocument, original, target })
        } else if (!task.requestSent && task.target.kind === 'segment') {
          if (!segmentReservationIntact(task, currentDoc.current)) throw new Error('The reserved segment changed. Discard it and start a new request.')
          const range = resolveSegmentRange(currentDoc.current, task.target)
          if (!range) throw new Error('The reserved segment anchor is no longer available.')
          const refreshed = makeSegmentTarget(currentDoc.current, range, task.target.area)
          const context = segmentContext?.() ?? { anchors: [], geometry: {} }
          const snapshotDocument = structuredClone(currentDoc.current)
          const original = copySegment(snapshotDocument, range, context.anchors, context.geometry)
          const segmentOriginalBlocks = structuredClone(snapshotDocument.content.content!.filter(node => refreshed.blockIds.includes(node.attrs?.id)))
          const segmentOriginalObjects = structuredClone(snapshotDocument.floating.filter(object => refreshed.objectIds.includes(object.id)))
          task = { ...task, snapshotDocument, original, target: refreshed, segmentOriginalBlocks, segmentOriginalObjects }
          update(id, { snapshotDocument, original, target: refreshed, segmentOriginalBlocks, segmentOriginalObjects })
        }
        const document = task.snapshotDocument!
        const { exportPng } = await import('../document/png')
        const blob = await exportPng(document)
        const snapshot = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob)
        })
        if (!preparing()) return
        update(id, { requestSent: true })
        remote = await aiRequest('/tasks', 'POST', { id, document, target: task.target, prompt, model: currentDoc.current.aiModel?.trim() || DEFAULT_AI_MODEL, snapshot })
      }
      if (!preparing()) {
        const current = state.current.find(task => task.id === id)
        if (!current) void aiRequest(`/tasks/${id}`, 'DELETE').catch(() => {})
        else if (current.status === 'stopped') void aiRequest(`/tasks/${id}/stop`, 'POST').catch(() => {})
        return
      }
      update(id, { ...remote, submitted: true, snapshotDocument: undefined })
    } catch (error) {
      if (preparing()) {
        if (task.submitted && error instanceof AIServiceError && error.status === 404) missingRemote(id)
        else update(id, { status: 'error', progress: 'Request failed', error: (error as Error).message })
      }
    }
    finally { if (preparations.current.get(id) === run) preparations.current.delete(id) }
  }

  async function stop(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!task) return
    preparations.current.delete(id)
    update(id, { status: 'stopped', progress: 'Stopping…' })
    if (!task.submitted && !task.requestSent) { update(id, { progress: 'Stopped' }); return }
    try {
      const remote = await aiRequest<RemoteTask>(`/tasks/${id}/stop`, 'POST')
      if (state.current.some(task => task.id === id && task.status === 'stopped')) update(id, { ...remote, submitted: true, status: 'stopped' })
    } catch (error) {
      if (state.current.some(task => task.id === id && task.status === 'stopped')) update(id, { error: (error as Error).message, progress: 'Stop was not confirmed. Discard to abandon this result.' })
    }
  }

  function forget(id: string) {
    preparations.current.delete(id)
    const task = state.current.find(task => task.id === id)
    const index = state.current.findIndex(task => task.id === id)
    state.current = state.current.filter(task => task.id !== id); setTasks(state.current)
    setActiveId(current => current === id ? (state.current[index] ?? state.current[index - 1])?.id ?? null : current)
    if (!state.current.length) setOpen(false)
    void storeTask(id).catch(() => setNotice('Could not clear saved task recovery.'))
    if (task?.submitted || task?.requestSent || task?.status === 'preparing') void aiRequest(`/tasks/${id}`, 'DELETE').catch(error => {
      if (!(error instanceof AIServiceError && error.status === 404)) setNotice('The local reservation was released, but server cleanup was not confirmed. Its result will not be applied; server work expires automatically.')
    })
  }
  function discard(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!task) return
    forget(id)
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
    if (!task?.candidate || ['running', 'queued', 'preparing'].includes(task.status)) return
    try {
      if (task.expiresAt <= Date.now()) throw new Error('This task has expired. Discard it and start a new request.')
      const next = candidateDocument(currentDoc.current, task, task.candidate, segmentContext?.())
      if (!permits(state.current.filter(other => other.id !== id), currentDoc.current, next)) throw new Error('This result would affect another reserved region. Resolve that task first.')
      unrestricted(() => history.setDoc(next)); forget(id); setNotice('')
      if (task.target.kind === 'object') {
        const objectId = task.target.objectId
        setRuns(current => ({ ...current, [objectId]: (current[objectId] ?? 0) + 1 }))
      }
    } catch (error) { update(id, { error: (error as Error).message }) }
  }
  function abandonAll() { for (const task of [...state.current]) forget(task.id) }
  function deleteObjects(floating: FloatingObject[]) {
    const removed = state.current.filter(task => task.target.kind === 'object' && !floating.some(object => object.id === (task.target as Extract<AITarget, { kind: 'object' }>).objectId))
    const next = { ...currentDoc.current, floating }
    if (!permits(state.current.filter(task => !removed.includes(task)), currentDoc.current, next)) {
      setNotice('That deletion would change another reserved region. Accept or discard its AI task first.'); return false
    }
    for (const task of removed) forget(task.id)
    history.boundary(); history.setDoc(next); history.boundary()
    return true
  }
  function deleteTarget(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!task) return
    if (task.target.kind === 'object') {
      deleteObjects(withoutObject(task.target.objectId) ?? currentDoc.current.floating.filter(object => object.id !== (task.target as Extract<AITarget, { kind: 'object' }>).objectId))
      return
    }
    if (task.target.kind === 'segment') {
      if (!task.target.blockIds.length && !task.target.objectIds.length) { forget(id); return }
      try {
        const next = applySegmentCandidate(currentDoc.current, task.target, null, segmentContext?.() ?? { anchors: [], geometry: {} })
        if (!permits(state.current.filter(other => other.id !== id), currentDoc.current, next)) {
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
    if (!permits(state.current.filter(other => other.id !== id), currentDoc.current, next)) {
      setNotice('That deletion would change another reserved region. Accept or discard its AI task first.'); return
    }
    forget(id); history.boundary(); history.setDoc(next); history.boundary()
  }
  return { tasks, loaded, open, setOpen, activeId, openTask, notice, setNotice, reserve, start, stop, discard, accept, update, abandonAll, runs, deleteObjects, deleteTarget, missingRemote,
    lockedIds: new Set(tasks.flatMap(task => task.target.kind === 'object' ? [task.target.objectId] : task.target.kind === 'segment' ? task.target.objectIds : [])) }
}
