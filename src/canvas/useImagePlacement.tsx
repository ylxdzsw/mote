import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import type { FloatingImage, MoteDocument } from '../document/model'
import { readImage } from '../document/image'
import { useHistory } from '../document/history'
import { isComposingKey } from '../editor/composition'
import { gridSize, type Point } from './floatingGeometry'

interface Placement { image: FloatingImage; origin: Point; point: Point; ratio: number }
interface Props {
  doc: MoteDocument; editable: boolean; scale: number; tool: string | null
  stage: RefObject<HTMLDivElement | null>; sheet: RefObject<HTMLDivElement | null>; editor: Editor | null
  insertion: () => Point | undefined; onStart: () => void; onCommit: (image: FloatingImage, point: Point) => void
}

// A clipboard image is only document content after placement is confirmed.
export function useImagePlacement({ doc, editable, scale, tool, stage, sheet, editor, insertion, onStart, onCommit }: Props) {
  const history = useHistory()
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [notice, setNotice] = useState('')
  const generation = useRef(0), loading = useRef(false)
  const pointer = useRef<{ clientX: number; clientY: number; altKey: boolean } | null>(null)
  const gesture = useRef<{ pointerId: number; start: Point; raw: Point; moved: boolean } | null>(null)
  const current = useRef(placement)
  current.current = placement
  function update(value: Placement | null) { current.current = value; setPlacement(value) }
  function cancel() {
    generation.current++; loading.current = false; update(null); setNotice('')
    const drag = gesture.current
    gesture.current = null
    if (drag && stage.current?.hasPointerCapture(drag.pointerId)) stage.current.releasePointerCapture(drag.pointerId)
  }
  useLayoutEffect(() => { cancel(); return () => { generation.current++ } }, [doc, editable, scale, history.revision])
  useLayoutEffect(() => { if (tool) cancel() }, [tool])

  function pageWidth() { return sheet.current!.clientWidth }
  function local(p: { clientX: number; clientY: number }): Point {
    const surface = sheet.current!, rect = surface.getBoundingClientRect()
    return { x: (p.clientX - rect.left) / scale - surface.clientLeft, y: (p.clientY - rect.top) / scale - surface.clientTop }
  }
  function snapped(p: Point, alt: boolean): Point {
    return alt ? p : { x: Math.round(p.x / gridSize) * gridSize, y: Math.round(p.y / gridSize) * gridSize }
  }
  function bounded(p: Point, width: number): Point {
    return { x: Math.max(0, Math.min(pageWidth() - width, p.x)), y: Math.max(0, p.y) }
  }
  function follow(event: { clientX: number; clientY: number; altKey: boolean }) {
    const value = current.current
    if (!value) return
    const p = local(event), drag = gesture.current
    if (!drag) { update({ ...value, point: bounded(snapped(p, event.altKey), value.image.width) }); return }
    if (!drag.moved && Math.hypot(p.x - drag.raw.x, p.y - drag.raw.y) * scale < 3) return
    drag.moved = true
    const end = snapped(p, event.altKey), west = end.x < drag.start.x, north = end.y < drag.start.y
    // Image objects have 8px padding and a 1px border on each side.
    const inset = 18, ratio = value.ratio
    const available = west ? drag.start.x : pageWidth() - drag.start.x
    const vertical = north ? Math.max(0, drag.start.y - inset) * ratio + inset : Infinity
    const width = Math.min(pageWidth(), Math.max(36, Math.min(available, vertical, Math.max(Math.abs(end.x - drag.start.x), Math.max(0, Math.abs(end.y - drag.start.y) - inset) * ratio + inset))))
    const height = Math.max(0, width - inset) / ratio + inset
    update({ ...value, image: { ...value.image, width }, point: bounded({ x: west ? drag.start.x - width : drag.start.x, y: north ? drag.start.y - height : drag.start.y }, width) })
  }
  function commit(atOrigin = false) {
    const value = current.current
    if (!value) return
    cancel()
    onCommit(value.image, atOrigin ? value.origin : value.point)
  }

  useLayoutEffect(() => {
    if (!editable) return
    async function paste(event: ClipboardEvent) {
      const data = event.clipboardData, target = document.activeElement
      if (!data || !(target instanceof HTMLElement) || !stage.current?.contains(target) || target.closest('input, textarea, select, iframe')) return
      const html = data.getData('text/html')
      if ([...data.types].some(type => type.startsWith('application/x-mote-')) || /data-mote-(floating|segment|paragraphs)/.test(html)) return
      if (data.getData('text/plain').trim()) return
      if (html && new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim()) return
      const files = [...data.files]
      if (!files.length || files.some(file => !file.type.startsWith('image/'))) return
      event.preventDefault(); event.stopImmediatePropagation()
      const caret = editor?.view.coordsAtPos(editor.state.selection.from)
      const origin = insertion() ?? (caret ? local({ clientX: caret.left, clientY: caret.top }) : { x: doc.margins.left, y: doc.margins.top })
      cancel(); onStart()
      if (files.length !== 1) { setNotice('Paste one image at a time, or drop multiple image files onto the document.'); return }
      stage.current!.focus({ preventScroll: true })
      const token = generation.current
      loading.current = true; setNotice('Opening clipboard image…')
      try {
        const src = await readImage(files[0])
        const image = new Image(); image.src = src; await image.decode()
        if (generation.current !== token) return
        const width = Math.min(340, image.naturalWidth + 18, pageWidth())
        const point = bounded(origin, width)
        update({ image: { id: crypto.randomUUID(), kind: 'image', src, alt: '', anchorId: null, x: point.x, y: point.y, width, placement: 'float' },
          origin: point, point, ratio: image.naturalWidth / image.naturalHeight })
        setNotice('Click to place, or drag to size. Enter places at the insertion point. Escape cancels.')
        if (pointer.current && sheet.current!.contains(document.elementFromPoint(pointer.current.clientX, pointer.current.clientY))) follow(pointer.current)
      } catch (error) { if (generation.current === token) setNotice((error as Error).message) }
      finally { if (generation.current === token) loading.current = false }
    }
    function move(event: globalThis.PointerEvent) {
      pointer.current = { clientX: event.clientX, clientY: event.clientY, altKey: event.altKey }
      if (gesture.current && gesture.current.pointerId !== event.pointerId) return
      if (gesture.current || sheet.current?.contains(event.target as Node)) follow(event)
    }
    function down(event: globalThis.PointerEvent) {
      if (!current.current && !loading.current) return
      if (!sheet.current?.contains(event.target as Node)) { cancel(); return }
      if (event.button !== 0 || !event.isPrimary) return
      event.preventDefault(); event.stopImmediatePropagation()
      const value = current.current
      if (!value) return
      follow(event)
      const raw = local(event), start = bounded(snapped(raw, event.altKey), 36)
      gesture.current = { pointerId: event.pointerId, raw, start, moved: false }
      stage.current!.setPointerCapture(event.pointerId)
    }
    function up(event: globalThis.PointerEvent) {
      if (gesture.current?.pointerId !== event.pointerId) return
      event.preventDefault(); event.stopImmediatePropagation()
      follow(event); commit()
    }
    function aborted(event: globalThis.PointerEvent) { if (gesture.current?.pointerId === event.pointerId) cancel() }
    function key(event: KeyboardEvent) {
      if ((!current.current && !loading.current) || isComposingKey(event)) return
      if (event.type === 'keydown' && (event.key === 'Escape' || event.key === 'Enter')) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (event.key === 'Escape') cancel()
        else if (!gesture.current) commit(true)
      } else if (event.key === 'Alt' && pointer.current) {
        pointer.current = { ...pointer.current, altKey: event.altKey }; follow(pointer.current)
      }
    }
    function scroll() { if (pointer.current && current.current) follow(pointer.current) }
    window.addEventListener('paste', paste, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', aborted, true)
    window.addEventListener('lostpointercapture', aborted, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('keyup', key, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('paste', paste, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', aborted, true)
      window.removeEventListener('lostpointercapture', aborted, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('keyup', key, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', cancel)
    }
  })
  return { active: !!placement, notice, preview: placement && <div className="image-placement floating-image" aria-hidden="true"
    style={{ left: placement.point.x, top: placement.point.y, width: placement.image.width }}><img src={placement.image.src} alt="" draggable={false} /></div> }
}
