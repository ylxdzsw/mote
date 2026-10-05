import type { ReactNode } from 'react'
import type { Command } from '@tiptap/pm/state'
import { addRowAfter, deleteRow } from '@tiptap/pm/tables'
import { alignColumns, changeColumns } from '../editor/table'
import { classLabel } from '../theme/ThemePanel'
import './inspector.css'

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

export function TextInspector({ semantic, listLevel, onTheme }: { semantic: string; listLevel: number; onTheme: (name: string) => void }) {
  return <div className="context-inspector">
    <h2>{semantic === 'list' ? `List item · Level ${listLevel + 1}` : 'Text & space'}</h2>
    <InspectorGroup title="Style">
      <button onClick={() => onTheme(semantic)}>{classLabel(semantic)} style…</button>
      <button onClick={() => onTheme('palette')}>Document palette…</button>
      <p className="hint">Styles apply to every paragraph of this class.</p>
    </InspectorGroup>
    {semantic === 'body' && <p className="hint">Tab turns a Body paragraph into a list. Shift+Tab returns a top-level item to Body.</p>}
    {semantic === 'list' && <p className="hint">Tab / Shift+Tab changes this item’s indentation.</p>}
    <InspectorHelp key={semantic}>
      {semantic === 'list' && <p>Each item is independent. Enter creates an item at the same level; Shift+Enter adds a line within it. Backspace at the start outdents, or returns a top-level item to Body.</p>}
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
