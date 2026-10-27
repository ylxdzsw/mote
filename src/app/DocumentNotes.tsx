import { useLayoutEffect, useRef, useState } from 'react'
import { useHistory } from '../document/history'
import { SourceEditor } from '../editor/SourceEditor'
import { PanelIcon } from './PanelIcon'
import { useViewSettings } from './GlobalSettings'

export function DocumentNotes({ value, onFocus }: {
  value: string[]; onFocus: () => void
}) {
  const history = useHistory()
  const { settings, update: onSettings, saveError } = useViewSettings(['notesOpen', 'notesHeight'])
  const pane = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(0)
  const [emptyNote, setEmptyNote] = useState(settings.notesOpen && !value.length)
  const notes = value.length ? value : emptyNote ? [''] : value
  const active = Math.min(selected, notes.length - 1)
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
  useLayoutEffect(() => {
    const workspace = pane.current!.parentElement!
    workspace.style.setProperty('--notes-overlay-height', `${settings.notesOpen ? height - 24 : 0}px`)
    return () => { workspace.style.removeProperty('--notes-overlay-height') }
  }, [height, settings.notesOpen])
  useLayoutEffect(() => {
    const list = tabs.current
    if (!list) return
    const tab = list.querySelector('.notes-tab.is-active')
    const reveal = () => tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(list)
    if (tab) observer.observe(tab)
    return () => observer.disconnect()
  }, [active, settings.notesOpen])

  function selectNote(index: number) {
    history.boundary()
    setSelected(index)
  }
  function focusInput() {
    requestAnimationFrame(() => pane.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus())
  }
  function removeNote(index: number) {
    history.boundary()
    setEmptyNote(false)
    if (value.length) history.setDoc(doc => doc && { ...doc, authoring: { ...doc.authoring, notes: notes.filter((_, at) => at !== index) } })
    const next = Math.max(0, Math.min(active - (index < active ? 1 : 0), notes.length - 2))
    selectNote(next)
    requestAnimationFrame(() => {
      const target = tabs.current?.querySelector<HTMLButtonElement>(`#document-note-tab-${next}`)
        ?? pane.current?.querySelector<HTMLButtonElement>('.notes-add')
      target?.focus()
    })
  }

  return <section ref={pane} className={`document-notes ${settings.notesOpen ? 'is-open' : ''}`} aria-label="Notes"
    style={{ height: settings.notesOpen ? height : 24 }}>
    {settings.notesOpen && <div className="notes-divider" role="separator" aria-label="Resize notes" aria-orientation="horizontal"
      aria-controls="document-notes-panel" aria-valuemin={72} aria-valuemax={maxHeight} aria-valuenow={height} tabIndex={0}
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
    <div className="notes-header" onClick={event => {
      if (!(event.target as HTMLElement).closest('button, .notes-tab')) toggle.current?.click()
    }}>
      <button ref={toggle} className="notes-toggle" aria-label="Notes" aria-expanded={settings.notesOpen} aria-controls="document-notes-panel"
        onClick={() => {
          history.boundary()
          onSettings({ ...settings, notesOpen: !settings.notesOpen })
          if (!settings.notesOpen) {
            setEmptyNote(!value.length)
            focusInput()
          }
        }}>
        <PanelIcon name="chevron" /> Notes
      </button>
      {settings.notesOpen && <>
        <div ref={tabs} className="notes-tabs" role="tablist" aria-label="Document notes" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? notes.length - 1
            : (active + (event.key === 'ArrowRight' ? 1 : -1) + notes.length) % notes.length
          selectNote(index)
          tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
        }}>
          {notes.map((note, index) => <div key={index} className={`notes-tab${index === active ? ' is-active' : ''}`} role="presentation"
            onClick={event => { if (event.target === event.currentTarget) selectNote(index) }}>
            <button id={`document-note-tab-${index}`} role="tab" aria-selected={index === active}
              aria-controls="document-notes-panel" tabIndex={index === active ? 0 : -1}
              onClick={() => selectNote(index)}>Note {index + 1}</button>
            {!note.trim() && <button className="notes-remove" aria-label={`Remove empty note ${index + 1}`} title="Remove empty note"
              onClick={() => removeNote(index)}><PanelIcon name="close" /></button>}
          </div>)}
        </div>
        <button className="notes-add" aria-label="Add note" title="Add note" onClick={() => {
          history.boundary()
          history.setDoc(doc => doc && { ...doc, authoring: { ...doc.authoring, notes: [...notes, ''] } })
          selectNote(notes.length)
          focusInput()
        }}><PanelIcon name="plus" /></button>
      </>}
      {saveError && <span className="sr-only" role="status">Couldn’t save Notes preferences. They still apply until you reload.</span>}
    </div>
    <div key={active} id="document-notes-panel" className="notes-source code-view" role="tabpanel"
      aria-labelledby={settings.notesOpen && active >= 0 ? `document-note-tab-${active}` : undefined} data-source-viewport hidden={!settings.notesOpen}>
      {active >= 0 ? <SourceEditor source={notes[active]} editorId={`document-notes-${active}`} canEdit label={`Note ${active + 1}`} inputId="document-notes-input"
        placeholder="Outlines, spare paragraphs, plans…" onActive={onFocus}
        onChange={text => history.setDoc(doc => doc && { ...doc, authoring: { ...doc.authoring, notes: notes.map((note, index) => index === active ? text : note) } })}
        onEscape={() => { onSettings({ ...settings, notesOpen: false }); toggle.current?.focus() }} />
        : <p className="notes-empty">Use + to add a note.</p>}
    </div>
  </section>
}
