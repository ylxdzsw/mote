import { useLayoutEffect, useRef, useState } from 'react'
import { useHistory } from '../document/history'
import { SourceEditor } from '../editor/SourceEditor'
import { PanelIcon } from './PanelIcon'
import type { ViewSettings } from './GlobalSettings'

export function DocumentNotes({ value, settings, onSettings, onFocus }: {
  value: string; settings: ViewSettings; onSettings: (settings: ViewSettings) => void; onFocus: () => void
}) {
  const history = useHistory()
  const pane = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const [maxHeight, setMaxHeight] = useState(400)
  const height = Math.min(dragHeight ?? settings.notesHeight, maxHeight)
  const clamp = (value: number) => Math.round(Math.max(72, Math.min(maxHeight, value)))
  useLayoutEffect(() => {
    const workspace = pane.current!.parentElement!
    const observer = new ResizeObserver(() => setMaxHeight(Math.max(72, Math.floor(workspace.clientHeight * .55))))
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])

  return <section ref={pane} className={`document-notes ${settings.notesOpen ? 'is-open' : ''}`} aria-label="Notes"
    style={{ height: settings.notesOpen ? height : 24 }}>
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
    <button ref={toggle} className="notes-toggle" aria-label="Notes" aria-expanded={settings.notesOpen} aria-controls="document-notes-input"
      onClick={() => {
        history.boundary()
        onSettings({ ...settings, notesOpen: !settings.notesOpen })
        if (!settings.notesOpen) requestAnimationFrame(() => pane.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus())
      }}>
      <PanelIcon name="chevron" /> Notes
    </button>
    <div className="notes-source code-view" data-source-viewport hidden={!settings.notesOpen}>
      <SourceEditor source={value} editorId="document-notes" canEdit label="Document notes" inputId="document-notes-input"
        placeholder="Outlines, spare paragraphs, plans…" onActive={onFocus}
        onChange={notes => history.setDoc(doc => doc && { ...doc, notes })}
        onEscape={() => { onSettings({ ...settings, notesOpen: false }); toggle.current?.focus() }} />
    </div>
  </section>
}
