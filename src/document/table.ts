import type { JSONContent } from '@tiptap/core'

export type ColumnAlignment = 'left' | 'center' | 'right'
export interface TableColumn { width: number; align: ColumnAlignment }

export function normalizeColumns(columns: TableColumn[], count = columns.length): TableColumn[] {
  const values = Array.from({ length: count }, (_, index) => columns[index] ?? { width: 1 / count, align: 'left' })
  const total = values.reduce((sum, column) => sum + column.width, 0)
  return values.map(column => ({ ...column, width: column.width / total }))
}

// A cell has one paragraph. Keep paragraph boundaries as newlines, including empty lines.
export function normalizeTableContent(node: JSONContent): JSONContent {
  if (node.type === 'tableCell') {
    const content = (node.content ?? []).flatMap((paragraph, index) => [
      ...(index ? [{ type: 'hardBreak' }] : []),
      ...(paragraph.content ?? []).flatMap(child => child.type === 'text' && child.text?.includes('\n')
        ? child.text.split('\n').flatMap((line, index) => [
          ...(index ? [{ type: 'hardBreak', marks: child.marks }] : []), ...(line ? [{ ...child, text: line }] : []),
        ]) : [child]),
    ])
    return { ...node, content: [{ type: 'paragraph', attrs: node.content?.[0]?.attrs, content }] }
  }
  return node.content ? { ...node, content: node.content.map(normalizeTableContent) } : node
}
