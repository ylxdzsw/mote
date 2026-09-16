import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { blockClasses, inlineClasses, type BlockClass, type InlineClass, type Theme } from '../document/model'
import { changeListLevel, setParagraphClass } from '../editor/paragraphBehavior'
import { classLabel } from '../theme/ThemePanel'
import type { CreationTool } from '../canvas/DocumentCanvas'
import './toolbar.css'

type InsertKind = 'text' | 'image' | 'table' | 'katex' | 'html' | 'rectangle' | 'ellipse' | 'line' | 'label'
type IconName = BlockClass | InsertKind | 'plain' | 'bold' | 'plus' | 'chevron' | 'undo' | 'redo' | 'outdent' | 'indent'

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    body: <path d="M13 19V5H9a4 4 0 0 0 0 8h4M17 5v14M10 5h9" />,
    heading: <path d="M6 5v14M18 5v14M6 12h12" />,
    title: <path d="M4 8V4h16v4M12 4v13M8 17h8M5 21h14" />,
    caption: <><rect x="4" y="4" width="16" height="9" rx="1" /><path d="M7 17h10M9 20h6" /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="3" /></>,
    code: <path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16" />,
    plain: <path d="m5 16 8-11a2 2 0 0 1 3 0l4 3a2 2 0 0 1 0 3l-7 9H9l-4-4ZM9 11l7 6M13 20h8" />,
    bold: <path d="M7 12h7a4 4 0 0 1 0 8H7V4h6a4 4 0 0 1 0 8" strokeWidth="2.8" />,
    text: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M8 9V8h8v1M12 8v8M10 16h4" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 6-5 4 4 3-3 5 4" /></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 10h18M3 15h18M11 4v16" /></>,
    katex: <><path d="M5 5h14M5 19h14M7 5v14M17 5v14" /><path d="m10 9 4 3-4 3" /></>,
    html: <><path d="m8 6-5 6 5 6M16 6l5 6-5 6M14 3l-4 18" /></>,
    rectangle: <rect x="3" y="5" width="18" height="14" rx="1" />,
    ellipse: <ellipse cx="12" cy="12" rx="9" ry="7" />,
    line: <path d="M4 20 20 4M12 4h8v8" />,
    label: <path d="M7 8V5h10v3M12 5v12M9 17h6M4 21h16" />,
    plus: <path d="M12 4v16M4 12h16" />,
    chevron: <path d="m7 10 5 5 5-5" />,
    undo: <path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12" />,
    redo: <path d="m15 4 5 5-5 5M20 9H10a6 6 0 0 0 0 12" />,
    outdent: <path d="M11 5h10M11 10h10M11 15h10M3 20h18m-14-6-4-4 4-4" />,
    indent: <path d="M11 5h10M11 10h10M11 15h10M3 20h18m-18-6 4-4-4-4" />,
  }
  return <svg className="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

interface MenuItem {
  id: string; label: string; icon: ReactNode; action: () => void
  checked?: boolean; disabled?: boolean; separator?: boolean; hint?: string
}

function ToolMenu({ label, children, items, disabled, armed = false }: {
  label: string; children: ReactNode; items: MenuItem[]; disabled?: boolean; armed?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const initial = buttons.find(button => button.getAttribute('aria-checked') === 'true') ?? buttons[0]
    initial?.focus()
    const outside = (event: PointerEvent) => { if (!root.current!.contains(event.target as Node)) setOpen(false) }
    const resize = () => { setOpen(false); trigger.current?.focus() }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize) }
  }, [open])
  return <div className="tool-menu" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }}>
    <button ref={trigger} className={`tool-menu-trigger${armed ? ' armed' : ''}`} aria-label={label} title={label}
      disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onMouseDown={event => event.preventDefault()} onClick={() => setOpen(!open)}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
      {children}<Icon name="chevron" />
    </button>
    {open && <div id={id} ref={menu} className="tool-menu-panel" role="menu" aria-label={label} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current!.focus(); return }
      if (event.key === 'Tab') { setOpen(false); trigger.current!.focus(); return }
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus() }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
        const ordered = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)]
        ordered.find(button => button.dataset.label!.toLowerCase().startsWith(event.key.toLowerCase()))?.focus()
      }
    }}>
      {items.map(item => <div key={item.id} role="none">
        {item.separator && <div className="tool-menu-separator" role="separator" />}
        <button role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked} tabIndex={-1}
          disabled={item.disabled} data-label={item.label} onMouseDown={event => event.preventDefault()}
          onClick={() => { setOpen(false); trigger.current!.focus(); item.action() }}>
          {item.icon}<span className="tool-menu-label">{item.label}</span>{item.hint && <span className="tool-menu-hint">{item.hint}</span>}
          <span className="tool-menu-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
        </button>
      </div>)}
    </div>}
  </div>
}

