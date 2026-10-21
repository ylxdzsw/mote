import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'

// The floor surrounds the scaled footprint; it never participates in page layout.
export function useScrollFloor(stage: RefObject<HTMLDivElement | null>, footprint: RefObject<HTMLDivElement | null>, editable: boolean) {
  const container = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const control = useMemo(() => {
    let held = false, height = 0, frame = 0
    function clearance() {
      const style = getComputedStyle(stage.current!)
      return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(getComputedStyle(container.current!).marginBottom)
    }
    function write(next: number) {
      if (next === height) return
      height = next
      container.current!.style.minHeight = height ? `${height}px` : ''
    }
    function trim(settled = true) {
      if (held || !height) return
      const viewport = stage.current!
      const inset = clearance()
      // No scrollHeight feedback: after release the floor can only decrease.
      const needed = Math.max(0, Math.ceil(viewport.scrollTop + viewport.clientHeight - inset))
      const next = Math.min(height, needed)
      const covered = settled && Math.round(footprint.current!.getBoundingClientRect().height + inset) >= next + inset
      write(viewport.scrollTop === 0 || covered ? 0 : next)
    }
    return {
      begin() {
        cancelAnimationFrame(frame)
        held = true
        write(Math.max(0, Math.ceil(stage.current!.scrollHeight - clearance())))
      },
      end() {
        if (!mounted.current) return
        held = false
        trim(false)
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => { frame = 0; trim() })
      },
      reset() { cancelAnimationFrame(frame); held = false; write(0) },
      stop() { cancelAnimationFrame(frame) },
      settle() { trim() },
    }
  }, [stage, footprint])

  useLayoutEffect(() => {
    mounted.current = true
    const viewport = stage.current!
    function measure() {
      // Leave the page bottom near the top of the viewport, without changing Auto zoom or page geometry.
      const room = editable ? Math.max(0, viewport.clientHeight * .85 - parseFloat(getComputedStyle(viewport).paddingBottom)) : 0
      container.current!.style.setProperty('--scroll-past-bottom', `${room}px`)
      control.settle()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(footprint.current!)
    viewport.addEventListener('scroll', control.settle, { passive: true })
    return () => {
      mounted.current = false
      control.stop()
      observer.disconnect()
      viewport.removeEventListener('scroll', control.settle)
    }
  }, [stage, footprint, control, editable])

  return { container, begin: control.begin, end: control.end, reset: control.reset }
}
