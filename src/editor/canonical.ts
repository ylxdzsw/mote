import type { JSONContent } from '@tiptap/core'

// Only for trusted editor-produced JSON. Native imports are validated unchanged.
export function canonicalEditorContent(node: JSONContent): JSONContent {
  const result = { ...node }
  if (node.attrs) {
    const attrs = { ...node.attrs }
    if (node.type === 'paragraph' && attrs.semantic !== 'list') delete attrs.listLevel
    if (node.type === 'tableCell' || node.type === 'tableRow') {
      if (attrs.colspan === 1) delete attrs.colspan
      if (attrs.rowspan === 1) delete attrs.rowspan
      if (attrs.colwidth === null) delete attrs.colwidth
    }
    if (node.type === 'table' && attrs.columns === null) delete attrs.columns
    if (Object.keys(attrs).length) result.attrs = attrs
    else delete result.attrs
  }
  if (node.content) result.content = node.content.map(canonicalEditorContent)
  return result
}
