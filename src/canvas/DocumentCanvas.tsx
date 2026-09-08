import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Editor, JSONContent } from '@tiptap/core'
import type { FloatingObject, FloatingPatch, MoteDocument } from '../document/model'
import { TextEditor } from '../editor/TextEditor'
import { themeVariables } from '../theme/ThemePanel'
import { useDocumentZoom } from './useDocumentZoom'
import { Minimap } from './Minimap'
import { SegmentBoundaries } from './SegmentBoundaries'
import type { ViewSettings } from '../app/GlobalSettings'

interface Point { x: number; y: number }

const zoomPresets = [.25, .5, .75, 1, 1.25, 1.5, 2, 3]

interface Props {
  doc: MoteDocument
  editable: boolean
  minimap: boolean
  minimapSize: ViewSettings['minimapSize']
  zoomHost: HTMLDivElement | null
  onMainChange: (content: JSONContent) => void
  onNoteChange: (id: string, patch: FloatingPatch) => void
  onNoteRemove: (id: string) => void
  onActive: (editor: Editor | null) => void
  onSelect: (id: string | null) => void
  onMainReady: (editor: Editor) => void
}

export function DocumentCanvas({ doc, editable, minimap, minimapSize, zoomHost, onMainChange, onNoteChange, onNoteRemove, onActive, onSelect, onMainReady }: Props) {
  const canvasId = useId()
  const stage = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLDivElement>(null)
  const [mainEditor, setMainEditor] = useState<Editor | null>(null)
  const [anchors, setAnchors] = useState<Record<string, Point>>({})
  const { scale, minScale, zoomTo, zoomBy, reset } = useDocumentZoom(stage, sheet, doc.width, editable)
  const [minHeight, setMinHeight] = useState(900)
  const [selected, setSelected] = useState<string | null>(null)
  function select(id: string | null) { setSelected(id); onSelect(id) }

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
    main.current!.querySelectorAll('[data-id]').forEach(element => observer.observe(element))
    surface.querySelectorAll('.floating-note').forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [doc, editable, scale])

  return <div className={`canvas-pane ${minimap ? 'has-minimap' : ''}`}>
    <div className="stage" ref={stage} id={canvasId} aria-label="Document canvas" onPointerDown={event => {
      if (!(event.target as HTMLElement).closest('.floating-note')) select(null)
    }}>
      <div className={`sheet ${editable ? 'is-editing' : 'is-reading'} ${selected ? 'has-selected-note' : ''}`} ref={sheet}
        style={{ ...themeVariables(doc.theme), width: doc.width, zoom: scale, minHeight }}>
        <div className="main-text" ref={main}>
          <TextEditor content={doc.content} editable={editable} spatial label="Main text"
            onChange={onMainChange} onReady={editor => { setMainEditor(editor); onMainReady(editor) }}
            onActive={editor => { select(null); onActive(editor) }} />
        </div>
        {mainEditor && <SegmentBoundaries editor={mainEditor} sheet={sheet} editable={editable} scale={scale}
          onActive={() => { select(null); onActive(mainEditor) }} />}
        {doc.floating.map(note => anchors[note.anchorId] && <FloatingNote key={note.id}
          note={note} anchor={anchors[note.anchorId]} scale={scale} editable={editable}
          selected={selected === note.id}
          onChange={patch => onNoteChange(note.id, patch)} onRemove={() => onNoteRemove(note.id)}
          onActive={editor => { select(note.id); onActive(editor) }} />)}
      </div>
      <p className="page-footer">MOTE <span>·</span> A place for text and space</p>
    </div>
    {minimap && <Minimap stage={stage} sheet={sheet} canvasId={canvasId} sizing={minimapSize} />}
    {zoomHost && createPortal(<div className="zoom-controls" aria-label="Document zoom" onPointerDown={event => {
      if ((event.target as HTMLElement).closest('button')) event.preventDefault()
    }}>
      <button aria-label="Zoom out" disabled={scale <= minScale} onClick={() => zoomBy(1 / 1.1)}>−</button>
      <select aria-label="Document zoom level" value={String(scale)}
        onChange={event => event.target.value === 'fit' ? reset() : zoomTo(Number(event.target.value))}>
        {!zoomPresets.includes(scale) && <option value={String(scale)} hidden>{Math.round(scale * 100)}%</option>}
        {!editable && <option value="fit">Fit</option>}
        {zoomPresets.map(value => <option key={value} value={String(value)}>{value * 100}%</option>)}
      </select>
      <button aria-label="Zoom in" disabled={scale >= 3} onClick={() => zoomBy(1.1)}>+</button>
    </div>, zoomHost)}
  </div>
}

