import { useEffect, useId, useRef, useState } from 'react'
import { PanelIcon } from './PanelIcon'

export function HeaderMenu({ onExport, onPreferences, onReset }: { onExport: () => void; onPreferences: () => void; onReset: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const menu = root.current!.querySelector<HTMLElement>('[role="menu"]')!
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const resize = () => setOpen(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', resize)
      if (document.activeElement === document.body || menu.contains(document.activeElement)) root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus({ preventScroll: true })
    }
  }, [open])
  return <div className="header-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button className="header-icon-btn" aria-label="More document actions" title="More document actions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}><PanelIcon name="more" /></button>
    {open && <div className="header-menu-popup" id={id} role="menu" aria-label="Document actions" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
      if (event.key === 'Tab') { setOpen(false); return }
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
      if (next >= 0) { event.preventDefault(); buttons[next].focus() }
    }}>
      <button role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); onExport() }}><PanelIcon name="export" />Export…</button>
      <button role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); onPreferences() }}><PanelIcon name="sliders" />Browser preferences…</button>
      <div role="separator" />
      <button role="menuitem" tabIndex={-1} className="header-reset" onClick={() => { setOpen(false); onReset() }}><PanelIcon name="reset" />Reset to example…</button>
    </div>}
  </div>
}
