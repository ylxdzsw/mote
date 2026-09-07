import { useEffect, useEffectEvent, useMemo } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { extensions } from './extensions'

interface Props {
  content: JSONContent
  editable: boolean
  spatial?: boolean
  label: string
  onChange: (content: JSONContent) => void
  onActive: (editor: Editor) => void
  onReady?: (editor: Editor) => void
}

export function TextEditor({ content, editable, spatial = false, label, onChange, onActive, onReady }: Props) {
  const schema = useMemo(() => extensions(spatial), [spatial])
  const editor = useEditor({
    extensions: schema,
    content,
    editable,
    editorProps: { attributes: { 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' } },
    onFocus: ({ editor }) => onActive(editor),
    onSelectionUpdate: ({ editor }) => onActive(editor),
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
  })

  const ready = useEffectEvent(() => onReady?.(editor))
  useEffect(() => { ready() }, [editor])
  useEffect(() => { editor.setEditable(editable, false) }, [editor, editable])

  return <EditorContent className="text-content" editor={editor} />
}
