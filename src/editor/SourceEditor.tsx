import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, placeholder as editorPlaceholder } from '@codemirror/view'
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import {
  copyLineDown, copyLineUp, indentLess, indentMore, insertNewlineKeepIndent,
  moveLineDown, moveLineUp, standardKeymap, toggleComment, toggleTabFocusMode,
} from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { useHistory } from '../document/history'
import { normalizeCodeLanguage } from '../document/code'
import { codeHighlightStyle, getCodeLanguage, highlightCode, loadCodeLanguage } from './codeLanguages'
import { SourceDisplay } from './SourceDisplay'

function htmlText(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script,style,template,noscript').forEach(node => node.remove())
  const blocks = new Set('address article aside blockquote div dl dt dd fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul'.split(' '))
  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ''
    if (!(node instanceof HTMLElement)) return [...node.childNodes].map(textOf).join('')
    if (node.tagName === 'BR' || node.tagName === 'HR') return '\n'
    const block = (child: Node) => child instanceof HTMLElement && blocks.has(child.tagName.toLowerCase())
    const hasBlocks = [...node.childNodes].some(block)
    const children = [...node.childNodes].filter(child => !hasBlocks || child.nodeType !== Node.TEXT_NODE || !!child.nodeValue?.trim())
    if (blocks.has(node.tagName.toLowerCase()) && children.length === 1 && node.firstElementChild?.tagName === 'BR') return ''
    return children.map((child, index) => `${index && (block(child) || block(children[index - 1])) ? '\n' : ''}${textOf(child)}`).join('')
  }
  return textOf(document.body).replace(/\r\n?/g, '\n')
}

function indentation(source: string) {
  const prefixes = source.match(/^[\t ]+(?=\S)/gm) ?? []
  if (prefixes.some(prefix => prefix.includes('\t'))) return '\t'
  const size = prefixes.length ? Math.min(...prefixes.map(prefix => prefix.length)) : 2
  return ' '.repeat(size)
}

function revealCaret(view: EditorView, head = view.state.selection.main.head) {
  if (!view.hasFocus) return
  const caret = view.coordsAtPos(head)
  if (!caret) return
  const scroll = view.dom.closest<HTMLElement>('.code-source-scroll')!
  const bounds = scroll.getBoundingClientRect()
  const scale = bounds.width / scroll.offsetWidth
  if (caret.left < bounds.left + 8) scroll.scrollLeft += (caret.left - bounds.left - 8) / scale
  else if (caret.right > bounds.right - 16) scroll.scrollLeft += (caret.right - bounds.right + 16) / scale
  const stage = view.dom.closest<HTMLElement>('[data-source-viewport], .stage')
  if (stage) {
    const viewport = stage.getBoundingClientRect()
    if (caret.bottom > viewport.bottom - 16) stage.scrollTop += caret.bottom - viewport.bottom + 16
    else if (caret.top < viewport.top + 16) stage.scrollTop += caret.top - viewport.top - 16
  }
}

