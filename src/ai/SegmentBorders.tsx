import { useLayoutEffect, useRef, type RefObject } from 'react'
import { extentBounds, type Box, type Geometries } from '../canvas/floatingGeometry'
import { nativeSize } from '../canvas/measurement'
import type { SegmentPreview } from './segmentProjection'
import type { AITask } from './types'

// An overlay, not a wrapper: paragraph margin collapse and Flow mounts stay native.
export function SegmentBorders({ sheet, tasks, previews, owners, geometry, activeId }: {
  sheet: RefObject<HTMLDivElement | null>; tasks: AITask[]; previews: SegmentPreview[]
  owners: Map<string, string>; geometry: Geometries; activeId: string | null
}) {
  const root = useRef<HTMLDivElement>(null)
  const previewIds = new Set(previews.flatMap(preview => preview.taskIds))
  const ids = tasks.filter(task => task.target.kind === 'segment').map(task => task.id)
  useLayoutEffect(() => {
    const surface = sheet.current!, rect = surface.getBoundingClientRect()
    const scale = rect.width / nativeSize(surface).width
    const boxes = new Map(ids.map(id => [id, [] as Box[]]))
    for (const element of surface.querySelectorAll<HTMLElement>('.ai-segment-preview > [data-ai-segment-owner], .ai-segment-reserved:not([data-ai-empty])')) {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const start = parseFloat(style.getPropertyValue('--ai-segment-start')) || 0
      const end = parseFloat(style.getPropertyValue('--ai-segment-end'))
      boxes.get(element.dataset.aiSegmentOwner ?? element.dataset.aiSegment!)?.push({
        x: (box.left - rect.left) / scale - surface.clientLeft,
        y: (box.top - rect.top) / scale - surface.clientTop + start,
        width: box.width / scale, height: (Number.isNaN(end) ? box.height / scale : end) - start,
      })
    }
    for (const [id, owner] of owners) if (geometry[id]) boxes.get(owner)?.push(extentBounds(geometry[id]))
    for (const task of tasks) if (task.target.kind === 'segment' && !previewIds.has(task.id)) {
      for (const id of task.target.objectIds) if (geometry[id]) boxes.get(task.id)?.push(extentBounds(geometry[id]))
    }
    for (const element of root.current!.children) {
      const border = element as HTMLDivElement, bounds = boxes.get(border.dataset.aiSegmentBorder!)!
      border.hidden = !bounds.length
      if (!bounds.length) continue
      const left = Math.min(...bounds.map(box => box.x)), top = Math.min(...bounds.map(box => box.y))
      Object.assign(border.style, {
        left: `${left - 4}px`, top: `${top - 4}px`,
        width: `${Math.max(...bounds.map(box => box.x + box.width)) - left + 8}px`,
        height: `${Math.max(...bounds.map(box => box.y + box.height)) - top + 8}px`,
      })
    }
  })
  return <div ref={root} className="ai-segment-borders" aria-hidden="true">
    {ids.map(id => <div key={id} className={`ai-segment-border${previewIds.has(id) ? '' : ' ai-reserved'}`} data-ai-segment-border={id} data-active={id === activeId ? '' : undefined} />)}
  </div>
}
