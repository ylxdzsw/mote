import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { useHistory } from '../document/history'
import type { MoteDocument } from '../document/model'
import { copySegment, moveSegment, parseSegment, replaceSegment, segmentObjectIds, segmentPointAt, segmentPosition, segmentText, serializeSegment, SEGMENT_MIME, type SegmentClipboard, type SegmentPoint, type SegmentRange } from '../document/segment'
import { isComposingKey } from '../editor/composition'
import { floatingClipboardJSON } from '../document/floatingClipboard'
import { paragraphClipboardJSON, parseParagraphs } from '../document/paragraphClipboard'
import { extentBounds, type Anchor, type Box, type Geometries } from './floatingGeometry'
import { layoutPixel } from './measurement'
import './segment.css'

interface Props {
  doc: MoteDocument; editable: boolean; editor: Editor | null; scale: number
  stage: RefObject<HTMLDivElement | null>; sheet: RefObject<HTMLDivElement | null>
  reservedSegments?: readonly { taskId: string; range: SegmentRange; objectIds: string[] }[]
  onSelectReservation?: (id: string) => void
  anchors: Anchor[]; geometry: Geometries; lockedIds: Set<string>; onStart: () => void
}
interface Block { top: number; bottom: number; height: number; space: boolean; stops?: { offset: number; y: number }[] }
interface Unit { taskId: string; range: SegmentRange; top: number; bottom: number }
type Measurement = Block[] & { units: Unit[] }
interface Paint { objects: (Box & { id: string })[]; top: number; bottom: number }
interface Drag {
  pointerId: number; y: number; originY: number; originClientY: number; alt: boolean; moved: boolean
  anchor: SegmentPoint; originBlock: number; handle?: 'start' | 'end'; handleOffset: number; previous: SegmentRange | null
  moving: boolean; destination?: SegmentPoint
}
const compare = (a: SegmentPoint, b: SegmentPoint) => a.index - b.index || a.offset - b.offset
const equal = (range: SegmentRange) => compare(range.start, range.end) === 0
const ordered = (a: SegmentPoint, b: SegmentPoint): SegmentRange => compare(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a }
const edge = (index: number): SegmentPoint => ({ index, offset: 0 })
const inside = (point: SegmentPoint, range: SegmentRange) => compare(point, range.start) > 0 && compare(point, range.end) < 0
const overlaps = (a: SegmentRange, b: SegmentRange) => compare(a.start, b.end) < 0 && compare(a.end, b.start) > 0
const boundaryTolerance = 3 // Screen pixels, independent of document zoom.
const escapeHTML = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const marker = <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h5l9 7-9 7H3l7-7z" /></svg>

