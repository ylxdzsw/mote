import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { GapCursor } from '@tiptap/pm/gapcursor'
import { TextSelection } from '@tiptap/pm/state'
import { atDocumentTail } from '../editor/documentTail'
import type { Theme } from '../document/model'
import { slideAtPoint, type SlideGeometry } from './floatingGeometry'

type TailPointer = Pick<globalThis.PointerEvent, 'clientX' | 'clientY' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>

export function useDocumentTail(editor: Editor | null, sheet: RefObject<HTMLDivElement | null>, active: boolean, scale: number, leftMargin: number, theme: Theme, slides: SlideGeometry[], onActivate: () => void) {
  const [hint, setHint] = useState<number | null>(null)
  const pointer = useRef<TailPointer | null>(null)
  const focusedBlank = useRef(false)

  function target(event: TailPointer) {
    if (!active || !editor || !sheet.current || event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return null
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    if (!hit || hit.closest('.stage') !== sheet.current.closest('.stage') || hit.closest('.floating-note, [data-ai-controls], [data-ai-preview], [data-slide-control]')) return null
    const surface = sheet.current.getBoundingClientRect()
    if (event.clientY < surface.bottom && event.clientX < surface.left + (sheet.current.clientLeft + leftMargin) * scale) return null
    const slide = slideAtPoint(slides, (event.clientY - surface.top) / scale - sheet.current.clientTop)
    const next = slide && slides[slide.index + 1]
    let end = editor.state.doc.content.size
    if (next) editor.state.doc.forEach((node, pos) => { if (node.attrs.id === next.id) end = pos })
    const last = editor.state.doc.resolve(end).nodeBefore!
    const element = editor.view.nodeDOM(end - last.nodeSize) as HTMLElement
    return event.clientX >= surface.left && event.clientX <= surface.right && event.clientY >= element.getBoundingClientRect().bottom ? end : null
  }

  useLayoutEffect(() => {
    if (!editor || !active) { setHint(null); return }
    const surface = sheet.current!
    function update() {
      const focused = editor!.isFocused && atDocumentTail(editor!.state)
      const hovered = pointer.current && target(pointer.current)
      surface.classList.toggle('can-continue-writing', hovered !== null)
      const end = focused ? editor!.state.selection.head : hovered
      if (end === null) { setHint(null); return }
      const last = editor!.state.doc.resolve(end).nodeBefore!
      if (last.type.name === 'paragraph') { setHint(null); return }
      const element = editor!.view.nodeDOM(end - last.nodeSize) as HTMLElement
      surface.style.setProperty('--tail-slide-offset', element.style.getPropertyValue('--slide-offset') || '0px')
      const style = getComputedStyle(surface)
      const before = parseFloat(style.getPropertyValue('--body-spaceBefore')) || 0
      const after = last.type.name === 'flow' ? parseFloat(style.getPropertyValue('--flow-spaceAfter')) || 0 : 0
      setHint((element.getBoundingClientRect().bottom - surface.getBoundingClientRect().top) / scale - surface.clientTop + Math.max(before, after))
    }
    const move = (event: globalThis.PointerEvent) => { pointer.current = event; update() }
    const leave = () => { pointer.current = null; update() }
    const observer = new ResizeObserver(update)
    observer.observe(editor.view.dom)
    surface.closest('.stage')!.addEventListener('pointermove', move as EventListener)
    surface.closest('.stage')!.addEventListener('pointerleave', leave)
    window.addEventListener('scroll', update, true)
    editor.on('transaction', update); editor.on('focus', update); editor.on('blur', update)
    update()
    return () => {
      observer.disconnect()
      surface.classList.remove('can-continue-writing')
      surface.style.removeProperty('--tail-slide-offset')
      surface.closest('.stage')?.removeEventListener('pointermove', move as EventListener)
      surface.closest('.stage')?.removeEventListener('pointerleave', leave)
      window.removeEventListener('scroll', update, true)
      editor.off('transaction', update); editor.off('focus', update); editor.off('blur', update)
    }
  }, [editor, active, scale, leftMargin, theme, sheet, slides])

  useLayoutEffect(() => {
    if (!editor || !active || focusedBlank.current) return
    focusedBlank.current = true
    if (editor.state.doc.childCount === 1 && editor.state.doc.firstChild?.type.name === 'paragraph' && !editor.state.doc.firstChild.content.size
      && !sheet.current!.querySelector('.floating-note')) editor.commands.focus('start')
  }, [editor, active, sheet])

  function begin(event: PointerEvent) {
    const end = target(event)
    if (end === null || !editor) return false
    event.preventDefault(); event.stopPropagation()
    const selection = editor.state.doc.resolve(end).nodeBefore!.type.name === 'paragraph'
      ? TextSelection.create(editor.state.doc, end - 1) : new GapCursor(editor.state.doc.resolve(end))
    const transaction = editor.state.tr.setSelection(selection)
    if (selection instanceof GapCursor) transaction.setStoredMarks([])
    editor.view.dispatch(transaction.scrollIntoView())
    editor.view.focus()
    onActivate()
    return true
  }
  return { hint: active ? hint : null, begin }
}
