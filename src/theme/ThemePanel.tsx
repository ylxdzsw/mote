import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { blockClasses, inlineClasses, type BlockClass, type InlineClass, type Theme } from '../document/model'
import { useHistory } from '../document/history'

export function themeVariables(theme: Theme): CSSProperties {
  const variables: Record<string, string> = { '--page-background': theme.defaults.background }
  for (const name of blockClasses) {
    const style = { ...theme.defaults, ...theme.blocks[name] }
    variables[`--${name}-family`] = style.family === 'mono' ? 'ui-monospace, SFMono-Regular, Consolas, monospace'
      : style.family === 'serif' ? 'Georgia, serif' : 'system-ui, sans-serif'
    for (const property of ['size', 'spaceBefore', 'spaceAfter', 'letterSpacing'] as const) variables[`--${name}-${property}`] = `${style[property]}px`
    for (const property of ['color', 'weight', 'lineHeight'] as const) variables[`--${name}-${property}`] = String(style[property])
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
export type ThemeClass = 'defaults' | BlockClass | InlineClass

export function NumberField({ label, value, onChange, min, max, step = 1, unit = 'px' }: {
  label: string; value: number; onChange: (value: number) => void; min: number; max: number; step?: number; unit?: string
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
    }} /><span>{unit}</span></div>{invalid && <p className="field-error">Use {min}–{max}{unit === 'px' ? 'px' : ''}.</p>}</>
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
  const isBlock = blockClasses.includes(selected as BlockClass)
  const styles = defaults ? theme.defaults : isBlock ? theme.blocks[selected as BlockClass] : theme.inline[selected as InlineClass]
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
      {([['', ['defaults']], ['Paragraphs', blockClasses], ['Phrases', inlineClasses]] as const).map(([label, names]) => <div key={label}>
        {label && <h3>{label}</h3>}
        <div className="class-buttons">{names.map(name => <button key={name} aria-pressed={selected === name}
          onClick={() => { history.boundary(); onSelect(name) }}>{classLabel(name)}</button>)}</div>
      </div>)}
    </nav>
    <section className="panel-section class-properties" key={selected}>
      <h2>{classLabel(selected)}</h2>
      <p className="hint">{defaults ? 'The shared baseline for paragraph styles.' : isBlock ? 'Every paragraph with this meaning follows this style.' : 'Applied within any paragraph, including table cells.'}</p>
      {(defaults || isBlock) && <>
        {choose('family', 'Typeface', [['sans', 'Sans serif'], ['serif', 'Serif'], ['mono', 'Monospace']], !defaults && values.family === undefined ? 'inherit' : resolved.family)}
        {number('size', 'Font size', 8, 96, .5)}
      </>}
      {choose('weight', 'Weight', [['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold']], !defaults && values.weight === undefined ? 'inherit' : String(resolved.weight), Number)}
      {field('color', 'Text color', <ColorField label="Text color" value={resolved.color} onChange={value => update('color', value)} />)}
      {defaults && field('background', 'Page background', <ColorField label="Page background" value={theme.defaults.background} onChange={value => update('background', value)} />)}
      {(defaults || isBlock) ? <>
        {number('lineHeight', 'Line height', .8, 3, .05, '×')}
        {number('letterSpacing', 'Letter spacing', -3, 10, .1)}
        <div className="paired-fields">{number('spaceBefore', 'Space before', 0, 200)}{number('spaceAfter', 'Space after', 0, 200)}</div>
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
