import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { isRecord, requestJSON } from '../cloud/connection'
import './model-field.css'

interface ModelHint { reference: string; efforts: string[] }
interface Catalog { models: ModelHint[] }

function validCatalog(value: unknown): value is Catalog {
  return isRecord(value) && Array.isArray(value.models) && value.models.every(model => isRecord(model)
    && typeof model.reference === 'string' && Array.isArray(model.efforts) && model.efforts.every(effort => typeof effort === 'string'))
}

export function ModelField({ label, value, placeholder, disabled, onChange, onFocus, onBlur }: {
  label: string; value: string; placeholder: string; disabled?: boolean
  onChange: (value: string) => void; onFocus?: () => void; onBlur?: () => void
}) {
  const id = useId()
  const field = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const [active, setActive] = useState(-1)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState(false)
  const query = value.trim().toLowerCase()
  const colon = query.indexOf(':')
  const processing = value.includes('@') ? value.slice(value.lastIndexOf('@')) : ''
  const options = (catalog?.models ?? []).flatMap(model => all || colon < 0 ? [model.reference]
    : model.reference.toLowerCase() === query.slice(0, colon)
      ? model.efforts.map(effort => `${model.reference}:${effort}${processing}`) : [])
    .filter(reference => all || reference.toLowerCase().includes(query))

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setCatalog(null); setError(false)
    requestJSON<Catalog>('/api/models', 'GET', undefined, validCatalog, { signal: controller.signal })
      .then(setCatalog, () => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [open])

  useLayoutEffect(() => {
    if (!open || disabled) return
    const menu = popup.current!
    menu.showPopover()
    function position() {
      const rect = field.current!.getBoundingClientRect()
      if (!rect.width) { setOpen(false); return }
      const below = window.innerHeight - rect.bottom - 10
      const above = rect.top - 10
      const upwards = below < 180 && above > below
      menu.style.width = `${rect.width}px`
      menu.style.left = `${rect.left}px`
      menu.style.maxHeight = `${Math.min(240, upwards ? above : below)}px`
      menu.style.top = upwards ? 'auto' : `${rect.bottom + 4}px`
      menu.style.bottom = upwards ? `${window.innerHeight - rect.top + 4}px` : 'auto'
    }
    position()
    const outside = (event: PointerEvent) => { if (!field.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    document.addEventListener('pointerdown', outside)
    return () => {
      menu.hidePopover()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      document.removeEventListener('pointerdown', outside)
    }
  }, [open, disabled])

  useEffect(() => { popup.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  function show(showAll: boolean) { setAll(showAll); setActive(-1); setOpen(true) }
  function choose(reference: string) { onChange(reference); setOpen(false); setActive(-1) }

  return <div className="model-field" ref={field}>
    <div className="model-field-control">
      <input ref={input} type="text" role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open && active >= 0 && options[active] ? `${id}-${active}` : undefined}
        aria-describedby={`${id}-hint`} value={value} placeholder={placeholder} disabled={disabled}
        maxLength={256} spellCheck={false} autoComplete="off" onFocus={onFocus}
        onBlur={() => { setOpen(false); onBlur?.() }}
        onChange={event => { onChange(event.target.value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')); show(false) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false) }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) show(true)
            else if (options.length) setActive(index => event.key === 'ArrowDown' ? (index + 1) % options.length : (index <= 0 ? options.length : index) - 1)
          } else if (event.key === 'Enter' && open && active >= 0 && options[active]) {
            event.preventDefault(); choose(options[active])
          } else if (event.key === 'Tab') setOpen(false)
        }} />
      <button type="button" className="model-field-toggle" tabIndex={-1} aria-label={`Show suggestions for ${label}`}
        aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} disabled={disabled}
        onPointerDown={event => event.preventDefault()} onClick={() => { input.current?.focus(); if (open) setOpen(false); else show(true) }}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
    </div>
    <span id={`${id}-hint`} className="model-field-hint">Choose a suggestion or enter a model reference.</span>
    {open && <div ref={popup} popover="manual" className="model-field-popup" onPointerDown={event => event.preventDefault()}>
      <div role="listbox" id={`${id}-list`} aria-label={`${label} suggestions`}>
        {options.map((reference, index) => <div key={reference} role="option" id={`${id}-${index}`} aria-selected={active === index}
          className="model-field-option" onClick={() => choose(reference)}>{reference}</div>)}
      </div>
      {!options.length && <p className="model-field-empty" role="status">{error ? 'Suggestions unavailable. You can still enter a model reference.'
        : !catalog ? 'Loading suggestions…' : catalog.models.length ? 'No matching suggestions. You can use the entered reference.'
          : 'No configured suggestions. You can still enter a model reference.'}</p>}
    </div>}
  </div>
}
