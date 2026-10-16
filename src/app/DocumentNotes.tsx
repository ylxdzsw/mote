import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { useHistory } from '../document/history'
import type { ViewSettings } from './GlobalSettings'

export function DocumentNotes({ value, settings, onSettings, onFocus }: {
  value: string; settings: ViewSettings; onSettings: (settings: ViewSettings) => void; onFocus: () => void
}) {
  const history = useHistory()
  const pane = useRef<HTMLElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)
  const composition = useRef<number | undefined>(undefined)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const [maxHeight, setMaxHeight] = useState(400)
  const height = Math.min(dragHeight ?? settings.notesHeight, maxHeight)
  const clamp = (value: number) => Math.round(Math.max(72, Math.min(maxHeight, value)))
  const nativeHistory = useEffectEvent((event: InputEvent) => {
    if (event.isComposing || composition.current !== undefined || !['historyUndo', 'historyRedo'].includes(event.inputType)) return
    event.preventDefault()
    if (event.inputType === 'historyUndo') history.undo(); else history.redo()
  })

  useLayoutEffect(() => {
    const workspace = pane.current!.parentElement!
    const textarea = input.current!
    const beforeInput = (event: InputEvent) => nativeHistory(event)
    textarea.addEventListener('beforeinput', beforeInput)
    const observer = new ResizeObserver(() => setMaxHeight(Math.max(72, Math.floor(workspace.clientHeight * .55))))
    observer.observe(workspace)
    return () => { observer.disconnect(); textarea.removeEventListener('beforeinput', beforeInput) }
  }, [])

  function change(value: string) {
    history.edit({ group: 'document-notes', editorId: 'document-notes', composition: composition.current }, () => {
      history.setDoc(doc => doc && { ...doc, notes: value })
    })
  }

  return <section ref={pane} className={`document-notes ${settings.notesOpen ? 'is-open' : ''}`} aria-label="Notes"
    style={{ height: settings.notesOpen ? height : 32 }}>
    {settings.notesOpen && <div className="notes-divider" role="separator" aria-label="Resize notes" aria-orientation="horizontal"
      aria-controls="document-notes-input" aria-valuemin={72} aria-valuemax={maxHeight} aria-valuenow={height} tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { y: event.clientY, height }
      }}
      onPointerMove={event => { if (drag.current) setDragHeight(clamp(drag.current.height + drag.current.y - event.clientY)) }}
      onPointerUp={event => {
        if (!drag.current) return
        onSettings({ ...settings, notesHeight: clamp(drag.current.height + drag.current.y - event.clientY) })
        drag.current = null; setDragHeight(null)
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onLostPointerCapture={() => { drag.current = null; setDragHeight(null) }}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        onSettings({ ...settings, notesHeight: clamp(event.key === 'Home' ? 72 : event.key === 'End' ? maxHeight : height + (event.key === 'ArrowUp' ? 20 : -20)) })
      }} />}
    <div className="notes-heading">
      <button ref={toggle} className="notes-toggle" aria-expanded={settings.notesOpen} aria-controls="document-notes-input"
        onClick={() => {
          history.boundary()
          onSettings({ ...settings, notesOpen: !settings.notesOpen })
          if (!settings.notesOpen) requestAnimationFrame(() => input.current?.focus())
        }}>
        <span aria-hidden="true">{settings.notesOpen ? '⌄' : '⌃'}</span> Notes
        {!!value.trim() && <span className="notes-dot" aria-label="Contains notes" />}
      </button>
      {settings.notesOpen && <span className="notes-hint">Working notes · outside the published page</span>}
    </div>
    <textarea ref={input} id="document-notes-input" data-document-notes hidden={!settings.notesOpen} aria-label="Document notes"
      placeholder="Outlines, spare paragraphs, plans…" value={value}
      onFocus={() => { history.boundary(); onFocus() }} onBlur={history.boundary}
      onPointerDown={history.boundary}
      onCompositionStart={() => { history.boundary(); composition.current = Date.now() }}
      onCompositionEnd={() => { queueMicrotask(() => { composition.current = undefined; history.boundary() }) }}
      onChange={event => change(event.target.value)}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        event.preventDefault(); event.stopPropagation()
        onSettings({ ...settings, notesOpen: false }); toggle.current?.focus()
      }} />
  </section>
}
