import { useEffect, useId, useRef, useState } from 'react'
import { PanelIcon } from './PanelIcon'

export function HeaderMenu({ compact, onDocumentSettings, documentSettingsOpen, onShare, sharingBlocked, onExport, onPreferences, preferencesOpen, onReset }: {
  compact: boolean; onDocumentSettings: () => void; documentSettingsOpen: boolean
  onShare: () => void; sharingBlocked: boolean; onExport: () => void; onPreferences: () => void; preferencesOpen: boolean; onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open || !compact) return
    const menu = root.current!.querySelector<HTMLElement>('[role="menu"]')!
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const resize = () => setOpen(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', resize)
      if (document.activeElement === document.body || menu.contains(document.activeElement)) root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus({ preventScroll: true })
    }
  }, [open, compact])
  const actions = [
    { label: 'Document settings', icon: 'sliders', run: onDocumentSettings, expanded: documentSettingsOpen },
    { label: 'Share', icon: 'share', run: onShare, disabled: sharingBlocked, title: sharingBlocked ? 'Sharing is disabled while Private is enabled or being confirmed.' : 'Share document' },
    { label: 'Export', icon: 'export', run: onExport },
    { label: 'Browser preferences', icon: 'browser', run: onPreferences, expanded: preferencesOpen },
    { label: 'Reset to example', icon: 'reset', run: onReset },
  ] as const
  const buttons = actions.map(action => <button key={action.icon} role={compact ? 'menuitem' : undefined} tabIndex={compact ? -1 : undefined}
    className={compact ? action.icon === 'reset' ? 'header-reset' : undefined : 'header-icon-btn'}
    aria-label={action.label} aria-haspopup="dialog" aria-expanded={'expanded' in action ? action.expanded : undefined}
    disabled={'disabled' in action && action.disabled} title={'title' in action ? action.title : compact ? undefined : action.label}
    onClick={() => { setOpen(false); action.run() }}><PanelIcon name={action.icon} />{compact && `${action.label}…`}</button>)
  if (!compact) return <div className="header-flat-actions" role="group" aria-label="Document actions" ref={root}>{buttons}</div>
  return <div className="header-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button className="header-icon-btn" aria-label="More document actions" title="More document actions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}><PanelIcon name="more" /></button>
    {open && <div className="header-menu-popup" id={id} role="menu" aria-label="Document actions" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
      if (event.key === 'Tab') { setOpen(false); return }
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
      if (next >= 0) { event.preventDefault(); buttons[next].focus() }
    }}>
      {buttons.slice(0, -1)}
      <div role="separator" />
      {buttons.at(-1)}
    </div>}
  </div>
}
