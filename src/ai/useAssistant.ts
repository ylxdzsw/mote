import { useEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { DEFAULT_AI_MODEL, paragraph, replaceMainContent, type FloatingObject, type MoteDocument } from '../document/model'
import { initializeDocument } from '../document/initialize'
import { validateDocument } from '../document/validate'
import type { useDocumentHistory } from '../document/history'
import { currentPlacement, objectContent, overlaps, permits, permitsEditor, reservedText, sameContent } from './reservations'
import { aiRequest, AIServiceError } from './api'
import { loadTasks, storeTask } from './storage'
import type { AITarget, AITask, RemoteTask } from './types'

export function candidateDocument(doc: MoteDocument, task: AITask, candidate = task.candidate): MoteDocument {
  if (!candidate) throw new Error('This task has no complete candidate.')
  const target = task.target
  let result: MoteDocument
  if (target.kind === 'object') {
    const original = doc.floating.find(object => object.id === target.objectId)
    if (!original || !candidate.object || candidate.content) throw new Error('The candidate must deliver exactly one floating object.')
    if (!target.isNew && (candidate.object.kind ?? 'text') !== (original.kind ?? 'text')) throw new Error('A revision must retain the object kind.')
    result = { ...doc, floating: doc.floating.map(object => object === original ? currentPlacement(candidate.object!, original) : object) }
  } else {
    if (!candidate.content?.length || candidate.object || candidate.content.some(node => node.type !== 'paragraph')) throw new Error('The candidate must deliver paragraphs.')
    const blocks = doc.content.content!, first = blocks.findIndex(node => node.attrs?.id === target.blockIds[0])
    if (first < 0 || !reservedText(doc.content, target.blockIds)) throw new Error('The reserved text is no longer available.')
    const content = candidate.content.map((node, index) => ({ ...node, attrs: { ...node.attrs,
      id: target.blockIds[index] ?? crypto.randomUUID() } }))
    result = replaceMainContent(doc, { ...doc.content, content: [...blocks.slice(0, first), ...content, ...blocks.slice(first + target.blockIds.length)] })
  }
  validateDocument(result)
  return initializeDocument(structuredClone(result))
}

export function useAssistant(history: ReturnType<typeof useDocumentHistory>, writable: boolean, withoutObject: (id: string) => FloatingObject[] | undefined) {
  const [tasks, setTasks] = useState<AITask[]>([])
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<Record<string, number>>({})
  const state = useRef(tasks), currentDoc = useRef(history.doc!), bypass = useRef(false)
  const mounted = useRef(true)
  currentDoc.current = history.doc!
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
  history.lockedBlocks.current = Object.fromEntries(tasks.flatMap(task => task.target.kind === 'text' ? task.target.blockIds.map(id => [id, task.id]) : []))

  useEffect(() => {
    mounted.current = true
    let active = true
    if (!writable) { setLoaded(true); return }
    void loadTasks().then(saved => {
      if (!active) return
      const doc = currentDoc.current
      const retained = saved.filter(task => {
        const valid = task.documentId === doc.id && task.expiresAt > Date.now() && (task.target.kind === 'object'
          ? sameContent(objectContent(doc.floating.find(object => object.id === (task.target as Extract<AITarget, { kind: 'object' }>).objectId) ?? {} as never), objectContent(task.original as never))
          : sameContent(reservedText(doc.content, task.target.blockIds), reservedText({ type: 'doc', content: task.original as JSONContent[] }, task.target.blockIds)))
        if (!valid) { void storeTask(task.id); if (task.submitted) void aiRequest(`/tasks/${task.id}`, 'DELETE').catch(() => {}) }
        return valid
      }).map(task => task.status === 'preparing' ? { ...task, status: 'error' as const, error: 'Generation was interrupted before confirmation. Retry or discard.' } : task)
      state.current = retained; setTasks(retained); setLoaded(true)
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
            try { candidateDocument(currentDoc.current, task, remote.candidate) }
            catch (error) { update(task.id, { status: 'error', error: `Invalid candidate: ${(error as Error).message}` }); return }
          }
          update(task.id, { error: undefined, ...remote })
        } catch (error) {
          if (active) update(task.id, { ...(error instanceof AIServiceError && error.status === 404 ? { status: 'error' as const } : {}), error: (error as Error).message })
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
    if (state.current.some(task => overlaps(task.target, target))) { setNotice('This region is already reserved by an AI task.'); setOpen(true); return }
    const task: AITask = { id: crypto.randomUUID(), documentId: snapshot.id, target, prompt: '',
      original: structuredClone(target.kind === 'object' ? snapshot.floating.find(object => object.id === target.objectId)! : snapshot.content.content!.filter(node => target.blockIds.includes(node.attrs?.id))),
      snapshotDocument: structuredClone(snapshot), status: 'draft', progress: '', submitted: false, preview: false, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }
    state.current = [...state.current, task]; setTasks(state.current); save(task); setOpen(true); setNotice(''); history.boundary()
    return task
  }

  async function start(id: string, prompt: string) {
    const task = state.current.find(task => task.id === id)
    if (!task || !prompt.trim() || ['running', 'queued', 'preparing'].includes(task.status)) return
    update(id, { status: 'preparing', prompt, error: undefined, preview: false, progress: 'Preparing full document snapshot…' })
    try {
      let remote: RemoteTask
      if (!task.submitted && task.status === 'error') {
        try {
          remote = await aiRequest<RemoteTask>(`/tasks/${id}`)
          update(id, { ...remote, submitted: true, snapshotDocument: undefined }); return
        } catch (error) { if (!(error instanceof AIServiceError) || error.status !== 404) throw error }
      }
      if (task.submitted) remote = await aiRequest(`/tasks/${id}/revise`, 'POST', { prompt })
      else {
        const document = task.snapshotDocument!
        const { exportPng } = await import('../document/png')
        const blob = await exportPng(document)
        const snapshot = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob)
        })
        if (!state.current.some(current => current.id === id && current.status === 'preparing')) return
        remote = await aiRequest('/tasks', 'POST', { id, document, target: task.target, prompt, model: currentDoc.current.aiModel?.trim() || DEFAULT_AI_MODEL, snapshot })
      }
      if (!state.current.some(current => current.id === id && current.status === 'preparing')) { void aiRequest(`/tasks/${id}`, 'DELETE').catch(() => {}); return }
      update(id, { ...remote, submitted: true, snapshotDocument: undefined })
    } catch (error) { update(id, { status: 'error', progress: 'Request failed', error: (error as Error).message }) }
  }

  async function stop(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!task) return
    update(id, { status: 'stopped', progress: 'Stopping…' })
    if (!task.submitted) { update(id, { progress: 'Stopped' }); return }
    try { const remote = await aiRequest<RemoteTask>(`/tasks/${id}/stop`, 'POST'); update(id, { ...remote, status: 'stopped' }) }
    catch (error) { update(id, { error: (error as Error).message, progress: 'Stop was not confirmed. Discard to abandon this result.' }) }
  }

  function forget(id: string) {
    const task = state.current.find(task => task.id === id)
    state.current = state.current.filter(task => task.id !== id); setTasks(state.current)
    void storeTask(id).catch(() => setNotice('Could not clear saved task recovery.'))
    if (task?.submitted || task?.status === 'preparing') void aiRequest(`/tasks/${id}`, 'DELETE').catch(() => {})
  }
  function discard(id: string) {
    const task = state.current.find(task => task.id === id)
    if (!task) return
    forget(id)
    const target = task.target
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
      const next = candidateDocument(currentDoc.current, task)
      if (!permits(state.current.filter(other => other.id !== id), currentDoc.current, next)) throw new Error('This result would affect another reserved region. Resolve that task first.')
      unrestricted(() => history.setDoc(next)); forget(id); setNotice('')
      if (task.target.kind === 'object') {
        const objectId = task.target.objectId
        setRuns(current => ({ ...current, [objectId]: (current[objectId] ?? 0) + 1 }))
      }
    } catch (error) { update(id, { error: (error as Error).message }) }
  }
  function abandonAll() { for (const task of [...state.current]) forget(task.id) }
  return { tasks, loaded, open, setOpen, notice, setNotice, reserve, start, stop, discard, accept, update, abandonAll, runs,
    lockedIds: new Set(tasks.flatMap(task => task.target.kind === 'object' ? [task.target.objectId] : [])) }
}
