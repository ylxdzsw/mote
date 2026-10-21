import { useRef, type PointerEvent } from 'react'
import type { Editor } from '@tiptap/core'
import { isText, type FloatingObject, type FloatingPatch } from '../document/model'
import { TextEditor } from '../editor/TextEditor'
import type { Geometry } from './floatingGeometry'
import { MathView } from './MathView'
import { HTMLWidgetView } from './HTMLWidgetView'
import { CodeView } from './CodeView'
import { DrawingView } from './DrawingView'
import { pixels } from '../theme/ThemePanel'
import { paletteCSS } from '../theme/palette'
import { ReviewControls, type AIReview } from '../ai/ReviewControls'
import type { AITask } from '../ai/types'

export type DragPart = 'move' | 'width' | 'nw' | 'ne' | 'sw' | 'se'
interface Props {
  note: FloatingObject; geometry: Geometry; editable: boolean; selected: boolean; contentActive: boolean; defaultFontSize: number
  onBegin: (part: DragPart, event: PointerEvent) => void
  onActive: (editor: Editor | null) => void
  onChange: (patch: FloatingPatch) => void
  onCaption: () => void
  onDrawingEdit?: () => void
  onKey: (event: React.KeyboardEvent) => void
  widgetRun: number; staticWidgets: boolean; order: number
  locked?: boolean; sizeLocked?: boolean; restoreWidgetRevision?: number
  aiTask?: AITask; aiReview?: AIReview
}

export function FloatingObjectView({ note, geometry: box, editable, selected, contentActive, defaultFontSize, onBegin, onActive, onChange, onCaption, onDrawingEdit, onKey, widgetRun, staticWidgets, order, locked = false, sizeLocked = locked, restoreWidgetRevision, aiTask, aiReview }: Props) {
  const editor = useRef<Editor | null>(null)
  const kind = note.kind ?? 'text'
  const textStyle = !note.kind || note.kind === 'text' ? { padding: pixels(note.padding ?? 0, defaultFontSize), backgroundColor: note.background ? paletteCSS(note.background) : 'transparent', borderColor: note.borderColor ? paletteCSS(note.borderColor) : 'transparent' } : {}
  function begin(part: DragPart, event: PointerEvent) { if (editable && event.button === 0) onBegin(part, event) }
  const caption = isText(note) && !!note.attachment
  return <div className={`floating-note floating-${kind} ${caption ? 'is-caption' : ''} ${selected ? 'is-selected' : ''} ${contentActive ? 'is-content-active' : ''} ${editable && locked ? `is-ai-reserved ai-reserved${aiTask?.preview && aiTask.candidate ? ' ai-candidate' : ''}` : ''}`}
    data-note-id={note.id} data-anchor-id={note.anchorId ?? ''} data-text-flow={note.textFlow}
    style={{ ...textStyle, '--ai-object-x': `${box.x}px`, zIndex: order + 1, left: box.x, top: box.y, width: Math.max(1, box.width), height: kind === 'html' || kind === 'drawing' ? Math.max(1, box.height) : undefined } as React.CSSProperties & { '--ai-object-x': string }}
    tabIndex={editable ? 0 : undefined} aria-label={caption ? 'Attached caption' : `Floating ${kind === 'text' ? 'text box' : kind}`}
    onFocus={event => { if (editable && event.target === event.currentTarget) onActive(null) }}
    onKeyDown={event => { if (event.target === event.currentTarget || (event.target as HTMLElement).matches('[data-floating-control]')) onKey(event) }}
    onPointerDown={event => {
      if (!editable) return
      if (locked || event.target === event.currentTarget || kind === 'image' || kind === 'katex' || kind === 'html') begin('move', event)
    }}
    onDoubleClick={event => {
      if (!editable || locked) return
      if (kind === 'drawing') { event.preventDefault(); event.stopPropagation(); onDrawingEdit?.(); return }
      if (kind === 'code') return
      if ('content' in note && event.target !== event.currentTarget) return
      event.preventDefault(); event.stopPropagation(); onCaption()
    }}>
    {note.kind === 'drawing' ? <DrawingView drawing={note} />
      : note.kind === 'image' ? <img src={note.src} alt={note.alt} draggable={false} />
      : note.kind === 'katex' ? <MathView latex={note.latex} />
      : note.kind === 'code' ? <CodeView note={note} editable={editable && contentActive && !locked} staticOnly={staticWidgets}
        onActive={() => onActive(null)} onBegin={event => begin('move', event)}
        onChange={source => onChange({ source })} />
      : note.kind === 'html' ? <HTMLWidgetView key={locked ? note.html : undefined} note={note} editable={editable} selected={contentActive} run={widgetRun}
        staticOnly={staticWidgets || !!(aiTask?.target.kind === 'object' && aiTask.target.isNew && !(aiTask.preview && aiTask.candidate))} restoreRevision={restoreWidgetRevision} />
      : 'content' in note ? <TextEditor content={note.content} editable={editable && contentActive && !locked} table={kind === 'table'}
        label={`Floating ${kind}`} historyId={note.id} onChange={content => onChange({ content })} onActive={onActive}
        onReady={value => { editor.current = value }} /> : null}
    {editable && selected && aiTask && aiTask.target.kind !== 'segment' && aiReview && <ReviewControls task={aiTask} review={aiReview} />}
    {editable && selected && !locked && note.kind === 'drawing' && onDrawingEdit && <button className="drawing-edit-button" aria-label="Edit drawing" title="Edit drawing"
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDrawingEdit() }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z" /></svg>
    </button>}
    {editable && !sizeLocked && !caption && <div className="floating-border-right" data-floating-control="width" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={`Resize floating ${kind} width`} aria-valuemin={kind === 'html' ? 16 : 120} aria-valuenow={Math.round(box.width)}
      onPointerDown={event => begin('width', event)} onFocus={() => onActive(editor.current)} />}
    {editable && !sizeLocked && selected && (note.kind === 'html' || note.kind === 'drawing') && (['nw', 'ne', 'sw', 'se'] as const).map(part => <button key={part}
      className={`object-handle handle-${part}`} data-floating-control={part} aria-label={`Resize ${kind} ${part}`} onPointerDown={event => begin(part, event)} />)}
  </div>
}
