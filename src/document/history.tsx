import { createContext, useContext, useRef, useState } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import type { MoteDocument } from './model'
import type { Reservation } from '../ai/types'

type SelectionJSON = ReturnType<Editor['state']['selection']['toJSON']>
interface HistoryEditor { selection: () => SelectionJSON; composing: () => boolean }
interface Snapshot { doc: MoteDocument; reservations: Reservation[]; selections: Record<string, SelectionJSON> }
interface EditOptions { group?: string; composition?: number; normalize?: boolean; editorId?: string; before?: SelectionJSON }
type Update = MoteDocument | null | ((doc: MoteDocument | null) => MoteDocument | null)

export function useDocumentHistory(initial: MoteDocument, initialReservations: Reservation[] = []) {
  const guard = useRef<(before: MoteDocument, after: MoteDocument) => boolean>(() => true)
  const guardState = useRef<(before: MoteDocument, beforeReservations: Reservation[], after: MoteDocument, afterReservations: Reservation[]) => boolean>(() => true)
  const guardEditor = useRef<(id: string, before: JSONContent, after: JSONContent) => boolean>(() => true)
  const lockedBlocks = useRef<Record<string, string>>({})
  const [{ doc, reservations }, render] = useState({ doc: initial, reservations: initialReservations })
  const [revision, setRevision] = useState(0)
  const state = useRef({ doc, reservations, past: [] as Snapshot[], future: [] as Snapshot[],
    editors: new Map<string, HistoryEditor>(), restored: {} as Snapshot['selections'],
    options: {} as EditOptions, control: '', group: '', time: 0 })
  const s = state.current

  function selections() {
    return Object.fromEntries([...s.editors].map(([id, editor]) => [id, editor.selection()]))
  }
  function boundary() { s.group = ''; s.control = '' }
  function setDoc(update: Update) {
    const next = typeof update === 'function' ? update(s.doc) : update
    if (next) commit(next, s.reservations)
  }
  function commit(next: MoteDocument, nextReservations: Reservation[], explicit = false) {
    if (next === s.doc && nextReservations === s.reservations) return
    if (!guardState.current(s.doc, s.reservations, next, nextReservations)) return
    // Explicit assistant edits have already checked their target scope. They may
    // replace reserved content; guardState still protects other reservations.
    if (!explicit && !guard.current(s.doc, next)) return
    if (!explicit && next.id === s.doc.id && next.content === s.doc.content && next.objects === s.doc.objects
      && next.version === s.doc.version && next.page.slideHeight === s.doc.page.slideHeight
      && next.page.width === s.doc.page.width && next.language === s.doc.language && next.authoring?.aiModel === s.doc.authoring?.aiModel && next.authoring?.notes === s.doc.authoring?.notes && JSON.stringify(next.page.margins) === JSON.stringify(s.doc.page.margins)
      && JSON.stringify(next.theme) === JSON.stringify(s.doc.theme)) {
      s.doc = next; render({ doc: next, reservations: s.reservations })
      return
    }
    if (!s.doc || next.id !== s.doc.id) {
      s.past = []; s.future = []; s.restored = {}; boundary()
    } else if (explicit || !s.options.normalize) {
      if (explicit) boundary()
      const composing = s.options.composition !== undefined
      const group = explicit ? '' : composing ? `composition:${s.options.editorId}:${s.options.composition}` : s.options.group ?? s.control
      const now = Date.now()
      if (!group || group !== s.group || (!s.control && !composing && now - s.time > 750)) {
        const before = selections()
        if (s.options.editorId && s.options.before) before[s.options.editorId] = s.options.before
        s.past.push({ doc: s.doc, reservations: s.reservations, selections: before })
        if (s.past.length > 100) s.past.shift()
      }
      s.future = []; s.group = group; s.time = now
    }
    s.doc = next
    s.reservations = nextReservations
    render({ doc: next, reservations: nextReservations })
  }
  function setState(document: MoteDocument, reservations: Reservation[]) { commit(document, reservations, true) }
  function travel(redo = false) {
    if ([...s.editors.values()].some(editor => editor.composing())) return
    const from = redo ? s.future : s.past
    const to = redo ? s.past : s.future
    const snapshot = from.at(-1)
    if (!snapshot || !s.doc) return
    if (!guardState.current(s.doc, s.reservations, snapshot.doc, snapshot.reservations)) return
    if (s.reservations === snapshot.reservations && !guard.current(s.doc, snapshot.doc)) return
    from.pop()
    to.push({ doc: s.doc, reservations: s.reservations, selections: selections() })
    boundary()
    s.restored = snapshot.selections
    s.doc = snapshot.doc
    s.reservations = snapshot.reservations
    render({ doc: snapshot.doc, reservations: snapshot.reservations })
    setRevision(value => value + 1)
  }
  function edit(options: EditOptions, action: () => void) {
    s.options = options
    try { action() } finally { s.options = {} }
  }
  return { doc, reservations, currentReservations: () => s.reservations,
    setDoc, setState, setReservations: (reservations: Reservation[]) => setState(s.doc, reservations),
    revision, guard, guardState, guardEditor, lockedBlocks, canUndo: !!s.past.length, canRedo: !!s.future.length,
    undo: () => travel(), redo: () => travel(true), boundary, edit,
    begin: (key: string) => { if (s.control !== key) { boundary(); s.control = key } },
    register: (id: string, editor: Editor | HistoryEditor) => {
      s.editors.set(id, 'state' in editor ? { selection: () => editor.state.selection.toJSON(), composing: () => editor.view.composing } : editor)
      return () => { s.editors.delete(id) }
    },
    restoredSelection: (id: string) => s.restored[id],
  }
}

export const HistoryContext = createContext<ReturnType<typeof useDocumentHistory> | null>(null)
export function useHistory() { return useContext(HistoryContext)! }
