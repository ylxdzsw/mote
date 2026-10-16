import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useHistory } from '../document/history'
import { highlightCode, type CodeToken } from '../document/code'
import '../canvas/code.css'

function rowsFor(tokens: CodeToken[]): CodeToken[][] {
  const rows: CodeToken[][] = [[]]
  for (const token of tokens) {
    let start = 0
    while (start < token.text.length) {
      const newline = token.text.indexOf('\n', start)
      const end = newline < 0 ? token.text.length : newline
      if (end > start) rows.at(-1)!.push({ text: token.text.slice(start, end), kind: token.kind })
      if (newline < 0) break
      rows.push([])
      start = newline + 1
    }
  }
  return rows
}

function lineStarts(source: string, start: number, end: number) {
  const lineStart = (position: number) => position ? source.lastIndexOf('\n', position - 1) + 1 : 0
  const first = lineStart(start)
  const endAtLineStart = end > start && source[end - 1] === '\n'
  const last = lineStart(endAtLineStart ? end - 1 : end)
  const starts = [first]
  for (let index = first; index < last;) {
    index = source.indexOf('\n', index) + 1
    if (index > 0 && index <= last) starts.push(index)
  }
  return starts
}

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

function pasteText(event: React.ClipboardEvent<HTMLTextAreaElement>, insert: (text: string) => void) {
  const transfer = event.clipboardData
  const types = Array.from(transfer.types)
  let text: string
  if (types.includes('text/plain')) text = transfer.getData('text/plain')
  else if (types.includes('text/html')) text = htmlText(transfer.getData('text/html'))
  else return
  event.preventDefault()
  insert(text.replace(/\r\n?/g, '\n'))
}

