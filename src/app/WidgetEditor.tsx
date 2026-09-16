import { useEffect, useRef, useState } from 'react'
import type { FloatingHTMLWidget } from '../document/model'
import { useHistory } from '../document/history'

interface Props {
  widget: FloatingHTMLWidget
  onChange: (html: string) => void
  onRun: () => void
  onClose: () => void
  onHistoryBegin: (name: string) => void
  onHistoryEnd: () => void
}

export function WidgetEditor({ widget, onChange, onRun, onClose, onHistoryBegin, onHistoryEnd }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const [fileError, setFileError] = useState('')
  const { revision } = useHistory()

  useEffect(() => () => { generation.current++ }, [widget.id, widget.html, revision])

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])

  async function dropFile(files: File[]) {
    const pending = ++generation.current
    setFileError('')
    const file = files[0]
    if (files.length !== 1 || !(file.type === 'text/html' || /\.html?$/i.test(file.name))) {
      setFileError('Drop one HTML file (.html or .htm).')
      return
    }
    try {
      const html = await file.text()
      if (pending !== generation.current) return
      onHistoryEnd()
      onChange(html)
      onHistoryEnd()
    } catch {
      if (pending === generation.current) setFileError('Couldn’t read this file. Try another HTML file.')
    }
  }

  return <dialog ref={dialog} className="widget-editor" aria-labelledby="widget-editor-title" aria-describedby="widget-editor-hint"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}
    onKeyDownCapture={event => { if (event.key === 'Escape') event.stopPropagation() }}>
    <div className="widget-editor-heading">
      <div><h1 id="widget-editor-title">Edit HTML widget</h1><p id="widget-editor-hint">Changes save immediately. Run / Restart executes the saved source in a fresh widget.</p></div>
      <button aria-label="Close HTML widget editor" onClick={onClose}>×</button>
    </div>
    <label className="widget-editor-source">HTML / CSS / JS
      <textarea autoFocus spellCheck={false} value={widget.html} aria-describedby="widget-editor-file-hint"
        onFocus={() => onHistoryBegin(`html-widget-source:${widget.id}`)} onBlur={onHistoryEnd}
        onChange={event => { generation.current++; setFileError(''); onChange(event.target.value) }}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault(); event.stopPropagation()
          void dropFile([...event.dataTransfer.files])
        }} />
    </label>
    <p className="hint" id="widget-editor-file-hint">Drop an .html or .htm file into the editor to replace its source.</p>
    {fileError && <p role="alert">{fileError}</p>}
    <p className="hint">CDN references are used as-is; online resources may not work offline.</p>
    <div className="widget-editor-actions">
      <button onClick={onRun}>Run / Restart</button>
      <button onClick={onClose}>Close</button>
    </div>
  </dialog>
}
