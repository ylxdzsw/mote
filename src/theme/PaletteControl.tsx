import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { PaletteEntry, Theme } from '../document/model'
import { useHistory } from '../document/history'
import { neutralIds, paletteColor, paletteEntries, paletteEntryUsed, replacePaletteEntry } from './palette'
import { contrastRatio, primaryEntry } from './colors'
import './palette.css'

export type PaletteControlOptional = 'none' | 'default'

export interface PaletteControlProps {
  theme: Theme
  label: string
  value: string | null
  onChange: (value: string | null) => void
  optional?: PaletteControlOptional
  fallback?: string
  tones?: boolean
  onFocus?: () => void
  onBlur?: () => void
}

export function PaletteControl({ theme, label, value, onChange, optional, fallback, tones = true, onFocus, onBlur }: PaletteControlProps) {
  const group = useId()
  const choice = (reference: string | null, name: string, color?: string) => <input type="radio" name={group}
    id={`${group}-${reference ?? 'optional'}`} className={`palette-choice${color ? '' : ' is-empty'}`}
    aria-label={name} title={name} checked={value === reference} value={reference ?? ''}
    style={{ '--swatch-color': color } as CSSProperties} onChange={() => onChange(reference)} />
  const optionalName = optional === 'none' ? 'None' : 'Default'
  return <div className={`palette-control${tones ? '' : ' strong-only'}`} role="radiogroup" aria-label={label}
    onFocus={event => { if (!event.currentTarget.contains(event.relatedTarget)) onFocus?.() }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.() }}>
    {optional && <div className="palette-choice-row">
      {choice(null, optionalName, optional === 'default' && fallback ? paletteColor(theme, fallback) : undefined)}
      {tones && <span aria-hidden="true" />}
      <label className="palette-choice-name" htmlFor={`${group}-optional`}>{optionalName}</label>
    </div>}
    {paletteEntries(theme).map(entry => <div className="palette-choice-row" key={entry.id}>
      {choice(entry.id, entry.soft ? `${entry.name} · Strong` : entry.name, entry.strong)}
      {tones && (entry.soft ? choice(`${entry.id}:soft`, `${entry.name} · Soft`, entry.soft) : <span aria-hidden="true" />)}
      <label className="palette-choice-name" htmlFor={`${group}-${entry.id}`}>{entry.name}</label>
    </div>)}
  </div>
}

function colorValue(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'
}

