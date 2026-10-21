import React, { useState, useRef, useEffect, type ReactNode, type CSSProperties } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { NodeSelection, type Command } from '@tiptap/pm/state'
import { addRowAfter, deleteRow } from '@tiptap/pm/tables'
import { alignColumns, changeColumns } from '../editor/table'
import { classLabel } from '../theme/ThemePanel'
import { blockClasses, type BlockClass, type Theme } from '../document/model'
import { changeListLevel, setParagraphClass } from '../editor/paragraphBehavior'
import { selectedInlineMarks, type InlineDecorationValue } from '../editor/inline'
import { neutralIds, paletteColor, paletteEntries } from '../theme/palette'
import { PanelIcon } from './PanelIcon'
import './inspector.css'

type TIconName = 'bold' | 'color' | 'box' | 'underline' | 'plain' | 'chevron' | 'clear' | BlockClass
function TIcon({ name }: { name: TIconName }) {
  const bodyPath = <path d="M13 19V5H9a4 4 0 0 0 0 8h4M17 5v14M10 5h9" />
  const paths: Record<TIconName, React.ReactNode> = {
    body: bodyPath,
    heading: <path d="M6 5v14M18 5v14M6 12h12" />,
    title: <path d="M4 8V4h16v4M12 4v13M8 17h8M5 21h14" />,
    caption: <><rect x="4" y="4" width="16" height="9" rx="1" /><path d="M7 17h10M9 20h6" /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="3" /></>,
    bold: <path d="M7 12h7a4 4 0 0 1 0 8H7V4h6a4 4 0 0 1 0 8" strokeWidth="2.8" />,
    color: <><circle cx="12" cy="12" r="8" /><path d="M8 16h8" strokeWidth="3" /></>,
    box: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m8 17 4-10 4 10M9.2 14h5.6" strokeWidth="1.5" /></>,
    underline: <path d="M7 5v6a5 5 0 0 0 10 0V5M5 19h14" />,
    plain: <path d="m5 16 8-11a2 2 0 0 1 3 0l4 3a2 2 0 0 1 0 3l-7 9H9l-4-4ZM9 11l7 6M13 20h8" />,
    clear: <><path d="m5 16 8-11a2 2 0 0 1 3 0l4 3a2 2 0 0 1 0 3l-7 9H9l-4-4Z" /><path d="m9 11 7 6" /></>,
    chevron: <path d="m7 10 5 5 5-5" />,
  }
  return <svg className="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width="16" height="16">{paths[name]}</svg>
}

function ToolPopup({ label, children, items, disabled }: {
  label: string; children: React.ReactNode
  items: { id: string; label: string; icon: React.ReactNode; checked?: boolean; action: () => void; separator?: boolean; disabled?: boolean }[]
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerId = React.useId()
  useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    const outside = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  return <div className="tt-popup" ref={rootRef} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
    <button className="tt-btn" aria-label={label} title={label} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open} id={triggerId}
      onMouseDown={e => e.preventDefault()} onClick={() => setOpen(!open)}>
      {children}<TIcon name="chevron" />
    </button>
    {open && <div className="tt-popup-panel" role="menu" aria-label={label}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('.tt-btn')?.focus(); return }
        const btns = [...rootRef.current!.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')]
        const i = btns.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'ArrowDown' ? (i+1)%btns.length : e.key === 'ArrowUp' ? (i-1+btns.length)%btns.length : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : -1
        if (next >= 0) { e.preventDefault(); btns[next]?.focus() }
      }}>
      {items.map(item => <div key={item.id} role="none">
        {item.separator && <div className="tt-sep" role="separator" />}
        <button role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} tabIndex={-1} aria-checked={item.checked} disabled={item.disabled}
          onMouseDown={e => e.preventDefault()}
          onClick={() => { setOpen(false); item.action() }}>
          {item.icon}<span>{item.label}</span>
          {item.checked !== undefined && <span aria-hidden="true">{item.checked ? '✓' : ''}</span>}
        </button>
      </div>)}
    </div>}
  </div>
}

