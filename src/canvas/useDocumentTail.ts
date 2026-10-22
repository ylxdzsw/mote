import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { GapCursor } from '@tiptap/pm/gapcursor'
import { TextSelection } from '@tiptap/pm/state'
import { atDocumentTail } from '../editor/documentTail'
import type { Theme } from '../document/model'

type TailPointer = Pick<globalThis.PointerEvent, 'clientX' | 'clientY' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>

export function useDocumentTail(editor: Editor | null, sheet: RefObject<HTMLDivElement | null>, active: boolean, scale: number, theme: Theme, onActivate: () => void) {
  const [hint, setHint] = useState<number | null>(null)
  const pointer = useRef<TailPointer | null>(null)
  const focusedBlank = useRef(false)

  function target(event: TailPointer) {
    if (!active || !editor || !sheet.current || event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return false
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    if (!hit || hit.closest('.stage') !== sheet.current.closest('.stage') || hit.closest('.floating-note, [data-ai-controls], [data-ai-preview]')) return false
    const surface = sheet.current.getBoundingClientRect()
    const last = editor.view.nodeDOM(editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize) as HTMLElement
    return event.clientX >= surface.left && event.clientX <= surface.right && event.clientY >= last.getBoundingClientRect().bottom
  }

  useLayoutEffect(() => {
    if (!editor || !active) { setHint(null); return }
    const surface = sheet.current!
    function update() {
      const last = editor!.state.doc.lastChild!
      const focused = editor!.isFocused && atDocumentTail(editor!.state)
      const hovered = pointer.current && target(pointer.current)
      surface.classList.toggle('can-continue-writing', !!hovered)
      if (last.type.name === 'paragraph' || (!hovered && !focused)) { setHint(null); return }
      const element = editor!.view.nodeDOM(editor!.state.doc.content.size - last.nodeSize) as HTMLElement
      const style = getComputedStyle(surface)
      const before = parseFloat(style.getPropertyValue('--body-spaceBefore')) || 0
      const after = last.type.name === 'flow' ? parseFloat(style.getPropertyValue('--body-spaceAfter')) || 0 : 0
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
      surface.closest('.stage')?.removeEventListener('pointermove', move as EventListener)
      surface.closest('.stage')?.removeEventListener('pointerleave', leave)
      window.removeEventListener('scroll', update, true)
      editor.off('transaction', update); editor.off('focus', update); editor.off('blur', update)
    }
  }, [editor, active, scale, theme, sheet])

  useLayoutEffect(() => {
    if (!editor || !active || focusedBlank.current) return
    focusedBlank.current = true
    if (editor.state.doc.childCount === 1 && editor.state.doc.firstChild?.type.name === 'paragraph' && !editor.state.doc.firstChild.content.size
      && !sheet.current!.querySelector('.floating-note')) editor.commands.focus('start')
  }, [editor, active, sheet])

  function begin(event: PointerEvent) {
    if (!target(event) || !editor) return false
    event.preventDefault(); event.stopPropagation()
    const end = editor.state.doc.content.size
    const selection = editor.state.doc.lastChild!.type.name === 'paragraph'
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
