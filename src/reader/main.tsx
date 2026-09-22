import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReadDocument } from '../canvas/ReadDocument'
import type { MoteDocument } from '../document/model'
import { useMedia } from '../app/useMedia'
import { uiThemeVariables } from '../theme/ui'
import '../app/styles.css'

function readDocument(): MoteDocument {
  const element = document.getElementById('mote-document')
  if (!element) throw new Error('Mote document payload is missing')
  return JSON.parse(element.textContent ?? '') as MoteDocument
}

function Reader({ initial }: { initial: MoteDocument }) {
  const smallScreen = useMedia('(max-width: 1050px)')
  return <div className="app" style={uiThemeVariables(initial.theme.hue)}>
    <main className="workspace reader">
      <ReadDocument initial={initial} minimap={!smallScreen} />
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Reader initial={readDocument()} /></StrictMode>)
