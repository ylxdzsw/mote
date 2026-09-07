import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import type { FloatingText, MoteDocument } from '../document/model'
import { TextEditor } from '../editor/TextEditor'
import { themeVariables } from '../theme/ThemePanel'
import { useDocumentZoom } from './useDocumentZoom'

interface Point { x: number; y: number }

interface Props {
  doc: MoteDocument
  editable: boolean
  onMainChange: (content: JSONContent) => void
  onNoteChange: (id: string, patch: Partial<FloatingText>) => void
  onNoteRemove: (id: string) => void
  onActive: (editor: Editor) => void
  onMainReady: (editor: Editor) => void
}

export function DocumentCanvas({ doc, editable, onMainChange, onNoteChange, onNoteRemove, onActive, onMainReady }: Props) {
  const stage = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLDivElement>(null)
  const [anchors, setAnchors] = useState<Record<string, Point>>({})
  const { scale, zoomTo, reset } = useDocumentZoom(stage, sheet, doc.width, editable)
  const [minHeight, setMinHeight] = useState(900)
  const [selected, setSelected] = useState<string | null>(null)

  useLayoutEffect(() => {
    const surface = sheet.current!
    const measure = () => {
      const rect = surface.getBoundingClientRect()
      const zoom = rect.width / surface.offsetWidth
      const textLeft = (main.current!.getBoundingClientRect().left - rect.left) / zoom - surface.clientLeft
        + parseFloat(getComputedStyle(main.current!).paddingLeft)
      const positions: Record<string, Point> = {}
      main.current!.querySelectorAll<HTMLElement>('[data-id]').forEach(element => {
        const block = element.getBoundingClientRect()
        positions[element.dataset.id!] = {
          x: textLeft,
          y: (block.top - rect.top) / zoom - surface.clientTop,
        }
      })
      setAnchors(positions)
      let bottom = 900
      surface.querySelectorAll<HTMLElement>('.floating-note').forEach(element => {
        const note = doc.floating.find(note => note.id === element.dataset.noteId)!
        const anchor = positions[note.anchorId]
        if (anchor) bottom = Math.max(bottom, anchor.y + note.y + element.offsetHeight + 64)
      })
      setMinHeight(bottom)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage.current!)
    observer.observe(main.current!)
    surface.querySelectorAll('.floating-note').forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [doc, editable, scale])

  return <div className="canvas-pane">
    <div className="stage" ref={stage} aria-label="Document canvas" onPointerDown={event => {
      if (!(event.target as HTMLElement).closest('.floating-note')) setSelected(null)
    }}>
      <div className={`sheet ${editable ? 'is-editing' : 'is-reading'} ${selected ? 'has-selected-note' : ''}`} ref={sheet}
        style={{ ...themeVariables(doc.theme), width: doc.width, zoom: scale, minHeight }}>
        <div className="main-text" ref={main}>
          <TextEditor content={doc.content} editable={editable} spatial label="Main text"
            onChange={onMainChange} onReady={onMainReady}
            onActive={editor => { setSelected(null); onActive(editor) }} />
        </div>
        {doc.floating.map(note => anchors[note.anchorId] && <FloatingNote key={note.id}
          note={note} anchor={anchors[note.anchorId]} scale={scale} editable={editable}
          selected={selected === note.id}
          onChange={patch => onNoteChange(note.id, patch)} onRemove={() => onNoteRemove(note.id)}
          onActive={editor => { setSelected(note.id); onActive(editor) }} />)}
      </div>
      <p className="page-footer">MOTE <span>·</span> A place for text and space</p>
    </div>
    <div className="zoom-controls" aria-label="Document zoom">
      <button aria-label="Zoom out" disabled={scale <= .25} onClick={() => zoomTo(scale / 1.1)}>−</button>
      <output aria-label="Document zoom level">{Math.round(scale * 100)}%</output>
      <button aria-label="Zoom in" disabled={scale >= 3} onClick={() => zoomTo(scale * 1.1)}>+</button>
      <button onClick={reset} title="Reset document zoom (Ctrl/⌘ 0)">{editable ? '100%' : 'Fit'}</button>
    </div>
  </div>
}

interface NoteProps {
  note: FloatingText
  anchor: Point
  scale: number
  editable: boolean
  selected: boolean
  onChange: (patch: Partial<FloatingText>) => void
  onRemove: () => void
  onActive: (editor: Editor) => void
}

function FloatingNote({ note, anchor, scale, editable, selected, onChange, onRemove, onActive }: NoteProps) {
  const editor = useRef<Editor | null>(null)
  const [preview, setPreview] = useState<Partial<FloatingText> | null>(null)
  const drag = useRef<{ client: Point; x: number; y: number; width: number; resize: boolean } | null>(null)
  const display = { ...note, ...preview }

  function start(event: PointerEvent<HTMLElement>, resize: boolean) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { client: { x: event.clientX, y: event.clientY }, x: note.x, y: note.y, width: note.width, resize }
    onActive(editor.current!)
  }

  function move(event: PointerEvent<HTMLElement>) {
    if (!drag.current) return
    const start = drag.current
    const dx = (event.clientX - start.client.x) / scale
    const dy = (event.clientY - start.client.y) / scale
    const sheetWidth = event.currentTarget.closest<HTMLElement>('.sheet')!.clientWidth
    setPreview(start.resize
      ? { width: Math.round(Math.max(120, Math.min(sheetWidth - anchor.x - note.x - 16, start.width + dx))) }
      : {
        x: Math.round(Math.max(16 - anchor.x, Math.min(sheetWidth - anchor.x - note.width - 16, start.x + dx))),
        y: Math.round(Math.max(16 - anchor.y, start.y + dy)),
      })
  }

  function finish() {
    if (preview) onChange(preview)
    drag.current = null
    setPreview(null)
  }

  function cancel() { drag.current = null; setPreview(null) }

  function remove() {
    if (window.confirm('Delete this floating text box?')) onRemove()
  }

  return <div className={`floating-note ${selected ? 'is-selected' : ''}`} data-note-id={note.id}
    style={{ left: anchor.x + display.x, top: anchor.y + display.y, width: display.width }}
    tabIndex={editable ? 0 : undefined} aria-label="Floating text box"
    onFocus={event => { if (editable && event.target === event.currentTarget) onActive(editor.current!) }}
    onPointerDown={event => { if (editable && event.target === event.currentTarget) start(event, false) }}
    onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}
    onKeyDown={event => {
      if (!editable || event.target !== event.currentTarget) return
      if (event.key === 'Escape') { cancel(); event.currentTarget.blur(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); return }
      const directions: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
      const direction = directions[event.key]
      if (!direction) return
      event.preventDefault()
      const step = event.shiftKey ? 1 : 8
      onChange({ x: note.x + direction.x * step, y: note.y + direction.y * step })
    }}>
    {editable && selected && <button className="note-delete" aria-label="Delete anchored text" title="Delete anchored text" onClick={remove}>×</button>}
    <TextEditor content={note.content} editable={editable} label="Floating text"
      onChange={content => onChange({ content })} onActive={onActive} onReady={value => { editor.current = value }} />
    {editable && selected && <button className="resize-handle" aria-label="Resize anchored text" title="Drag, or use left/right arrow keys"
      onPointerDown={event => start(event, true)}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        onChange({ width: Math.max(120, note.width + (event.key === 'ArrowLeft' ? -8 : 8)) })
      }}>⌟</button>}
  </div>
}