export function SourceEditor({ source, language = 'plaintext', editorId, canEdit, label, inputId, placeholder, onChange, onActive, onEscape }: {
  source: string; language?: string; editorId: string; canEdit: boolean; label: string; inputId?: string; placeholder?: string
  onChange?: (source: string) => void; onActive?: () => void; onEscape?: () => void
}) {
  const history = useHistory()
  const composition = useRef<number | undefined>(undefined)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const caretMeasure = useRef<HTMLSpanElement>(null)
  const pendingSelection = useRef<{ start: number; end: number } | null>(null)
  const [composing, setComposing] = useState(false)
  const lines = useMemo(() => rowsFor(highlightCode(source, language)), [source, language])
  function change(next: string, atomic = false) {
    if (atomic) history?.boundary()
    if (history) history.edit({ group: editorId, editorId, composition: composition.current }, () => onChange?.(next))
    else onChange?.(next)
    if (atomic) history?.boundary()
  }
  function revealCaret() {
    const input = textarea.current, measure = caretMeasure.current
    if (!input || !measure || document.activeElement !== input) return
    const position = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd
    const before = input.value.slice(0, position)
    measure.textContent = before.slice(before.lastIndexOf('\n') + 1)
    const scroll = input.closest<HTMLElement>('.code-source-scroll')!
    const x = measure.offsetWidth
    if (x < scroll.scrollLeft + 8) scroll.scrollLeft = Math.max(0, x - 8)
    else if (x > scroll.scrollLeft + scroll.clientWidth - 24) scroll.scrollLeft = x - scroll.clientWidth + 24
    input.scrollLeft = 0
    const line = input.parentElement!.querySelectorAll<HTMLElement>('.code-line')[before.split('\n').length - 1]
    const stage = input.closest<HTMLElement>('[data-source-viewport], .stage')
    if (line && stage) {
      const caret = line.getBoundingClientRect(), viewport = stage.getBoundingClientRect()
      if (caret.bottom > viewport.bottom - 16) stage.scrollTop += caret.bottom - viewport.bottom + 16
      else if (caret.top < viewport.top + 16) stage.scrollTop += caret.top - viewport.top - 16
    }
  }

  useLayoutEffect(() => {
    const selection = pendingSelection.current
    const input = textarea.current
    if (selection && input) {
      pendingSelection.current = null
      input.setSelectionRange(selection.start, selection.end)
    }
    revealCaret()
  }, [source])

  useEffect(() => {
    const input = textarea.current
    if (!input || !history) return
    const beforeInput = (event: InputEvent) => {
      if (event.isComposing || composition.current !== undefined || !['historyUndo', 'historyRedo'].includes(event.inputType)) return
      event.preventDefault()
      if (event.inputType === 'historyUndo') history.undo(); else history.redo()
    }
    input.addEventListener('beforeinput', beforeInput)
    return () => input.removeEventListener('beforeinput', beforeInput)
  }, [canEdit, history])

  const replaceRange = (input: HTMLTextAreaElement, text: string, start = input.selectionStart, end = input.selectionEnd) => {
    const next = source.slice(0, start) + text + source.slice(end)
    if (next === source) return
    pendingSelection.current = { start: start + text.length, end: start + text.length }
    change(next, true)
  }

  const editLines = (input: HTMLTextAreaElement, outdent: boolean) => {
    const start = input.selectionStart
    const end = input.selectionEnd
    if (!outdent && start === end) { replaceRange(input, '  '); return }
    const starts = lineStarts(source, start, end)
    const edits = starts.flatMap(at => {
      if (!outdent) return [{ at, remove: 0, add: '  ' }]
      const prefix = source.slice(at).match(/^(?: {1,2}|\t)/)?.[0]
      return prefix ? [{ at, remove: prefix.length, add: '' }] : []
    })
    if (!edits.length) return
    let next = source
    for (const edit of [...edits].reverse()) next = next.slice(0, edit.at) + edit.add + next.slice(edit.at + edit.remove)
    const mapPosition = (position: number) => edits.reduce((mapped, edit) => {
      if (edit.add) return mapped + (edit.at <= position ? edit.add.length : 0)
      const removed = position >= edit.at + edit.remove ? edit.remove : position > edit.at ? position - edit.at : 0
      return mapped - removed
    }, position)
    pendingSelection.current = { start: mapPosition(start), end: mapPosition(end) }
    change(next, true)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) history?.boundary()
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (onEscape) onEscape(); else event.currentTarget.closest<HTMLElement>('[data-note-id]')?.focus(); return }
    if (event.key !== 'Tab') return
    event.preventDefault()
    event.stopPropagation()
    editLines(event.currentTarget, event.shiftKey)
  }

  return <div className={`code-body${composing ? ' is-composing' : ''}`}>
    <div className="code-gutter" aria-hidden="true">{lines.map((_, index) => <span className="code-line-number" key={index}>{index + 1}</span>)}</div>
    <div className="code-source-scroll" onPointerDown={event => { if (canEdit) event.stopPropagation() }}>
      <div className="code-source-track">
        <pre className={canEdit ? 'code-highlight' : 'code-readonly'} aria-hidden={canEdit || undefined}><code>{lines.map((line, index) => <span className="code-line" key={index}>{line.map((token, tokenIndex) => token.kind
          ? <span className={`code-token code-${token.kind}`} key={tokenIndex}>{token.text}</span>
          : <span key={tokenIndex}>{token.text}</span>)}{index < lines.length - 1 ? '\n' : null}</span>)}</code></pre>
        {canEdit && <><span ref={caretMeasure} className="code-caret-measure" aria-hidden="true" /><textarea ref={textarea} data-code-source="" className="code-editor" id={inputId} aria-label={label} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoComplete="off" autoCorrect="off"
            wrap="off" rows={lines.length} value={source} onFocus={() => { history?.boundary(); onActive?.() }} onBlur={() => history?.boundary()} onChange={event => change(event.currentTarget.value.replace(/\r\n?/g, '\n'))}
            onKeyDown={onKeyDown} onPaste={event => pasteText(event, text => replaceRange(event.currentTarget, text))}
            onSelect={revealCaret} onKeyUp={revealCaret} onPointerDown={() => history?.boundary()}
            onCompositionStart={() => { composition.current = Date.now(); history?.boundary(); setComposing(true) }}
            onCompositionEnd={() => { setComposing(false); queueMicrotask(() => { composition.current = undefined; history?.boundary() }) }} /></>}
      </div>
    </div>
  </div>
}
