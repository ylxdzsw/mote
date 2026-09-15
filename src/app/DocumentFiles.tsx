import { useRef, useState } from 'react'
import type { MoteDocument } from '../document/model'
import './files.css'

const formats = {
  png: { description: 'PNG image', mime: 'image/png' },
  html: { description: 'Offline HTML reader', mime: 'text/html' },
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

export function DocumentFiles({ doc, onImport }: { doc: MoteDocument; onImport?: (doc: MoteDocument) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [filename, setFilename] = useState('Untitled')
  const basename = filename.trim().replace(/\.(png|html|mote)$/i, '')
  const invalidName = !basename || /^[. ]+$/.test(basename) || /[<>:"/\\|?*\u0000-\u001f]/.test(basename)

  async function exporting(format: keyof typeof formats) {
    if (invalidName) return
    const name = `${basename}.${format}`
    const preparing = `Preparing ${format === 'mote' ? '.mote document' : format.toUpperCase()}…`
    setBusy(saveWindow.showSaveFilePicker ? 'Choose where to save…' : preparing); setError(''); setResult('')
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
      setBusy(preparing)
      const snapshot = structuredClone(doc)
      const blob = format === 'mote' ? await (await import('../document/file')).encodeMote(snapshot)
        : format === 'html' ? await (await import('../reader/export')).exportHtml(snapshot)
        : await (await import('../document/png')).exportPng(snapshot)
      if (handle) {
        setBusy('Saving file…')
        const writable = await handle.createWritable()
        try { await writable.write(blob); await writable.close() }
        catch (error) { await writable.abort().catch(() => {}); throw error }
        setResult(`Saved ${handle.name}.`)
      } else {
        download(blob, name)
        setResult('Export ready. Your browser will download the file.')
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Export failed. Please try again.') }
    finally { setBusy('') }
  }

  async function importing(file: File) {
    if (!onImport) return
    setBusy('Opening .mote document…'); setError(''); setResult('')
    try {
      const next = await (await import('../document/file')).decodeMote(file)
      if (window.confirm('Replace your local draft with this .mote document? This clears undo history and cannot be undone. Export your current draft first if you want to keep it.')) onImport(next)
    } catch (error) { setError(error instanceof Error ? error.message : 'This .mote document could not be opened.') }
    finally { setBusy('') }
  }

  return <>
    <button className="view-settings-toggle" aria-haspopup="dialog" onClick={() => { setError(''); setResult(''); dialog.current!.showModal() }}>File</button>
    <dialog ref={dialog} className="document-files" aria-labelledby="document-files-title" onCancel={event => { if (busy) event.preventDefault() }}>
      <div className="files-heading"><h1 id="document-files-title">Document files</h1><button aria-label="Close document files" disabled={!!busy} onClick={() => dialog.current!.close()}>×</button></div>
      <h2>Export</h2>
      <p>Export the current document, including changes not yet saved in this browser.</p>
      <label className="export-filename">Filename
        <input type="text" value={filename} disabled={!!busy} aria-invalid={invalidName || undefined} aria-describedby="filename-hint"
          onFocus={event => event.currentTarget.select()} onChange={event => setFilename(event.target.value)} />
      </label>
      <p id="filename-hint">{invalidName ? 'Enter a filename without / \\ : * ? " < > |.' : 'The selected format’s extension is added automatically.'}</p>
      <div className="export-formats">
        <button disabled={!!busy || invalidName} onClick={() => void exporting('png')}><strong>PNG</strong><span>Full-length image · {Math.ceil(doc.width)}px wide · native resolution</span></button>
        <button disabled={!!busy || invalidName} onClick={() => void exporting('html')}><strong>HTML</strong><span>Standalone offline reader · bundled document and images</span></button>
        <button disabled={!!busy || invalidName} onClick={() => void exporting('mote')}><strong>Mote document <small>.mote</small></strong><span>Compressed editable document · can be imported back</span></button>
      </div>
      {onImport && <section className="files-import"><h2>Import</h2><p>Only .mote documents can be imported. Import replaces the local draft after confirmation.</p>
        <button disabled={!!busy} onClick={() => input.current!.click()}>Import .mote…</button>
        <input ref={input} type="file" accept=".mote" hidden aria-label="Mote document file" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = ''; if (file) void importing(file)
        }} /></section>}
      <p className="files-status" role="status">{busy || result}</p>
      {error && <p className="error" role="alert">{error}</p>}
    </dialog>
  </>
}
