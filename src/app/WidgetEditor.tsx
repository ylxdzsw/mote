import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FloatingHTMLWidget } from '../document/model'
import { useHistory } from '../document/history'
import { SourceEditor } from '../editor/SourceEditor'

interface Props {
  widget: FloatingHTMLWidget
  onChange: (html: string) => void
  onRun: () => void
  onClose: () => void
  onHistoryEnd: () => void
}

export function WidgetEditor({ widget, onChange, onRun, onClose, onHistoryEnd }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const [fileError, setFileError] = useState('')
  const { revision } = useHistory()

  useEffect(() => () => { generation.current++ }, [widget.id, widget.html, revision])

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    element.querySelector<HTMLElement>('[data-code-source]')?.focus()
    return () => { element.close() }
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
    <div className="widget-editor-source"><span>HTML / CSS / JS</span>
      <div className="code-view" data-source-viewport>
        <SourceEditor source={widget.html} language="html" editorId={`html-widget-source:${widget.id}`} canEdit label="HTML / CSS / JS source"
          describedBy="widget-editor-file-hint" onChange={text => { generation.current++; setFileError(''); onChange(text) }}
          onEscape={onClose} onFiles={files => { void dropFile(files) }} />
      </div>
    </div>
    <p className="hint" id="widget-editor-file-hint">Drop an .html or .htm file into the editor to replace its source.</p>
    {fileError && <p role="alert">{fileError}</p>}
    <p className="hint">CDN references are used as-is; online resources may not work offline.</p>
    <div className="widget-editor-actions">
      <button onClick={onRun}>Run / Restart</button>
      <button onClick={onClose}>Close</button>
    </div>
  </dialog>
}
