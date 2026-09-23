import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

interface Boundary { from: number; top: number }

export function useParagraphInsertion(editor: Editor | null, sheet: RefObject<HTMLDivElement | null>, active: boolean, scale: number, onFinish: () => void) {
  const [hint, setHint] = useState<Boundary | null>(null)
  const finish = useRef(onFinish)
  finish.current = onFinish

  function target(x: number, y: number): Boundary | null {
    const surface = sheet.current, hit = document.elementFromPoint(x, y)
    if (!active || !editor || !surface || !hit || !surface.contains(hit) || hit.closest('.floating-note, [data-ai-controls], [data-ai-preview]')) return null
    const rect = surface.getBoundingClientRect()
    const localY = (y - rect.top) / scale - surface.clientTop
    const blocks: { from: number; end: number; top: number; bottom: number; space: boolean }[] = []
    editor.state.doc.forEach((node, from) => {
      const element = editor.view.nodeDOM(from) as HTMLElement
      const box = element.getBoundingClientRect()
      blocks.push({ from, end: from + node.nodeSize, top: (box.top - rect.top) / scale - surface.clientTop,
        bottom: (box.bottom - rect.top) / scale - surface.clientTop, space: node.type.name === 'spacer' })
    })
    const boundaries = blocks.map((block, i) => {
      const previous = blocks[i - 1]
      return { from: block.from, top: !previous || block.space ? block.top : previous.space ? previous.bottom : (previous.bottom + block.top) / 2 }
    })
    const last = blocks.at(-1)
    if (!last) return null
    boundaries.push({ from: last.end, top: last.bottom })
    return boundaries.reduce((best, boundary) => Math.abs(boundary.top - localY) < Math.abs(best.top - localY) ? boundary : best)
  }

  useLayoutEffect(() => {
    setHint(null)
    if (!active || !editor) return
    let pointer: { x: number; y: number } | null = null
    const hover = () => setHint(pointer ? target(pointer.x, pointer.y) : null)
    const move = (event: globalThis.PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; hover() }
    const blur = () => finish.current()
    window.addEventListener('pointermove', move)
    window.addEventListener('scroll', hover, true)
    window.addEventListener('blur', blur)
    editor.on('transaction', hover)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('scroll', hover, true)
      window.removeEventListener('blur', blur)
      editor.off('transaction', hover)
    }
  }, [active, editor, scale, sheet])

  function insert(event: PointerEvent) {
    event.preventDefault(); event.stopPropagation()
    if (!event.isPrimary || !editor) return
    const boundary = target(event.clientX, event.clientY)
    if (!boundary) return
    const node = editor.schema.nodes.paragraph.create({ id: crypto.randomUUID(), semantic: 'body' })
    const transaction = editor.state.tr.insert(boundary.from, node)
    transaction.setSelection(TextSelection.create(transaction.doc, boundary.from + 1)).setStoredMarks([])
      .setMeta('historyBoundary', true).scrollIntoView()
    editor.view.dispatch(transaction)
    if (editor.state.doc.nodeAt(boundary.from)?.attrs.id !== node.attrs.id) return
    finish.current()
    editor.view.focus()
  }
  return { hint: active ? hint : null, insert }
}
