import { useRef, useState } from 'react'
import type { FloatingHTMLWidget } from '../document/model'
import './embeds.css'

function page(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:transparent}</style></head>${html}`
}

export function HTMLWidgetView({ note, editable, selected, run, staticOnly, restoreRevision }: {
  note: FloatingHTMLWidget; editable: boolean; selected: boolean; run: number; staticOnly: boolean; restoreRevision?: number
}) {
  const [execution, setExecution] = useState({ run, html: note.html })
  const restored = useRef(restoreRevision)
  // Editing source saves it without executing incomplete code. Only Run replaces the page.
  if (execution.run !== run) setExecution({ run, html: note.html })
  if (restored.current !== restoreRevision) {
    restored.current = restoreRevision
    if (execution.html !== note.html) setExecution({ run, html: note.html })
  }
  const interactive = !editable || selected
  return <div className="html-widget">
    <img className={`widget-screenshot${staticOnly ? ' is-static' : ''}`} src={note.screenshot} alt={note.alt} draggable={false} />
    {!staticOnly && <div className="widget-live" data-widget-live="">
      <iframe key={execution.run} title={note.alt || 'HTMLWidget'} sandbox="allow-scripts" srcDoc={page(execution.html)}
        tabIndex={interactive ? 0 : -1} inert={!interactive} style={{ pointerEvents: interactive ? 'auto' : 'none' }} />
    </div>}
  </div>
}
