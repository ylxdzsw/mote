import { initializeDocument } from '../document/initialize'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReaderPage } from './ReaderPage'
import { PreparedContentContext, type PreparedContent } from './PreparedContent'
import type { MoteDocument } from '../document/model'
import '../app/styles.css'

function readDocument(): MoteDocument {
  const element = document.getElementById('mote-document')
  if (!element) throw new Error('Mote document payload is missing')
  return initializeDocument(JSON.parse(element.textContent ?? ''))
}

const root = createRoot(document.getElementById('root')!)
try {
  const initial = readDocument()
  const prepared = JSON.parse(document.getElementById('mote-prepared-content-v1')!.textContent!) as PreparedContent
  root.render(<StrictMode><PreparedContentContext.Provider value={prepared}><ReaderPage initial={initial} /></PreparedContentContext.Provider></StrictMode>)
}
catch (error) { root.render(<main className="loading"><h1>Mote</h1><p role="alert">{error instanceof Error ? error.message : 'Unsupported document format'}. The embedded data has not been changed. Open a supported V1–V5 document or retain this file for recovery.</p></main>) }
