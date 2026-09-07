import { useState, type CSSProperties } from 'react'
import { blockClasses, inlineClasses, type BlockClass, type InlineClass, type Theme } from '../document/model'

export function themeVariables(theme: Theme): CSSProperties {
  const variables: Record<string, string> = {}
  for (const name of blockClasses) {
    const style = theme.blocks[name]
    variables[`--${name}-size`] = `${style.size}px`
    variables[`--${name}-color`] = style.color
    variables[`--${name}-family`] = style.family === 'serif' ? 'Georgia, serif' : 'system-ui, sans-serif'
  }
  for (const name of inlineClasses) {
    variables[`--${name}-color`] = theme.inline[name].color
    variables[`--${name}-background`] = theme.inline[name].background
  }
  return variables as CSSProperties
}

export function ThemePanel({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const [selected, setSelected] = useState<BlockClass | InlineClass>('body')
  const isBlock = blockClasses.includes(selected as BlockClass)
  const block = theme.blocks[selected as BlockClass]
  const inline = theme.inline[selected as InlineClass]

  function update(patch: object) {
    onChange(isBlock
      ? { ...theme, blocks: { ...theme.blocks, [selected]: { ...block, ...patch } } }
      : { ...theme, inline: { ...theme.inline, [selected]: { ...inline, ...patch } } })
  }

  return <section className="panel-section">
    <h2>Theme</h2>
    <p className="hint">Style a meaning, not a selection.</p>
    <label>Semantic class
      <select value={selected} onChange={event => setSelected(event.target.value as typeof selected)}>
        <optgroup label="Paragraphs">{blockClasses.map(name => <option key={name}>{name}</option>)}</optgroup>
        <optgroup label="Phrases">{inlineClasses.map(name => <option key={name}>{name}</option>)}</optgroup>
      </select>
    </label>
    {isBlock && <>
      <label>Typeface
        <select value={block.family} onChange={event => update({ family: event.target.value })}>
          <option value="sans">Sans serif</option><option value="serif">Serif</option>
        </select>
      </label>
      <label>Size <output>{block.size}px</output>
        <input aria-label="Theme font size" type="range" min="10" max="64" value={block.size} onChange={event => update({ size: Number(event.target.value) })} />
      </label>
    </>}
    <label className="color-field">Text color
      <input aria-label="Theme text color" type="color" value={(isBlock ? block : inline).color} onChange={event => update({ color: event.target.value })} />
    </label>
    {!isBlock && <label className="color-field">Highlight color
      <input aria-label="Theme highlight color" type="color" value={inline.background} onChange={event => update({ background: event.target.value })} />
    </label>}
  </section>
}
