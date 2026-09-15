import { useEffect, useRef, useState } from 'react'
import type { FloatingHTMLWidget } from '../document/model'
import './embeds.css'

function page(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:transparent}</style></head>${html}`
}

export function HTMLWidgetView({ note, editable, selected, run, staticOnly }: {
  note: FloatingHTMLWidget; editable: boolean; selected: boolean; run: number; staticOnly: boolean
}) {
  const [execution, setExecution] = useState({ run, html: note.html })
  const [interacting, setInteracting] = useState(false)
  const exit = useRef<HTMLButtonElement>(null)
  // Editing source saves it without executing incomplete code. Only Run replaces the page.
  if (execution.run !== run) setExecution({ run, html: note.html })
  useEffect(() => { setInteracting(false) }, [editable, selected, run])
  const interactive = !editable || (selected && interacting)
  return <div className="html-widget">
    <img className={`widget-screenshot${staticOnly ? ' is-static' : ''}`} src={note.screenshot} alt={note.alt} draggable={false} />
    {!staticOnly && <div className="widget-live" data-widget-live="">
      <iframe key={execution.run} title={note.alt || 'HTMLWidget'} sandbox="allow-scripts" srcDoc={page(execution.html)}
        tabIndex={interactive ? 0 : -1} inert={!interactive} style={{ pointerEvents: interactive ? 'auto' : 'none' }} />
      {editable && selected && <div className="widget-controls" data-widget-control="" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        {interactive ? <button ref={exit} onClick={() => { setInteracting(false); exit.current?.closest<HTMLElement>('.floating-note')?.focus({ preventScroll: true }) }}>Exit interaction</button>
          : <button onClick={() => setInteracting(true)}>Interact</button>}
      </div>}
    </div>}
  </div>
}