interface NoteProps {
  note: FloatingObject
  anchor: Point
  scale: number
  editable: boolean
  selected: boolean
  onChange: (patch: FloatingPatch) => void
  onRemove: () => void
  onActive: (editor: Editor | null) => void
}

function FloatingNote({ note, anchor, scale, editable, selected, onChange, onRemove, onActive }: NoteProps) {
  const editor = useRef<Editor | null>(null)
  const [preview, setPreview] = useState<FloatingPatch | null>(null)
  const pending = useRef<FloatingPatch | null>(null)
  const drag = useRef<{ client: Point; x: number; y: number; width: number; resize: boolean } | null>(null)
  const display = { ...note, ...preview }
  const kind = note.kind ?? 'text'
  const label = kind === 'text' ? 'text box' : kind

  function start(event: PointerEvent<HTMLElement>, resize: boolean) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { client: { x: event.clientX, y: event.clientY }, x: note.x, y: note.y, width: note.width, resize }
    onActive(editor.current)
  }

  function move(event: PointerEvent<HTMLElement>) {
    if (!drag.current) return
    const start = drag.current
    const dx = (event.clientX - start.client.x) / scale
    const dy = (event.clientY - start.client.y) / scale
    const sheetWidth = event.currentTarget.closest<HTMLElement>('.sheet')!.clientWidth
    pending.current = start.resize
      ? { width: Math.round(Math.max(120, Math.min(sheetWidth - anchor.x - note.x - 16, start.width + dx))) }
      : {
        x: Math.round(Math.max(16 - anchor.x, Math.min(sheetWidth - anchor.x - note.width - 16, start.x + dx))),
        y: Math.round(Math.max(16 - anchor.y, start.y + dy)),
      }
    setPreview(pending.current)
  }

  function finish() {
    if (pending.current) onChange(pending.current)
    drag.current = null
    pending.current = null
    setPreview(null)
  }

  function cancel() { drag.current = null; pending.current = null; setPreview(null) }

  useLayoutEffect(cancel, [editable, scale])

  function remove() {
    if (window.confirm(`Delete this floating ${label}?`)) onRemove()
  }

  return <div className={`floating-note floating-${kind} ${selected ? 'is-selected' : ''}`} data-note-id={note.id}
    style={{ left: anchor.x + display.x, top: anchor.y + display.y, width: display.width }}
    tabIndex={editable ? 0 : undefined} aria-label={`Floating ${label}`}
    onFocus={event => { if (editable && event.target === event.currentTarget) onActive(editor.current) }}
    onPointerDown={event => {
      if (!editable) return
      if (event.target === event.currentTarget) start(event, false)
      else if ((event.target as HTMLElement).tagName === 'IMG') {
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        onActive(null)
      }
    }}
    onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}
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
    {note.kind === 'image' ? <img src={note.src} alt={note.alt} draggable={false} />
      : <TextEditor content={note.content} editable={editable} table={note.kind === 'table'} label={`Floating ${kind}`}
        onChange={content => onChange({ content })} onActive={onActive} onReady={value => { editor.current = value }} />}
    {editable && <div className="floating-border-right" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={`Resize floating ${kind} width`} aria-valuemin={120} aria-valuenow={Math.round(display.width)}
      title="Drag the right border to resize; use left/right arrows when focused"
      onPointerDown={event => start(event, true)}
      onFocus={() => onActive(editor.current)}
      onKeyDown={event => {
        if (event.key === 'Escape') { cancel(); event.currentTarget.blur(); return }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        onChange({ width: Math.max(120, note.width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 8)) })
      }} />}
  </div>
}
