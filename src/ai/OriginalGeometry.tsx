import { useRef } from 'react'
import type { MoteDocument } from '../document/model'
import { ReadDocument } from '../canvas/ReadDocument'
import type { SegmentContext } from './segments'

// Source anchors must not be measured from the candidate's reflowed document.
// Reuse the static reader, without widgets executing or browser-local writes.
export function OriginalGeometry({ doc, onMeasure }: { doc: MoteDocument; onMeasure: (doc: MoteDocument, context: SegmentContext) => void }) {
  const version = useRef({ doc, key: 0 })
  if (version.current.doc !== doc) version.current = { doc, key: version.current.key + 1 }
  return <div inert aria-hidden="true" className="ai-original-measurement"
    style={{ position: 'fixed', left: -100000, top: 0, width: doc.width + 48, height: 600, pointerEvents: 'none' }}>
    <ReadDocument key={version.current.key} initial={doc} staticWidgets initialScale={1} onActions={actions => {
      const context = actions.segmentContext()
      if (context && context.anchors.length === doc.content.content!.length) onMeasure(doc, context)
    }} />
  </div>
}