function selectedClasses(editor: Editor | null) {
  const paragraphs = new Set<string>()
  if (!editor || editor.state.selection instanceof NodeSelection) return { paragraph: '', text: false, list: false, fixed: '', ...selectedInlineMarks(null) }
  const { selection, doc } = editor.state
  for (const { $from, $to } of selection.ranges) {
    doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.type.name === 'paragraph' && ($from.pos === $to.pos || pos + 1 < $to.pos)) {
        paragraphs.add(node.attrs.semantic ?? 'body')
      }
    })
  }
  const inline = selectedInlineMarks(editor)
  return {
    paragraph: paragraphs.size === 1 ? [...paragraphs][0] : '',
    text: paragraphs.size > 0, list: paragraphs.has('list'),
    fixed: editor.schema.nodes.table ? 'Table' : '',
    ...inline,
  }
}

export function InspectorGroup({ title, children, divided = false }: { title: string; children: ReactNode; divided?: boolean }) {
  return <section className={`inspector-group${divided ? ' is-divided' : ''}`} aria-label={title}>
    <h3>{title}</h3>{children}
  </section>
}

export function InspectorField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="inspector-field" role="group" aria-label={label}><div className="field-heading">{label}</div>{children}</div>
}

export function InspectorRow({ children }: { children: ReactNode }) {
  return <div className="inspector-row">{children}</div>
}

export function InspectorHelp({ children }: { children: ReactNode }) {
  return <details className="inspector-help"><summary>Help &amp; shortcuts</summary><div>{children}</div></details>
}

export function ContextHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return <header className="context-heading"><h2>{title}</h2><p>{subtitle}</p></header>
}

export function TypographyPreview({ theme, semantic }: { theme: Theme; semantic: string }) {
  const style = { ...theme.defaults, ...theme.blocks[semantic as keyof Theme['blocks']] }
  return <div className="style-preview">
    <span aria-hidden="true" style={{ fontFamily: style.family === 'serif' ? 'Georgia, serif' : style.family === 'mono' ? 'ui-monospace, monospace' : 'inherit', fontWeight: style.weight }}>Aa</span>
    <div>{classLabel(semantic)}<small>Document theme</small></div>
  </div>
}

export function TextInspector({ theme, semantic, listLevel, onTheme, onRevise, reviseDisabled }: {
  theme: Theme; semantic: string; listLevel: number; onTheme: (name: string) => void; onRevise?: () => void; reviseDisabled?: boolean
}) {
  return <div className="context-inspector">
    <ContextHeading title={semantic === 'list' ? 'List item' : `${classLabel(semantic)} paragraph`} subtitle={semantic === 'list' ? `Main document text · Level ${listLevel + 1}` : 'Main document text'} />
    <InspectorGroup title="Typography">
      <TypographyPreview theme={theme} semantic={semantic} />
      <button onClick={() => onTheme(semantic)}>Edit {semantic} style <PanelIcon name="sliders" /></button>
      <button className="quiet-action" onClick={() => onTheme('palette')}>Document palette <PanelIcon name="arrow" /></button>
    </InspectorGroup>
    {onRevise && <InspectorGroup title="Assistant">
      <button data-ai-segment-action onClick={onRevise} disabled={reviseDisabled}>Revise this passage <PanelIcon name="spark" /></button>
    </InspectorGroup>}
    <InspectorHelp key={semantic}>
      {semantic === 'body' && <p>Tab turns a Body paragraph into a list. Shift+Tab returns a top-level item to Body.</p>}
      {semantic === 'list' && <p>Each item is independent. Enter creates an item at the same level; Shift+Enter adds a line within it. Backspace at the start outdents, or returns a top-level item to Body.</p>}
      <p>Revise this passage uses the selected segment, selected paragraphs, or the paragraph at the caret. Styles apply to every paragraph of their class.</p>
      <p>With no text selected, Ctrl/⌘C copies the paragraph and Ctrl/⌘X cuts it. Whole paragraphs paste below; Ctrl/⌘Shift+V pastes plain text at the caret.</p>
      <p>Drag the strip just left of the page to select a segment, then drag its highlight to move it, or copy or cut it. Adjust its boundary handles; hold Alt to split an inserted space. Escape clears the selection.</p>
      <p>Hold Alt and drag between paragraphs to add room. Drag inside a gap or its first text line below to resize it; pull up to close it. Drag other empty areas to select objects.</p>
    </InspectorHelp>
  </div>
}

