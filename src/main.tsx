import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { ReaderPage } from './reader/ReaderPage'
import { previewPath, receivePreview } from './reader/usePreview'
import './app/styles.css'

const root = createRoot(document.getElementById('root')!)
if (location.pathname === previewPath) {
  const receiving = receivePreview((snapshot, revision) => {
    root.render(<StrictMode><ReaderPage key={revision} initial={snapshot} /></StrictMode>)
    window.scrollTo(0, 0)
  })
  root.render(<main className="loading">{receiving ? 'Opening preview…' : 'Open Preview from a Mote document.'}</main>)
} else root.render(<StrictMode><App /></StrictMode>)
