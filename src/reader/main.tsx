import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReadDocument } from '../canvas/ReadDocument'
import type { MoteDocument } from '../document/model'
import { GlobalSettings, useViewSettings } from '../app/GlobalSettings'
import { useMedia } from '../app/useMedia'
import '../app/styles.css'
import './styles.css'

function readDocument(): MoteDocument {
  const element = document.getElementById('mote-document')
  if (!element) throw new Error('Mote document payload is missing')
  return JSON.parse(element.textContent ?? '') as MoteDocument
}

function Reader({ initial }: { initial: MoteDocument }) {
  const smallScreen = useMedia('(max-width: 1050px)')
  const { settings, update } = useViewSettings(false)
  const [viewOpen, setViewOpen] = useState(false)
  const [zoomHost, setZoomHost] = useState<HTMLDivElement | null>(null)
  const showMinimap = settings.minimap === 'show' || (settings.minimap === 'auto' && !smallScreen)

  return <div className="app reader-app">
    <header className="app-header reader-header">
      <div className="brand" aria-label="Mote"><span className="brand-mark">m</span>Mote</div>
      <div className="document-label">Untitled notebook <span className="version">V0</span></div>
      <div className="header-zoom" ref={setZoomHost} />
      <button className="view-settings-toggle" aria-label="View settings" aria-expanded={viewOpen}
        aria-controls="reader-view-settings" onClick={() => setViewOpen(open => !open)}>View</button>
    </header>
    <main className={`workspace ${viewOpen ? '' : 'reader'}`}>
      <ReadDocument initial={initial} minimap={showMinimap} minimapSize={settings.minimapSize} zoomHost={zoomHost} />
      {viewOpen && <aside className="inspector reader-settings" id="reader-view-settings" aria-label="View settings">
        <div className="inspector-heading">VIEW SETTINGS
          <button aria-label="Close view settings" onClick={() => setViewOpen(false)}>×</button>
        </div>
        <GlobalSettings settings={settings} onChange={update} saveError={false} persist={false} />
      </aside>}
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Reader initial={readDocument()} /></StrictMode>)
