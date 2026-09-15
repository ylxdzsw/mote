import { useEffect, useRef } from 'react'
import type { FloatingHTMLWidget } from '../document/model'

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

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])

  return <dialog ref={dialog} className="widget-editor" aria-labelledby="widget-editor-title" aria-describedby="widget-editor-hint"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}
    onKeyDownCapture={event => { if (event.key === 'Escape') event.stopPropagation() }}>
    <div className="widget-editor-heading">
      <div><h1 id="widget-editor-title">Edit HTML widget</h1><p id="widget-editor-hint">Changes save immediately. Run / Restart executes the saved source in a fresh widget.</p></div>
      <button aria-label="Close HTML widget editor" onClick={onClose}>×</button>
    </div>
    <label className="widget-editor-source">HTML / CSS / JS
      <textarea autoFocus spellCheck={false} value={widget.html}
        onFocus={() => onHistoryBegin(`html-widget-source:${widget.id}`)} onBlur={onHistoryEnd}
        onChange={event => onChange(event.target.value)} />
    </label>
    <p className="hint">CDN references are used as-is; online resources may not work offline.</p>
    <div className="widget-editor-actions">
      <button onClick={onRun}>Run / Restart</button>
      <button onClick={onClose}>Close</button>
    </div>
  </dialog>
}
