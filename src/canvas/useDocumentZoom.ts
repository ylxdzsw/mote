import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { isComposingKey } from '../editor/composition'

interface Point { x: number; y: number }

export function useDocumentZoom(stage: RefObject<HTMLDivElement | null>, sheet: RefObject<HTMLDivElement | null>, width: number, editable: boolean, initialScale?: number) {
  const [fit, setFit] = useState(1)
  const [autoScale, setAutoScale] = useState(1)
  const [zoom, setZoom] = useState<number | null>(initialScale ?? null)
  const scale = zoom ?? autoScale
  const minScale = Math.min(.25, autoScale)
  const focal = useRef<{ document: Point; client: Point } | null>(null)
  const wheelGesture = useRef<{ scale: number; time: number } | null>(null)

  useLayoutEffect(() => { wheelGesture.current = null }, [autoScale, editable])

  useLayoutEffect(() => {
    const viewport = stage.current!
    const measure = () => {
      const style = getComputedStyle(viewport)
      const availableWidth = Math.max(1, viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
      const availableHeight = Math.max(1, viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
      setFit(Math.min(1, availableWidth / width))
      // Auto reserves breathing room even when reading has no scrollable side padding.
      const autoWidth = Math.max(1, viewport.clientWidth - 2 * parseFloat(style.getPropertyValue('--canvas-gutter')))
      // Keep at least 600 document pixels visible instead of overfilling wide, short screens.
      setAutoScale(Math.min(3, autoWidth / width, availableHeight / 600))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [stage, width])

  function zoomTo(next: number, client?: Point, snap = false, automatic = false) {
    wheelGesture.current = null
    if (snap) {
      const target = [1, autoScale].sort((a, b) => Math.abs(Math.log(next / a)) - Math.abs(Math.log(next / b)))
        .find(value => next >= value * .95 && next <= value * 1.05)
      if (target !== undefined) next = target
    }
    next = Math.max(minScale, Math.min(3, next))
    // Even an unchanged manual scale leaves Auto (including snapping to its value).
    setZoom(automatic ? null : next)
    if (next === scale) return
    const viewport = stage.current!
    const rect = viewport.getBoundingClientRect()
    const page = sheet.current!.getBoundingClientRect()
    const point = client ?? { x: rect.left + viewport.clientWidth / 2, y: rect.top + viewport.clientHeight / 2 }
    focal.current = { document: { x: (point.x - page.left) / scale, y: (point.y - page.top) / scale }, client: point }
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
    const next = Math.max(minScale, Math.min(3, base * Math.exp(-delta * .01)))
    zoomTo(next, { x: event.clientX, y: event.clientY }, true)
    // Accumulate unsnapped input so small trackpad deltas can leave the detent.
    wheelGesture.current = { scale: next, time: event.timeStamp }
  })
  const key = useEffectEvent((event: KeyboardEvent) => {
    if (isComposingKey(event)) return
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

  return { scale, minScale, automatic: zoom === null, zoomTo, zoomBy, reset, fit: () => zoomTo(fit) }
}
