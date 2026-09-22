import { useEffect, useRef, type PointerEvent } from 'react'
import type { Editor } from '@tiptap/core'
import type { FloatingObject, FloatingPatch } from '../document/model'
import { TextEditor } from '../editor/TextEditor'
import { arrowPoints, type Geometry, type Point } from './floatingGeometry'
import { MathView } from './MathView'
import { HTMLWidgetView } from './HTMLWidgetView'
import { pixels } from '../theme/ThemePanel'
import { paletteCSS } from '../theme/palette'
import { ReviewControls, type AIReview } from '../ai/ReviewControls'
import type { AITask } from '../ai/types'

export type DragPart = 'move' | 'width' | 'nw' | 'ne' | 'sw' | 'se' | 'start' | 'end' | 'bend'
interface Props {
  note: FloatingObject; geometry: Geometry; editable: boolean; selected: boolean; contentActive: boolean; editingLabel: boolean; defaultColor: string; defaultFontSize: number
  onBegin: (part: DragPart, event: PointerEvent) => void
  onActive: (editor: Editor | null) => void
  onChange: (patch: FloatingPatch) => void
  onLabel: () => void
  onFinishLabel: () => void
  onKey: (event: React.KeyboardEvent) => void
  widgetRun: number; staticWidgets: boolean; order: number
  locked?: boolean; sizeLocked?: boolean; restoreWidgetRevision?: number
  aiTask?: AITask; aiReview?: AIReview
}

function arrow(tip: Point, from: Point, width: number) {
  return arrowPoints(tip, from, width).map(p => `${p.x},${p.y}`).join(' ')
}

