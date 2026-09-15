export type ColumnAlignment = 'left' | 'center' | 'right'
export interface TableColumn { width: number; align: ColumnAlignment }

export function normalizeColumns(columns: TableColumn[], count = columns.length): TableColumn[] {
  const values = Array.from({ length: count }, (_, index) => columns[index] ?? { width: 1 / count, align: 'left' })
  const total = values.reduce((sum, column) => sum + column.width, 0)
  return values.map(column => ({ ...column, width: column.width / total }))
}
