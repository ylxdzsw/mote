import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { px, themeBlockClasses, type DocumentLanguage, type ThemeBlockClass, type Theme, type LineHeight, type BlockClass, type ThemeLength } from '../document/model'
import { useHistory } from '../document/history'
import { paletteColor, paletteEntries, pageColor } from './palette'
import { PaletteControl, PaletteEditor } from './PaletteControl'
import { MathView } from '../canvas/MathView'
import { CodeView } from '../canvas/CodeView'
import { PanelIcon } from '../app/PanelIcon'

export function pixels(value: ThemeLength | LineHeight | number, base: number, fontSize = base) {
  return typeof value === 'number' ? value : value.value * (value.unit === 'em' ? base : value.unit === 'ratio' ? fontSize : 1)
}

function blockOverrides(theme: Theme, name: ThemeBlockClass) {
  return (name === 'table' || name === 'code' || name === 'formula' ? theme.objects[name] : theme.paragraphs[name]) ?? {}
}

function setOverrides(theme: Theme, name: ThemeBlockClass, style: object): Theme {
  return name === 'table' || name === 'code' || name === 'formula'
    ? { ...theme, objects: { ...theme.objects, [name]: style } }
    : { ...theme, paragraphs: { ...theme.paragraphs, [name as BlockClass]: style } }
}

export function themeVariables(theme: Theme, language: DocumentLanguage): CSSProperties {
  const neutralSoft = paletteColor(theme, 'gray5')
  const body = { ...theme.defaults, ...(theme.paragraphs.body ?? {}) }
  const variables: Record<string, string> = {
    '--page-background': pageColor(theme),
    '--text-autospace': theme.autospace === false ? 'no-autospace' : 'normal',
    '--flow-spaceBefore': `${pixels(theme.flow?.spaceBefore ?? 0, theme.defaults.size)}px`,
    '--flow-spaceAfter': `${pixels(theme.flow?.spaceAfter ?? body.spaceAfter, theme.defaults.size)}px`,
  }
  for (const entry of paletteEntries(theme)) {
    const soft = entry.soft ?? neutralSoft
    variables[`--palette-${entry.id}`] = entry.strong
    variables[`--palette-${entry.id}-soft`] = soft
    variables[`--palette-${entry.id}-surface`] = soft
  }
  for (const name of themeBlockClasses) {
    const style = { ...theme.defaults, ...blockOverrides(theme, name) }
    if (name === 'formula') {
      variables[`--${name === 'formula' ? 'math' : name}-size`] = `${pixels(style.size, theme.defaults.size)}px`
      variables[`--${name === 'formula' ? 'math' : name}-color`] = paletteColor(theme, style.color)
      continue
    }
    variables[`--${name}-family`] = name === 'code' || style.family === 'mono' ? 'ui-monospace, SFMono-Regular, Consolas, "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Microsoft YaHei", monospace'
      : style.family === 'serif' ? 'Georgia, "Songti SC", SimSun, "Noto Serif CJK SC", "Noto Serif SC", serif'
      : `${language === 'en' ? 'Inter, "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", "Liberation Sans", ' : ''}"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif`
    if (name === 'code') variables['--code-family'] = variables['--code-family'].replace('"Microsoft YaHei", ', '')
    for (const property of ['size', 'spaceBefore', 'spaceAfter', 'letterSpacing'] as const) variables[`--${name}-${property}`] = `${pixels(style[property], theme.defaults.size)}px`
    variables[`--${name}-lineHeight`] = `${pixels(style.lineHeight, theme.defaults.size, pixels(style.size, theme.defaults.size))}px`
    variables[`--${name}-color`] = paletteColor(theme, style.color)
    variables[`--${name}-weight`] = String(style.weight)
  }
  return variables as CSSProperties
}

export const classLabel = (name: string) => name === 'flow' ? 'Flow objects' : name[0].toUpperCase() + name.slice(1)
export type ThemeClass = 'defaults' | 'palette' | ThemeBlockClass | 'flow'

