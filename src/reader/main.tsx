import { initializeDocument } from '../document/initialize'
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { ReadDocument } from '../canvas/ReadDocument'
import type { MoteDocument } from '../document/model'
import { useMedia } from '../app/useMedia'
import { uiThemeVariables } from '../theme/ui'
import '../app/styles.css'

function readDocument(): MoteDocument {
  const element = document.getElementById('mote-document')
  if (!element) throw new Error('Mote document payload is missing')
  return initializeDocument(JSON.parse(element.textContent ?? ''))
}

function Reader({ initial }: { initial: MoteDocument }) {
  const smallScreen = useMedia('(max-width: 1050px)')
  const uiStyle = useMemo(() => uiThemeVariables(initial.theme), [initial.theme])
  return <div className="app" style={uiStyle}>
    <main className="workspace reader">
      <ReadDocument initial={initial} minimap={!smallScreen} />
    </main>
  </div>
}

const root = createRoot(document.getElementById('root')!)
try { root.render(<StrictMode><Reader initial={readDocument()} /></StrictMode>) }
catch (error) { root.render(<main className="loading"><h1>Mote</h1><p role="alert">{error instanceof Error ? error.message : 'Unsupported document format'}. The embedded data has not been changed. Open a supported V1 document or retain this file for recovery.</p></main>) }