export interface TableInspectorSelection {
  tableRect: { removeRow: boolean; removeColumn: boolean } | null
  columnAlignment: 'left' | 'center' | 'right' | null
}

export function TableControls({ selection, onCommand }: { selection: TableInspectorSelection | null; onCommand: (command: Command) => void }) {
  return <InspectorGroup title="Cells">
    <div className="inspector-stack" onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }}>
      <InspectorField label="Rows"><InspectorRow>
        <button aria-label="Add row below" disabled={!selection?.tableRect} onClick={() => onCommand(addRowAfter)}>Add below</button>
        <button aria-label="Remove row" disabled={!selection?.tableRect?.removeRow} onClick={() => onCommand(deleteRow)}>Remove</button>
      </InspectorRow></InspectorField>
      <InspectorField label="Columns"><InspectorRow>
        <button aria-label="Add column after" disabled={!selection?.tableRect} onClick={() => onCommand(changeColumns())}>Add after</button>
        <button aria-label="Remove column" disabled={!selection?.tableRect?.removeColumn} onClick={() => onCommand(changeColumns(true))}>Remove</button>
      </InspectorRow></InspectorField>
      <InspectorField label="Column alignment">
        <div className="column-alignment">
          {(['left', 'center', 'right'] as const).map(align => <button key={align} disabled={!selection?.tableRect}
            aria-pressed={selection?.columnAlignment === align} onClick={() => onCommand(alignColumns(align))}>{classLabel(align)}</button>)}
        </div>
        <p className="hint">{selection?.tableRect ? 'Applies to entire selected columns.' : 'Click a cell to edit rows, columns, and alignment.'}</p>
      </InspectorField>
    </div>
  </InspectorGroup>
}

const neutralSet = new Set<string>(neutralIds)
function colorEntries(theme: Theme) {
  return paletteEntries(theme).filter(e => e.id === 'ink' || e.id === 'muted' || !neutralSet.has(e.id))
}
function swatchColor(theme: Theme, reference: string | null | 'mixed') {
  if (!reference || reference === 'mixed') return undefined
  const [id, tone] = reference.split(':')
  const entry = paletteEntries(theme).find(v => v.id === id)
  return tone === 'soft' ? entry?.soft ?? entry?.strong : entry?.strong
}

export interface TextToolsRowProps {
  editor: Editor | null
  theme: Theme
  onPalette?: () => void
  recentColors?: string[]
  onColorApplied?: (color: string) => void
}

