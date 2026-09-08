import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react'

interface Point { x: number; y: number }

export function useDocumentZoom(stage: RefObject<HTMLDivElement | null>, sheet: RefObject<HTMLDivElement | null>, width: number, editable: boolean) {
  const [fit, setFit] = useState(1)
  const [zoom, setZoom] = useState(1)
  const scale = fit * zoom
  const minScale = Math.min(.25, fit)
  const focal = useRef<{ document: Point; client: Point } | null>(null)
  const wheelGesture = useRef<{ scale: number; time: number } | null>(null)

  useLayoutEffect(() => { setZoom(1) }, [editable])
  useLayoutEffect(() => { wheelGesture.current = null }, [fit, editable])

  useLayoutEffect(() => {
    const viewport = stage.current!
    const measure = () => setFit(editable ? 1 : Math.min(1, (viewport.clientWidth - 48) / width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [stage, width, editable])

  function zoomTo(next: number, client?: Point, snap = false) {
    wheelGesture.current = null
    if (snap && next >= .95 && next <= 1.05) next = 1
    next = Math.max(minScale, Math.min(3, next))
    if (next === scale) return
    const viewport = stage.current!
    const rect = viewport.getBoundingClientRect()
    const page = sheet.current!.getBoundingClientRect()
    const point = client ?? { x: rect.left + viewport.clientWidth / 2, y: rect.top + viewport.clientHeight / 2 }
    focal.current = { document: { x: (point.x - page.left) / scale, y: (point.y - page.top) / scale }, client: point }
    setZoom(next / fit)
  }

  function zoomBy(factor: number) { zoomTo(scale * factor, undefined, true) }

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
    if (!(event.ctrlKey || event.metaKey) || !['+', '=', '-', '0'].includes(event.key)) return
    event.preventDefault()
    if (event.key === '0') zoomTo(fit)
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

  return { scale, minScale, zoomTo, zoomBy, reset: () => zoomTo(fit) }
}
