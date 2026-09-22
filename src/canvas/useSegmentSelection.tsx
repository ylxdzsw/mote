import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { useHistory } from '../document/history'
import type { MoteDocument } from '../document/model'
import { copySegment, moveSegment, parseSegment, replaceSegment, segmentObjectIds, segmentPointAt, segmentPosition, segmentText, serializeSegment, SEGMENT_MIME, type SegmentClipboard, type SegmentPoint, type SegmentRange } from '../document/segment'
import { isComposingKey } from '../editor/composition'
import { floatingClipboardJSON } from '../document/floatingClipboard'
import type { Anchor, Box, Geometries } from './floatingGeometry'
import './segment.css'

interface Props {
  doc: MoteDocument; editable: boolean; editor: Editor | null; scale: number
  stage: RefObject<HTMLDivElement | null>; sheet: RefObject<HTMLDivElement | null>
  anchors: Anchor[]; geometry: Geometries; lockedIds: Set<string>; onStart: () => void
}
interface Block { top: number; bottom: number; height: number; space: boolean }
interface Paint { bands: Box[]; objects: (Box & { id: string })[]; top: number; bottom: number }
interface Drag {
  pointerId: number; y: number; originY: number; originClientY: number; alt: boolean; moved: boolean
  anchor: SegmentPoint; originBlock: number; handle?: 'start' | 'end'; handleOffset: number; previous: SegmentRange | null
  moving: boolean; destination?: SegmentPoint
}
const compare = (a: SegmentPoint, b: SegmentPoint) => a.index - b.index || a.offset - b.offset
const equal = (range: SegmentRange) => compare(range.start, range.end) === 0
const ordered = (a: SegmentPoint, b: SegmentPoint): SegmentRange => compare(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a }
const edge = (index: number): SegmentPoint => ({ index, offset: 0 })
const escapeHTML = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const marker = <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h5l9 7-9 7H3l7-7z" /></svg>

