import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { Selection, TextSelection } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { paletteSwatches } from '../theme/palette'
import { extensions } from './extensions'
import './label.css'
import { useHistory } from '../document/history'
import { spaceLayoutKey, type SpaceMerge, type SpaceShift } from './spaces'
import { reservationExtension } from './reservations'

interface Props {
  content: JSONContent
  editable: boolean
  spatial?: boolean
  table?: boolean
  singleLabel?: boolean
  onFinish?: () => void
  label: string
  historyId: string
  onChange: (content: JSONContent, merges?: SpaceMerge[], shift?: SpaceShift) => void
  onActive: (editor: Editor) => void
  onReady?: (editor: Editor) => void
}

export function TextEditor({ content, editable, spatial = false, table = false, singleLabel = false, onFinish, label, historyId, onChange, onActive, onReady }: Props) {
  const history = useHistory()
  const palette = useRef(new Set<string>())
  palette.current = new Set(paletteSwatches(history.doc!.theme).map(swatch => swatch.value))
  const before = useRef<ReturnType<Selection['toJSON']>>(null)
  const syncing = useRef(false)
  const syncedRevision = useRef(-1)
  const schema = useMemo(() => [...extensions(spatial, table, singleLabel, onFinish), reservationExtension(history, historyId)], [spatial, table, singleLabel, onFinish, historyId])
  const editor = useEditor({
    extensions: schema,
    content,
    editable,
    onCreate: ({ editor }) => {
      if (spatial) editor.view.dispatch(editor.state.tr.setMeta('normalizeSpaces', true).setMeta('addToHistory', false))
    },
    editorProps: {
      transformPasted: slice => {
        const clean = (node: ProseMirrorNode): ProseMirrorNode => {
          const children: ProseMirrorNode[] = []
          node.forEach(child => children.push(clean(child)))
          return (node.isLeaf ? node : node.copy(Fragment.from(children)))
            .mark(node.marks.filter(mark => mark.type.name !== 'color' || palette.current.has(mark.attrs.color)))
        }
        const nodes: ProseMirrorNode[] = []
        slice.content.forEach(node => nodes.push(clean(node)))
        return new Slice(Fragment.from(nodes), slice.openStart, slice.openEnd)
      },
      attributes: { 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' },
      handleDOMEvents: { pointerdown: (_view, event) => {
        const space = (event.target as HTMLElement).closest('[data-spacer]')
        if (!editable || event.button !== 0 || !space) return false
        event.preventDefault()
        return true
      }, beforeinput: (view, event) => {
        if (!editable || event.isComposing || view.composing || !['historyUndo', 'historyRedo'].includes(event.inputType)) return false
        event.preventDefault()
        if (event.inputType === 'historyUndo') history.undo(); else history.redo()
        return true
      } },
    },
    onFocus: ({ editor }) => { history.boundary(); onActive(editor) },
    onSelectionUpdate: ({ editor, transaction }) => {
      if (syncing.current || transaction.getMeta('historyRestore')) return
      if (!transaction.docChanged && !editor.view.composing && transaction.getMeta('composition') === undefined) history.boundary()
      onActive(editor)
    },
    onUpdate: ({ editor, transaction }) => {
      const typing = !transaction.getMeta('historyBoundary') && !transaction.getMeta('paste') && transaction.steps.length === 1
        && transaction.steps[0] instanceof ReplaceStep && transaction.steps[0].slice.content.childCount <= 1
        && (!transaction.steps[0].slice.content.firstChild || transaction.steps[0].slice.content.firstChild.isText)
      history.edit({ editorId: historyId, before: before.current,
        composition: transaction.getMeta('composition'),
        group: typing ? `text:${historyId}` : undefined, normalize: transaction.getMeta('addToHistory') === false },
      () => onChange(editor.getJSON(), spaceLayoutKey.getState(editor.state)?.merges, transaction.getMeta('spaceShift')))
    },
  })

  useLayoutEffect(() => {
    const remember = () => { before.current = editor.state.selection.toJSON() }
    editor.on('beforeTransaction', remember)
    const unregister = history.register(historyId, editor)
    return () => { editor.off('beforeTransaction', remember); unregister() }
  }, [editor, historyId])

  useLayoutEffect(() => {
    const replay = syncedRevision.current !== history.revision
    syncedRevision.current = history.revision
    const next = editor.schema.nodeFromJSON(content)
    const changed = !editor.state.doc.eq(next)
    if (!changed && !replay) return
    const previous = editor.state.selection.from
    syncing.current = true
    try {
      const transaction = editor.state.tr.setMeta('preventUpdate', true).setMeta('historyRestore', true)
      if (changed) {
        transaction.replaceWith(0, transaction.doc.content.size, next.content)
        for (const [name, value] of Object.entries(next.attrs)) transaction.setDocAttribute(name, value)
      }
      const saved = replay && history.restoredSelection(historyId)
      const selection = saved ? Selection.fromJSON(transaction.doc, saved)
        : TextSelection.near(transaction.doc.resolve(Math.min(previous, transaction.doc.content.size)))
      editor.view.dispatch(transaction.setSelection(selection))
    } finally { syncing.current = false }
  }, [content, editor, history.revision, historyId])

  useLayoutEffect(() => {
    const marks = editor.state.storedMarks
    if (marks?.some(mark => mark.type.name === 'color' && !palette.current.has(mark.attrs.color))) {
      editor.view.dispatch(editor.state.tr.setStoredMarks(marks.filter(mark => mark.type.name !== 'color' || palette.current.has(mark.attrs.color))))
    }
  }, [editor, history.doc!.theme.palette])

  const ready = useEffectEvent(() => onReady?.(editor))
  useEffect(() => { ready() }, [editor])
  useEffect(() => { editor.setEditable(editable, false) }, [editor, editable])
  const reservations = JSON.stringify(history.lockedBlocks.current)
  useLayoutEffect(() => { editor.view.dispatch(editor.state.tr.setMeta('reservationsChanged', true)) }, [editor, reservations])

  return <EditorContent className={`text-content${singleLabel ? ' label-editor' : ''}`} editor={editor} />
}
