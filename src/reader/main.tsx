import { initializeDocument } from '../document/initialize'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReaderPage } from './ReaderPage'
import type { MoteDocument } from '../document/model'
import '../app/styles.css'

function readDocument(): MoteDocument {
  const element = document.getElementById('mote-document')
  if (!element) throw new Error('Mote document payload is missing')
  return initializeDocument(JSON.parse(element.textContent ?? ''))
}

const root = createRoot(document.getElementById('root')!)
try { root.render(<StrictMode><ReaderPage initial={readDocument()} /></StrictMode>) }
catch (error) { root.render(<main className="loading"><h1>Mote</h1><p role="alert">{error instanceof Error ? error.message : 'Unsupported document format'}. The embedded data has not been changed. Open a supported V1 or V2 document or retain this file for recovery.</p></main>) }