export function useSegmentSelection(props: Props) {
  const history = useHistory()
  const live = useRef({ ...props, history })
  live.current = { ...props, history }
  const selected = useRef<SegmentRange | null>(null)
  const insertion = useRef<SegmentPoint | null>(null)
  const [range, setRange] = useState<SegmentRange | null>(null)
  const [paint, setPaint] = useState<Paint>({ bands: [], objects: [], top: 0, bottom: 0 })
  const [notice, setNotice] = useState('')
  const [dropY, setDropY] = useState<number | null>(null)
  const drag = useRef<Drag | null>(null)
  const tick = useRef<() => void>(() => {})
  const content = useRef(props.doc.content)

  function select(next: SegmentRange | null) {
    insertion.current = null
    selected.current = next; setRange(next); setNotice('')
  }
  function measure(): Block[] {
    const { editor, sheet, scale } = live.current
    if (!editor || !sheet.current) return []
    const rect = sheet.current.getBoundingClientRect(), border = sheet.current.clientTop
    const blocks: Block[] = []
    editor.state.doc.forEach((node, from) => {
      const element = editor.view.nodeDOM(from) as HTMLElement
      const candidate = sheet.current!.querySelector<HTMLElement>(`[data-ai-block="${node.attrs.id}"]`)?.closest('.main-paragraph')
      const box = (candidate ?? element).getBoundingClientRect()
      const top = (box.top - rect.top) / scale - border, space = node.type.name === 'spacer'
      let bottom = top + box.height / scale
      // Extra candidate paragraphs belong to the final original reservation block.
      for (let next = candidate?.nextElementSibling; next?.getAttribute('data-ai-block') === ''; next = next.nextElementSibling) {
        const box = next.getBoundingClientRect()
        bottom = (box.bottom - rect.top) / scale - border
      }
      const height = space ? node.attrs.height : bottom - top
      blocks.push({ top, bottom: top + height, height, space })
    })
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
    for (const [index, block] of blocks.entries()) {
      if (alt && block.space && y > block.top && y < block.bottom) {
        const offset = Math.min(block.height, Math.round((y - block.top) * 10) / 10)
        return offset === block.height ? edge(index + 1) : { index, offset }
      }
    }
    // One logical break may have two visual edges, separated only by theme spacing.
    const candidates = blocks.flatMap((block, index) => [{ point: edge(index), y: block.top }, { point: edge(index + 1), y: block.bottom }])
    return candidates.reduce((best, candidate) => Math.abs(candidate.y - y) < Math.abs(best.y - y) ? candidate : best).point
  }
  function boundaryY(point: SegmentPoint, side: 'start' | 'end', blocks: Block[]) {
    if (!blocks.length) return 0
    if (point.offset) return blocks[point.index].top + point.offset
    return side === 'start' ? blocks[point.index]?.top ?? blocks.at(-1)!.bottom : blocks[point.index - 1]?.bottom ?? blocks[0].top
  }
  function refresh() {
    const current = selected.current, { doc, geometry } = live.current
    const blocks = measure()
    if (!current || !blocks.length) return
    const objects = [...segmentObjectIds(doc, current)].flatMap(id => geometry[id] ? [{ ...geometry[id], id }] : [])
    const top = boundaryY(current.start, 'start', blocks), bottom = equal(current) ? top : boundaryY(current.end, 'end', blocks)
    const bands = equal(current) ? [] : [{ x: 0, y: top, width: doc.width - 2, height: bottom - top }]
    const next = { bands, objects, top, bottom }
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
      select(ordered(d.anchor, point))
    } else {
      if (!d.moved) return
      const down = y >= d.originY
      const touched = blocks.findIndex(block => !block.space && y >= block.top && y < block.bottom)
      if (touched >= 0) point = edge(touched + (down ? 1 : 0))
      const anchor = d.originBlock >= 0 ? edge(d.originBlock + (down ? 0 : 1)) : endpoint(d.originY, d.alt, blocks)
      // The original page position stays fixed while the viewport auto-scrolls.
      d.anchor = anchor
      select(ordered(d.anchor, point))
    }
  }
  function begin(event: ReactPointerEvent) {
    const { editable, editor, stage, onStart } = live.current
    const target = (event.target as Element).closest<HTMLElement>('[data-segment-control]')
    if (!editable || !editor || !target || event.button !== 0 || !event.isPrimary) return false
    event.preventDefault(); event.stopPropagation()
    const previous = selected.current, control = target.dataset.segmentControl
    const moving = control === 'move', handle = control === 'start' || control === 'end' ? control : undefined
    if (moving && (!previous || equal(previous))) return true
    if (moving && reserved(previous!)) { setNotice('Accept or discard the selected AI task before moving this segment.'); return true }
    const y = localY(event.clientY), blocks = measure(), anchor = endpoint(y, event.altKey, blocks)
    const originBlock = blocks.findIndex(block => !block.space && y >= block.top && y < block.bottom)
    onStart()
    stage.current!.focus({ preventScroll: true })
    window.getSelection()?.removeAllRanges()
    drag.current = { pointerId: event.pointerId, y: event.clientY, originY: y, originClientY: event.clientY, alt: event.altKey, moved: false, moving,
      anchor: handle && previous ? previous[handle === 'start' ? 'end' : 'start'] : anchor, originBlock, handle,
      handleOffset: handle && previous ? boundaryY(previous[handle], equal(previous) ? 'start' : handle, blocks) - y : 0, previous }
    document.documentElement.classList.add('segment-dragging')
    if (moving) document.documentElement.classList.add('segment-moving')
    stage.current!.setPointerCapture(event.pointerId)
    if (!handle && !moving) select(originBlock >= 0 ? { start: edge(originBlock), end: edge(originBlock + 1) } : { start: anchor, end: anchor })
    tick.current()
    return true
  }
  function ownedFocus() {
    const element = document.activeElement
    return !!element && live.current.stage.current!.contains(element) && !element.matches('input, textarea, select')
  }
  function reserved(current: SegmentRange) {
    const { doc, history, lockedIds } = live.current
    return (doc.content.content ?? []).slice(current.start.index, current.end.index + (current.end.offset ? 1 : 0)).some(node => history.lockedBlocks.current[node.attrs!.id])
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
    const current = selected.current, { editable, doc, anchors, geometry } = live.current
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
    let json = event.clipboardData.getData(SEGMENT_MIME)
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
      const payload = parseSegment(json)
      let target = current ?? (insertion.current ? { start: insertion.current, end: insertion.current } : null)
      if (!target) {
        const selection = editor.state.selection, start = selection.$from.index(0)
        if (selection.empty) {
          const index = start + (selection.$from.depth > 0 && selection.$from.parentOffset === selection.$from.parent.content.size && selection.$from.parent.content.size > 0 ? 1 : 0)
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
  const actions = useRef({ adjust, release, select, clear, copy, paste, refresh, drop })
  actions.current = { adjust, release, select, clear, copy, paste, refresh, drop }
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
      if (isComposingKey(event)) return
      const d = drag.current
      if (event.key === 'Alt' && d) { d.alt = event.altKey; actions.current.adjust() }
      if (event.type === 'keydown' && event.key === 'Escape' && (d || selected.current || insertion.current)) { event.preventDefault(); if (d) cancel(); else actions.current.clear() }
    }
    function outside(event: PointerEvent) {
      if ((event.target as Element).closest('[data-ai-segment-action]')) return
      if (!live.current.stage.current!.contains(event.target as Node)) actions.current.clear()
    }
    function focus(event: FocusEvent) {
      const target = event.target as HTMLElement
      if (target !== live.current.stage.current && !target.closest('[data-segment-control]')) actions.current.clear()
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
    window.addEventListener('keydown', key)
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
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
      window.removeEventListener('copy', copied, true)
      window.removeEventListener('cut', copied, true)
      window.removeEventListener('paste', pasted, true)
    }
  }, [props.editable, props.editor, props.scale, history.revision])

  function handleKey(side: 'start' | 'end', event: React.KeyboardEvent) {
    const current = selected.current
    if (!current || isComposingKey(event.nativeEvent) || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const blocks = measure(), point = current[side], down = event.key === 'ArrowDown'
    let next = event.key === 'Home' ? edge(0) : event.key === 'End' ? edge(blocks.length)
      : edge(Math.max(0, Math.min(blocks.length, point.index + (down ? 1 : point.offset ? 0 : -1))))
    if (event.altKey && (event.key === 'ArrowUp' || down)) {
      const index = !down && !point.offset ? point.index - 1 : point.index, block = blocks[index]
      if (block?.space) {
        const offset = Math.max(0, Math.min(block.height, (!down && !point.offset ? block.height : point.offset) + (down ? 1 : -1)))
        next = offset === block.height ? edge(index + 1) : { index, offset }
      }
    }
    const anchor = current[side === 'start' ? 'end' : 'start'], direction = compare(next, anchor)
    select(ordered(anchor, next))
    const nextSide = direction < 0 ? 'start' : direction > 0 ? 'end' : side
    if (nextSide !== side) live.current.stage.current!.querySelector<HTMLButtonElement>(`[data-segment-control="${nextSide}"]`)!.focus({ preventScroll: true })
  }
  const styleBox = (box: Box) => ({ left: (box.x + 1) * props.scale, top: (box.y + 1) * props.scale, width: box.width * props.scale, height: box.height * props.scale })
  const overlay = props.editable && <div className={`segment-layer${range ? ' has-segment' : ''}`}>
    <div className="segment-gutter" data-segment-control="gutter" title="Drag to select a segment · Alt splits explicit spaces" />
    {range && <>
      {paint.bands.map((box, index) => <div className="segment-band" data-segment-control="move" title="Drag to move segment · Alt splits spaces" key={index} style={styleBox(box)} />)}
      {paint.objects.map(box => <div className="segment-object" data-segment-control="move" title="Drag to move segment · Alt splits spaces" data-segment-object={box.id} key={box.id} style={styleBox(box)} />)}
      {(['start', 'end'] as const).map(side => {
        const offset = equal(range) ? 0 : Math.max(0, 24 - (paint.bottom - paint.top) * props.scale) / 2 * (side === 'start' ? -1 : 1)
        return <div className="segment-boundary" key={side} style={{ top: ((side === 'start' ? paint.top : paint.bottom) + 1) * props.scale }}>
        {!!offset && <span className="segment-handle-join" style={{ top: Math.min(0, offset), height: Math.abs(offset) }} />}
        <button className="segment-handle" data-segment-control={side} aria-label={`Segment ${side}`} title={`Drag to adjust ${side} · Alt splits spaces`}
          style={{ transform: `translateY(${offset}px)` }}
          onKeyDown={event => handleKey(side, event)}>{marker}</button>
      </div>})}
      {dropY !== null && <div className="segment-drop" style={{ top: (dropY + 1) * props.scale }}><span>Move here</span></div>}
    </>}
  </div>
  return { begin, clear, overlay, notice,
    selection: () => selected.current && { range: selected.current, area: { x: 0, y: paint.top, width: props.doc.width - 2, height: Math.max(0, paint.bottom - paint.top) } },
    context: () => ({ anchors: snapshotAnchors(), geometry: live.current.geometry }),
  }
}
