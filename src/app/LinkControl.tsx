import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { normalizeLinkHref } from '../../shared/links.mjs'
import { selectedLink, type LinkRange } from '../editor/links'

export function useLinkControl(editor: Editor | null, enabled: boolean) {
  const selection = useEditorState({ editor, selector: () => selectedLink(editor) }) ?? selectedLink(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [focusRequest, setFocusRequest] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef<{ editor: Editor; doc: Editor['state']['doc']; ranges: LinkRange[]; original: string } | null>(null)

  useLayoutEffect(() => {
    pending.current = null
    setAdding(false)
    setDraft(selection.href ?? '')
    setError('')
  }, [editor, selection.from, selection.to, selection.href, selection.mixed])

  useLayoutEffect(() => {
    if (focusRequest) { input.current?.focus(); input.current?.select() }
  }, [focusRequest])

  function open() { setAdding(true); setFocusRequest(value => value + 1) }
  useEffect(() => {
    if (!enabled || !editor) return
    const shortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
      if (!editor.isFocused && event.target !== input.current) return
      event.preventDefault()
      open()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [editor, enabled])

  function apply(target: NonNullable<typeof pending.current>, href: string | null) {
    const { editor, doc, ranges } = target
    if (!editor.isEditable || editor.isDestroyed || editor.state.doc !== doc) return
    const tr = editor.state.tr, type = editor.schema.marks.link
    for (const { from, to } of ranges) {
      if (from === to) {
        if (href) {
          const marks = type.create({ href }).addToSet(type.removeFromSet(editor.state.storedMarks ?? tr.doc.resolve(from).marks()))
          tr.insert(from, editor.schema.text(href, marks))
            .setSelection(TextSelection.create(tr.doc, from + href.length)).setStoredMarks(type.removeFromSet(marks))
        }
      } else if (href) tr.addMark(from, to, type.create({ href }))
      else tr.removeMark(from, to, type)
    }
    editor.view.dispatch(tr.setMeta('historyBoundary', true))
  }

  function commit() {
    const target = pending.current
    if (!target) return true
    const value = draft.trim()
    const href = value ? normalizeLinkHref(value) : null
    if (value && !href) { setError('Enter a website URL (http or https).'); return false }
    pending.current = null
    if (value !== target.original) apply(target, href)
    setDraft(href ?? '')
    setAdding(false)
    setError('')
    return true
  }

  const visible = enabled && (adding || selection.linked || selection.mixed || !!selection.href)
  return {
    button: <button className="tt-btn" aria-label="Link" title="Link · Ctrl/⌘K" disabled={!enabled}
      aria-pressed={selection.mixed ? 'mixed' : selection.linked} aria-expanded={visible}
      onMouseDown={event => event.preventDefault()} onClick={() => {
        if (!editor) return
        if (!selection.linked) { open(); return }
        pending.current = null
        apply({ editor, doc: editor.state.doc, ranges: selection.ranges, original: selection.href ?? '' }, null)
        setAdding(false)
        editor.commands.focus()
      }}>
      <svg className="tool-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)" />
      </svg>
    </button>,
    row: visible && <div className="tt-link-row">
      <label><span>URL</span><input ref={input} type="text" inputMode="url" aria-label="Link URL" placeholder={selection.mixed ? 'Mixed links' : 'https://example.com'}
        autoComplete="off" spellCheck={false} value={draft} aria-invalid={!!error}
        onFocus={() => {
          if (editor) pending.current = { editor, doc: editor.state.doc, ranges: selection.ranges, original: selection.href ?? '' }
        }}
        onChange={event => { setDraft(event.target.value); setError('') }}
        onBlur={commit}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation()
            if (commit()) editor?.commands.focus()
          } else if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation()
            pending.current = null
            setDraft(selection.href ?? ''); setAdding(false); setError('')
            editor?.commands.focus()
          }
        }} /></label>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>,
  }
}
