import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { SegmentPoint } from '../document/segment'

interface Boundary { from: number; top: number }

export function useParagraphInsertion(editor: Editor | null, sheet: RefObject<HTMLDivElement | null>, active: boolean, scale: number, boundaryAt: (y: number) => { point: SegmentPoint; top: number }, onFinish: () => void) {
  const [hint, setHint] = useState<Boundary | null>(null)
  const finish = useRef(onFinish)
  finish.current = onFinish

  function target(x: number, y: number): Boundary | null {
    const surface = sheet.current, hit = document.elementFromPoint(x, y)
    if (!active || !editor || !surface || !hit || !surface.contains(hit) || hit.closest('.floating-note, [data-ai-controls], [data-ai-preview]')) return null
    const rect = surface.getBoundingClientRect()
    const localY = (y - rect.top) / scale - surface.clientTop
    const boundary = boundaryAt(localY)
    let from = 0
    for (let index = 0; index < boundary.point.index; index++) from += editor.state.doc.child(index).nodeSize
    return { from, top: boundary.top }
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