export function FloatingObjectView({ note, geometry: box, editable, selected, contentActive, editingLabel, defaultColor, defaultFontSize, onBegin, onActive, onChange, onLabel, onFinishLabel, onKey, widgetRun, staticWidgets, order, locked = false, sizeLocked = locked, restoreWidgetRevision, aiTask, aiReview }: Props) {
  const editor = useRef<Editor | null>(null)
  const kind = note.kind ?? 'text'
  const geometric = kind === 'rectangle' || kind === 'ellipse' || kind === 'line'
  const textStyle = !note.kind || note.kind === 'text' ? { padding: pixels(note.padding ?? 0, defaultFontSize), backgroundColor: note.background ? paletteCSS(note.background) : 'transparent', borderColor: note.borderColor ? paletteCSS(note.borderColor) : 'transparent' } : {}
  useEffect(() => { if (editingLabel) editor.current?.commands.focus('end') }, [editingLabel])
  function begin(part: DragPart, event: PointerEvent) { if (editable && event.button === 0) onBegin(part, event) }
  const stroke = 'stroke' in note ? note.stroke ? paletteCSS(note.stroke) : defaultColor : defaultColor
  const path = box.path?.map(point => ({ x: point.x - box.x, y: point.y - box.y }))
  return <div className={`floating-note floating-${kind} ${selected ? 'is-selected' : ''} ${contentActive ? 'is-content-active' : ''} ${editable && locked ? `is-ai-reserved ai-reserved${aiTask?.preview && aiTask.candidate ? ' ai-candidate' : ''}` : ''}`}
    data-note-id={note.id} data-anchor-id={note.anchorId ?? ''} data-text-flow={note.textFlow}
    style={{ ...textStyle, '--ai-object-x': `${box.x}px`, zIndex: order + 1, left: box.x, top: box.y, width: kind === 'label' ? 'max-content' : Math.max(1, box.width), height: geometric || kind === 'html' ? Math.max(1, box.height) : undefined } as React.CSSProperties & { '--ai-object-x': string }}
    tabIndex={editable ? 0 : undefined} aria-label={`Floating ${kind === 'text' ? 'text box' : kind}`}
    onFocus={event => { if (editable && event.target === event.currentTarget) onActive(null) }}
    onKeyDown={event => { if (event.target === event.currentTarget || (event.target as HTMLElement).matches('[data-floating-control]')) onKey(event) }}
    onPointerDown={event => {
      if (!editable) return
      if (locked || event.target === event.currentTarget || kind === 'image' || kind === 'katex' || kind === 'html') begin('move', event)
    }}
    onDoubleClick={event => {
      if (!editable || locked) return
      if ('content' in note && event.target !== event.currentTarget) return
      event.preventDefault(); event.stopPropagation(); onLabel()
    }}>
    {note.kind === 'image' ? <img src={note.src} alt={note.alt} draggable={false} />
      : note.kind === 'katex' ? <MathView latex={note.latex} />
      : note.kind === 'html' ? <HTMLWidgetView key={locked ? note.html : undefined} note={note} editable={editable} selected={contentActive} run={widgetRun}
        staticOnly={staticWidgets || !!(aiTask?.target.kind === 'object' && aiTask.target.isNew && !(aiTask.preview && aiTask.candidate))} restoreRevision={restoreWidgetRevision} />
      : note.kind === 'rectangle' || note.kind === 'ellipse' ? <svg className="floating-vector" width="100%" height="100%" overflow="visible">
        {note.kind === 'rectangle' ? <rect className="vector-ink" x="0" y="0" width={box.width} height={box.height} rx={note.rounded ? Math.min(12, box.height / 4, box.width / 4) : 0}
          fill={note.fill ? paletteCSS(note.fill) : 'none'} stroke={stroke} strokeWidth={note.strokeWidth} strokeDasharray={note.dashed ? `${note.strokeWidth * 6} ${note.strokeWidth * 4}` : undefined} onPointerDown={event => begin('move', event)} />
          : <ellipse className="vector-ink" cx={box.width / 2} cy={box.height / 2} rx={box.width / 2} ry={box.height / 2} fill={note.fill ? paletteCSS(note.fill) : 'none'} stroke={stroke} strokeWidth={note.strokeWidth}
            strokeDasharray={note.dashed ? `${note.strokeWidth * 6} ${note.strokeWidth * 4}` : undefined} onPointerDown={event => begin('move', event)} />}
        {editable && (note.kind === 'rectangle' ? <rect className="vector-hit" x="0" y="0" width={box.width} height={box.height} rx={note.rounded ? Math.min(12, box.height / 4, box.width / 4) : 0} onPointerDown={event => begin('move', event)} />
          : <ellipse className="vector-hit" cx={box.width / 2} cy={box.height / 2} rx={box.width / 2} ry={box.height / 2} onPointerDown={event => begin('move', event)} />)}
      </svg>
      : note.kind === 'line' && path ? <svg className="floating-vector" width="100%" height="100%" overflow="visible">
        <polyline points={path.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke={stroke} strokeWidth={note.strokeWidth} strokeLinejoin="round"
          strokeDasharray={note.dashed ? `${note.strokeWidth * 6} ${note.strokeWidth * 4}` : undefined} />
        {note.arrowStart && <polygon className="vector-ink" points={arrow(path[0], path.find(p => p.x !== path[0].x || p.y !== path[0].y) ?? path.at(-1)!, note.strokeWidth)} fill={stroke} onPointerDown={event => begin('move', event)} />}
        {note.arrowEnd && <polygon className="vector-ink" points={arrow(path.at(-1)!, path.findLast(p => p.x !== path.at(-1)!.x || p.y !== path.at(-1)!.y) ?? path[0], note.strokeWidth)} fill={stroke} onPointerDown={event => begin('move', event)} />}
        {editable && <polyline className="vector-hit" points={path.map(p => `${p.x},${p.y}`).join(' ')} onPointerDown={event => begin('move', event)} />}
      </svg>
      : 'content' in note ? <TextEditor content={note.content} editable={editable && contentActive && !locked} table={kind === 'table'} singleLabel={kind === 'label'}
        label={`Floating ${kind}`} historyId={note.id} onChange={content => onChange({ content })} onActive={onActive}
        onFinish={onFinishLabel} onReady={value => { editor.current = value; if (editingLabel) value.commands.focus('end') }} /> : null}
    {editable && selected && aiTask && aiTask.target.kind !== 'segment' && aiReview && <ReviewControls task={aiTask} review={aiReview} />}
    {editable && !sizeLocked && !geometric && kind !== 'label' && <div className="floating-border-right" data-floating-control="width" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={`Resize floating ${kind} width`} aria-valuemin={kind === 'html' ? 16 : 120} aria-valuenow={Math.round(box.width)}
      onPointerDown={event => begin('width', event)} onFocus={() => onActive(editor.current)} />}
    {editable && !sizeLocked && selected && (note.kind === 'rectangle' || note.kind === 'ellipse' || note.kind === 'html') && (['nw', 'ne', 'sw', 'se'] as const).map(part => <button key={part}
      className={`object-handle handle-${part}`} data-floating-control={part} aria-label={`Resize ${kind} ${part}`} onPointerDown={event => begin(part, event)} />)}
    {editable && !sizeLocked && selected && note.kind === 'line' && path && <>
      {(['start', 'end'] as const).map((part, index) => <button key={part} className="object-handle" data-floating-control={part} aria-label={`Move line ${part}`}
        style={{ left: index ? path.at(-1)!.x : path[0].x, top: index ? path.at(-1)!.y : path[0].y }} onPointerDown={event => begin(part, event)} />)}
      {note.route === 'elbow' && <button className="object-handle bend-handle" data-floating-control="bend" aria-label="Move line bend"
        style={{ left: path[1].x, top: (path[1].y + path[2].y) / 2 }} onPointerDown={event => begin('bend', event)} />}
    </>}
  </div>
}
