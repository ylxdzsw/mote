import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { heightTolerance, segmentLayoutKey, type SegmentStyle } from '../editor/segmentSizing'

interface Segment {
  id: string
  from: number
  owner: number | null
  kind: 'text' | 'space'
  top: number
  height: number
  natural: number
  minimum: number | null
  selected: boolean
}

interface Props {
  editor: Editor
  sheet: RefObject<HTMLDivElement | null>
  editable: boolean
  scale: number
  reflow: () => unknown
  floatingPreview: boolean
  onActive: () => void
}

export function SegmentBoundaries({ editor, sheet, editable, scale, reflow, floatingPreview, onActive }: Props) {
  const [segments, setSegments] = useState<Segment[]>([])
  const current = useRef<Segment[]>([])
  const drag = useRef<{ id: string; clientY: number; height: number; target: number } | null>(null)
  const refresh = useRef(() => {})

  useLayoutEffect(() => {
    drag.current = null
    let frame = 0
    const observed = new Set<HTMLElement>()
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(editor.view.dom)

    function measure() {
      frame = 0
      reflow()
      const surface = sheet.current!
      const rect = surface.getBoundingClientRect()
      const y = (value: number) => (value - rect.top) / scale - surface.clientTop
      const blocks: { from: number; to: number; id: string; kind: 'text' | 'space'; minimum: number | null; element: HTMLElement }[] = []
      editor.state.doc.forEach((node, from) => {
        blocks.push({ from, to: from + node.nodeSize, id: node.attrs.id,
          kind: node.type.name === 'spacer' ? 'space' : 'text', minimum: node.attrs.minSegmentHeight ?? null,
          element: editor.view.nodeDOM(from) as HTMLElement })
      })
      const elements = new Set(blocks.map(block => block.element))
      for (const element of observed) if (!elements.has(element)) { observer.unobserve(element); observed.delete(element) }
      for (const element of elements) if (!observed.has(element)) { observer.observe(element); observed.add(element) }

      const next: Segment[] = []
      const styles: SegmentStyle[] = []
      const transaction = editor.state.tr
      const selection = editor.state.selection
      if (blocks[0]?.kind !== 'text' && editor.state.doc.attrs.minSegmentHeight !== null) {
        transaction.setDocAttribute('minSegmentHeight', null)
      }
      for (let index = 0; index < blocks.length; index++) {
        const first = blocks[index]
        const startIndex = index
        if (first.kind === 'text') while (blocks[index + 1]?.kind === 'text') index++
        const last = blocks[index]
        const owner = startIndex === 0 ? null : blocks[startIndex - 1].from
        const minimum = first.kind === 'text' ? startIndex === 0 ? editor.state.doc.attrs.minSegmentHeight : blocks[startIndex - 1].minimum : null
        const top = first.kind === 'space' || startIndex === 0 ? y(first.element.getBoundingClientRect().top)
          : y(blocks[startIndex - 1].element.getBoundingClientRect().bottom)
        const bottom = first.kind === 'text' && blocks[index + 1]
          ? y(blocks[index + 1].element.getBoundingClientRect().top) : y(last.element.getBoundingClientRect().bottom)
        const height = bottom - top
        const natural = first.kind === 'space' ? 24 : height - parseFloat(last.element.style.paddingBottom || '0')
        const pending = drag.current?.id === first.id ? drag.current : null
        const target = pending ? Math.max(natural, pending.target) : minimum
        if (first.kind === 'text') {
          const padding = target !== null && target > natural + heightTolerance ? target - natural : 0
          if (padding > 0) styles.push({ from: last.from, to: last.to, property: 'padding-bottom', value: padding })
          if (!pending && !surface.hasAttribute('data-floating-preview') && minimum !== null && natural >= minimum - heightTolerance) {
            if (owner === null) transaction.setDocAttribute('minSegmentHeight', null)
            else transaction.setNodeAttribute(owner, 'minSegmentHeight', null)
          }
        } else {
          if (pending) styles.push({ from: first.from, to: first.to, property: '--spacer-preview-height', value: target! })
          if (blocks[index + 1]?.kind !== 'text' && first.minimum !== null) transaction.setNodeAttribute(first.from, 'minSegmentHeight', null)
        }
        next.push({ id: first.id, from: first.from, owner, kind: first.kind, top, height, natural,
          minimum, selected: selection instanceof NodeSelection && selection.from === first.from })
      }

      const previous = segmentLayoutKey.getState(editor.state)!.styles
      const changed = previous === null || styles.length !== previous.length || styles.some((style, index) => {
        const old = previous[index]
        return !old || style.from !== old.from || style.to !== old.to || style.property !== old.property || Math.abs(style.value - old.value) > heightTolerance
      })
      if (changed) transaction.setMeta(segmentLayoutKey, styles)
      if (transaction.docChanged || changed) {
        editor.view.dispatch(transaction.setMeta('addToHistory', false))
        schedule()
      }
      current.current = next
      setSegments(next)
    }

    refresh.current = schedule
    measure()
    editor.on('transaction', schedule)
    document.fonts.addEventListener('loadingdone', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      editor.off('transaction', schedule)
      document.fonts.removeEventListener('loadingdone', schedule)
    }
  }, [editor, sheet, scale, editable, reflow])

  useLayoutEffect(() => { refresh.current() }, [floatingPreview])

  function commit(segment: Segment, target: number) {
    const height = Math.max(segment.natural, target)
    const value = segment.kind === 'text' && height <= segment.natural + heightTolerance ? null : height
    const attribute = segment.kind === 'text' ? 'minSegmentHeight' : 'height'
    const position = segment.kind === 'text' ? segment.owner : segment.from
    const previous = (position === null ? editor.state.doc : editor.state.doc.nodeAt(position)!).attrs[attribute]
    if (value === previous || (value !== null && previous !== null && Math.abs(value - previous) <= heightTolerance)) return
    const transaction = editor.state.tr.setMeta('historyBoundary', true)
    if (position === null) transaction.setDocAttribute(attribute, value)
    else transaction.setNodeAttribute(position, attribute, value)
    editor.view.dispatch(transaction)
  }

  function cancel() { drag.current = null; refresh.current() }

  return editable && <div className="segment-boundaries">
    {segments.map((segment, index) => <div key={segment.id} className={`segment-boundary ${segment.selected || segments[index + 1]?.selected ? 'is-selected' : ''}`}
      data-segment-id={segment.id} data-segment-kind={segment.kind}
      role="separator" aria-orientation="horizontal" tabIndex={0}
      aria-label={`Resize ${segment.kind === 'text' ? 'text segment' : 'space'} ${index + 1}`}
      aria-valuemin={Math.round(segment.natural)} aria-valuenow={Math.round(segment.height)}
      aria-valuetext={segment.kind === 'text' && segment.minimum === null ? 'Automatic height' : `${Math.round(segment.height)} pixels`}
      title={`${segment.kind === 'text' ? 'Text segment' : 'Space'} height · drag or use up/down arrows; Home resets${segment.kind === 'text' ? ' to automatic' : ''}`}
      style={{ top: segment.top + segment.height }}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { id: segment.id, clientY: event.clientY, height: segment.height, target: segment.height }
        onActive()
      }}
      onPointerMove={event => {
        const start = drag.current
        if (!start) return
        start.target = start.height + (event.clientY - start.clientY) / scale
        refresh.current()
      }}
      onPointerUp={() => {
        const start = drag.current
        const latest = current.current.find(segment => segment.id === start?.id)
        if (start && latest) commit(latest, start.target)
        cancel()
      }}
      onPointerCancel={cancel} onLostPointerCapture={cancel}
      onKeyDown={event => {
        if (event.key === 'Escape') { cancel(); event.currentTarget.blur(); return }
        if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
        event.preventDefault()
        onActive()
        commit(segment, event.key === 'Home' ? segment.natural : segment.height + (event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? 1 : 8))
      }} />)}
  </div>
}