function parseHex(value: string): [number, number, number] | null {
  const match = value.match(/^#([0-9a-f]{6})$/i)
  if (!match) return null
  return [0, 1, 2].map(index => parseInt(match[1].slice(index * 2, index * 2 + 2), 16)) as [number, number, number]
}

function suggestSoft(value: string) {
  const rgb = parseHex(value) ?? [48, 88, 56]
  return `#${rgb.map(channel => Math.round(channel + (255 - channel) * .88).toString(16).padStart(2, '0')).join('')}`
}

function isNeutral(id: string) {
  return neutralIds.includes(id as typeof neutralIds[number])
}

function ContrastCheck({ label, first, second }: { label: string; first: string; second: string }) {
  const ratio = contrastRatio(first, second)
  const low = ratio < 4.5
  return <span className={`palette-contrast ${low ? 'is-warning' : 'is-ok'}`} title={`${label}: ${ratio.toFixed(2)}:1; target 4.5:1`}>
    {low ? '⚠ ' : ''}{label} {ratio.toFixed(1)}:1
  </span>
}

function PaletteEntryRow({ entry, theme, onChange, onDelete }: {
  entry: PaletteEntry; theme: Theme; onChange: (patch: Partial<PaletteEntry>, field: string) => void; onDelete: () => void
}) {
  const history = useHistory()
  const [name, setName] = useState(entry.name)
  useEffect(() => setName(entry.name), [entry.name])
  const edit = (patch: Partial<PaletteEntry>, field: string) => {
    history.begin(`palette-${entry.id}-${field}`)
    onChange(patch, field)
  }
  const page = paletteColor(theme, theme.defaults.background)
  const soft = entry.soft ?? null
  return <article className={`palette-entry${isNeutral(entry.id) ? ' is-neutral' : ''}`}>
    <div className="palette-entry-heading">
      <input className="palette-entry-name" aria-label={`${entry.name} name`} type="text" value={name}
        onFocus={() => history.begin(`palette-${entry.id}-name`)} onBlur={() => { setName(entry.name); history.boundary() }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        onChange={event => { setName(event.target.value); if (event.target.value.trim()) edit({ name: event.target.value }, 'name') }} />
      {!isNeutral(entry.id) && <button className="palette-delete-button" onClick={onDelete}>Delete</button>}
    </div>
    <div className={`palette-entry-colors${soft ? ' has-soft' : ''}`}>
      <label className="palette-color-field">{soft ? 'Strong' : 'Color'}
        <span className="palette-color-input"><input aria-label={`${entry.name} ${soft ? 'strong' : 'color'}`} type="color" value={colorValue(entry.strong)}
          onFocus={() => history.begin(`palette-${entry.id}-strong`)} onBlur={history.boundary}
          onChange={event => edit({ strong: event.target.value }, 'strong')} /><code>{entry.strong.toUpperCase()}</code></span>
      </label>
      {soft && <label className="palette-color-field">Soft
        <span className="palette-color-input"><input aria-label={`${entry.name} soft`} type="color" value={colorValue(soft)}
          onFocus={() => history.begin(`palette-${entry.id}-soft`)} onBlur={history.boundary}
          onChange={event => edit({ soft: event.target.value }, 'soft')} /><code>{soft.toUpperCase()}</code></span>
        <button className="palette-suggest-button" onClick={() => { history.boundary(); edit({ soft: suggestSoft(entry.strong) }, 'soft') }}>Suggest soft</button>
      </label>}
    </div>
    {soft && <div className="palette-tone-preview" aria-label={`${entry.name} preview`} style={{ color: entry.strong }}>
      <span style={{ background: page }}>Aa</span><span style={{ background: soft }}>Aa</span>
    </div>}
    {soft && <div className="palette-contrast-list" aria-label="Contrast checks">
      <ContrastCheck label="Strong / page" first={entry.strong} second={page} />
      <ContrastCheck label="Strong / soft" first={entry.strong} second={soft} />
    </div>}
  </article>
}

export function PaletteEditor({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const history = useHistory()
  const { doc, setDoc } = history
  const [deleting, setDeleting] = useState<string | null>(null)
  const [replacement, setReplacement] = useState('')
  const replacementChoices = useRef<HTMLDivElement>(null)
  useEffect(() => { if (deleting) replacementChoices.current?.querySelector('input')?.focus() }, [deleting])

  function editEntry(id: string, patch: Partial<PaletteEntry>, field: string) {
    history.begin(`palette-${id}-${field}`)
    onChange({ ...theme, palette: theme.palette.map(entry => entry.id === id ? { ...entry, ...patch } : entry) })
  }
  function startDelete(entry: PaletteEntry) {
    if (isNeutral(entry.id)) return
    history.boundary()
    if (doc && !paletteEntryUsed(doc, entry.id)) {
      onChange({ ...theme, palette: theme.palette.filter(value => value.id !== entry.id) })
      setDeleting(null)
      return
    }
    setDeleting(entry.id)
    setReplacement('')
  }
  function removeEntry() {
    if (!deleting || !replacement) return
    history.boundary()
    setDoc(doc ? replacePaletteEntry(doc, deleting, replacement) : doc)
    setDeleting(null)
  }
  function addFamily() {
    const strong = '#355b43'
    history.boundary()
    onChange({ ...theme, palette: [...theme.palette, { id: crypto.randomUUID(), name: 'New family', strong, soft: suggestSoft(strong) }] })
  }

  const deletingEntry = theme.palette.find(entry => entry.id === deleting)
  const page = paletteColor(theme, theme.defaults.background)
  const primary = primaryEntry(theme.hue)
  return <section className="panel-section palette-editor" aria-label="Document palette">
    <h2>Palette</h2>
    <p className="hint">Named colors are shared by the document and interface. Ink and Muted color UI text; Subtle colors secondary surfaces. The interface follows Page background in Defaults.</p>
    <p className="hint">Interface colors adapt when needed for readable contrast. Your palette and document colors stay unchanged.</p>
    <div className="palette-entries">
      <article className="palette-entry palette-primary" aria-label="Primary family">
        <div className="palette-entry-heading"><strong>Primary</strong></div>
        <p className="hint">Theme hue colors interface accents and Primary. Its Strong and Soft tones are automatic.</p>
        <label className="theme-hue-label" htmlFor="theme-hue">Theme hue <output>{theme.hue}°</output></label>
        <input id="theme-hue" className="theme-hue" aria-label="Theme hue" type="range" min="0" max="359" step="1" value={theme.hue}
          onFocus={() => history.begin('theme-hue')} onBlur={history.boundary}
          onPointerDown={() => history.begin('theme-hue')} onPointerUp={history.boundary} onPointerCancel={history.boundary}
          onChange={event => { history.begin('theme-hue'); onChange({ ...theme, hue: Number(event.target.value) }) }} />
        <div className="palette-primary-tones">
          <span><i style={{ background: primary.strong }} />Strong <code>{primary.strong.toUpperCase()}</code></span>
          <span><i style={{ background: primary.soft }} />Soft <code>{primary.soft.toUpperCase()}</code></span>
        </div>
        <div className="palette-tone-preview" aria-label="Primary preview" style={{ color: primary.strong }}>
          <span style={{ background: page }}>Aa</span><span style={{ background: primary.soft }}>Aa</span>
        </div>
        <div className="palette-contrast-list" aria-label="Primary contrast checks">
          <ContrastCheck label="Strong / page" first={primary.strong} second={page} />
          <ContrastCheck label="Strong / soft" first={primary.strong} second={primary.soft} />
        </div>
      </article>
      {theme.palette.map(entry => <PaletteEntryRow key={entry.id} entry={entry} theme={theme}
        onChange={(patch, field) => editEntry(entry.id, patch, field)} onDelete={() => startDelete(entry)} />)}
    </div>
    {deletingEntry && <div className="palette-delete-dialog" role="alertdialog" aria-label={`Delete ${deletingEntry.name}`}>
      <strong>Delete {deletingEntry.name}?</strong>
      <p>All uses will be replaced with:</p>
      <div ref={replacementChoices}><PaletteControl theme={{ ...theme, palette: theme.palette.filter(entry => entry.id !== deletingEntry.id) }}
        label="Replacement color" value={replacement || null} tones={false} onChange={value => setReplacement(value!)} /></div>
      <div className="palette-dialog-actions"><button onClick={() => setDeleting(null)}>Cancel</button><button disabled={!replacement} onClick={removeEntry}>Delete family</button></div>
    </div>}
    <button className="palette-add-button" onClick={addFamily}>Add color family</button>
    <p className="hint">Contrast checks compare each strong color with the page ({page.toUpperCase()}) and its soft color. The target is 4.5:1. Other backgrounds may differ; use wording, not color alone, for important meaning.</p>
  </section>
}
