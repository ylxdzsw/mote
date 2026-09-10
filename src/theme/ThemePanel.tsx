import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { themeBlockClasses, inlineClasses, type ThemeBlockClass, type InlineClass, type Theme, type ThemeLength } from '../document/model'
import { useHistory } from '../document/history'

function pixels(value: ThemeLength, base: number) {
  return typeof value === 'number' ? value : parseFloat(value) * (value.endsWith('em') ? base : 1)
}

export function themeVariables(theme: Theme): CSSProperties {
  const variables: Record<string, string> = { '--page-background': theme.defaults.background }
  for (const name of themeBlockClasses) {
    const style = { ...theme.defaults, ...theme.blocks[name] }
    variables[`--${name}-family`] = style.family === 'mono' ? 'ui-monospace, SFMono-Regular, Consolas, monospace'
      : style.family === 'serif' ? 'Georgia, serif' : 'system-ui, sans-serif'
    for (const property of ['size', 'spaceBefore', 'spaceAfter', 'letterSpacing'] as const) variables[`--${name}-${property}`] = `${pixels(style[property], theme.defaults.size)}px`
    variables[`--${name}-lineHeight`] = typeof style.lineHeight === 'number' ? String(style.lineHeight) : `${pixels(style.lineHeight, theme.defaults.size)}px`
    for (const property of ['color', 'weight'] as const) variables[`--${name}-${property}`] = String(style[property])
  }
  for (const name of inlineClasses) {
    const style = theme.inline[name]
    variables[`--${name}-color`] = style.color ?? 'inherit'
    variables[`--${name}-background`] = style.background ?? 'transparent'
    variables[`--${name}-weight`] = String(style.weight ?? 'inherit')
    variables[`--${name}-italic`] = style.italic === undefined ? 'inherit' : style.italic ? 'italic' : 'normal'
    variables[`--${name}-decoration`] = style.decoration ?? 'inherit'
  }
  return variables as CSSProperties
}

export const classLabel = (name: string) => name[0].toUpperCase() + name.slice(1)
export type ThemeClass = 'defaults' | ThemeBlockClass | InlineClass

