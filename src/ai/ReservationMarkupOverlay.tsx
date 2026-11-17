import { useLayoutEffect, useRef } from 'react'
import type { MoteDocument } from '../document/model'
import { MarkupView } from '../canvas/DrawingView'
import { themeVariables } from '../theme/ThemePanel'
import { selectedCandidateVersion } from './candidates'
import { measureReservationMarkup } from './markup'
import type { SegmentContext } from './segments'
import type { AITask } from './types'

// Outside the sheet: instructions never enter layout, minimap snapshots or exports.
export function ReservationMarkupOverlay({ doc, tasks, context, scale }: {
  doc: MoteDocument; tasks: AITask[]; context: SegmentContext; scale: number
}) {
  const root = useRef<HTMLDivElement>(null)
  const marked = tasks.filter(task => task.markup && !task.released && !(task.preview && selectedCandidateVersion(task)))
  useLayoutEffect(() => {
    const footprint = root.current!.parentElement!
    const sheet = footprint.querySelector<HTMLElement>(':scope > .sheet')!
    const position = () => {
      for (const [index, task] of marked.entries()) {
        const element = root.current!.children[index] as HTMLElement
        const geometry = measureReservationMarkup(footprint, doc, task.target, context)
        element.hidden = !geometry
        if (!geometry) continue
        Object.assign(element.style, {
          left: `${(geometry.origin.x + task.markup!.x + sheet.clientLeft) * scale}px`,
          top: `${(geometry.origin.y + task.markup!.y + sheet.clientTop) * scale}px`,
          width: `${task.markup!.width * scale}px`, height: `${task.markup!.height * scale}px`,
        })
      }
    }
    position()
    const mutations = new MutationObserver(position)
    mutations.observe(sheet, { subtree: true, childList: true, attributes: true, characterData: true })
    const resize = new ResizeObserver(position)
    resize.observe(sheet)
    return () => { mutations.disconnect(); resize.disconnect() }
  })
  return <div ref={root} className="reservation-markup-overlay" aria-hidden="true" inert
    style={themeVariables(doc.theme, doc.language ?? 'en', doc.version)}>
    {marked.map(task => <div key={task.id} data-reservation-markup={task.id} hidden style={{ position: 'absolute' }}>
      <MarkupView markup={task.markup!} />
    </div>)}
  </div>
}
