import { createRoot } from 'react-dom/client'
import { StrictMode, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ReadDocument } from '../canvas/ReadDocument'
import type { CanvasActions } from '../canvas/DocumentCanvas'
import { MarkupView } from '../canvas/DrawingView'
import { initializeDocument } from '../document/initialize'
import type { MoteDocument } from '../document/model'
import { uiThemeVariables } from '../theme/ui'
import { validateObjectMarkup } from '../../shared/document.mjs'
import type { AITarget } from './types'
import { measureReservationMarkup, type ReservationMarkup, type ReservationMarkupGeometry } from './markup'
import '../app/styles.css'

interface Placement { sheet: HTMLElement; geometry: ReservationMarkupGeometry }

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }

function parseMarkup(value: unknown): ReservationMarkup | undefined {
  if (value == null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Reservation markup must be an object.')
  const markup = value as Record<string, unknown>, keys = ['x', 'y', 'width', 'height', 'strokes', 'labels']
  if (Object.keys(markup).length !== keys.length || Object.keys(markup).some(key => !keys.includes(key))) throw new Error('Reservation markup has an invalid shape.')
  if (!finite(markup.x) || !finite(markup.y)) throw new Error('Reservation markup has invalid offsets.')
  const native = validateObjectMarkup({ width: markup.width, height: markup.height, strokes: markup.strokes, labels: markup.labels }, 'reservation.markup')
  return { ...native, x: markup.x, y: markup.y }
}

function Preview({ doc, target, markup }: { doc: MoteDocument; target: AITarget; markup?: ReservationMarkup }) {
  const reader = useRef<HTMLDivElement>(null)
  const actions = useRef<CanvasActions | null>(null)
  const [placement, setPlacement] = useState<Placement>()

  const measure = useCallback(() => {
    const root = reader.current
    const sheet = root?.querySelector<HTMLElement>('.sheet')
    if (!root || !sheet || !sheet.getBoundingClientRect().width) return
    const geometry = measureReservationMarkup(root, doc, target, actions.current?.segmentContext())
    setPlacement(previous => {
      if (!geometry) return undefined
      return previous?.sheet === sheet && previous.geometry.origin.x === geometry.origin.x && previous.geometry.origin.y === geometry.origin.y
        && previous.geometry.frame.x === geometry.frame.x && previous.geometry.frame.y === geometry.frame.y
        && previous.geometry.frame.width === geometry.frame.width && previous.geometry.frame.height === geometry.frame.height
        ? previous : { sheet, geometry }
    })
  }, [doc, target])

  useLayoutEffect(() => {
    measure()
    const root = reader.current
    if (!root) return
    const resize = new ResizeObserver(measure)
    const watch = () => {
      resize.disconnect()
      const sheet = root.querySelector<HTMLElement>('.sheet')
      if (sheet) resize.observe(sheet)
      for (const element of root.querySelectorAll<HTMLElement>('.main-text [data-id], [data-note-id] > .object-body, .object-caption')) resize.observe(element)
    }
    const mutations = new MutationObserver(() => { watch(); measure() })
    mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    watch()
    void document.fonts.ready.then(measure)
    return () => { mutations.disconnect(); resize.disconnect() }
  }, [doc, measure])

  const onActions = useCallback((value: CanvasActions) => { actions.current = value; measure() }, [measure])
  const marks = markup && placement && <div aria-hidden="true" style={{
    position: 'absolute', left: placement.geometry.origin.x + markup.x, top: placement.geometry.origin.y + markup.y,
    width: markup.width, height: markup.height, zIndex: 'var(--canvas-ui-layer)', pointerEvents: 'none',
  }}><MarkupView markup={{ width: markup.width, height: markup.height, strokes: markup.strokes, labels: markup.labels }} /></div>

  return <div ref={reader} className="app local-markup-preview" style={uiThemeVariables(doc.theme, doc.language ?? 'en')}>
    <main className="workspace reader">
      <ReadDocument initial={doc} staticWidgets expandSlides nativeScroll onActions={onActions} />
    </main>
    {markup && placement && createPortal(marks, placement.sheet)}
  </div>
}

function payload<T>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Preview data is missing: ${id}`)
  return JSON.parse(element.textContent ?? '') as T
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Preview root is missing.')
const root = createRoot(rootElement)
try {
  const doc = initializeDocument(payload('mote-document'))
  const target = payload<AITarget>('mote-target')
  const markup = parseMarkup(payload('mote-markup'))
  root.render(<StrictMode><Preview doc={doc} target={target} markup={markup} /></StrictMode>)
} catch (error) {
  root.render(<main role="alert" style={{ margin: '24px auto', maxWidth: 720, padding: 20, font: '16px/1.5 system-ui,sans-serif', color: '#303030', background: '#fff' }}>
    <h1>Mote preview unavailable</h1>
    <p>{error instanceof Error ? error.message : 'The document or reservation markup is invalid.'}</p>
  </main>)
}
