export type ColumnAlignment = 'left' | 'center' | 'right'
export interface TableColumn { weight: number; align: ColumnAlignment }

export function normalizeColumns(columns: TableColumn[], count = columns.length): TableColumn[] {
  const values = Array.from({ length: count }, (_, index) => columns[index] ?? { weight: 1 / count, align: 'left' })
  const total = values.reduce((sum, column) => sum + column.weight, 0)
  return values.map(column => ({ ...column, weight: column.weight / total }))
}