export function TextToolsRow({ editor, theme, onPalette, recentColors = [], onColorApplied }: TextToolsRowProps) {
  const tools = useRef<HTMLDivElement>(null)
  const selection = useEditorState({ editor, selector: () => selectedClasses(editor) }) ?? selectedClasses(null)
  useEffect(() => {
    if (!selection.text) return
    function focusTools(event: KeyboardEvent) {
      if (event.altKey && event.key === 'F10' && !event.isComposing) {
        event.preventDefault(); tools.current?.querySelector<HTMLButtonElement>('.tt-btn:not(:disabled)')?.focus()
      }
    }
    window.addEventListener('keydown', focusTools)
    return () => window.removeEventListener('keydown', focusTools)
  }, [selection.text])
  if (!selection.text) return null

  const paragraphDisabled = !editor?.isEditable || !selection.text || !!selection.fixed
  const inlineDisabled = !editor?.isEditable || !selection.text

  const applyParagraph = (name: BlockClass) => { if (editor) setParagraphClass(editor, name) }
  const applyBold = () => editor?.chain().focus().toggleMark('bold').run()
  const applyColor = (color: string | null) => {
    if (!editor) return
    const chain = editor.chain().focus()
    if (color) { if (chain.setMark('color', { color }).run()) onColorApplied?.(color) }
    else chain.unsetMark('color').run()
  }
  const applyDecoration = (decoration: InlineDecorationValue, toggle = true) => {
    if (!editor) return
    const chain = editor.chain().focus()
    if (toggle && selection.decoration === decoration) chain.unsetMark('decoration').run()
    else chain.setMark('decoration', { decoration }).run()
  }

  const paragraph = (selection.fixed.toLowerCase() || selection.paragraph) as keyof Theme['blocks']
  const inheritedColor = theme.blocks[paragraph]?.color ?? theme.defaults.color
  const colorSwatch = swatchColor(theme, selection.color === null ? inheritedColor : selection.color)
  return <div className="text-tools" ref={tools}
    style={{ '--palette-ink': paletteColor(theme, 'ink'), '--palette-muted': paletteColor(theme, 'muted'), '--palette-paper': paletteColor(theme, 'paper') } as CSSProperties}>
    <div className="tools-heading"><span>Text</span><button title="Focus text tools · Alt F10" onClick={() => tools.current?.querySelector<HTMLButtonElement>('.tt-btn:not(:disabled)')?.focus()}><kbd>Alt F10</kbd></button></div>
    <div className="text-tools-row" role="toolbar" aria-label="Text formatting" onKeyDown={event => {
      if ((event.target as HTMLElement).closest('[role="menu"]')) return
      if (event.key === 'Escape') { event.preventDefault(); editor?.commands.focus(); return }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.tt-btn:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault()
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }}>
    <ToolPopup label="Paragraph class" disabled={paragraphDisabled} items={[
      ...blockClasses.map(name => ({ id: name, label: classLabel(name), icon: <TIcon name={name} />, checked: selection.paragraph === name, action: () => applyParagraph(name) })),
      ...([-1, 1] as const).map(delta => ({ id: String(delta), label: delta < 0 ? 'Decrease list level' : 'Increase list level', icon: <TIcon name="chevron" />,
        separator: delta < 0, disabled: !selection.list, action: () => { editor!.view.focus(); changeListLevel(editor!, delta) } })),
    ]}>
      <span className="tt-para-label">{selection.fixed || (selection.text ? selection.paragraph ? classLabel(selection.paragraph) : 'Mixed' : 'Paragraph')}</span>
    </ToolPopup>
    <span className="tt-divider" aria-hidden="true" />
    <button className="tt-btn tt-bold" aria-label="Bold" title="Bold · Ctrl/⌘B"
      aria-pressed={inlineDisabled ? false : selection.bold} disabled={inlineDisabled}
      onMouseDown={e => e.preventDefault()} onClick={applyBold}><TIcon name="bold" /></button>
    <ToolPopup label="Text color" disabled={inlineDisabled} items={[
      { id: 'inherit', label: 'Inherit', icon: <span className="tt-swatch tt-swatch-inherit" />, checked: selection.color === null, action: () => applyColor(null) },
      ...colorEntries(theme).map(entry => ({ id: entry.id, label: entry.name, icon: <span className="tt-swatch" style={{ backgroundColor: entry.strong }} />, checked: selection.color === entry.id, action: () => applyColor(entry.id) })),
      ...recentColors.flatMap(id => {
        const entry = colorEntries(theme).find(value => value.id === id)
        return entry ? [{ id: `recent-${id}`, label: `${entry.name} · Recent`, icon: <span className="tt-swatch" style={{ backgroundColor: entry.strong }} />, separator: id === recentColors[0], action: () => applyColor(id) }] : []
      }),
      { id: 'edit-palette', label: 'Edit palette…', icon: <TIcon name="color" />, separator: !recentColors.length, action: () => onPalette?.() },
      { id: 'clear', label: 'Clear formatting', icon: <TIcon name="clear" />, action: () => editor?.chain().focus().unsetMark('color').unsetMark('bold').unsetMark('decoration').run() },
    ]}>
      <span className={`tt-swatch${selection.color === 'mixed' ? ' mixed' : ''}`} style={colorSwatch ? { backgroundColor: colorSwatch } : undefined} />
    </ToolPopup>
    {(['box', 'underline'] as const).map(decoration => <button key={decoration} className="tt-btn" aria-label={classLabel(decoration)} title={classLabel(decoration)}
      aria-pressed={selection.decoration === decoration} disabled={inlineDisabled} onMouseDown={event => event.preventDefault()} onClick={() => applyDecoration(decoration)}><TIcon name={decoration} /></button>)}
    </div>
    <p className="tt-caption">{selection.fixed ? 'Table cell' : selection.paragraph ? `${classLabel(selection.paragraph)} paragraph` : 'Mixed paragraph styles'}</p>
  </div>
}