export function NumberField({ label, value, onChange, min, max, step = 1, unit = 'px', units, onUnitChange }: {
  label: string; value: number; onChange: (value: number) => void; min: number; max: number; step?: number; unit?: string
  units?: string[]; onUnitChange?: (unit: string) => void
}) {
  const history = useHistory()
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  const invalid = draft !== '' && (!Number.isFinite(Number(draft)) || Number(draft) < min || Number(draft) > max)
  useEffect(() => { if (!focused.current) setDraft(String(value)) }, [value])
  return <><div className="number-field"><input aria-label={label} aria-invalid={invalid || undefined} type="number" min={min} max={max} step={step} value={draft}
    onFocus={() => { focused.current = true; history.begin(label) }}
    onBlur={() => { focused.current = false; setDraft(String(value)); history.boundary() }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
    onChange={event => {
      setDraft(event.target.value)
      const number = event.target.valueAsNumber
      if (Number.isFinite(number) && number >= min && number <= max) { history.begin(label); onChange(number) }
    }} />{units ? <select aria-label={`${label} unit`} value={unit} onChange={event => {
      history.boundary(); onUnitChange!(event.target.value)
    }}>{units.map(unit => <option key={unit}>{unit}</option>)}</select> : <span>{unit}</span>}</div>{invalid && <p className="field-error">Use {Number(min.toFixed(3))}–{Number(max.toFixed(3))}{unit === '×' ? '' : unit}.</p>}</>
}

function ColorField({ label, value, onChange, optional = false }: { label: string; value: string; onChange: (value: string) => void; optional?: boolean }) {
  const history = useHistory()
  return <div className="color-control">
    <input aria-label={label} type="color" value={value === 'transparent' ? '#ffffff' : value}
      onPointerDown={() => { history.boundary(); history.begin(label) }} onFocus={() => history.begin(label)}
      onBlur={history.boundary} onChange={event => { history.begin(label); onChange(event.target.value) }} />
    <span>{value === 'transparent' ? 'None' : value.toUpperCase()}</span>
    {optional && value !== 'transparent' && <button aria-label={`Clear ${label.toLowerCase()}`} onClick={() => { history.boundary(); onChange('transparent') }}>None</button>}
  </div>
}

export function ThemePanel({ theme, selected, onSelect, onChange }: {
  theme: Theme; selected: ThemeClass; onSelect: (value: ThemeClass) => void; onChange: (theme: Theme) => void
}) {
  const history = useHistory()
  const defaults = selected === 'defaults'
  const isBlock = themeBlockClasses.includes(selected as ThemeBlockClass)
  const styles = defaults ? theme.defaults : isBlock ? theme.blocks[selected as ThemeBlockClass] : theme.inline[selected as InlineClass]
  const resolved = { ...theme.defaults, ...styles }
  const values = styles as Record<string, string | number | boolean>

  function update(property: string, value?: string | number | boolean) {
    const next = { ...styles } as Record<string, string | number | boolean>
    if (value === undefined) delete next[property]; else next[property] = value
    onChange(defaults ? { ...theme, defaults: next as unknown as Theme['defaults'] }
      : isBlock ? { ...theme, blocks: { ...theme.blocks, [selected]: next } }
      : { ...theme, inline: { ...theme.inline, [selected]: next } })
  }
  function field(property: string, label: string, control: ReactNode) {
    const inherited = !defaults && values[property] === undefined
    return <div className="style-field" key={property}>
      <div className="field-heading"><span>{label}</span>{!defaults && (inherited
        ? <span className="inherited" title={isBlock ? 'Follows Defaults' : 'Follows the surrounding paragraph; background is transparent'}>Inherited</span>
        : <button aria-label={`Reset ${label.toLowerCase()} to inherited`} title="Use inherited value" onClick={() => { history.boundary(); update(property) }}>↶</button>)}</div>
      {control}
    </div>
  }
  function number(property: keyof Theme['defaults'], label: string, min: number, max: number, step = 1, unit = 'px') {
    return field(property, label, <NumberField label={label} value={resolved[property] as number} min={min} max={max} step={step} unit={unit}
      onChange={value => update(property, value)} />)
  }
  function length(property: 'size' | 'lineHeight' | 'letterSpacing' | 'spaceBefore' | 'spaceAfter', label: string, min: number, max: number, step = 1) {
    const value = resolved[property]
    const base = theme.defaults.size
    const fontSize = pixels(resolved.size, base)
    const unit = typeof value === 'number' ? property === 'lineHeight' ? '×' : 'px' : value.endsWith('em') ? 'em' : 'px'
    const divisor = unit === 'em' ? base : unit === '×' ? fontSize : 1
    return field(property, label, <NumberField label={label} value={typeof value === 'number' ? value : parseFloat(value)}
      min={min / divisor} max={max / divisor} step={unit === 'px' ? step : .025} unit={unit}
      units={property === 'lineHeight' ? ['em', 'px', '×'] : ['em', 'px']}
      onChange={value => update(property, unit === '×' ? value : `${value}${unit}`)}
      onUnitChange={nextUnit => {
        const absolute = unit === '×' ? Number(value) * fontSize : pixels(value, base)
        const next = Number((absolute / (nextUnit === 'em' ? base : nextUnit === '×' ? fontSize : 1)).toFixed(6))
        update(property, nextUnit === '×' ? next : `${next}${nextUnit}`)
      }} />)
  }
  function choose(property: string, label: string, choices: [string, string][], value: string, parse: (value: string) => string | number | boolean = value => value) {
    const inherited = choices.find(([value]) => value === String(resolved[property as keyof typeof resolved]))?.[1]
    return field(property, label, <select aria-label={label} value={value} onChange={event => {
      history.boundary(); update(property, event.target.value === 'inherit' ? undefined : parse(event.target.value))
    }}>
      {!defaults && <option value="inherit">Inherited · {isBlock ? inherited : 'surrounding text'}</option>}
      {choices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>)
  }

  return <>
    <nav className="theme-classes" aria-label="Theme classes">
      {([['', ['defaults']], ['Paragraphs', themeBlockClasses], ['Phrases', inlineClasses]] as const).map(([label, names]) => <div key={label}>
        {label && <h3>{label}</h3>}
        <div className="class-buttons">{names.map(name => <button key={name} aria-pressed={selected === name}
          onClick={() => { history.boundary(); onSelect(name) }}>{classLabel(name)}</button>)}</div>
      </div>)}
    </nav>
    <section className="panel-section class-properties" key={selected}>
      <h2>{classLabel(selected)}</h2>
      <p className="hint">{defaults ? 'The shared baseline for paragraph styles. Font size defines 1em.' : isBlock ? 'Every paragraph with this meaning follows this style.' : 'Applied within any paragraph, including table cells.'}</p>
      {(defaults || isBlock) && <p className="hint">1em = Defaults font size ({theme.defaults.size}px), including spacing and line height. × line height follows this paragraph’s font size.</p>}
      {(defaults || isBlock) && <>
        {choose('family', 'Typeface', [['sans', 'Sans serif'], ['serif', 'Serif'], ['mono', 'Monospace']], !defaults && values.family === undefined ? 'inherit' : resolved.family)}
        {defaults ? number('size', 'Font size', 8, 96, .5) : length('size', 'Font size', 1, 512, .5)}
      </>}
      {choose('weight', 'Weight', [['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold']], !defaults && values.weight === undefined ? 'inherit' : String(resolved.weight), Number)}
      {field('color', 'Text color', <ColorField label="Text color" value={resolved.color} onChange={value => update('color', value)} />)}
      {defaults && field('background', 'Page background', <ColorField label="Page background" value={theme.defaults.background} onChange={value => update('background', value)} />)}
      {(defaults || isBlock) ? <>
        {length('lineHeight', 'Line height', 1, 1024, .5)}
        {length('letterSpacing', 'Letter spacing', -64, 64, .1)}
        <div className="paired-fields">{length('spaceBefore', 'Space before', 0, 2000)}{length('spaceAfter', 'Space after', 0, 2000)}</div>
      </> : <>
        {field('background', 'Highlight', <ColorField label="Highlight" value={String(values.background ?? 'transparent')} optional onChange={value => update('background', value)} />)}
        {choose('italic', 'Slant', [['false', 'Normal'], ['true', 'Italic']], values.italic === undefined ? 'inherit' : String(values.italic), value => value === 'true')}
        {choose('decoration', 'Decoration', [['none', 'None'], ['underline', 'Underline'], ['line-through', 'Strikethrough']], String(values.decoration ?? 'inherit'))}
      </>}
      <div className="theme-sample text-content" style={{ ...themeVariables(defaults ? { ...theme, blocks: { ...theme.blocks, body: {} } } : theme), background: theme.defaults.background }} aria-label="Style sample">
        {selected === 'code' ? <pre data-semantic="code"><code>{'const thought = {\n  room: "to think"\n}'}</code></pre>
          : selected === 'list' ? <><p data-semantic="list" data-list-level="0">A thought to keep</p><p data-semantic="list" data-list-level="1" style={{ '--list-level': 1 } as CSSProperties}>A little more detail</p></>
          : <p data-semantic={isBlock ? selected : 'body'}>{defaults || isBlock ? 'A little room to think.' : <>A thought with <span data-inline-semantic={selected}>something to remember</span>.</>}</p>}
      </div>
      {!defaults && <button disabled={!Object.keys(styles).length} onClick={() => {
        history.boundary()
        onChange(isBlock ? { ...theme, blocks: { ...theme.blocks, [selected]: {} } } : { ...theme, inline: { ...theme.inline, [selected]: {} } })
      }}>Reset class overrides</button>}
    </section>
  </>
}