export function useSegmentSelection(props: Props) {
  const history = useHistory()
  const live = useRef({ ...props, history })
  live.current = { ...props, history }
  const selected = useRef<SegmentRange | null>(null)
  const insertion = useRef<SegmentPoint | null>(null)
  const [range, setRange] = useState<SegmentRange | null>(null)
  const [paint, setPaint] = useState<Paint>({ objects: [], top: 0, bottom: 0 })
  const [notice, setNotice] = useState('')
  const [dropY, setDropY] = useState<number | null>(null)
  const [marginHover, setMarginHover] = useState(false)
  const [reservationHover, setReservationHover] = useState(false)
  const marginPointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const drag = useRef<Drag | null>(null)
  const tick = useRef<() => void>(() => {})
  const content = useRef(props.doc.content)

  function expand(next: SegmentRange) {
    for (const { range } of live.current.reservedSegments ?? []) {
      if (inside(next.start, range)) next = { ...next, start: range.start }
      if (inside(next.end, range)) next = { ...next, end: range.end }
    }
    return next
  }
  function select(next: SegmentRange | null) {
    if (next) next = expand(next)
    insertion.current = null
    selected.current = next; setRange(next); setNotice('')
  }
  function measure(): Measurement {
    const { editor, sheet, scale, doc, reservedSegments = [] } = live.current
    const blocks = Object.assign([] as Block[], { units: [] as Unit[] })
    if (!editor || !sheet.current) return blocks
    const rect = sheet.current.getBoundingClientRect(), border = sheet.current.clientTop
    const bounds = (element: Element) => {
      const box = element.getBoundingClientRect()
      const top = layoutPixel((box.top - rect.top) / scale - border)
      return { top, bottom: element.matches('.ai-segment-preview-handle, [data-ai-segment-border][data-ai-empty]') ? top : layoutPixel((box.bottom - rect.top) / scale - border) }
    }
    const candidates = new Map<string, HTMLElement>()
    for (const element of editor.view.dom.querySelectorAll<HTMLElement>('[data-ai-block]')) {
      const id = element.dataset.aiBlock!
      const block = element.closest<HTMLElement>('.main-paragraph, [data-spacer], [data-flow]')
      if (block && !candidates.has(id)) candidates.set(id, block)
    }
    const elements: HTMLElement[] = []
    editor.state.doc.forEach((node, from) => {
      const element = editor.view.nodeDOM(from) as HTMLElement
      elements.push(element)
      const candidate = candidates.get(node.attrs.id)
      let { top, bottom } = bounds(candidate ?? element)
      // Extra text-task paragraphs belong to the final original block.
      for (let next = candidate?.nextElementSibling; next?.getAttribute('data-ai-block') === ''; next = next.nextElementSibling) bottom = bounds(next).bottom
      const space = node.type.name === 'spacer'
      blocks.push({ top, bottom, height: space ? node.attrs.height : bottom - top, space })
    })
    const content = doc.content.content!
    const position = (point: SegmentPoint) => segmentPosition(content, point)
    for (const root of editor.view.dom.querySelectorAll<HTMLElement>('[data-ai-segment-preview]')) {
      const children = [...root.children] as HTMLElement[]
      if (!children.length) continue
      const hidden: number[] = []
      for (let next = root.nextElementSibling; next?.classList.contains('ai-original-hidden'); next = next.nextElementSibling) {
        const index = elements.indexOf(next as HTMLElement)
        if (index >= 0) hidden.push(index)
      }
      const first = hidden[0] ?? elements.findIndex(element => !!(root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
      const start = edge(first < 0 ? blocks.length : first), end = edge(hidden.length ? hidden.at(-1)! + 1 : start.index)
      const top = bounds(children[0]).top, bottom = bounds(children.at(-1)!).bottom
      const tasks = new Set(root.dataset.aiSegmentTasks?.split(' '))
      const reservations = reservedSegments.filter(unit => tasks.has(unit.taskId) && compare(unit.range.start, end) <= 0 && compare(unit.range.end, start) >= 0)
        .sort((a, b) => compare(a.range.start, b.range.start))
      const knots = [{ position: position(start), y: top }, { position: position(end), y: bottom }]
      for (const [index, unit] of reservations.entries()) {
        const owned = children.filter(element => element.dataset.aiSegmentOwner === unit.taskId)
        let unitTop = owned.length ? bounds(owned[0]).top : top
        let unitBottom = owned.length ? bounds(owned.at(-1)!).bottom : unitTop
        // Retained spacer fragments are outside the task. For a merged/empty
        // replacement, recover its edges from those original spacer lengths.
        if ((!owned.length || owned[0] === children[0]) && index === 0 && unit.range.start.index === start.index && unit.range.start.offset) unitTop = top + unit.range.start.offset
        if ((!owned.length || owned.at(-1) === children.at(-1)) && index === reservations.length - 1 && unit.range.end.offset && unit.range.end.index === end.index - 1) {
          unitBottom = bottom - (blocks[unit.range.end.index].height - unit.range.end.offset)
        }
        const next = reservations[index + 1]
        if (!owned.length && next && next.range.start.index === unit.range.end.index && next.range.start.offset > unit.range.end.offset) {
          const nextOwned = children.find(element => element.dataset.aiSegmentOwner === next.taskId)
          if (nextOwned) unitBottom = bounds(nextOwned).top - (next.range.start.offset - unit.range.end.offset)
        }
        const band = sheet.current.querySelector<HTMLElement>(`[data-ai-segment-border="${unit.taskId}"]:not([hidden])`)
        if (band) ({ top: unitTop, bottom: unitBottom } = bounds(band))
        unitBottom = Math.max(unitTop, unitBottom)
        blocks.units.push({ taskId: unit.taskId, range: unit.range, top: unitTop, bottom: unitBottom })
        knots.push({ position: position(unit.range.start), y: unitTop }, { position: position(unit.range.end), y: unitBottom })
        if (index === 0 && unit.range.start.index === start.index && unit.range.start.offset) {
          knots.push({ position: position(unit.range.start), y: top + unit.range.start.offset })
        }
        if (index === reservations.length - 1 && unit.range.end.offset && unit.range.end.index === end.index - 1) {
          knots.push({ position: position(unit.range.end), y: bottom - (blocks[unit.range.end.index].height - unit.range.end.offset) })
        }
      }
      knots.sort((a, b) => a.position - b.position || a.y - b.y)
      const at = (value: number, side: 'start' | 'end') => {
        const exact = knots.filter(knot => knot.position === value)
        if (exact.length) return (side === 'start' ? exact.at(-1)! : exact[0]).y
        const before = knots.findLast(knot => knot.position < value)!, after = knots.find(knot => knot.position > value)!
        return before.y + (after.y - before.y) * (value - before.position) / (after.position - before.position)
      }
      for (const index of hidden) {
        const block = blocks[index], from = position(edge(index)), to = position(edge(index + 1))
        block.top = at(from, 'start'); block.bottom = at(to, 'end')
        if (block.space) block.stops = [{ offset: 0, y: block.top }, ...knots.filter(knot => knot.position > from && knot.position < to).map(knot => ({ offset: knot.position - from, y: knot.y })), { offset: block.height, y: block.bottom }]
      }
    }
    for (const unit of reservedSegments) if (!blocks.units.some(measured => measured.taskId === unit.taskId)) {
      const band = sheet.current.querySelector<HTMLElement>(`[data-ai-segment-border="${unit.taskId}"]:not([hidden])`)
      blocks.units.push({ taskId: unit.taskId, range: unit.range, ...(band ? bounds(band) : {
        top: blockBoundaryY(unit.range.start, 'start', blocks), bottom: blockBoundaryY(unit.range.end, equal(unit.range) ? 'start' : 'end', blocks),
      }) })
    }
    return blocks
  }
  function snapshotAnchors() {
    const { anchors, doc } = live.current, blocks = measure()
    return anchors.map(anchor => ({ ...anchor, bottom: blocks[doc.content.content!.findIndex(node => node.attrs!.id === anchor.id)]?.bottom }))
  }
  function localY(clientY: number) {
    const { sheet, scale } = live.current
    return (clientY - sheet.current!.getBoundingClientRect().top) / scale - sheet.current!.clientTop
  }
  function endpoint(y: number, alt: boolean, blocks = measure()): SegmentPoint {
    if (!blocks.length) return edge(0)
    const boundary = reservationBoundary(y, blocks)
    if (boundary) return boundary
    const unit = blocks.units.find(unit => y > unit.top && y < unit.bottom)
    if (unit) return y - unit.top < unit.bottom - y ? unit.range.start : unit.range.end
    for (const [index, block] of blocks.entries()) {
      if (alt && block.space && y > block.top && y < block.bottom) {
        const stops = block.stops ?? [{ offset: 0, y: block.top }, { offset: block.height, y: block.bottom }]
        const before = stops.findLast(stop => stop.y <= y)!, after = stops.find(stop => stop.y > y)!
        const offset = Math.min(block.height, Math.round((before.offset + (y - before.y) * (after.offset - before.offset) / (after.y - before.y)) * 10) / 10)
        return offset === block.height ? edge(index + 1) : { index, offset }
      }
    }
    // One logical break may have two visual edges, separated only by theme spacing.
    let nearest = edge(0), distance = Math.abs(blocks[0].top - y)
    for (const [index, block] of blocks.entries()) {
      const startDistance = Math.abs(block.top - y)
      if (startDistance < distance && !blocks.units.some(unit => inside(edge(index), unit.range))) { nearest = edge(index); distance = startDistance }
      const endDistance = Math.abs(block.bottom - y)
      if (endDistance < distance && !blocks.units.some(unit => inside(edge(index + 1), unit.range))) { nearest = edge(index + 1); distance = endDistance }
    }
    for (const unit of blocks.units) for (const side of ['start', 'end'] as const) {
      const delta = Math.abs((side === 'start' ? unit.top : unit.bottom) - y)
      if (delta < distance) { nearest = unit.range[side]; distance = delta }
    }
    return nearest
  }
  function reservationBoundary(y: number, blocks: Measurement) {
    let point: SegmentPoint | undefined, distance = boundaryTolerance / live.current.scale
    for (const unit of blocks.units) {
      if (equal(unit.range) && unit.top === unit.bottom) continue
      for (const side of ['start', 'end'] as const) {
        const delta = Math.abs((side === 'start' ? unit.top : unit.bottom) - y)
        if (delta <= distance) { point = unit.range[side]; distance = delta }
      }
    }
    return point
  }
  function blockBoundaryY(point: SegmentPoint, side: 'start' | 'end', blocks: Block[]) {
    if (!blocks.length) return 0
    if (point.offset) {
      const block = blocks[point.index]
      if (!block.stops) return block.top + point.offset
      const before = block.stops.findLast(stop => stop.offset <= point.offset)!, after = block.stops.find(stop => stop.offset > point.offset)
      return after ? before.y + (point.offset - before.offset) * (after.y - before.y) / (after.offset - before.offset) : before.y
    }
    return side === 'start' ? blocks[point.index]?.top ?? blocks.at(-1)!.bottom : blocks[point.index - 1]?.bottom ?? blocks[0].top
  }
  function boundaryY(point: SegmentPoint, side: 'start' | 'end', blocks: Measurement) {
    const unit = blocks.units.find(unit => compare(point, unit.range[side]) === 0)
    return unit ? side === 'start' ? unit.top : unit.bottom : blockBoundaryY(point, side, blocks)
  }
  function selectionObjects(current: SegmentRange) {
    const ids = segmentObjectIds(live.current.doc, current)
    for (const unit of live.current.reservedSegments ?? []) if (overlaps(current, unit.range)) {
      for (const id of unit.objectIds) ids.add(id)
    }
    return ids
  }
  function refresh() {
    const current = selected.current, { geometry } = live.current
    if (!current) return
    const blocks = measure()
    if (!blocks.length) return
    const objects = [...selectionObjects(current)].flatMap(id => {
      const box = geometry[id]
      if (!box) return []
      const bounds = extentBounds(box)
      return [{ ...bounds, id }]
    })
    const top = boundaryY(current.start, 'start', blocks), bottom = equal(current) ? top : boundaryY(current.end, 'end', blocks)
    const next = { objects, top, bottom }
    setPaint(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }
  useLayoutEffect(() => {
    if (content.current !== props.doc.content) { content.current = props.doc.content; release(); select(null) }
    refresh()
  })

  function release() {
    const previous = drag.current
    drag.current = null
    if (previous) document.documentElement.classList.remove('segment-dragging', 'segment-moving')
    setDropY(null)
    const stage = live.current.stage.current
    if (previous && stage?.hasPointerCapture(previous.pointerId)) stage.releasePointerCapture(previous.pointerId)
  }
  function clear() { release(); select(null) }
  function startSelection() {
    live.current.onStart()
    live.current.stage.current!.focus({ preventScroll: true })
    window.getSelection()?.removeAllRanges()
  }
  function adjust() {
    const d = drag.current
    if (!d) return
    const blocks = measure(), y = localY(d.y) + d.handleOffset
    let point = endpoint(y, d.alt, blocks)
    if (d.moving) {
      if (!d.moved) return
      const source = d.previous!
      d.destination = compare(point, source.start) < 0 || compare(point, source.end) > 0 ? point : undefined
      setDropY(d.destination ? boundaryY(point, 'start', blocks) : null)
      return
    }
    if (d.handle) {
      select(ordered(d.anchor, selectionEndpoint(y, d.anchor, point, blocks)))
    } else {
      if (!d.moved) return
      const down = y >= d.originY
      const touched = reservationBoundary(y, blocks) ? -1 : blocks.findIndex(block => !block.space && y >= block.top && y < block.bottom)
      if (touched >= 0) point = edge(touched + (down ? 1 : 0))
      const anchor = d.originBlock >= 0 ? edge(d.originBlock + (down ? 0 : 1)) : endpoint(d.originY, d.alt, blocks)
      // The original page position stays fixed while the viewport auto-scrolls.
      d.anchor = anchor
      select(ordered(d.anchor, selectionEndpoint(y, d.anchor, point, blocks)))
    }
  }
  function selectionEndpoint(y: number, anchor: SegmentPoint, point: SegmentPoint, blocks: Measurement) {
    const boundary = reservationBoundary(y, blocks)
    if (boundary) return boundary
    const unit = blocks.units.find(unit => y > unit.top && y < unit.bottom)
    return unit ? compare(anchor, unit.range.start) <= 0 ? unit.range.end : unit.range.start : point
  }
  function marginTarget(event: Pick<ReactPointerEvent, 'target' | 'clientX' | 'clientY'>) {
    const { editable, sheet, scale, doc } = live.current
    if (!editable || !sheet.current || !(event.target as Element).matches('.sheet, .main-text, [data-spacer]')) return false
    const rect = sheet.current.getBoundingClientRect()
    const x = (event.clientX - rect.left) / scale
    return x >= 0 && x < sheet.current.clientLeft + doc.page.margins.left && event.clientY >= rect.top && event.clientY < rect.bottom
  }
  function refreshMarginHover() {
    const point = marginPointer.current
    const target = point && document.elementFromPoint(point.clientX, point.clientY)
    const margin = !!point && !!target && marginTarget({ ...point, target })
    const gutter = target?.closest('[data-segment-control="gutter"]')
    const blocks = point && (margin || gutter) ? measure() : null
    const y = blocks && point ? localY(point.clientY) : 0
    const task = !!blocks && !reservationBoundary(y, blocks) && blocks.units.some(unit => y > unit.top && y < unit.bottom)
    setReservationHover(task)
    setMarginHover(margin && !task)
  }
  useLayoutEffect(refreshMarginHover)
  useLayoutEffect(() => {
    window.addEventListener('scroll', refreshMarginHover, true)
    window.addEventListener('resize', refreshMarginHover)
    return () => {
      window.removeEventListener('scroll', refreshMarginHover, true)
      window.removeEventListener('resize', refreshMarginHover)
    }
  }, [])
  function begin(event: ReactPointerEvent) {
    const { editable, editor, stage, sheet, scale, doc } = live.current
    const target = (event.target as Element).closest<HTMLElement>('[data-segment-control]')
    if (!editable || !editor || (!target && !marginTarget(event)) || event.button !== 0 || !event.isPrimary) return false
    event.preventDefault(); event.stopPropagation()
    const rect = sheet.current!.getBoundingClientRect()
    const previous = selected.current, control = target?.dataset.segmentControl
    const handle = control === 'start' || control === 'end' ? control : undefined
    const y = localY(event.clientY), blocks = measure(), boundary = reservationBoundary(y, blocks)
    const inGutter = event.clientX < rect.left + (sheet.current!.clientLeft + doc.page.margins.left) * scale
    const member = target?.dataset.segmentObject
    const owned = member && live.current.reservedSegments?.find(unit => unit.objectIds.includes(member))
    const unit = !handle && (!boundary || !inGutter) && (owned ?? blocks.units.find(unit => y > unit.top && y < unit.bottom)
      ?? blocks.units.find(unit => equal(unit.range) && Math.abs(y - unit.top) * scale <= boundaryTolerance
        && !blocks.some(block => Math.min(Math.abs(y - block.top), Math.abs(y - block.bottom)) * scale <= boundaryTolerance)))
    if (unit) {
      clear(); startSelection()
      live.current.onSelectReservation?.(unit.taskId)
      return true
    }
    const moving = control === 'move' && !(inGutter && boundary)
    if (moving && (!previous || equal(previous))) return true
    if (moving && reserved(previous!)) { setNotice('Accept or discard the selected AI task before moving this segment.'); return true }
    const anchor = endpoint(y, event.altKey, blocks)
    const originBlock = boundary ? -1 : blocks.findIndex(block => !block.space && y >= block.top && y < block.bottom)
    startSelection()
    drag.current = { pointerId: event.pointerId, y: event.clientY, originY: y, originClientY: event.clientY, alt: event.altKey, moved: false, moving,
      anchor: handle && previous ? previous[handle === 'start' ? 'end' : 'start'] : anchor, originBlock, handle,
      handleOffset: handle && previous ? boundaryY(previous[handle], equal(previous) ? 'start' : handle, blocks) - y : 0, previous }
    document.documentElement.classList.add('segment-dragging')
    if (moving) document.documentElement.classList.add('segment-moving')
    stage.current!.setPointerCapture(event.pointerId)
    if (!handle && !moving) {
      select(originBlock >= 0 ? { start: edge(originBlock), end: edge(originBlock + 1) } : { start: anchor, end: anchor })
    }
    tick.current()
    return true
  }
  function ownedFocus() {
    const element = document.activeElement
    return !!element && live.current.stage.current!.contains(element) && !element.closest('input, textarea, select, [data-code-source]')
  }
  function reserved(current: SegmentRange) {
    const { doc, history, lockedIds } = live.current
    return live.current.reservedSegments?.some(unit => overlaps(current, unit.range) || inside(current.start, unit.range)
      || equal(unit.range) && compare(current.start, unit.range.start) <= 0 && compare(current.end, unit.range.end) >= 0)
      || (doc.content.content ?? []).slice(current.start.index, current.end.index + (current.end.offset ? 1 : 0)).some(node => history.lockedBlocks.current[node.attrs!.id])
      || [...segmentObjectIds(doc, current)].some(id => lockedIds.has(id))
  }
  function nextDocument(current: SegmentRange, payload: SegmentClipboard | null) {
    const { doc, geometry, history } = live.current
    const next = replaceSegment(doc, current, payload, snapshotAnchors(), geometry)
    if (!history.guard.current(doc, next)) throw new Error('Accept or discard the affected AI task before changing this segment.')
    return next
  }
  function commit(next: MoteDocument, current: SegmentRange, payload: SegmentClipboard | null = null) {
    const { doc } = live.current
    // Locate both insertion boundaries even when adjacent spaces merge.
    const prefix = segmentPosition(doc.content.content!, current.start)
    const size = payload ? segmentPosition(payload.content, edge(payload.content.length)) : 0
    commitSelection(next, { start: segmentPointAt(next.content.content!, prefix), end: segmentPointAt(next.content.content!, prefix + size) }, !!payload)
  }
  function commitSelection(next: MoteDocument, selection: SegmentRange, keepSelection = true) {
    const { history, editor, stage } = live.current
    const { start, end } = selection
    history.boundary(); history.setDoc(next); history.boundary()
    select(null)
    requestAnimationFrame(() => {
      if (!editor || editor.isDestroyed || live.current.doc !== next) return
      let position = 0
      editor.state.doc.forEach((node, _from, i) => { if (i < end.index) position += node.nodeSize })
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position))))
      stage.current!.focus({ preventScroll: true })
      content.current = next.content
      if (keepSelection) select({ start, end })
      else insertion.current = start
    })
  }
  function drop() {
    const d = drag.current
    release()
    if (!d?.moving || !d.moved || !d.destination || !d.previous) return
    const { doc, geometry, history } = live.current
    try {
      if (reserved(d.previous)) throw new Error('Accept or discard the selected AI task before moving this segment.')
      const next = moveSegment(doc, d.previous, d.destination, snapshotAnchors(), geometry)
      if (next.doc === doc) return
      if (!history.guard.current(doc, next.doc)) throw new Error('Accept or discard the affected AI task before moving this segment.')
      commitSelection(next.doc, next.range)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'This segment could not be moved.') }
  }
  function copy(event: ClipboardEvent) {
    const { editable, doc, editor, anchors, geometry } = live.current
    let current = selected.current
    if (!current && editor?.isFocused && !editor.state.selection.empty) {
      const { $from, $to } = editor.state.selection
      const start = $from.index(0), end = Math.min(doc.content.content!.length, $to.index(0) + ($to.depth && $to.parentOffset ? 1 : 0))
      if (doc.content.content!.slice(start, end).some(block => block.type === 'flow')) current = { start: edge(start), end: edge(end) }
    }
    if (!editable || !current || equal(current) || !ownedFocus() || !event.clipboardData) return
    event.preventDefault(); event.stopImmediatePropagation()
    try {
      if (reserved(current)) throw new Error('Accept or discard the selected AI task before copying or cutting this segment.')
      const next = event.type === 'cut' ? nextDocument(current, null) : null
      const payload = copySegment(doc, current, anchors, geometry), json = serializeSegment(payload), text = segmentText(payload)
      event.clipboardData.setData(SEGMENT_MIME, json)
      event.clipboardData.setData('text/plain', text || '\n')
      event.clipboardData.setData('text/html', `<div data-mote-segment="${escapeHTML(json)}">${text.split('\n').map(line => `<p>${escapeHTML(line) || '<br>'}</p>`).join('')}</div>`)
      if (next) commit(next, current)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The segment could not be copied.') }
  }
  function paste(event: ClipboardEvent) {
    const { editable, editor, doc } = live.current
    if (!editable || !editor || !ownedFocus() || !event.clipboardData) return
    if (floatingClipboardJSON(event.clipboardData)) return
    const current = selected.current
    if (!current && !insertion.current && !editor.isFocused) return
    const paragraphs = paragraphClipboardJSON(event.clipboardData)
    if (paragraphs && !current && !insertion.current) return
    let json = paragraphs || event.clipboardData.getData(SEGMENT_MIME)
    if (!json) {
      const html = event.clipboardData.getData('text/html')
      if (html.includes('data-mote-segment')) json = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-mote-segment]')?.getAttribute('data-mote-segment') ?? ''
    }
    if (!json) {
      if (current) { event.preventDefault(); event.stopImmediatePropagation(); setNotice('This selection accepts a copied Mote segment. Click in text to paste ordinary text or images.') }
      return
    }
    event.preventDefault(); event.stopImmediatePropagation()
    try {
      const payload = paragraphs ? parseParagraphs(json) : parseSegment(json)
      let target = current ?? (insertion.current ? { start: insertion.current, end: insertion.current } : null)
      if (!target) {
        const selection = editor.state.selection, start = selection.$from.index(0)
        if (selection.empty) {
          const paragraph = selection.$from.parent.type.name === 'paragraph'
          const empty = paragraph && !selection.$from.parent.content.size
          const index = start + (paragraph && !empty ? 1 : 0)
          target = { start: edge(index), end: edge(index) }
        } else {
          const end = Math.min(doc.content.content!.length, selection.$to.index(0) + (selection.$to.depth > 0 && selection.$to.parentOffset > 0 ? 1 : 0))
          target = { start: edge(start), end: edge(Math.max(start + 1, end)) }
        }
      }
      if (reserved(target)) throw new Error('Accept or discard the selected AI task before replacing this segment.')
      const next = nextDocument(target, payload)
      if (live.current.doc === doc) commit(next, target, payload)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The clipboard does not contain a valid Mote segment.') }
  }
  function deleteSelection() {
    const current = selected.current
    if (!current || !live.current.editable) return false
    try {
      if (reserved(current)) throw new Error('Accept or discard the selected AI task before deleting this selection.')
      const next = nextDocument(current, null)
      commit(next, current)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The selection could not be deleted.') }
    return true
  }
  const actions = useRef({ adjust, release, select, clear, copy, paste, refresh, drop, deleteSelection })
  actions.current = { adjust, release, select, clear, copy, paste, refresh, drop, deleteSelection }
  useLayoutEffect(() => {
    if (!props.editable || !props.editor) return
    let frame = 0
    function scroll() {
      frame = 0
      const d = drag.current
      if (d?.moved) {
        const stage = live.current.stage.current!, rect = stage.getBoundingClientRect()
        const speed = d.y < rect.top + 36 ? -Math.min(18, (rect.top + 36 - d.y) / 3) : d.y > rect.bottom - 36 ? Math.min(18, (d.y - rect.bottom + 36) / 3) : 0
        if (speed) {
          stage.scrollTop += speed
          actions.current.adjust()
        }
      }
      if (drag.current) frame = requestAnimationFrame(scroll)
    }
    function move(event: PointerEvent) {
      const d = drag.current
      if (!d || event.pointerId !== d.pointerId) return
      event.preventDefault()
      if (Math.abs(event.clientY - (d.moving ? d.originClientY : d.y)) >= (d.moving ? 4 : 1)) d.moved = true
      d.y = event.clientY; d.alt = event.altKey
      actions.current.adjust()
    }
    function finish(event: PointerEvent) { if (event.pointerId === drag.current?.pointerId) actions.current.drop() }
    function cancel(event?: Event) {
      if (event instanceof PointerEvent && event.pointerId !== drag.current?.pointerId) return
      const d = drag.current
      actions.current.release()
      if (d) actions.current.select(d.previous)
    }
    function key(event: KeyboardEvent) {
      if (isComposingKey(event) || (event.target as Element).closest?.('#document-theme')) return
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
        const target = document.activeElement
        const canvas = target === document.body ? !document.querySelector('dialog[open]') : ownedFocus()
        if (!canvas || target instanceof HTMLElement && target.isContentEditable && target !== live.current.editor?.view.dom) return
        event.preventDefault(); event.stopImmediatePropagation()
        actions.current.clear(); startSelection()
        actions.current.select({ start: edge(0), end: edge(live.current.doc.content.content!.length) })
        return
      }
      if (event.type === 'keydown' && selected.current && ownedFocus() && ['Delete', 'Backspace'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation(); actions.current.deleteSelection(); return
      }
      const d = drag.current
      if (event.key === 'Alt' && d) { d.alt = event.altKey; actions.current.adjust() }
      if (event.type === 'keydown' && event.key === 'Escape' && (d || selected.current || insertion.current)) { event.preventDefault(); if (d) cancel(); else actions.current.clear() }
    }
    const keepsSelection = '.side-panel, [aria-controls="document-theme"], #document-theme'
    function outside(event: PointerEvent) {
      if ((event.target as Element).closest(keepsSelection)) return
      if (!live.current.stage.current!.contains(event.target as Node)) actions.current.clear()
    }
    function focus(event: FocusEvent) {
      const target = event.target as HTMLElement
      if (target !== live.current.stage.current && !target.closest(`[data-segment-control], ${keepsSelection}`)) actions.current.clear()
    }
    const copied = (event: ClipboardEvent) => actions.current.copy(event)
    const pasted = (event: ClipboardEvent) => actions.current.paste(event)
    const observer = new ResizeObserver(() => actions.current.refresh())
    observer.observe(props.editor.view.dom)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    const stage = live.current.stage.current!
    stage.addEventListener('lostpointercapture', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('focusin', focus)
    window.addEventListener('keydown', key, true)
    window.addEventListener('keyup', key)
    window.addEventListener('copy', copied, true)
    window.addEventListener('cut', copied, true)
    window.addEventListener('paste', pasted, true)
    tick.current = () => { if (!frame) frame = requestAnimationFrame(scroll) }
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); actions.current.clear()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      stage.removeEventListener('lostpointercapture', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('focusin', focus)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('keyup', key)
      window.removeEventListener('copy', copied, true)
      window.removeEventListener('cut', copied, true)
      window.removeEventListener('paste', pasted, true)
    }
  }, [props.editable, props.editor, props.scale, history.revision])

  const styleBox = (box: Box) => ({ left: (box.x + 1) * props.scale, top: (box.y + 1) * props.scale, width: box.width * props.scale, height: box.height * props.scale })
  const overlay = props.editable && <div className={`segment-layer segment-selection${range ? ' has-segment' : ''}`}>
    <div className="segment-gutter" data-segment-control="gutter" style={reservationHover ? { cursor: 'pointer' } : undefined} title={reservationHover ? "Select reserved segment" : "Drag to select a segment · Alt splits explicit spaces"} />
    {range && <>
      {!equal(range) && <div className="segment-band" data-segment-control="move" title="Drag to move segment · Alt splits spaces"
        style={styleBox({ x: 0, y: paint.top, width: props.doc.page.width - 2, height: paint.bottom - paint.top })} />}
      {paint.objects.map(box => <div className="segment-object" data-segment-control="move" title="Drag to move segment · Alt splits spaces" data-segment-object={box.id} key={box.id} style={styleBox(box)} />)}
      {(['start', 'end'] as const).map(side => {
        const offset = equal(range) ? 0 : Math.max(0, 24 - (paint.bottom - paint.top) * props.scale) / 2 * (side === 'start' ? -1 : 1)
        return <div className="segment-boundary" key={side} style={{ top: ((side === 'start' ? paint.top : paint.bottom) + 1) * props.scale }}>
        {!!offset && <span className="segment-handle-join" style={{ top: Math.min(0, offset), height: Math.abs(offset) }} />}
        <div className="segment-handle" data-segment-control={side} aria-label={`Segment ${side}`} title={`Drag to adjust ${side} · Alt splits spaces`}
          style={{ transform: `translateY(${offset}px)` }}>{marker}</div>
      </div>})}
      {dropY !== null && <div className="segment-drop" style={{ top: (dropY + 1) * props.scale }}><span>Move here</span></div>}
    </>}
  </div>
  return { begin, clear, overlay, notice, range, marginHover, deleteSelection,
    hover: (event: ReactPointerEvent | null) => {
      marginPointer.current = event && { clientX: event.clientX, clientY: event.clientY }
      refreshMarginHover()
    },
    target: (y: number, alt = false) => {
      const blocks = measure(), point = endpoint(y, alt, blocks)
      return { point, top: boundaryY(point, 'start', blocks) }
    },
    selection: () => {
      const current = selected.current
      if (!current) return null
      const blocks = measure()
      const top = boundaryY(current.start, 'start', blocks)
      const bottom = equal(current) ? top : boundaryY(current.end, 'end', blocks)
      return { range: current,
        area: { x: 0, y: top, width: live.current.doc.page.width - 2, height: Math.max(0, bottom - top) } }
    },
    context: () => ({ anchors: snapshotAnchors(), geometry: live.current.geometry }),
  }
}