function TablePicker({ disabled, onInsert }: { disabled: boolean; onInsert: (columns: number, rows: number) => void }) {
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState({ columns: 2, rows: 2 })
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    root.current!.querySelector<HTMLButtonElement>('[data-columns="2"][data-rows="2"]')!.focus()
    const outside = (event: PointerEvent) => { if (!root.current!.contains(event.target as Node)) setOpen(false) }
    const resize = () => setOpen(false)
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize) }
  }, [open])
  return <div className="tool-menu tier-medium" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button ref={trigger} aria-label="Insert table" title="Insert table" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onMouseDown={event => event.preventDefault()} onClick={() => { setSize({ columns: 2, rows: 2 }); setOpen(!open) }}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}><Icon name="table" /></button>
    {open && <div id={id} className="tool-menu-panel table-picker" role="dialog" aria-label="Table size" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current!.focus(); return }
      const button = event.target as HTMLButtonElement
      const columns = Number(button.dataset.columns), rows = Number(button.dataset.rows)
      const next = { columns: Math.max(1, Math.min(8, columns + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))),
        rows: Math.max(1, Math.min(8, rows + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))) }
      if (event.key.startsWith('Arrow')) { event.preventDefault(); root.current!.querySelector<HTMLButtonElement>(`[data-columns="${next.columns}"][data-rows="${next.rows}"]`)!.focus() }
    }}>
      <div className="table-picker-size" aria-live="polite">{size.columns} columns × {size.rows} rows</div>
      <div className="table-picker-grid">{Array.from({ length: 64 }, (_, index) => {
        const columns = index % 8 + 1, rows = Math.floor(index / 8) + 1
        return <button key={index} data-columns={columns} data-rows={rows} aria-label={`${columns} columns, ${rows} rows`}
          tabIndex={columns === size.columns && rows === size.rows ? 0 : -1} className={columns <= size.columns && rows <= size.rows ? 'chosen' : ''}
          onPointerEnter={() => setSize({ columns, rows })} onFocus={() => setSize({ columns, rows })} onMouseDown={event => event.preventDefault()}
          onClick={() => { setOpen(false); trigger.current!.focus(); onInsert(columns, rows) }} />
      })}</div>
    </div>}
  </div>
}

// Inspect every selected range, including rectangular cell selections and unmarked text.
function selectedClasses(editor: Editor | null) {
  const paragraphs = new Set<string>(), inline = new Set<string>()
  if (!editor || editor.state.selection instanceof NodeSelection) return { paragraph: '', inline: '', text: false, code: false, list: false, fixed: '' }
  const { selection, storedMarks, doc } = editor.state
  for (const { $from, $to } of selection.ranges) {
    doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.type.name === 'paragraph' && ($from.pos === $to.pos || pos + 1 < $to.pos)) {
        paragraphs.add(node.attrs.semantic ?? 'body')
        if (!node.content.size) inline.add('')
      }
      if (node.isInline) inline.add(node.marks.find(mark => mark.type.name === 'semanticText')?.attrs.semantic ?? '')
    })
  }
  if (selection.empty) {
    inline.clear()
    inline.add((storedMarks ?? selection.$from.marks()).find(mark => mark.type.name === 'semanticText')?.attrs.semantic ?? '')
  }
  return {
    paragraph: paragraphs.size === 1 ? [...paragraphs][0] : '',
    inline: inline.size > 1 ? 'mixed' : [...inline][0] ?? '',
    text: paragraphs.size > 0, code: paragraphs.has('code'), list: paragraphs.has('list'),
    fixed: editor.schema.nodes.table ? 'Table' : !editor.schema.nodes.paragraph.spec.attrs?.semantic ? 'Label' : '',
  }
}

