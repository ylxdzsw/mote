import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'

// The floor surrounds the scaled footprint; it never participates in page layout.
export function useScrollFloor(stage: RefObject<HTMLDivElement | null>, footprint: RefObject<HTMLDivElement | null>) {
  const container = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const control = useMemo(() => {
    let held = false, height = 0, frame = 0
    function padding() {
      const style = getComputedStyle(stage.current!)
      return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    }
    function write(next: number) {
      if (next === height) return
      height = next
      container.current!.style.minHeight = height ? `${height}px` : ''
    }
    function trim(settled = true) {
      if (held || !height) return
      const viewport = stage.current!
      const inset = padding()
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
        write(Math.max(0, Math.ceil(stage.current!.scrollHeight - padding())))
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
    const observer = new ResizeObserver(control.settle)
    observer.observe(viewport)
    observer.observe(footprint.current!)
    viewport.addEventListener('scroll', control.settle, { passive: true })
    return () => {
      mounted.current = false
      control.stop()
      observer.disconnect()
      viewport.removeEventListener('scroll', control.settle)
    }
  }, [stage, footprint, control])

  return { container, begin: control.begin, end: control.end, reset: control.reset }
}
