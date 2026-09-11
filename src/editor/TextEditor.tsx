import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { extensions } from './extensions'
import './label.css'
import { useHistory } from '../document/history'

interface Props {
  content: JSONContent
  editable: boolean
  spatial?: boolean
  table?: boolean
  singleLabel?: boolean
  onFinish?: () => void
  label: string
  historyId: string
  onChange: (content: JSONContent) => void
  onActive: (editor: Editor) => void
  onReady?: (editor: Editor) => void
}

export function TextEditor({ content, editable, spatial = false, table = false, singleLabel = false, onFinish, label, historyId, onChange, onActive, onReady }: Props) {
  const history = useHistory()
  const before = useRef<ReturnType<Selection['toJSON']>>(null)
  const syncing = useRef(false)
  const syncedRevision = useRef(-1)
  const schema = useMemo(() => extensions(spatial, table, singleLabel, onFinish), [spatial, table, singleLabel, onFinish])
  const editor = useEditor({
    extensions: schema,
    content,
    editable,
    editorProps: {
      attributes: { 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' },
      handleDOMEvents: { pointerdown: (view, event) => {
        const space = (event.target as HTMLElement).closest('[data-spacer]')
        if (!editable || event.button !== 0 || !space) return false
        event.preventDefault()
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, view.posAtDOM(space, 0))))
        view.focus()
        onActive(editor)
        return true
      }, beforeinput: (_view, event) => {
        if (!editable || !['historyUndo', 'historyRedo'].includes(event.inputType)) return false
        event.preventDefault()
        if (event.inputType === 'historyUndo') history.undo(); else history.redo()
        return true
      } },
    },
    onFocus: ({ editor }) => { history.boundary(); onActive(editor) },
    onSelectionUpdate: ({ editor, transaction }) => {
      if (syncing.current || transaction.getMeta('historyRestore')) return
      if (!transaction.docChanged) history.boundary()
      onActive(editor)
    },
    onUpdate: ({ editor, transaction }) => {
      const typing = !transaction.getMeta('historyBoundary') && !transaction.getMeta('paste') && transaction.steps.length === 1
        && transaction.steps[0] instanceof ReplaceStep && transaction.steps[0].slice.content.childCount <= 1
        && (!transaction.steps[0].slice.content.firstChild || transaction.steps[0].slice.content.firstChild.isText)
      history.edit({ editorId: historyId, before: before.current,
        group: typing ? `text:${historyId}` : undefined, normalize: transaction.getMeta('addToHistory') === false },
      () => onChange(editor.getJSON()))
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

  const ready = useEffectEvent(() => onReady?.(editor))
  useEffect(() => { ready() }, [editor])
  useEffect(() => { editor.setEditable(editable, false) }, [editor, editable])

  return <EditorContent className={`text-content${singleLabel ? ' label-editor' : ''}`} editor={editor} />
}
