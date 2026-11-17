import { useLayoutEffect, useRef } from 'react'
import { extentBounds, type Box, type Geometries } from '../canvas/floatingGeometry'
import { nativeSize } from '../canvas/measurement'
import type { MoteDocument } from '../document/model'
import type { SegmentPoint, SegmentRange } from '../document/segment'
import type { SegmentPreview } from './segmentProjection'
import { resolveSegmentRange } from './segments'
import type { AITask } from './types'

// An overlay, not a wrapper: paragraph margin collapse and Flow mounts stay native.
export function SegmentBorders({ doc, ranges, tasks, previews, owners, geometry, activeId, onSelect }: {
  doc: MoteDocument; ranges?: readonly { taskId: string; range: SegmentRange }[]
  tasks: AITask[]; previews: SegmentPreview[]
  owners: Map<string, string>; geometry: Geometries; activeId: string | null
  onSelect?: (taskId: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const previewIds = new Set(previews.flatMap(preview => preview.taskIds))
  const ids = tasks.filter(task => task.target.kind === 'segment').map(task => task.id)
  const measuredRanges = ranges ?? tasks.flatMap(task => {
    const range = task.target.kind === 'segment' && resolveSegmentRange(doc, task.target)
    return range ? [{ taskId: task.id, range }] : []
  })
  const objects = new Map(owners)
  for (const task of tasks) if (task.target.kind === 'segment') {
    for (const id of task.target.objectIds) if (!objects.has(id)) objects.set(id, task.id)
  }
  useLayoutEffect(() => {
    // A child's layout effect runs before its parent's sheet ref is attached.
    const surface = root.current!.parentElement!
    const editor = surface.querySelector<HTMLElement>('.main-text .tiptap')
    const elements = new Map(Array.from(editor?.querySelectorAll<HTMLElement>(':scope > [data-id]:not(.ai-original-hidden), :scope > .ai-segment-preview > [data-ai-block]') ?? [],
      element => [element.dataset.aiBlock ?? element.dataset.id!, element]))
    const measure = () => {
      const rect = surface.getBoundingClientRect(), scale = rect.width / nativeSize(surface).width
      const width = doc.page.width - surface.clientLeft * 2
      const boxOf = (element: HTMLElement): Box => {
        const box = element.getBoundingClientRect()
        return { x: (box.left - rect.left) / scale - surface.clientLeft,
          y: (box.top - rect.top) / scale - surface.clientTop, width: box.width / scale, height: box.height / scale }
      }
      const blocks = (doc.content.content ?? []).map(node => {
        const element = elements.get(node.attrs!.id)
        return element && !element.classList.contains('ai-original-hidden') ? boxOf(element) : undefined
      })
      const boundary = (point: SegmentPoint, end = false) => {
        const block = blocks[point.index]
        if (point.offset) return block && block.y + point.offset
        const previous = blocks[point.index - 1]
        return end ? previous ? previous.y + previous.height : block?.y
          : block?.y ?? (previous && previous.y + previous.height)
      }
      const bands = new Map<string, Box>()
      for (const { taskId, range } of measuredRanges) {
        if (!ranges && previewIds.has(taskId)) continue
        const top = boundary(range.start)
        const empty = range.start.index === range.end.index && range.start.offset === range.end.offset
        const bottom = empty ? top : boundary(range.end, true)
        if (top !== undefined && bottom !== undefined) bands.set(taskId, { x: 0, y: top, width, height: Math.max(0, bottom - top) })
      }
      // Without projected ranges, fall back to owned replacement blocks. Supplied
      // intervals are authoritative, including subranges of merged spacers.
      if (!ranges) for (const element of surface.querySelectorAll<HTMLElement>('.ai-segment-preview > [data-ai-segment-owner]')) {
        const id = element.dataset.aiSegmentOwner!, box = boxOf(element), band = bands.get(id)
        if (element.classList.contains('ai-segment-preview-anchor')) box.height = 0
        const top = Math.min(band?.y ?? box.y, box.y)
        const bottom = Math.max(band ? band.y + band.height : box.y + box.height, box.y + box.height)
        bands.set(id, { x: 0, y: top, width, height: bottom - top })
      }
      for (const element of root.current!.children) {
        const border = element as HTMLDivElement
        const taskId = border.dataset.aiSegment!, band = bands.get(taskId)
        const objectId = border.dataset.aiSegmentObject
        const box = objectId ? geometry[objectId] && extentBounds(geometry[objectId]) : band
        border.hidden = !box || !!(objectId && band && box.x >= 0 && box.x + box.width <= width && box.y >= band.y && box.y + box.height <= band.y + band.height)
        if (!box) continue
        Object.assign(border.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` })
        border.toggleAttribute('data-ai-empty', box.height === 0)
        if (!objectId) {
          border.dataset.aiSegmentStart = String(box.y)
          border.dataset.aiSegmentEnd = String(box.y + box.height)
          const handle = border.querySelector<HTMLButtonElement>('.ai-segment-preview-handle')
          if (handle) handle.hidden = box.height !== 0
        }
      }
      for (const marker of surface.querySelectorAll<HTMLElement>('.ai-segment-marker')) {
        const band = bands.get(marker.dataset.aiSegment!)
        if (!band) continue
        const offset = parseFloat(marker.style.getPropertyValue('--ai-segment-offset')) || 0
        marker.style.setProperty('--ai-segment-offset', `${band.y - boxOf(marker).y + offset}px`)
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (editor) observer.observe(editor)
    for (const element of elements.values()) observer.observe(element)
    for (const element of surface.querySelectorAll<HTMLElement>('.ai-segment-preview > *')) observer.observe(element)
    return () => observer.disconnect()
  })
  return <div ref={root} className="ai-segment-borders">
    {ids.map(id => <div key={id} className={`ai-segment-border${previewIds.has(id) ? '' : ' ai-reserved'}`} data-ai-segment-border={id} data-ai-segment={id} data-active={id === activeId ? '' : undefined}>
      {previewIds.has(id) && onSelect && <button type="button" className="ai-segment-handle ai-segment-preview-handle" hidden
        aria-label="Select empty AI segment preview" aria-pressed={id === activeId}
        onFocus={() => onSelect(id)}
        onPointerDown={event => {
          if (event.button !== 0) return
          event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true })
        }}
        onClick={event => { event.stopPropagation(); onSelect(id) }} />}
    </div>)}
    {[...objects].map(([objectId, id]) => <div key={`object:${objectId}`} className={`ai-segment-border ai-segment-object-border${previewIds.has(id) ? '' : ' ai-reserved'}`}
      data-ai-segment-object={objectId} data-ai-segment={id} data-active={id === activeId ? '' : undefined} aria-hidden="true" />)}
  </div>
}