export function SourceEditor({ source, language = 'plaintext', editorId, canEdit, label, inputId, describedBy, placeholder, onChange, onActive, onEscape, onFiles }: {
  source: string; language?: string; editorId: string; canEdit: boolean; label: string; inputId?: string; describedBy?: string; placeholder?: string
  onChange?: (source: string) => void; onActive?: () => void; onEscape?: () => void; onFiles?: (files: File[]) => void
}) {
  const history = useHistory()
  const mount = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const syncing = useRef(false)
  const composition = useRef<number | undefined>(undefined)
  const revision = useRef(history?.revision)
  const live = useRef({ source, history, onChange, onActive, onEscape, onFiles })
  live.current = { source, history, onChange, onActive, onEscape, onFiles }
  const configuration = useMemo(() => new Compartment(), [])
  const [loaded, setLoaded] = useState({ id: language, language: getCodeLanguage(language), error: false })
  const [attempt, setAttempt] = useState(0)
  const [activeLine, setActiveLine] = useState(1)
  const syntax = loaded.id === language ? loaded.language : getCodeLanguage(language)
  const tokens = useMemo(() => highlightCode(source, syntax), [source, syntax])

  useEffect(() => {
    let active = true
    loadCodeLanguage(language).then(value => {
      if (active) setLoaded({ id: language, language: value, error: false })
    }).catch(() => {
      if (active) setLoaded({ id: language, language: null, error: true })
    })
    return () => { active = false }
  }, [language, attempt])

  useLayoutEffect(() => {
    if (!canEdit || !mount.current) return
    const view = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: live.current.source,
        extensions: [
          configuration.of([]),
          syntaxHighlighting(codeHighlightStyle),
          EditorView.contentAttributes.of({
            'data-code-source': '', 'aria-label': label, 'aria-multiline': 'true',
            ...(inputId ? { id: inputId } : {}), ...(describedBy ? { 'aria-describedby': describedBy } : {}),
            spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off',
          }),
          placeholder ? editorPlaceholder(placeholder) : [],
          keymap.of([
            { key: 'Tab', run: target => {
              if (!target.state.selection.main.empty) return indentMore(target)
              target.dispatch(target.state.update(target.state.replaceSelection(target.state.facet(indentUnit)), { userEvent: 'input', scrollIntoView: true }))
              return true
            }, shift: indentLess },
            { key: 'Mod-/', run: toggleComment },
            { key: 'Mod-[', run: indentLess },
            { key: 'Mod-]', run: indentMore },
            { key: 'Alt-ArrowUp', run: moveLineUp },
            { key: 'Alt-ArrowDown', run: moveLineDown },
            { key: 'Alt-Shift-ArrowUp', run: copyLineUp },
            { key: 'Alt-Shift-ArrowDown', run: copyLineDown },
            { key: 'Ctrl-m', mac: 'Alt-Shift-m', run: toggleTabFocusMode },
            ...standardKeymap,
          ]),
          EditorView.scrollHandler.of((target, range) => { revealCaret(target, range.head); return true }),
          EditorView.domEventHandlers({
            focus: () => { live.current.history?.boundary(); live.current.onActive?.() },
            blur: () => { live.current.history?.boundary() },
            pointerdown: event => { live.current.history?.boundary(); event.stopPropagation() },
            keydown: (event, target) => {
              if (event.isComposing || event.keyCode === 229) return false
              if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation()
                if (live.current.onEscape) live.current.onEscape()
                else target.dom.closest<HTMLElement>('[data-note-id]')?.focus()
                return true
              }
              event.stopPropagation()
              return false
            },
            beforeinput: event => {
              if (event.isComposing || editor.current?.compositionStarted || !['historyUndo', 'historyRedo'].includes(event.inputType)) return false
              event.preventDefault()
              if (event.inputType === 'historyUndo') live.current.history?.undo(); else live.current.history?.redo()
              return true
            },
            paste: (event, target) => {
              const transfer = event.clipboardData
              if (!transfer) return false
              const types = Array.from(transfer.types)
              const text = types.includes('text/plain') ? transfer.getData('text/plain')
                : types.includes('text/html') ? htmlText(transfer.getData('text/html')) : null
              if (text === null) return false
              event.preventDefault(); event.stopPropagation()
              target.dispatch(target.state.update(target.state.replaceSelection(text.replace(/\r\n?/g, '\n')), { userEvent: 'input.paste', scrollIntoView: true }))
              return true
            },
            dragover: event => {
              if (!live.current.onFiles || !event.dataTransfer?.types.includes('Files')) return false
              event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'
              return true
            },
            drop: event => {
              if (!live.current.onFiles || !event.dataTransfer?.types.includes('Files')) return false
              event.preventDefault(); event.stopPropagation()
              live.current.onFiles([...event.dataTransfer.files])
              return true
            },
            compositionstart: () => { composition.current = Date.now(); live.current.history?.boundary() },
          }),
        ],
      }),
      dispatchTransactions: (transactions, target) => {
        target.update(transactions)
        if (syncing.current) return
        const changed = transactions.some(transaction => transaction.docChanged)
        const selection = target.state.selection.main
        setActiveLine(target.state.doc.lineAt(selection.head).number)
        if (changed) {
          const current = live.current
          const composing = target.compositionStarted || transactions.some(transaction => transaction.isUserEvent('input.type.compose'))
          if (!composing) composition.current = undefined
          else if (composition.current === undefined || transactions.some(transaction => transaction.isUserEvent('input.type.compose.start'))) composition.current = Date.now()
          const atomic = !composing && !transactions.every(transaction => transaction.isUserEvent('input.type') || transaction.isUserEvent('delete'))
          if (atomic) current.history?.boundary()
          const before = transactions[0].startState.selection.main
          const next = target.state.doc.toString()
          if (current.history) current.history.edit({ group: editorId, editorId, before: { type: 'source', anchor: before.anchor, head: before.head }, composition: composition.current }, () => current.onChange?.(next))
          else current.onChange?.(next)
          if (atomic) current.history?.boundary()
        } else if (!target.compositionStarted && transactions.some(transaction => transaction.selection)) live.current.history?.boundary()
      },
    })
    editor.current = view
    const unregister = live.current.history?.register(editorId, {
      selection: () => ({ type: 'source', anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }),
      composing: () => view.compositionStarted,
    })
    return () => { unregister?.(); editor.current = null; composition.current = undefined; view.destroy() }
  }, [canEdit, editorId, configuration, label, inputId, describedBy, placeholder])

  useLayoutEffect(() => {
    const view = editor.current
    if (!view) return
    view.dispatch({ effects: configuration.reconfigure([
      EditorState.tabSize.of(4), indentUnit.of(indentation(source)),
      syntax ? [syntax, indentOnInput(), bracketMatching(), closeBrackets(), keymap.of(closeBracketsKeymap)]
        : keymap.of([{ key: 'Enter', run: insertNewlineKeepIndent, shift: insertNewlineKeepIndent }]),
    ]) })
  }, [syntax, language, canEdit, configuration, editorId])

  useLayoutEffect(() => {
    const view = editor.current
    const replay = history?.revision !== revision.current
    revision.current = history?.revision
    if (!view) return
    const changed = view.state.doc.toString() !== source
    const saved = replay && history?.restoredSelection(editorId)
    if (!changed && !saved) return
    const selection = saved?.type === 'source' ? saved : view.state.selection.main
    const clamp = (position: number) => Math.min(position, source.length)
    syncing.current = true
    try {
      view.dispatch({
        ...(changed ? { changes: { from: 0, to: view.state.doc.length, insert: source } } : {}),
        selection: EditorSelection.single(clamp(selection.anchor), clamp(selection.head)),
        annotations: Transaction.addToHistory.of(false),
        scrollIntoView: view.hasFocus,
      })
      setActiveLine(view.state.doc.lineAt(view.state.selection.main.head).number)
    } finally { syncing.current = false }
  }, [source, history?.revision, editorId, canEdit])

  const failed = loaded.id === language && loaded.error
  const supported = normalizeCodeLanguage(language)
  return <div className="code-source" data-code-loading={supported && supported !== 'plaintext' && !syntax && !failed ? '' : undefined}
    onPointerDown={event => {
      const view = editor.current
      if (!view || event.target !== event.currentTarget || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault(); event.stopPropagation()
      live.current.history?.boundary()
      view.focus()
      view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), scrollIntoView: true })
    }}>
    {failed && canEdit && <p className="code-source-status" role="status">Language tools unavailable; editing plain text. <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    <SourceDisplay tokens={tokens} activeLine={activeLine} canEdit={canEdit}>
      {canEdit && <div ref={mount} className="code-editor" />}
    </SourceDisplay>
  </div>
}
