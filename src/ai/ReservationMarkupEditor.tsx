import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { FloatingDrawing, MoteDocument } from '../document/model'
import { DrawingEditor } from '../app/DrawingEditor'
import { ReadDocument } from '../canvas/ReadDocument'
import type { CanvasActions } from '../canvas/DocumentCanvas'
import type { Reservation } from './types'
import { measureReservationMarkup, type ReservationMarkup, type ReservationMarkupGeometry } from './markup'

interface Props {
  doc: MoteDocument
  reservation: Reservation
  onChange: (markup: ReservationMarkup | undefined) => void
  onClose: () => void
}

export function ReservationMarkupEditor({ doc, reservation, onChange, onClose }: Props) {
  const reader = useRef<HTMLDivElement>(null)
  const actions = useRef<CanvasActions | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const [geometry, setGeometry] = useState<ReservationMarkupGeometry>()
  const [reference, setReference] = useState<ReservationMarkup | undefined>(() => reservation.markup)
  const documentVersion = useRef({ doc, key: 0 })
  if (documentVersion.current.doc !== doc) documentVersion.current = { doc, key: documentVersion.current.key + 1 }

  const measure = useCallback(() => {
    const root = reader.current
    const sheet = root?.querySelector<HTMLElement>('.sheet')
    if (!root || !sheet || !sheet.getBoundingClientRect().width) return
    const next = measureReservationMarkup(root, doc, reservation.target, actions.current?.segmentContext())
    if (next) {
      setGeometry(current => current && current.origin.x === next.origin.x && current.origin.y === next.origin.y
        && current.frame.x === next.frame.x && current.frame.y === next.frame.y
        && current.frame.width === next.frame.width && current.frame.height === next.frame.height ? current : next)
      if (!reference && !reservation.markup) setReference({ x: next.frame.x - next.origin.x, y: next.frame.y - next.origin.y,
        width: next.frame.width, height: next.frame.height, strokes: [], labels: [] })
    }
  }, [doc, reference, reservation.markup, reservation.target])

  useLayoutEffect(() => {
    measure()
    const root = reader.current
    if (!root) return
    const watch = () => {
      observer.current?.disconnect()
      observer.current = new ResizeObserver(measure)
      const sheet = root.querySelector<HTMLElement>('.sheet')
      if (sheet) observer.current.observe(sheet)
      for (const element of root.querySelectorAll<HTMLElement>('.main-text [data-id], [data-note-id] > .object-body, .object-caption')) observer.current.observe(element)
    }
    const mutations = new MutationObserver(() => { watch(); measure() })
    mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    watch()
    return () => { mutations.disconnect(); observer.current?.disconnect(); observer.current = null }
  }, [doc, documentVersion.current.key, measure])

  const onActions = useCallback((value: CanvasActions) => {
    actions.current = value
    measure()
  }, [measure])

  const base = reference ?? reservation.markup ?? { x: 0, y: 0, width: doc.page.width,
    height: 180, strokes: [], labels: [] }
  const markup = reservation.markup ?? { ...base, strokes: [], labels: [] }
  const currentOrigin = geometry?.origin ?? { x: 0, y: 0 }
  const sheet = reader.current?.querySelector<HTMLElement>('.sheet')
  const backgroundX = currentOrigin.x + markup.x + (sheet?.clientLeft ?? 0)
  const backgroundY = currentOrigin.y + markup.y + (sheet?.clientTop ?? 0)
  const drawing: FloatingDrawing = { id: reservation.id, kind: 'drawing',
    layout: { width: base.width, height: base.height, placement: { type: 'flow', x: 0 } },
    strokes: markup.strokes, labels: markup.labels, background: null }

  return <DrawingEditor drawing={drawing} theme={doc.theme} maxWidth={base.width} signedY={false}
    lockedBackground={{ width: base.width, height: base.height, title: 'Spatial instructions',
      hint: 'Marks use fixed document pixels. The underlying document stays unchanged.',
      content: <div className="reservation-markup-reader" ref={reader} aria-hidden="true" inert
        style={{ left: `calc(${-backgroundX}px * var(--drawing-editor-scale))`,
          top: `calc(${-backgroundY}px * var(--drawing-editor-scale))`, width: doc.page.width,
          transform: 'scale(var(--drawing-editor-scale))', transformOrigin: 'top left' }}>
        <ReadDocument key={`${doc.id}:${documentVersion.current.key}`} initial={doc} staticWidgets nativeScroll initialScale={1} onActions={onActions} />
      </div> }}
    onChange={patch => {
      const next = { ...base, strokes: patch.strokes ?? markup.strokes, labels: patch.labels ?? markup.labels }
      onChange(next.strokes.length || next.labels.length ? next : undefined)
    }} onClose={onClose} />
}
