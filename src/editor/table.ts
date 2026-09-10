import { Node } from '@tiptap/core'
import { DOMParser, Fragment, Slice, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model'
import { Plugin, type Command, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { addColumnAfter, deleteColumn, goToNextCell, isInTable, selectedRect, TableMap, tableEditing } from '@tiptap/pm/tables'
import Paragraph from '@tiptap/extension-paragraph'
import { normalizeColumns, type ColumnAlignment } from '../document/table'
import { tableView } from './tableView'

// The class is structural, not a selectable paragraph attribute.
export const TableParagraph = Paragraph.extend({
  parseHTML: () => [{ tag: 'p' }, ...[1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}` }))],
  renderHTML: () => ['p', { 'data-semantic': 'table' }, 0],
})

export function tableColumns(table: ProseMirrorNode) {
  return normalizeColumns(table.attrs.columns ?? [], TableMap.get(table).width)
}

export function columnAlignment(state: EditorState) {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  const selected = tableColumns(rect.table).slice(rect.left, rect.right)
  return selected.every(column => column.align === selected[0].align) ? selected[0].align : null
}

export const alignColumns = (align: ColumnAlignment): Command => (state, dispatch) => {
  if (!isInTable(state)) return false
  const rect = selectedRect(state)
  const columns = tableColumns(rect.table).map((column, index) => index >= rect.left && index < rect.right ? { ...column, align } : column)
  if (dispatch) dispatch(state.tr.setNodeAttribute(rect.tableStart - 1, 'columns', columns).setMeta('historyBoundary', true))
  return true
}

export const changeColumns = (remove = false): Command => (state, dispatch) => {
  if (!isInTable(state)) return false
  const rect = selectedRect(state)
  const columns = tableColumns(rect.table)
  if (remove) columns.splice(rect.left, rect.right - rect.left)
  else columns.splice(rect.right, 0, { width: 1 / columns.length, align: 'left' })
  return (remove ? deleteColumn : addColumnAfter)(state, dispatch && (tr => {
    tr.setNodeAttribute(rect.tableStart - 1, 'columns', normalizeColumns(columns)).setMeta('historyBoundary', true)
    dispatch(tr)
  }))
}

function inlineDOM(element: globalThis.Node): DocumentFragment {
  const result = document.createDocumentFragment()
  let previousBlock = false
  for (const child of element.childNodes) {
    if (child.nodeType === 3 && !child.textContent?.trim() && child.textContent?.includes('\n')) continue
    const block = child instanceof HTMLElement && /^(P|DIV|H[1-6]|PRE|BLOCKQUOTE|UL|OL|LI)$/.test(child.tagName)
    if ((block && (result.hasChildNodes() || previousBlock)) || (!block && previousBlock)) result.append(document.createElement('br'))
    result.append(block ? inlineDOM(child) : child.cloneNode(true))
    previousBlock = block
  }
  return result
}

function parseCell(element: globalThis.Node, schema: Schema) {
  const container = document.createElement('div')
  container.append(inlineDOM(element))
  const paragraph = DOMParser.fromSchema(schema).parse(container, { topNode: schema.nodes.paragraph.create() })
  return Fragment.from(paragraph)
}

function textParagraph(text: string, schema: Schema) {
  return schema.nodes.paragraph.create(null, text.split('\n').flatMap((line, index) => [
    ...(index ? [schema.nodes.hardBreak.create()] : []), ...(line ? [schema.text(line)] : []),
  ]))
}

const Table = Node.create({
  name: 'table',
  priority: 1000,
  content: 'tableRow+',
  isolating: true,
  addAttributes: () => ({ columns: { default: null, rendered: false } }),
  parseHTML: () => [{ tag: 'table' }],
  renderHTML: ({ node }) => ['table', ['colgroup', ...tableColumns(node).map(column => ['col', { style: `width: ${column.width * 100}%` }])], ['tbody', 0]],
  addNodeView: () => tableView,
  extendNodeSchema(extension) {
    const roles: Record<string, string> = { table: 'table', tableRow: 'row', tableCell: 'cell' }
    return roles[extension.name] ? { tableRole: roles[extension.name] } : {}
  },
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({
      props: {
        transformPastedHTML: html => {
          const container = document.createElement('div')
          container.innerHTML = html
          if (container.querySelector('table, tr, td, th')) return html
          const paragraph = document.createElement('p')
          paragraph.append(inlineDOM(container))
          return paragraph.outerHTML
        },
        handleDOMEvents: {
          beforeinput: (_view, event) => {
            if (!editor.isEditable || event.inputType !== 'insertParagraph') return false
            event.preventDefault()
            editor.commands.setHardBreak()
            return true
          },
        },
        clipboardTextParser: (text, $context) => {
          const schema = $context.doc.type.schema
          text = text.replace(/\r\n?/g, '\n')
          if (!text.includes('\t')) return new Slice(Fragment.from(textParagraph(text, schema)), 1, 1)
          const rows = text.replace(/\n$/, '').split('\n').map(row => schema.nodes.tableRow.create(null,
            row.split('\t').map(cell => schema.nodes.tableCell.create(null, textParagraph(cell, schema)))))
          return new Slice(Fragment.from(schema.nodes.table.create(null, rows)), 0, 0)
        },
        transformPasted: slice => {
          if (slice.content.childCount < 2 || !slice.content.content.every(node => node.type.name === 'paragraph')) return slice
          const schema = slice.content.firstChild!.type.schema
          const content = slice.content.content.flatMap((paragraph, index) => [
            ...(index ? [schema.nodes.hardBreak.create()] : []), ...paragraph.content.content,
          ])
          return new Slice(Fragment.from(schema.nodes.paragraph.create(null, content)), 1, 1)
        },
        decorations: state => {
          const table = state.doc.firstChild!
          const map = TableMap.get(table)
          const columns = tableColumns(table)
          const decorations = [...new Set(map.map)].map(pos => {
            const cell = table.nodeAt(pos)!
            return Decoration.node(pos + 1, pos + 1 + cell.nodeSize, { style: `text-align: ${columns[map.colCount(pos)].align}` })
          })
          return DecorationSet.create(state.doc, decorations)
        },
      },
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some(tr => tr.docChanged)) return null
        const table = state.doc.firstChild!
        // Rectangular paste can grow the table without using the column controls.
        if (table.attrs.columns?.length === TableMap.get(table).width) return null
        return state.tr.setNodeAttribute(0, 'columns', tableColumns(table))
      },
    }), tableEditing()]
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.setHardBreak(),
      'Shift-Enter': () => this.editor.commands.setHardBreak(),
      'Mod-Enter': () => this.editor.commands.setHardBreak(),
      Tab: () => goToNextCell(1)(this.editor.state, this.editor.view.dispatch),
      'Shift-Tab': () => goToNextCell(-1)(this.editor.state, this.editor.view.dispatch),
    }
  },
})

const TableRow = Node.create({
  name: 'tableRow',
  content: 'tableCell+',
  parseHTML: () => [{ tag: 'tr' }],
  renderHTML: () => ['tr', 0],
})

const TableCell = Node.create({
  name: 'tableCell',
  content: 'paragraph',
  isolating: true,
  addAttributes: () => ({
    colspan: { default: 1, parseHTML: element => Number(element.getAttribute('colspan') || 1) },
    rowspan: { default: 1, parseHTML: element => Number(element.getAttribute('rowspan') || 1) },
    colwidth: { default: null, rendered: false },
  }),
  parseHTML: () => [{ tag: 'td', getContent: parseCell }, { tag: 'th', getContent: parseCell }],
  renderHTML: ({ HTMLAttributes }) => ['td', HTMLAttributes, 0],
})

export const tableExtensions = [Table, TableRow, TableCell]
