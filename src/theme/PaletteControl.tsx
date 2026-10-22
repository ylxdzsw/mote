import { useId, type CSSProperties } from 'react'
import type { Theme } from '../document/model'
import { useHistory } from '../document/history'
import { boxColorIds, paletteColor, paletteEntries, pageColor } from './palette'
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
  // Pick a Strong/Soft pair by family ID (Gray 4/Gray 5 as the single gray pair).
  pairs?: boolean
  onFocus?: () => void
  onBlur?: () => void
}

export function PaletteControl({ theme, label, value, onChange, optional, fallback, tones = true, pairs = false, onFocus, onBlur }: PaletteControlProps) {
  const group = useId()
  const entries = pairs
    ? paletteEntries(theme).filter(entry => boxColorIds.includes(entry.id)).map(entry => entry.soft ? entry : { ...entry, name: 'Gray', soft: paletteColor(theme, 'gray5') })
    : paletteEntries(theme)
  const choice = (reference: string | null, name: string, color?: string, soft?: string) => <input type="radio" name={group}
    id={`${group}-${reference ?? 'optional'}`} className={`palette-choice${color ? '' : ' is-empty'}${soft ? ' is-pair' : ''}`}
    aria-label={name} title={name} checked={value === reference} value={reference ?? ''}
    style={{ '--swatch-color': color, '--swatch-soft': soft } as CSSProperties} onChange={() => onChange(reference)} />
  const optionalName = optional === 'none' ? 'None' : 'Inherit'
  return <div className="palette-control" role="radiogroup" aria-label={label}
    onFocus={event => { if (!event.currentTarget.contains(event.relatedTarget)) onFocus?.() }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.() }}>
    {optional && <label className="palette-optional">
      {choice(null, optionalName, optional === 'default' && fallback ? paletteColor(theme, fallback) : undefined)}{optionalName}
    </label>}
    {[entries.slice(0, 2), entries.slice(2, 8), entries.slice(8)].map((section, index) => <div key={index} className={`palette-group palette-group-${index}`}>
      {section.map(entry => <div className="palette-pair" key={entry.id}>
        {pairs ? choice(entry.id, entry.name, entry.strong, entry.soft) : <>
          {choice(entry.id, entry.soft ? `${entry.name} · Strong` : entry.name, entry.strong)}
          {tones && entry.soft && choice(`${entry.id}:soft`, `${entry.name} · Soft`, entry.soft)}
        </>}
      </div>)}
    </div>)}
  </div>
}

export function PaletteEditor({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const history = useHistory()
  const id = useId()
  const entries = paletteEntries(theme)
  return <section className="panel-section palette-editor" aria-label="Document palette">
    <h2>Palette</h2>
    <div className="style-field">
      <div className="field-heading">Appearance</div>
      <div className="placement-options" role="group" aria-label="Document appearance">
        {(['light', 'dark'] as const).map(mode => <button key={mode} aria-pressed={theme.mode === mode}
          onClick={() => { history.boundary(); onChange({ ...theme, mode }); history.boundary() }}>{mode === 'light' ? 'Light' : 'Dark'}</button>)}
      </div>
      <p className="hint">Applies to this document and the Mote interface.</p>
    </div>
    {(['hue', 'secondaryHue'] as const).map((key, index) => <div className="theme-hue-field" key={key}>
      <label className="theme-hue-label" htmlFor={`${id}-${key}`}>{index ? 'Secondary hue' : 'Primary hue'}<output>{theme[key]}°</output></label>
      <input id={`${id}-${key}`} className="theme-hue" type="range" min="0" max="359" step="1" value={theme[key]}
        onFocus={() => history.begin(key)} onBlur={history.boundary}
        onPointerDown={() => history.begin(key)} onPointerUp={history.boundary} onPointerCancel={history.boundary}
        onKeyUp={event => { if (event.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) history.boundary() }}
        onChange={event => { history.begin(key); onChange({ ...theme, [key]: Number(event.target.value) }) }} />
      <div className="palette-tone-preview" style={{ color: entries[index].strong }} aria-label={`${entries[index].name} preview`}>
        <span style={{ background: pageColor(theme) }}>Strong</span><span style={{ background: entries[index].soft }}>Strong on Soft</span>
      </div>
    </div>)}
    <p className="hint">Primary also colors interface accents. Secondary colors document content.</p>
    <div className="palette-preview" aria-label="Palette preview">
      {[entries.slice(0, 2), entries.slice(2, 8), entries.slice(8)].map((section, index) => <div className={`palette-group palette-group-${index}`} key={index}>
        {section.map(entry => <div className="palette-pair" key={entry.id}>
          <span className="palette-preview-swatch" title={entry.soft ? `${entry.name} · Strong` : entry.name} style={{ background: entry.strong }} />
          {entry.soft && <span className="palette-preview-swatch" title={`${entry.name} · Soft`} style={{ background: entry.soft }} />}
        </div>)}
      </div>)}
    </div>
    <p className="hint">Eight Strong / Soft pairs and six grays. Colors adapt when appearance changes; black and white exchange places.</p>
  </section>
}
