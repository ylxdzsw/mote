import { Node } from '@tiptap/core'
import { goToNextCell, tableEditing } from '@tiptap/pm/tables'
import Paragraph from '@tiptap/extension-paragraph'

// No paragraph semantic attribute exists in this schema: pasted headings also become body.
export const TableParagraph = Paragraph.extend({
  parseHTML: () => [{ tag: 'p' }, ...[1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}` }))],
  renderHTML: () => ['p', { 'data-semantic': 'body' }, 0],
})

const Table = Node.create({
  name: 'table',
  content: 'tableRow+',
  isolating: true,
  parseHTML: () => [{ tag: 'table' }],
  renderHTML: () => ['table', ['tbody', 0]],
  extendNodeSchema(extension) {
    const roles: Record<string, string> = { table: 'table', tableRow: 'row', tableCell: 'cell' }
    return roles[extension.name] ? { tableRole: roles[extension.name] } : {}
  },
  addProseMirrorPlugins: () => [tableEditing()],
  addKeyboardShortcuts() {
    return {
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
  content: 'paragraph+',
  isolating: true,
  addAttributes: () => ({
    colspan: { default: 1, parseHTML: element => Number(element.getAttribute('colspan') || 1) },
    rowspan: { default: 1, parseHTML: element => Number(element.getAttribute('rowspan') || 1) },
    colwidth: { default: null, rendered: false },
  }),
  parseHTML: () => [{ tag: 'td' }, { tag: 'th' }],
  renderHTML: ({ HTMLAttributes }) => ['td', HTMLAttributes, 0],
})

export const tableExtensions = [Table, TableRow, TableCell]
