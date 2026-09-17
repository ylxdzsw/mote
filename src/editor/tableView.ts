import type { NodeViewRendererProps } from '@tiptap/core'
import type { NodeView } from '@tiptap/pm/view'
import { TableMap } from '@tiptap/pm/tables'
import { normalizeColumns, type TableColumn } from '../document/table'
import { isComposingKey } from './composition'

export function tableView({ node: initial, editor, getPos }: NodeViewRendererProps): NodeView {
  let node = initial
  const dom = document.createElement('div')
  dom.className = 'table-layout'
  const table = document.createElement('table')
  const colgroup = document.createElement('colgroup')
  const contentDOM = document.createElement('tbody')
  const controls = document.createElement('div')
  controls.className = 'table-column-controls'
  controls.contentEditable = 'false'
  table.append(colgroup, contentDOM)
  dom.append(table, controls)
  let drag: { index: number; x: number; width: number; columns: TableColumn[]; pending: TableColumn[]; handle: HTMLElement; pointer: number } | null = null

  const columns = () => normalizeColumns(node.attrs.columns ?? [], TableMap.get(node).width)
  function commit(value: TableColumn[]) {
    const pos = getPos()
    if (pos !== undefined && editor.isEditable) editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'columns', value).setMeta('historyBoundary', true))
  }
  function resized(value: TableColumn[], index: number, delta: number) {
    const pair = value[index].width + value[index + 1].width
    const minimum = Math.min(40 / table.clientWidth, pair / 2)
    const width = Math.max(minimum, Math.min(pair - minimum, value[index].width + delta))
    return value.map((column, i) => i === index ? { ...column, width } : i === index + 1 ? { ...column, width: pair - width } : column)
  }
  function finish(commitChange = false) {
    if (!drag) return
    const previous = drag
    drag = null
    mode.disconnect()
    previous.handle.classList.remove('is-dragging')
    if (previous.handle.hasPointerCapture(previous.pointer)) previous.handle.releasePointerCapture(previous.pointer)
    if (commitChange && previous.pending.some((column, index) => column.width !== previous.columns[index].width)) commit(previous.pending)
    paint(columns())
  }
  function paint(value: TableColumn[]) {
    while (colgroup.children.length > value.length) colgroup.lastChild!.remove()
    while (colgroup.children.length < value.length) colgroup.append(document.createElement('col'))
    while (controls.children.length > value.length - 1) controls.lastChild!.remove()
    let left = 0
    value.forEach((column, index) => {
      ;(colgroup.children[index] as HTMLElement).style.width = `${column.width * 100}%`
      left += column.width
      if (index === value.length - 1) return
      let handle = controls.children[index] as HTMLDivElement | undefined
      if (!handle) {
        handle = document.createElement('div')
        handle.className = 'table-column-divider'
        handle.tabIndex = 0
        handle.setAttribute('role', 'separator')
        handle.setAttribute('aria-orientation', 'vertical')
        handle.setAttribute('aria-label', `Resize column ${index + 1}`)
        handle.title = 'Drag to resize adjacent columns; Left/Right arrows resize, Shift for 1px'
        handle.onfocus = event => editor.emit('focus', { editor, event, transaction: editor.state.tr })
        handle.onpointerdown = event => {
          if (!editor.isEditable || event.button !== 0 || !event.isPrimary) return
          event.preventDefault(); event.stopPropagation()
          handle!.focus({ preventScroll: true })
          handle!.setPointerCapture(event.pointerId)
          const value = columns()
          drag = { index, x: event.clientX, width: table.getBoundingClientRect().width, columns: value, pending: value, handle: handle!, pointer: event.pointerId }
          mode.observe(dom.closest('.sheet')!, { attributes: true, attributeFilter: ['style', 'class'] })
          handle!.classList.add('is-dragging')
        }
        handle.onpointermove = event => {
          if (!drag) return
          if (!editor.isEditable || Math.abs(table.getBoundingClientRect().width - drag.width) > .1) { finish(); return }
          drag.pending = resized(drag.columns, drag.index, (event.clientX - drag.x) / drag.width)
          paint(drag.pending)
        }
        handle.onpointerup = event => { event.stopPropagation(); finish(true) }
        handle.onpointercancel = () => finish()
        handle.onlostpointercapture = () => finish()
        handle.onkeydown = event => {
          if (!editor.isEditable || isComposingKey(event) || event.altKey || event.ctrlKey || event.metaKey) return
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault(); event.stopPropagation()
          commit(resized(columns(), index, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 8) / table.clientWidth))
        }
        controls.append(handle)
      }
      handle.style.left = `${left * 100}%`
      handle.setAttribute('aria-valuemin', '0')
      handle.setAttribute('aria-valuemax', '100')
      handle.setAttribute('aria-valuenow', String(Math.round(column.width * 100)))
      handle.setAttribute('aria-valuetext', `Column ${index + 1}: ${Math.round(column.width * 100)}% of table width`)
    })
  }
  const escape = (event: KeyboardEvent) => {
    if (isComposingKey(event)) return
    if (drag && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish() }
  }
  document.addEventListener('keydown', escape, true)
  const resize = new ResizeObserver(() => { if (drag && Math.abs(table.getBoundingClientRect().width - drag.width) > .1) finish() })
  resize.observe(table)
  // View scaling and reading-mode switches need cancellation even without a pointer move.
  const mode = new MutationObserver(() => {
    if (drag && (!editor.isEditable || dom.closest('.is-reading') || Math.abs(table.getBoundingClientRect().width - drag.width) > .1)) finish()
  })
  paint(columns())
  return {
    dom, contentDOM,
    update(next) {
      if (next.type !== node.type) return false
      if (next !== node) finish()
      node = next
      paint(columns())
      return true
    },
    stopEvent: event => controls.contains(event.target as globalThis.Node),
    ignoreMutation: mutation => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
    destroy() { finish(); resize.disconnect(); mode.disconnect(); document.removeEventListener('keydown', escape, true) },
  }
}
