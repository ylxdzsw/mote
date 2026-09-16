import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { useHistory } from '../document/history'
import { spaceLayoutKey, spaceRemovalThreshold, type SpacePreview, type SpaceShift } from '../editor/spaces'
import { isComposingKey } from '../editor/composition'

interface Target extends SpacePreview { top: number }
interface Drag { target: Target; y: number; height: number; moved: boolean; pointerId: number; shift?: SpaceShift }

export function useSpaceGesture(editor: Editor | null, sheet: RefObject<HTMLDivElement | null>, editable: boolean, scale: number, reflow: () => unknown, onActive: () => void) {
  const history = useHistory()
  const drag = useRef<Drag | null>(null)
  const [hint, setHint] = useState<{ top: number; height: number; dragging: boolean; existing: boolean } | null>(null)
  const findTarget = useRef<(_x: number, _y: number) => Target | null>(() => null)

  useLayoutEffect(() => {
    if (!editor) return
    const surface = sheet.current!
    let pointer: { x: number; y: number } | null = null
    let alt = false
    function preview(value: SpacePreview | null, shift: SpaceShift | null = null) {
      editor!.view.dispatch(editor!.state.tr.setMeta(spaceLayoutKey, { preview: value, shift }))
      reflow()
    }
    function target(x: number, y: number): Target | null {
      const hit = document.elementFromPoint(x, y)
      if (!editable || !hit || !surface.contains(hit) || hit.closest('.floating-note') || surface.classList.contains('has-creation-tool') || surface.hasAttribute('data-floating-preview')) return null
      const rect = surface.getBoundingClientRect()
      const localY = (y - rect.top) / scale - surface.clientTop
      const blocks: { from: number; space: boolean; top: number; bottom: number; line: number; height: number }[] = []
      editor!.state.doc.forEach((node, from) => {
        const element = editor!.view.nodeDOM(from) as HTMLElement
        const box = element.getBoundingClientRect()
        blocks.push({ from, space: node.type.name === 'spacer', top: (box.top - rect.top) / scale - surface.clientTop,
          bottom: (box.bottom - rect.top) / scale - surface.clientTop, line: parseFloat(getComputedStyle(element).lineHeight), height: node.attrs.height ?? 0 })
      })
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i], next = blocks[i + 1]
        if (!block.space) continue
        const bottom = next && !next.space ? Math.min(next.bottom, next.top + next.line) : block.bottom + 8
        if (localY >= block.top - 8 && localY <= bottom) return { from: block.from, existing: true, height: block.height, top: block.top }
      }
      let closest: { target: Target; distance: number } | null = null
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i], next = blocks[i + 1]
        if (block.space || next?.space) continue
        const top = next ? (block.bottom + next.top) / 2 : block.bottom
        if (localY < block.bottom - 8 || localY > (next?.top ?? block.bottom) + 8) continue
        const distance = Math.abs(localY - top)
        if (!closest || distance < closest.distance) closest = { target: { from: next?.from ?? editor!.state.doc.content.size, existing: false, height: 0, top }, distance }
      }
      return closest?.target ?? null
    }
    function hover() {
      if (drag.current) return
      const current = alt && pointer ? target(pointer.x, pointer.y) : null
      setHint(current ? { top: current.top, height: current.height, existing: current.existing, dragging: false } : null)
    }
    function cancel() {
      const previous = drag.current
      drag.current = null
      if (previous) {
        preview(null)
        if (surface.hasPointerCapture(previous.pointerId)) surface.releasePointerCapture(previous.pointerId)
      }
      hover()
    }
    function move(event: PointerEvent) {
      pointer = { x: event.clientX, y: event.clientY }; alt = event.altKey
      const current = drag.current
      if (!current) { hover(); return }
      if (event.pointerId !== current.pointerId) return
      event.preventDefault()
      if (!current.moved && Math.abs(event.clientY - current.y) < 3) return
      current.moved = true
      current.height = Math.max(0, current.target.height + (event.clientY - current.y) / scale)
      preview({ ...current.target, height: current.height }, current.shift ? { ...current.shift, delta: current.height - current.target.height } : null)
      setHint({ top: current.target.top, height: current.height, existing: current.target.existing, dragging: true })
    }
    function finish(event: PointerEvent) {
      const current = drag.current
      if (!current || event.pointerId !== current.pointerId) return
      drag.current = null
      const transaction = editor!.state.tr.setMeta(spaceLayoutKey, { preview: null, shift: null }).setMeta('historyBoundary', true)
      if (current.moved) {
        const height = Math.round(current.height * 10) / 10
        const { from, existing } = current.target
        if (existing) {
          if (current.shift) {
            const shift = { ...current.shift, delta: (height < spaceRemovalThreshold ? 0 : height) - current.target.height }
            if (height < spaceRemovalThreshold) {
              const anchor = shift.anchors.at(-1)!, previous = shift.anchors.at(-2)!
              shift.removed = { id: anchor.id!, anchorId: previous.id, offset: anchor.top - previous.top }
            }
            transaction.setMeta('spaceShift', shift)
          }
          if (height < spaceRemovalThreshold) transaction.delete(from, from + 1)
          else if (height !== current.target.height) transaction.setNodeAttribute(from, 'height', height)
        } else if (height >= spaceRemovalThreshold) transaction.insert(from, editor!.schema.nodes.spacer.create({ id: crypto.randomUUID(), height }))
      }
      editor!.view.dispatch(transaction)
      reflow()
      if (surface.hasPointerCapture(current.pointerId)) surface.releasePointerCapture(current.pointerId)
      hover()
    }
    function key(event: KeyboardEvent) {
      if (isComposingKey(event)) return
      alt = event.altKey
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancel() }
      hover()
    }
    function blur() { alt = false; pointer = null; cancel() }
    function changed({ transaction }: { transaction: Transaction }) {
      if (transaction.docChanged && drag.current) cancel()
    }
    findTarget.current = target
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    surface.addEventListener('lostpointercapture', cancel)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    window.addEventListener('blur', blur)
    window.addEventListener('scroll', hover, true)
    editor.on('transaction', changed)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      surface.removeEventListener('lostpointercapture', cancel)
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
      window.removeEventListener('blur', blur)
      window.removeEventListener('scroll', hover, true)
      editor.off('transaction', changed)
      cancel()
      setHint(null)
    }
  }, [editor, sheet, editable, scale, reflow, history.revision])

  function begin(event: ReactPointerEvent) {
    if (!event.altKey || !event.isPrimary || !editable || !editor) return false
    const target = findTarget.current(event.clientX, event.clientY)
    if (!target) return false
    event.preventDefault(); event.stopPropagation()
    let shift: SpaceShift | undefined
    if (target.existing) {
      const surface = sheet.current!, rect = surface.getBoundingClientRect()
      const anchors: SpaceShift['anchors'] = [{ id: null, top: 0 }]
      editor.state.doc.forEach((node, from) => {
        if (from > target.from) return
        const element = editor.view.nodeDOM(from) as HTMLElement
        anchors.push({ id: node.attrs.id, top: (element.getBoundingClientRect().top - rect.top) / scale - surface.clientTop })
      })
      shift = { anchors, from: Math.max(target.top, Math.min(target.top + target.height, (event.clientY - rect.top) / scale - surface.clientTop)), delta: 0 }
    }
    drag.current = { target, y: event.clientY, height: target.height, moved: false, pointerId: event.pointerId, shift }
    sheet.current!.setPointerCapture(event.pointerId)
    setHint({ top: target.top, height: target.height, existing: target.existing, dragging: true })
    history.boundary(); onActive()
    return true
  }
  return { begin, hint }
}
