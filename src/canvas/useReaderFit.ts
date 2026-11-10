import { useLayoutEffect, useState, type RefObject } from 'react'

// Fit once, then let browser zoom and window scrolling own the viewport.
// Re-fitting on every resize would cancel desktop browser zoom.
export function useReaderFit(stage: RefObject<HTMLDivElement | null>, width: number, enabled: boolean) {
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    if (!enabled) return
    const fit = () => setScale(Math.min(1, stage.current!.clientWidth / width))
    fit()
    screen.orientation?.addEventListener('change', fit)
    return () => screen.orientation?.removeEventListener('change', fit)
  }, [stage, width, enabled])
  return scale
}
