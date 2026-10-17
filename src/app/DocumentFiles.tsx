import { useId, useState } from 'react'
import type { MoteDocument } from '../document/model'
import { encodeMote } from '../document/file'
import { exportHtml } from '../reader/export'
import { exportPng } from '../document/png'
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

export function DocumentFiles({ doc, onBusyChange }: { doc: MoteDocument; onBusyChange?: (busy: boolean) => void }) {
  const titleId = useId()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [filename, setFilename] = useState('Untitled')
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
        : format === 'html' ? await exportHtml(snapshot) : await exportPng(snapshot)
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

  return <section className="document-files" aria-labelledby={titleId}>
      <h2 id={titleId}>Export</h2>
      <p>Export the current working copy, including changes not yet synced to the cloud.</p>
      <label className="export-filename">Filename
        <input type="text" value={filename} disabled={!!busy} aria-invalid={invalidName || undefined} aria-describedby={`${titleId}-filename-hint`}
          onFocus={event => event.currentTarget.select()} onChange={event => setFilename(event.target.value)} />
      </label>
      <p id={`${titleId}-filename-hint`}>{invalidName ? 'Enter a filename without / \\ : * ? " < > |.' : 'The selected format’s extension is added automatically.'}</p>
      <div className="export-formats">
        <button disabled={!!busy || invalidName} onClick={() => void exporting('png')}><strong>PNG</strong><span>Full-length image · {Math.ceil(doc.width)}px wide · native resolution</span></button>
        <button disabled={!!busy || invalidName} onClick={() => void exporting('html')}><strong>HTML</strong><span>Standalone reader · can be imported back</span></button>
        <button disabled={!!busy || invalidName} onClick={() => void exporting('mote')}><strong>Mote document <small>.mote</small></strong><span>Compressed editable document · can be imported back</span></button>
      </div>
      <p>Internal notes are included only in .mote exports. HTML and PNG contain the published page.</p>
      {doc.floating.some(object => object.kind === 'html') && <p>HTML widgets stay interactive in HTML exports; their online resources still need a connection. PNG uses the screenshots you supplied.</p>}
      <p className="files-status" role="status">{busy || result}</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
}
