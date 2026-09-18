import { createContext, useContext, useRef, useState } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import type { MoteDocument } from './model'

type SelectionJSON = ReturnType<Editor['state']['selection']['toJSON']>
interface Snapshot { doc: MoteDocument; selections: Record<string, SelectionJSON> }
interface EditOptions { group?: string; composition?: number; normalize?: boolean; editorId?: string; before?: SelectionJSON }
type Update = MoteDocument | null | ((doc: MoteDocument | null) => MoteDocument | null)

export function useDocumentHistory(initial: MoteDocument) {
  const guard = useRef<(before: MoteDocument, after: MoteDocument) => boolean>(() => true)
  const guardEditor = useRef<(id: string, before: JSONContent, after: JSONContent) => boolean>(() => true)
  const lockedBlocks = useRef<Record<string, string>>({})
  const [doc, render] = useState<MoteDocument | null>(initial)
  const [revision, setRevision] = useState(0)
  const state = useRef({ doc, past: [] as Snapshot[], future: [] as Snapshot[],
    editors: new Map<string, Editor>(), restored: {} as Snapshot['selections'],
    options: {} as EditOptions, control: '', group: '', time: 0 })
  const s = state.current

  function selections() {
    return Object.fromEntries([...s.editors].map(([id, editor]) => [id, editor.state.selection.toJSON()]))
  }
  function boundary() { s.group = ''; s.control = '' }
  function setDoc(update: Update) {
    const next = typeof update === 'function' ? update(s.doc) : update
    if (!next || next === s.doc) return
    if (s.doc && !guard.current(s.doc, next)) return
    if (s.doc && next.id === s.doc.id && next.content === s.doc.content && next.floating === s.doc.floating
      && next.width === s.doc.width && next.language === s.doc.language && next.aiModel === s.doc.aiModel && JSON.stringify(next.margins) === JSON.stringify(s.doc.margins)
      && JSON.stringify(next.theme) === JSON.stringify(s.doc.theme)) {
      s.doc = next; render(next)
      return
    }
    if (!s.doc || next.id !== s.doc.id) {
      s.past = []; s.future = []; s.restored = {}; boundary()
    } else if (!s.options.normalize) {
      const composing = s.options.composition !== undefined
      const group = composing ? `composition:${s.options.editorId}:${s.options.composition}` : s.options.group ?? s.control
      const now = Date.now()
      if (!group || group !== s.group || (!s.control && !composing && now - s.time > 750)) {
        const before = selections()
        if (s.options.editorId && s.options.before) before[s.options.editorId] = s.options.before
        s.past.push({ doc: s.doc, selections: before })
        if (s.past.length > 100) s.past.shift()
      }
      s.future = []; s.group = group; s.time = now
    }
    s.doc = next
    render(next)
  }
  function travel(redo = false) {
    if ([...s.editors.values()].some(editor => editor.view.composing)) return
    const from = redo ? s.future : s.past
    const to = redo ? s.past : s.future
    const snapshot = from.at(-1)
    if (!snapshot || !s.doc) return
    if (!guard.current(s.doc, snapshot.doc)) return
    from.pop()
    to.push({ doc: s.doc, selections: selections() })
    boundary()
    s.restored = snapshot.selections
    s.doc = snapshot.doc
    render(snapshot.doc)
    setRevision(value => value + 1)
  }
  function edit(options: EditOptions, action: () => void) {
    s.options = options
    try { action() } finally { s.options = {} }
  }
  return { doc, setDoc, revision, guard, guardEditor, lockedBlocks, canUndo: !!s.past.length, canRedo: !!s.future.length,
    undo: () => travel(), redo: () => travel(true), boundary, edit,
    begin: (key: string) => { if (s.control !== key) { boundary(); s.control = key } },
    register: (id: string, editor: Editor) => { s.editors.set(id, editor); return () => { s.editors.delete(id) } },
    restoredSelection: (id: string) => s.restored[id],
  }
}

export const HistoryContext = createContext<ReturnType<typeof useDocumentHistory> | null>(null)
export function useHistory() { return useContext(HistoryContext)! }
