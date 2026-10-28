import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { isComposingKey } from '../editor/composition'

interface Point { x: number; y: number }

export function useDocumentZoom(stage: RefObject<HTMLDivElement | null>, sheet: RefObject<HTMLDivElement | null>, width: number, editable: boolean, initialScale?: number) {
  const [autoScale, setAutoScale] = useState(1)
  // Counts explicit zoom actions so readers can show transient feedback, excluding automatic fitting.
  const [zoomed, setZoomed] = useState(0)
  const [zooms, setZooms] = useState<{ edit: number | null; read: number | null | undefined }>({ edit: initialScale ?? null, read: initialScale })
  const mode = editable ? 'edit' : 'read'
  const zoom = zooms[mode]
  const scale = zoom === undefined ? Math.min(autoScale, 1) : zoom ?? autoScale
  const minScale = Math.min(.25, autoScale)
  const focal = useRef<{ document: Point; client: Point } | null>(null)
  const topPadding = useRef<number | null>(null)
  const wheelGesture = useRef<{ scale: number; time: number } | null>(null)

  useLayoutEffect(() => { wheelGesture.current = null; pinch.current = null }, [autoScale, editable])

  const measure = useEffectEvent(() => {
    const viewport = stage.current!
    const style = getComputedStyle(viewport)
    const paddingTop = parseFloat(style.paddingTop)
    const paddingChange = paddingTop - (topPadding.current ?? paddingTop)
    topPadding.current = paddingTop
    const availableWidth = Math.max(1, viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
    const availableHeight = Math.max(1, viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))

    // Keep at least 600 document pixels visible instead of overfilling wide, short screens.
    const automatic = Math.min(3, availableWidth / width, availableHeight / 600)
    if (zoom === null && automatic !== scale && !focal.current) {
      const rect = viewport.getBoundingClientRect()
      // Anchor the visible top, not the centre; leave the page top in place when it is visible.
      const pageTop = sheet.current!.getBoundingClientRect().top
      rememberFocal({ x: rect.left + viewport.clientWidth / 2, y: Math.max(rect.top, pageTop) }, pageTop < rect.top ? paddingChange : 0)
    }
    setAutoScale(automatic)
    if (!editable) setZooms(current => current.read === undefined ? { ...current, read: Math.min(automatic, 1) } : current)
  })

  useLayoutEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage.current!)
    return () => observer.disconnect()
  }, [stage, width, editable])

  function rememberFocal(client: Point, paddingChange = 0) {
    const page = sheet.current!.getBoundingClientRect()
    // Responsive padding has already changed by the time ResizeObserver runs.
    focal.current = { document: { x: (client.x - page.left) / scale, y: (client.y - page.top + paddingChange) / scale }, client }
  }

  function zoomTo(next: number, client?: Point, snap = false, automatic = false) {
    wheelGesture.current = null
    setZoomed(count => count + 1)
    if (snap) {
      const target = [1, autoScale].sort((a, b) => Math.abs(Math.log(next / a)) - Math.abs(Math.log(next / b)))
        .find(value => next >= value * .95 && next <= value * 1.05)
      if (target !== undefined) next = target
    }
    next = Math.max(minScale, Math.min(3, next))
    // Even an unchanged manual scale leaves Auto (including snapping to its value).
    setZooms(current => ({ ...current, [mode]: automatic ? null : next }))
    if (next === scale) return
    const viewport = stage.current!
    const rect = viewport.getBoundingClientRect()
    rememberFocal(client ?? { x: rect.left + viewport.clientWidth / 2, y: rect.top + viewport.clientHeight / 2 })
  }

  function zoomBy(factor: number) { zoomTo(scale * factor, undefined, true) }
  function reset() { zoomTo(autoScale, undefined, false, true) }

  useLayoutEffect(() => {
    if (!focal.current) return
    const { document: point, client } = focal.current
    const page = sheet.current!.getBoundingClientRect()
    stage.current!.scrollLeft += page.left + point.x * scale - client.x
    stage.current!.scrollTop += page.top + point.y * scale - client.y
    focal.current = null
  }, [scale, sheet, stage])

  const wheel = useEffectEvent((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    if (!stage.current!.contains(event.target as Node)) return
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.current!.clientHeight : 1)
    const previous = wheelGesture.current
    const base = previous && event.timeStamp - previous.time < 250 ? previous.scale : scale
    // Wheel ticks can report hundreds of pixels; cap each event while retaining fine trackpad input.
    const step = Math.max(-50, Math.min(50, delta)) * .002
    const next = Math.max(minScale, Math.min(3, base * Math.exp(-step)))
    zoomTo(next, { x: event.clientX, y: event.clientY }, true)
    // Accumulate unsnapped input so small trackpad deltas can leave the detent.
    wheelGesture.current = { scale: next, time: event.timeStamp }
  })
  const key = useEffectEvent((event: KeyboardEvent) => {
    if (isComposingKey(event)) return
    if ((event.target as Element).closest('.drawing-editor')) return
    if (!(event.ctrlKey || event.metaKey) || !['+', '=', '-', '0'].includes(event.key)) return
    event.preventDefault()
    if (event.key === '0') reset()
    else zoomBy(event.key === '-' ? 1 / 1.1 : 1.1)
  })
  const pinch = useRef<{ distance: number; scale: number } | null>(null)
  const touch = useEffectEvent((event: TouchEvent) => {
    if (event.touches.length !== 2) { pinch.current = null; return }
    event.preventDefault()
    if (!stage.current!.contains(event.target as Node)) return
    const [a, b] = event.touches
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (!pinch.current) pinch.current = { distance, scale }
    else zoomTo(pinch.current.scale * distance / pinch.current.distance, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }, true)
  })

  useEffect(() => {
    const onWheel = (event: WheelEvent) => wheel(event)
    const onKey = (event: KeyboardEvent) => key(event)
    const onTouch = (event: TouchEvent) => touch(event)
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey, { capture: true })
    for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) window.addEventListener(name, onTouch as EventListener, { passive: false })
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey, { capture: true })
      for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) window.removeEventListener(name, onTouch as EventListener)
    }
  }, [])

  return { scale, minScale, automatic: zoom === null, zoomed, zoomTo, zoomBy, reset }
}