const paragraphQuick = ['heading', 'list', 'code'] as const
const inlineQuick = ['bold', 'primary', 'secondary', 'term'] as const
const insertKinds: InsertKind[] = ['text', 'label', 'image', 'table', 'katex', 'html', 'rectangle', 'ellipse', 'line']
const insertLabels: Record<InsertKind, string> = { text: 'Text box', image: 'Image', table: 'Table', katex: 'KaTeX', html: 'HTML widget', rectangle: 'Rectangle', ellipse: 'Ellipse', line: 'Line', label: 'Label' }

interface Props {
  editor: Editor | null; canInsert: boolean; imageLoading: boolean; theme: Theme; tool: CreationTool
  onInsert: (kind: InsertKind, columns?: number, rows?: number) => void
  canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void
}

export function Toolbar({ editor, canInsert, imageLoading, theme, tool, onInsert, canUndo, canRedo, undo, redo }: Props) {
  const selection = useEditorState({ editor, selector: () => selectedClasses(editor) }) ?? selectedClasses(null)
  const paragraphDisabled = !editor?.isEditable || !selection.text || !!selection.fixed
  const inlineDisabled = !editor?.isEditable || !selection.text || selection.code
  const applyParagraph = (name: BlockClass) => { if (editor) setParagraphClass(editor, name) }
  const applyInline = (name: string) => {
    if (name) editor?.chain().focus().setMark('semanticText', { semantic: name }).run()
    else editor?.chain().focus().unsetMark('semanticText').run()
  }
  const badge = (name: InlineClass, sample = false) => {
    if (name === 'bold') return <Icon name="bold" />
    const style = theme.inline[name]
    return <span className={`inline-badge${sample ? ' sample' : ''}`} style={{ color: style.color ?? theme.defaults.color, background: style.background,
      fontWeight: style.weight, fontStyle: style.italic ? 'italic' : undefined, textDecoration: style.decoration }}>{sample ? 'Aa' : classLabel(name)}</span>
  }
  const insertionDisabled = (kind: InsertKind) => ['text', 'image', 'table', 'katex', 'html'].includes(kind) && (!canInsert || (['image', 'html'].includes(kind) && imageLoading))
  const insertionLabel = (kind: InsertKind) => kind === 'image' && imageLoading ? 'Opening image…' : kind === 'html' && imageLoading ? 'Opening screenshot…' : `${['rectangle', 'ellipse', 'line'].includes(kind) ? 'Draw' : 'Insert'} ${insertLabels[kind].toLowerCase()}`

  return <div className="toolbar" role="group" aria-label="Editing tools">
    <div className="tool-group" role="group" aria-label="Paragraph">
      <ToolMenu label="Paragraph class" disabled={paragraphDisabled} items={[
        ...blockClasses.map(name => ({ id: name, label: classLabel(name), icon: <Icon name={name} />, checked: selection.paragraph === name, action: () => applyParagraph(name) })),
        ...([-1, 1] as const).map(delta => ({ id: String(delta), label: delta < 0 ? 'Decrease list level' : 'Increase list level', icon: <Icon name={delta < 0 ? 'outdent' : 'indent'} />,
          separator: delta < 0, hint: delta < 0 ? 'Shift+Tab' : 'Tab', disabled: !selection.list, action: () => { editor!.view.focus(); changeListLevel(editor!, delta) } })),
      ]}>
        <span className="class-menu-value">{selection.fixed || (selection.text ? selection.paragraph ? classLabel(selection.paragraph) : 'Mixed' : 'Paragraph')}</span>
      </ToolMenu>
      {paragraphQuick.map(name => <button key={name} className={`tool-quick tier-${name === 'code' ? 'wide' : 'medium'}`} aria-label={classLabel(name)}
        title={`${classLabel(name)} · Click again for Body`} aria-pressed={!paragraphDisabled && selection.paragraph === name} disabled={paragraphDisabled}
        onMouseDown={event => event.preventDefault()} onClick={() => applyParagraph(selection.paragraph === name ? 'body' : name)}><Icon name={name} /></button>)}
    </div>
    <div className="tool-group" role="group" aria-label="Inline">
      <ToolMenu label="Inline class" disabled={inlineDisabled} items={[
        { id: 'plain', label: 'Plain', icon: <Icon name="plain" />, checked: selection.inline === '', action: () => applyInline('') },
        ...(['bold', ...inlineClasses.filter(name => name !== 'bold')] as InlineClass[]).map(name => ({ id: name, label: classLabel(name), icon: badge(name, true), checked: selection.inline === name,
          hint: name === 'bold' ? 'Ctrl/⌘B' : undefined, action: () => applyInline(name) })),
      ]}><span className="class-menu-value">{selection.text ? selection.inline ? classLabel(selection.inline) : 'Plain' : 'Inline'}</span></ToolMenu>
      {inlineQuick.map(name => <button key={name} className={`tool-quick ${name === 'bold' ? 'tier-core' : 'tier-wide badge-button'}`}
        aria-label={classLabel(name)} title={`${classLabel(name)}${name === 'bold' ? ' · Ctrl/⌘B' : ''} · Click again for Plain`}
        aria-pressed={!inlineDisabled && selection.inline === name} disabled={inlineDisabled} onMouseDown={event => event.preventDefault()}
        onClick={() => applyInline(selection.inline === name ? '' : name)}>{badge(name)}</button>)}
    </div>
    <div className="tool-group" role="group" aria-label="Insert">
      <ToolMenu label={tool ? `Insert · ${classLabel(tool)} tool active` : 'Insert'} armed={!!tool} items={insertKinds.map(kind => ({
        id: kind, label: insertLabels[kind], icon: <Icon name={kind} />, action: () => onInsert(kind), disabled: insertionDisabled(kind),
        separator: ['image', 'rectangle'].includes(kind), checked: ['rectangle', 'ellipse', 'line', 'label'].includes(kind) ? tool === kind : undefined,
        hint: ['image', 'html'].includes(kind) && imageLoading ? 'Opening…' : undefined,
      }))}><Icon name="plus" /></ToolMenu>
      <TablePicker disabled={!canInsert} onInsert={(columns, rows) => onInsert('table', columns, rows)} />
      {(['text', 'rectangle', 'line'] as const).map(kind => <button key={kind} className={`tool-quick tier-${kind === 'text' ? 'medium' : 'wide'}`}
        aria-label={insertionLabel(kind)} title={insertionLabel(kind)} disabled={insertionDisabled(kind)} aria-pressed={kind === 'rectangle' || kind === 'line' ? tool === kind : undefined}
        onMouseDown={event => event.preventDefault()} onClick={() => onInsert(kind)}><Icon name={kind} /></button>)}
    </div>
    <div className="tool-group toolbar-history" role="group" aria-label="History">
      <button aria-label="Undo" title="Undo · Ctrl/⌘Z" disabled={!canUndo} onMouseDown={event => event.preventDefault()} onClick={undo}><Icon name="undo" /></button>
      <button aria-label="Redo" title="Redo · Ctrl/⌘Shift+Z" disabled={!canRedo} onMouseDown={event => event.preventDefault()} onClick={redo}><Icon name="redo" /></button>
    </div>
  </div>
}