export function NumberField({ label, value, onChange, min, max, step = 1, unit = 'px', units, onUnitChange }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number | 'any'; unit?: string
  units?: string[]; onUnitChange?: (unit: string) => void
}) {
  const history = useHistory()
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  const invalid = draft !== '' && (!Number.isFinite(Number(draft)) || (min !== undefined && Number(draft) < min) || (max !== undefined && Number(draft) > max))
  useEffect(() => { if (!focused.current) setDraft(String(value)) }, [value])
  return <><div className="number-field"><input aria-label={label} aria-invalid={invalid || undefined} type="number" min={min} max={max} step={step} value={draft}
    onFocus={() => { focused.current = true; history.begin(label) }}
    onBlur={() => { focused.current = false; setDraft(String(value)); history.boundary() }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
    onChange={event => {
      setDraft(event.target.value)
      const number = event.target.valueAsNumber
      if (Number.isFinite(number) && (min === undefined || number >= min) && (max === undefined || number <= max)) { history.begin(label); onChange(number) }
    }} />{units ? <select aria-label={`${label} unit`} value={unit} onChange={event => {
      history.boundary(); onUnitChange!(event.target.value)
    }}>{units.map(unit => <option key={unit}>{unit}</option>)}</select> : <span>{unit}</span>}</div>{invalid && <p className="field-error">{min === undefined && max === undefined ? 'Enter a finite number.' : `Use ${min === undefined ? 'any' : Number(min.toFixed(3))}–${max === undefined ? 'any' : Number(max.toFixed(3))}${unit === '×' ? '' : unit}.`}</p>}</>
}

export function ThemePanel({ theme, language, selected, onSelect, onChange }: {
  theme: Theme; language: DocumentLanguage; selected: ThemeClass; onSelect: (value: ThemeClass) => void; onChange: (theme: Theme) => void
}) {
  const history = useHistory()
  const defaults = selected === 'defaults'
  const palette = selected === 'palette'
  const isFlow = selected === 'flow'
  const isBlock = !defaults && !palette && themeBlockClasses.includes(selected as ThemeBlockClass)
  const isMath = selected === 'formula'
  const isCode = selected === 'code'
  const isParagraphBlock = isBlock && !isMath && !isCode
  const styles = defaults ? theme.defaults : isFlow ? theme.flow ?? {} : isBlock ? blockOverrides(theme, selected as ThemeBlockClass) : {}
  const bodyStyle = { ...theme.defaults, ...(theme.paragraphs.body ?? {}) }
  const resolved = isFlow
    ? { ...theme.defaults, spaceBefore: px(0), spaceAfter: bodyStyle.spaceAfter, ...styles }
    : { ...theme.defaults, ...styles }
  const values = styles as Record<string, string | number | boolean | LineHeight | undefined>

  function update(property: string, value?: string | number | boolean | LineHeight) {
    if (palette) return
    const next = { ...styles } as Record<string, string | number | boolean | LineHeight>
    if (value === undefined) delete next[property]; else next[property] = value
    if (defaults) onChange({ ...theme, defaults: next as unknown as Theme['defaults'] })
    else if (isFlow) {
      const updated = { ...theme }
      if (Object.keys(next).length) updated.flow = next as Theme['flow']
      else updated.flow = {}
      onChange(updated)
    } else onChange(setOverrides(theme, selected as ThemeBlockClass, next))
  }
  function field(property: string, label: string, control: ReactNode) {
    const inherited = !defaults && values[property] === undefined
    const source = isFlow ? property === 'spaceBefore' ? 'default (0px)' : 'Body' : 'Defaults'
    const resetTarget = isFlow && property === 'spaceBefore' ? 'default' : 'inherited'
    return <div className="style-field" key={property}>
      <div className="field-heading"><span>{label}</span>{!defaults && (inherited
        ? <span className="inherit-indicator" role="img" aria-label={`${label} inherited from ${source}`} title={`Inherited from ${source}`}><PanelIcon name="inherit" /></span>
        : <button className="inherit-reset" aria-label={`Reset ${label.toLowerCase()} to ${resetTarget}`} title={`Inherit from ${source}`} onClick={() => { history.boundary(); update(property) }}><PanelIcon name="reset" /></button>)}</div>
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
    const unit = typeof value === 'number' ? 'px' : value.unit === 'ratio' ? '×' : value.unit
    const divisor = unit === 'em' ? base : unit === '×' ? fontSize : 1
    return field(property, label, <NumberField label={label} value={typeof value === 'number' ? value : value.value}
      min={min / divisor} max={max / divisor} step={unit === 'px' ? step : .025} unit={unit}
      units={property === 'lineHeight' ? ['em', 'px', '×'] : ['em', 'px']}
      onChange={value => update(property, { value, unit: unit === '×' ? 'ratio' : unit })}
      onUnitChange={nextUnit => {
        const absolute = pixels(value, base, fontSize)
        const next = Number((absolute / (nextUnit === 'em' ? base : nextUnit === '×' ? fontSize : 1)).toFixed(6))
        update(property, { value: next, unit: nextUnit === '×' ? 'ratio' : nextUnit as 'em' | 'px' })
      }} />)
  }
  function choose(property: string, label: string, choices: [string, string][], parse: (value: string) => string | number | boolean | LineHeight = value => value) {
    return field(property, label, <select aria-label={label} value={String(resolved[property as keyof typeof resolved])} onChange={event => {
      history.boundary(); update(property, parse(event.target.value))
    }}>
      {choices.map(([choice, choiceLabel]) => <option key={choice} value={choice}>{choiceLabel}</option>)}
    </select>)
  }
  function paletteField(property: 'color', label: string) {
    const value = String(resolved[property])
    return field(property, label, <PaletteControl theme={theme} label={label} value={value} onChange={next => { if (next) update(property, next) }}
      onFocus={() => history.begin(`theme-${selected}-${property}`)} onBlur={history.boundary} />)
  }

  return <>
    <nav className="theme-classes" aria-label="Theme classes">
      {([['', ['defaults', 'palette']], ['Paragraphs', themeBlockClasses.filter(name => name !== 'formula' && name !== 'code' && name !== 'table')], ['Objects', ['flow', 'table', 'formula', 'code']]] as const).map(([label, names]) => <div key={label}>
        {label && <h3>{label}</h3>}
        <div className="class-buttons">{names.map(name => <button key={name} aria-pressed={selected === name}
          onClick={() => { history.boundary(); onSelect(name) }}>{classLabel(name)}</button>)}</div>
      </div>)}
    </nav>
    {palette ? <PaletteEditor theme={theme} onChange={onChange} /> : <section className="panel-section class-properties" key={selected}>
      <h2>{classLabel(selected)}</h2>
      <p className="hint">{defaults ? 'The shared baseline for paragraph styles. Font size defines 1em.' : isFlow ? 'Spacing for every Flow object. Space before defaults to 0; Space after follows Body.' : isCode ? 'Every code object uses monospace typography. Syntax colors follow the document appearance.' : isMath ? 'Math follows Defaults except for size and color overrides.' : 'Every paragraph with this meaning follows this style.'}</p>
      {(defaults || isParagraphBlock) && <>
        {choose('family', 'Typeface', [['sans', 'Sans serif'], ['serif', 'Serif'], ['mono', 'Monospace']])}
        {defaults ? number('size', 'Font size', 8, 96, .5) : length('size', 'Font size', 1, 512, .5)}
      </>}
      {(isMath || isCode) && length('size', 'Font size', 1, 512, .5)}
      {(defaults || isParagraphBlock || isMath || isCode) && !isMath && choose('weight', 'Weight', [['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold']], Number)}
      {!isFlow && !isCode && paletteField('color', 'Text color')}
      {defaults && <>
        <label className="link-margins"><input type="checkbox" checked={theme.autospace !== false} onChange={event => {
          history.boundary(); onChange({ ...theme, autospace: event.target.checked })
        }} /> Mixed-script spacing</label>
      </>}
      {(defaults || isParagraphBlock || isCode) && <>
        {length('lineHeight', 'Line height', 1, 1024, .5)}
        {length('letterSpacing', 'Letter spacing', -64, 64, .1)}
        {!isCode && <div className="paired-fields">{length('spaceBefore', 'Space before', 0, 2000)}{length('spaceAfter', 'Space after', 0, 2000)}</div>}
      </>}
      {isFlow && <div className="paired-fields">{length('spaceBefore', 'Space before', 0, 2000)}{length('spaceAfter', 'Space after', 0, 2000)}</div>}
      <div className="theme-sample text-content" lang={language} data-mode={theme.appearance.mode} style={{ ...themeVariables(defaults ? { ...theme, paragraphs: { ...theme.paragraphs, body: {} } } : theme, language), background: pageColor(theme) }} aria-label="Style sample">
        {selected === 'formula' ? <MathView latex="E=mc^2" />
          : selected === 'code' ? <CodeView note={{ id: 'sample', kind: 'code', layout: { width: 300, placement: { type: 'float', anchorId: null, x: 0, y: 0 } }, language: 'javascript', source: 'const thought = {\n  room: "思考空间"\n}' }} editable={false} staticOnly />
          : isFlow ? <><p>Text before</p><div title="Flow object" style={{ marginBlockStart: 'var(--flow-spaceBefore)', marginBlockEnd: 'var(--flow-spaceAfter)', border: '1px solid var(--ui-border)', borderRadius: 4, padding: 8, color: 'var(--ui-muted)' }}>Flow object</div><p>Text after</p></>
          : selected === 'list' ? <><p data-semantic="list" data-list-level="0">A thought to keep</p><p data-semantic="list" data-list-level="1" style={{ '--list-level': 1 } as CSSProperties}><span lang="zh-Hans">用Mote记录想法</span></p></>
          : <p data-semantic={isBlock ? selected : 'body'}>A little room to think.<br /><span lang="zh-Hans">用Mote记录想法，留下思考空间。</span></p>}
      </div>
      {!defaults && <button className="reset-class-overrides" disabled={!Object.keys(styles).length} onClick={() => {
        history.boundary()
        if (isFlow) {
          const updated = { ...theme }
          updated.flow = {}
          onChange(updated)
        } else onChange(setOverrides(theme, selected as ThemeBlockClass, {}))
      }}><PanelIcon name="reset" /> Reset class overrides</button>}
      <details className="settings-help"><summary>Typography details</summary>
        <p>1em = Defaults font size ({theme.defaults.size}px). × line height follows the local font size.</p>
        {!defaults && <p className="inherit-help"><PanelIcon name="inherit" /> marks an inherited value. <PanelIcon name="reset" /> resets an override to inherit again.</p>}
        {(defaults || isParagraphBlock || isFlow) && <p>Adjacent paragraph and Flow spacing collapses to the larger value, including at the page’s top and bottom margins. Object margins add to that gap; explicit spaces add a separate pause.</p>}
        {(defaults || isParagraphBlock) && <p>{resolved.family === 'sans' ? language === 'en' ? 'Prefers Latin fonts for English, with Microsoft YaHei, PingFang SC, and Noto Sans SC for Chinese.' : 'Prefers Microsoft YaHei, then PingFang SC and Noto Sans SC.' : resolved.family === 'serif' ? 'Georgia for English; Songti SC, SimSun, or Noto Serif SC for Chinese.' : 'System monospace with Simplified Chinese fallbacks. Mixed-script cell widths can vary.'} Uses installed fonts.</p>}
        {defaults && <p>Mixed-script spacing adds a small gap between Chinese and English letters or numbers where supported. It does not change your text; Code stays literal.</p>}
      </details>
    </section>}
  </>
}
