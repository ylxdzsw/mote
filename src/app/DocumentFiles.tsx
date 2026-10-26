import { useId, useState } from 'react'
import type { MoteDocument } from '../document/model'
import { encodeMote } from '../document/file'
import { exportHtml } from '../reader/export'
import { exportPng } from '../document/png'
import { PanelIcon } from './PanelIcon'
import './files.css'

const formats = {
  png: { description: 'PNG image', mime: 'image/png' },
  html: { description: 'HTML reader', mime: 'text/html' },
  mote: { description: 'Mote document', mime: 'application/gzip' },
}
const saveWindow = window as Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string; types: { description: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle>
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = name
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export function DocumentFiles({ doc, name, onBusyChange }: { doc: MoteDocument; name: string; onBusyChange?: (busy: boolean) => void }) {
  const titleId = useId()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [filename, setFilename] = useState(name)
  const [pngScale, setPngScale] = useState<1 | 2>(2)
  const basename = filename.trim().replace(/\.(png|html|mote)$/i, '')
  const invalidName = !basename || /^[. ]+$/.test(basename) || /[<>:"/\\|?*\u0000-\u001f]/.test(basename)

  function updateBusy(value: string) {
    setBusy(value)
    onBusyChange?.(!!value)
  }

  async function exporting(format: keyof typeof formats) {
    if (invalidName) return
    const name = `${basename}.${format}`
    const preparing = `Preparing ${format === 'mote' ? '.mote document' : format.toUpperCase()}…`
    updateBusy(saveWindow.showSaveFilePicker ? 'Choose where to save…' : preparing); setError(''); setResult('')
    try {
      let handle: FileSystemFileHandle | undefined
      try {
        // Invoke the picker in the click gesture, before imports or rendering consume activation.
        handle = await saveWindow.showSaveFilePicker?.({ suggestedName: name,
          types: [{ description: formats[format].description, accept: { [formats[format].mime]: [`.${format}`] } }],
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') { setResult('Export canceled.'); return }
        throw error
      }
      updateBusy(preparing)
      const snapshot = structuredClone(doc)
      const blob = format === 'mote' ? await encodeMote(snapshot)
        : format === 'html' ? await exportHtml(snapshot) : await exportPng(snapshot, pngScale)
      if (handle) {
        updateBusy('Saving file…')
        const writable = await handle.createWritable()
        try { await writable.write(blob); await writable.close() }
        catch (error) { await writable.abort().catch(() => {}); throw error }
        setResult(`Saved ${handle.name}.`)
      } else {
        download(blob, name)
        setResult('Export ready. Your browser will download the file.')
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Export failed. Please try again.') }
    finally { updateBusy('') }
  }

  return <div className="document-files">
      <label className="export-filename">Filename
        <input type="text" value={filename} disabled={!!busy} aria-invalid={invalidName || undefined} aria-describedby={invalidName ? `${titleId}-filename-hint` : undefined}
          onFocus={event => event.currentTarget.select()} onChange={event => setFilename(event.target.value)} />
      </label>
      {invalidName && <p id={`${titleId}-filename-hint`}>Enter a filename without / \ : * ? " &lt; &gt; |.</p>}
      <div className="export-formats">
        <div className="export-png" role="group" aria-label="PNG export">
          <button className="export-format" aria-label="Export PNG" disabled={!!busy || invalidName} onClick={() => void exporting('png')}
            title="Exports the page as a full-length image without internal notes. Widgets use their saved screenshots. Higher resolution sharpens text and vectors; image detail depends on the source. Very large pages may require 1× resolution."><span className="export-format-copy"><strong>PNG <small>.png</small></strong><span>Full-length image · {Math.ceil(doc.page.width * pngScale)}px wide</span></span><PanelIcon name="export" /></button>
          <label className="export-resolution">Resolution
            <select value={pngScale} disabled={!!busy} onChange={event => setPngScale(Number(event.currentTarget.value) as 1 | 2)}>
              <option value={1}>1× · Original</option>
              <option value={2}>2× · High resolution</option>
            </select>
          </label>
        </div>
        <button className="export-format" aria-label="Export HTML" disabled={!!busy || invalidName} onClick={() => void exporting('html')}
          title="Exports the page as a standalone browser reader that can be imported back into Mote. Internal notes are excluded, including from the embedded document. Widgets stay interactive; their online resources still need a connection. JavaScript is required to view the page."><span className="export-format-copy"><strong>HTML <small>.html</small></strong><span>Standalone reader · reimportable · excludes internal notes</span></span><PanelIcon name="export" /></button>
        <button className="export-format" aria-label="Export Mote document" disabled={!!busy || invalidName} onClick={() => void exporting('mote')}
          title="Exports the complete document and all internal notes as a compressed editable file. Import it into Mote to continue editing. Internal notes are included in any copy you share."><span className="export-format-copy"><strong>Mote document <small>.mote</small></strong><span>Editable document · includes internal notes</span></span><PanelIcon name="export" /></button>
      </div>
      <p className="files-status" role="status">{busy || result}</p>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
}
