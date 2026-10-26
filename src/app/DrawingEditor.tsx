import { objectX, objectY } from '../document/model'
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { FloatingDrawing, FloatingPatch, Theme } from '../document/model'
import { useHistory } from '../document/history'
import { drawingPoint, drawingStrokeHit, type DrawingPoint } from '../document/drawing'
import { DrawingView } from '../canvas/DrawingView'
import { paletteCSS, paletteEntries } from '../theme/palette'
import { PaletteControl } from '../theme/PaletteControl'
import { PanelIcon } from './PanelIcon'
import './drawing.css'

interface Props {
  drawing: FloatingDrawing
  theme: Theme
  // Horizontal region for x (text column for Flow, page for Float); whether y is a signed offset from a Flow owner.
  maxWidth: number
  signedY: boolean
  onChange: (patch: FloatingPatch) => void
  onClose: () => void
}

type Side = 'top' | 'right' | 'bottom' | 'left'
type Crop = Record<Side, number>
const sides = ['top', 'right', 'bottom', 'left'] as const
const sideKeys: Record<Side, [string, string]> = { top: ['ArrowUp', 'ArrowDown'], right: ['ArrowRight', 'ArrowLeft'], bottom: ['ArrowDown', 'ArrowUp'], left: ['ArrowLeft', 'ArrowRight'] }

// Positive amounts extend a side, negative amounts cut it; content keeps its document-pixel size.
function cropped(drawing: FloatingDrawing, crop: Crop): FloatingDrawing {
  return { ...drawing, layout: { ...drawing.layout, width: drawing.layout.width + crop.left + crop.right, height: drawing.layout.height + crop.top + crop.bottom },
    strokes: drawing.strokes.map(stroke => ({ ...stroke, points: stroke.points.map(([x, y]) => [x + crop.left, y + crop.top]) })),
    labels: drawing.labels.map(label => ({ ...label, x: label.x + crop.left, y: label.y + crop.top })) }
}

type Tool = 'pen' | 'eraser' | 'label'
type Stroke = FloatingDrawing['strokes'][number]
type Label = FloatingDrawing['labels'][number]
type Gesture = { pointer: number; tool: 'pen' | 'eraser'; last: DrawingPoint; stroke: Stroke; pointBudget: number; erased: Set<number>; base: FloatingDrawing }
const widths = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]
const limits = { strokes: 10000, points: 100000, labels: 1000, text: 4096 }
const strokeLimitMessage = 'Stroke limit reached (10,000). Erase strokes to continue.'
const pointLimitMessage = 'Point limit reached (100,000). Erase strokes to continue.'
const labelLimitMessage = 'Label limit reached (1,000). Edit or delete an existing label.'

function ToolIcon({ tool }: { tool: Tool }) {
  if (tool === 'pen') return <PanelIcon name="edit" />
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={tool === 'eraser' ? 'm4 13 9-9a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-9 9H7l-3-3a3 3 0 0 1 0-4Zm4-4 9 9M11 20h10' : 'M5 5h14M12 5v15M8 20h8M5 5v3m14-3v3'} />
  </svg>
}

export function DrawingEditor({ drawing, theme, maxWidth, signedY, onChange, onClose }: Props) {
  const history = useHistory()
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const labelInput = useRef<HTMLTextAreaElement>(null)
  const popoverBox = useRef<HTMLDivElement>(null)
  const popoverTrigger = useRef<HTMLButtonElement | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(theme.defaults.color)
  const [widthIndex, setWidthIndex] = useState(1)
  const [areaSize, setAreaSize] = useState({ width: 0, height: 0 })
  const [preview, setPreview] = useState<FloatingDrawing | null>(null)
  const [labelDraft, setLabelDraft] = useState<{ index: number | null; label: Label } | null>(null)
  const [popover, setPopover] = useState<'color' | 'more' | null>(null)
  const [morePage, setMorePage] = useState<'options' | 'clear' | 'help'>('options')
  const [limitMessage, setLimitMessage] = useState('')
  const [crop, setCrop] = useState<{ pointer: number; side: Side; start: number; scale: number; crop: Crop } | null>(null)
  const fit = (target: FloatingDrawing) => Math.min(areaSize.width / target.layout.width, areaSize.height / target.layout.height)
  const shown = crop ? cropped(drawing, crop.crop) : preview ?? drawing
  // Keep the zoom steady while cropping; shrink only when extended bounds no longer fit.
  const scale = crop ? Math.min(crop.scale, fit(shown)) : fit(drawing)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    history.boundary()
    if (!dialog.current!.open) dialog.current!.showModal()
    const observer = new ResizeObserver(([entry]) => {
      cancelGesture()
      setAreaSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(area.current!)
    window.addEventListener('resize', cancelGesture)
    window.addEventListener('blur', cancelGesture)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', cancelGesture)
      window.removeEventListener('blur', cancelGesture)
      history.boundary(); previous?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => { cancelGesture() }, [drawing.layout.width, drawing.layout.height])
  useEffect(() => { cancelGesture(); setLabelDraft(null) }, [history.revision])
  useEffect(() => { if (labelDraft) { labelInput.current?.focus(); labelInput.current?.select() } }, [labelDraft])
  useEffect(() => {
    if (popover) popoverBox.current?.querySelector<HTMLElement>('input:checked, button, input')?.focus()
  }, [popover, morePage])

  function commit(patch: FloatingPatch) {
    const message = patch.strokes && patch.strokes.length > limits.strokes ? strokeLimitMessage
      : patch.strokes && patch.strokes.reduce((count, stroke) => count + stroke.points.length, 0) > limits.points ? pointLimitMessage
        : patch.labels && patch.labels.length > limits.labels ? labelLimitMessage
          : patch.labels?.some(label => label.text.length > limits.text) ? 'Labels can contain up to 4,096 characters. Shorten this label to save it.' : ''
    if (message) { setLimitMessage(message); return false }
    history.boundary()
    onChange(patch)
    history.boundary()
    return true
  }

  function cancelGesture() {
    const active = gesture.current
    gesture.current = null
    if (active && canvas.current?.hasPointerCapture(active.pointer)) canvas.current.releasePointerCapture(active.pointer)
    setPreview(null)
    setCrop(null)
  }

  function bounded(side: Side, amount: number): Crop {
    const crop = { top: 0, right: 0, bottom: 0, left: 0, [side]: amount }
    const horizontal = side === 'left' || side === 'right'
    const size = horizontal ? drawing.layout.width : drawing.layout.height
    crop[side] = Math.round(Math.max(16 - size, Math.min((horizontal ? maxWidth : 4000) - size, amount)))
    return crop
  }

  function commitCrop(crop: Crop) {
    if (!crop.top && !crop.right && !crop.bottom && !crop.left) return
    const next = cropped(drawing, crop)
    // Keep the remaining content in place on the page.
    const x = Math.max(0, Math.min(maxWidth - next.layout.width, objectX(drawing) - crop.left))
    const position = drawing.layout.placement.type === 'flow' ? (drawing.layout.placement.x === 'center') ? {} : { x }
      : { x, y: signedY ? objectY(drawing) - crop.top : Math.max(0, objectY(drawing) - crop.top) }
    commit({ width: next.layout.width, height: next.layout.height, strokes: next.strokes, labels: next.labels, ...position })
  }

  function startCrop(side: Side, event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary || gesture.current || crop) return
    event.preventDefault(); event.stopPropagation()
    closePopover()
    if (!commitLabel()) return
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    setCrop({ pointer: event.pointerId, side, start: side === 'left' || side === 'right' ? event.clientX : event.clientY, scale, crop: bounded(side, 0) })
  }

  function moveCrop(event: PointerEvent<HTMLButtonElement>) {
    if (crop?.pointer !== event.pointerId) return
    const delta = ((crop.side === 'left' || crop.side === 'right' ? event.clientX : event.clientY) - crop.start) / crop.scale
    setCrop({ ...crop, crop: bounded(crop.side, crop.side === 'left' || crop.side === 'top' ? -delta : delta) })
  }

  function endCrop(event: PointerEvent<HTMLButtonElement>) {
    if (crop?.pointer !== event.pointerId) return
    setCrop(null)
    commitCrop(crop.crop)
  }

  function cropKey(side: Side, event: KeyboardEvent<HTMLButtonElement>) {
    const direction = sideKeys[side].indexOf(event.key)
    if (direction < 0) return
    event.preventDefault()
    commitCrop(bounded(side, (direction ? -1 : 1) * (event.shiftKey ? 1 : 8)))
  }

  function closePopover(restore = false) {
    setPopover(null)
    if (restore) popoverTrigger.current?.focus()
  }

  function togglePopover(next: 'color' | 'more', button: HTMLButtonElement) {
    popoverTrigger.current = button
    setMorePage('options')
    setPopover(popover === next ? null : next)
  }

  function commitLabel() {
    if (!labelDraft) return true
    const text = labelInput.current!.value
    if (text.trim()) {
      const label = { ...labelDraft.label, text }
      const labels = labelDraft.index === null ? [...drawing.labels, label]
        : drawing.labels.map((existing, index) => index === labelDraft.index ? label : existing)
      if ((labelDraft.index === null || text !== drawing.labels[labelDraft.index].text) && !commit({ labels })) {
        labelInput.current!.focus()
        return false
      }
    } else if (labelDraft.index !== null) commit({ labels: drawing.labels.filter((_, index) => index !== labelDraft.index) })
    setLimitMessage('')
    setLabelDraft(null)
    canvas.current?.focus({ preventScroll: true })
    return true
  }

  function editLabel(index: number | null, label: Label) {
    if (index === null && drawing.labels.length >= limits.labels) { setLimitMessage(labelLimitMessage); return }
    setLimitMessage('')
    setLabelDraft({ index, label })
  }

  function close(saveLabel: boolean) {
    cancelGesture()
    if (saveLabel && !commitLabel()) return
    onClose()
  }

  function travel(redo: boolean) {
    cancelGesture()
    setLabelDraft(null)
    if (redo) history.redo(); else history.undo()
  }

  function position(event: { clientX: number; clientY: number }): DrawingPoint {
    return drawingPoint(event.clientX, event.clientY, canvas.current!.getBoundingClientRect(), drawing.layout.width, drawing.layout.height)
  }

  function showGesture() {
    const active = gesture.current!
    setPreview({ ...active.base, strokes: active.tool === 'pen'
      ? [...active.base.strokes, { ...active.stroke, points: [...active.stroke.points] }]
      : active.base.strokes.filter((_, index) => !active.erased.has(index)) })
  }

  function sample(point: DrawingPoint) {
    const active = gesture.current!
    if (active.tool === 'pen') {
      if (Math.hypot(point[0] - active.last[0], point[1] - active.last[1]) < .25) return true
      if (active.stroke.points.length >= active.pointBudget) {
        setLimitMessage('This stroke stops at the 100,000-point limit. Erase strokes to continue.')
        return false
      }
      active.stroke.points.push(point)
    } else {
      const radius = 8 * drawing.layout.width / canvas.current!.getBoundingClientRect().width
      active.base.strokes.forEach((stroke, index) => {
        if (!active.erased.has(index) && drawingStrokeHit(stroke.points, active.last, point, radius + stroke.width / 2)) active.erased.add(index)
      })
    }
    active.last = point
    return true
  }

  function startPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return
    event.preventDefault()
    closePopover()
    canvas.current!.focus({ preventScroll: true })
    if (labelDraft) { commitLabel(); return }
    setLimitMessage('')
    const point = position(event)
    if (tool === 'label') {
      // SVG text bounds include the actual font metrics, including non-Latin labels.
      const texts = canvas.current!.querySelectorAll('svg text')
      const index = drawing.labels.findLastIndex((_, index) => {
        const bounds = texts[index].getBoundingClientRect()
        return event.clientX >= bounds.left - 6 && event.clientX <= bounds.right + 6 && event.clientY >= bounds.top - 6 && event.clientY <= bounds.bottom + 6
      })
      editLabel(index < 0 ? null : index, index < 0
        ? { x: point[0], y: point[1], text: '', color, size: 20 }
        : drawing.labels[index])
      return
    }
    const pointBudget = limits.points - drawing.strokes.reduce((count, stroke) => count + stroke.points.length, 0)
    if (tool === 'pen' && drawing.strokes.length >= limits.strokes) { setLimitMessage(strokeLimitMessage); return }
    if (tool === 'pen' && pointBudget <= 0) { setLimitMessage(pointLimitMessage); return }
    gesture.current = { pointer: event.pointerId, tool, last: point, stroke: { points: [point], color, width: widths[widthIndex] }, pointBudget, erased: new Set(), base: drawing }
    canvas.current!.setPointerCapture(event.pointerId)
    if (tool === 'eraser') sample(point)
    showGesture()
  }

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointer !== event.pointerId) return
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? []
    for (const sampleEvent of samples.length ? samples : [event]) if (!sample(position(sampleEvent))) break
    showGesture()
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current
    if (!active || active.pointer !== event.pointerId) return
    sample(position(event))
    const strokes = active.tool === 'pen' ? [...active.base.strokes, active.stroke] : active.base.strokes.filter((_, index) => !active.erased.has(index))
    cancelGesture()
    if (active.tool === 'pen' || active.erased.size) commit({ strokes })
  }

  function keydown(event: KeyboardEvent<HTMLDialogElement>) {
    // The parent window-capture shortcut must skip events inside this dialog.
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const target = event.target as HTMLElement
    const typing = target.matches('input:not([type=range]):not([type=radio]), textarea, [contenteditable=true]')
    const key = event.key.toLowerCase()
    if (key === 'escape') {
      event.preventDefault()
      if (popover) closePopover(true)
      else close(false)
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
      if (!typing) { event.preventDefault(); travel(key === 'y' || event.shiftKey) }
    } else if (typing && key === 'enter' && !event.shiftKey && labelDraft) {
      event.preventDefault(); commitLabel()
    } else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && !popover) {
      const next = ({ p: 'pen', e: 'eraser', l: 'label' } as const)[key as 'p' | 'e' | 'l']
      if (next) { event.preventDefault(); cancelGesture(); setTool(next) }
      else if (key === 'enter' && target === canvas.current && tool === 'label') {
        event.preventDefault(); editLabel(null, { x: drawing.layout.width / 2, y: drawing.layout.height / 2, text: '', color, size: 20 })
      }
    }
  }

  const palette = Object.fromEntries(paletteEntries(theme).flatMap(entry => [[`--palette-${entry.id}`, entry.strong], [`--palette-${entry.id}-soft`, entry.soft ?? entry.strong]])) as CSSProperties
  return <dialog ref={dialog} className="drawing-editor" aria-labelledby={`${id}-title`} style={palette}
    onKeyDown={keydown} onCancel={event => { event.preventDefault(); event.stopPropagation(); close(false) }}
    onPointerDownCapture={event => {
      if (popover && !popoverBox.current?.contains(event.target as Node) && !popoverTrigger.current?.contains(event.target as Node)) closePopover()
    }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <header className="drawing-editor-heading">
      <h1 id={`${id}-title`}>Drawing</h1>
      <span>{Math.round(shown.layout.width)} × {Math.round(shown.layout.height)}</span>
      <button className="drawing-done" title="Done (Escape)" onClick={() => close(true)}>Done</button>
    </header>
    <div ref={area} className="drawing-editor-area">
      <div className={`drawing-editor-frame${crop ? ' is-cropping' : ''}`} style={{ width: shown.layout.width * scale, height: shown.layout.height * scale,
        // The area centers the frame; offset it so the edge opposite the dragged side stays put.
        translate: crop ? `${(crop.crop.right - crop.crop.left) * scale / 2}px ${(crop.crop.bottom - crop.crop.top) * scale / 2}px` : undefined }}>
        <div ref={canvas} className={`drawing-editor-canvas is-${tool}`} tabIndex={0} role="group" aria-label="Drawing canvas"
          aria-describedby={`${id}-hint`}
          onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer}
          onPointerCancel={event => { if (gesture.current?.pointer === event.pointerId) cancelGesture() }}
          onLostPointerCapture={event => { if (gesture.current?.pointer === event.pointerId) cancelGesture() }}>
          <DrawingView drawing={shown} />
        </div>
        {sides.map(side => <button key={side} className="drawing-crop-handle" data-side={side} data-active={crop?.side === side || undefined}
          aria-label={`Crop or extend ${side} edge`} title={`Drag to crop or extend the ${side} edge`}
          onPointerDown={event => startCrop(side, event)} onPointerMove={moveCrop} onPointerUp={endCrop}
          onPointerCancel={event => { if (crop?.pointer === event.pointerId) cancelGesture() }}
          onLostPointerCapture={event => { if (crop?.pointer === event.pointerId) setCrop(null) }}
          onKeyDown={event => cropKey(side, event)} />)}
      </div>
      {labelDraft && <div className="drawing-label-editor" role="group" aria-label={labelDraft.index === null ? 'New label' : 'Edit label'}
        style={{ left: `clamp(8px, ${(areaSize.width - drawing.layout.width * scale) / 2 + labelDraft.label.x * scale}px, calc(100% - 292px))`, top: `clamp(8px, ${(areaSize.height - drawing.layout.height * scale) / 2 + labelDraft.label.y * scale}px, calc(100% - 164px))` }}>
        <textarea ref={labelInput} aria-label="Label text" aria-describedby={`${id}-label-hint ${id}-hint`} defaultValue={labelDraft.label.text} maxLength={limits.text} rows={3} placeholder="Type a label…"
          onInput={event => setLimitMessage(event.currentTarget.value.length >= limits.text ? 'Label limit reached (4,096 characters). Shorten the text to add more.' : '')} />
        <p id={`${id}-label-hint`}>Enter to save · Shift+Enter for a new line</p>
        <div>
          {labelDraft.index !== null && <button className="drawing-danger" onClick={() => { commit({ labels: drawing.labels.filter((_, index) => index !== labelDraft.index) }); setLabelDraft(null); canvas.current?.focus() }}>Delete</button>}
          <button onClick={() => { setLabelDraft(null); canvas.current?.focus() }}>Cancel</button>
          <button onClick={commitLabel}>Save label</button>
        </div>
      </div>}
    </div>
    <footer className="drawing-editor-footer">
      <p id={`${id}-hint`} className="drawing-editor-hint" role="status">{limitMessage || (crop ? 'Drag outward to extend or inward to crop. Content keeps its size.' : tool === 'pen' ? 'Draw with a mouse or pen.' : tool === 'eraser' ? 'Drag across a stroke to erase it.' : 'Click to add or edit a label. Enter adds a centered label.')}</p>
      <div className="drawing-tools" role="group" aria-label="Drawing tools">
        {(['pen', 'eraser', 'label'] as const).map(value => <button key={value} className="drawing-tool" aria-label={value === 'pen' ? 'Pen' : value === 'eraser' ? 'Eraser' : 'Label'}
          title={`${value === 'pen' ? 'Pen (P)' : value === 'eraser' ? 'Eraser (E)' : 'Label (L)'}`} aria-pressed={tool === value}
          onClick={() => { if (commitLabel()) { setTool(value); closePopover() } }}><ToolIcon tool={value} /></button>)}
        <span className="drawing-tool-divider" />
        <button className="drawing-tool drawing-color-button" aria-label="Drawing color" title="Color for new strokes and labels" aria-expanded={popover === 'color'} aria-controls={`${id}-popover`}
          onClick={event => togglePopover('color', event.currentTarget)}><span style={{ background: paletteCSS(color) }} /></button>
        <label className="drawing-width"><span>Width <output>{widths[widthIndex]} px</output></span>
          <input type="range" min="0" max={widths.length - 1} step="1" value={widthIndex} aria-label="Pen width" aria-valuetext={`${widths[widthIndex]} document pixels`}
            title="Width for new strokes" onChange={event => setWidthIndex(Number(event.target.value))} />
        </label>
        <span className="drawing-tool-divider" />
        <button className="drawing-tool" aria-label="Undo drawing change" title="Undo (Ctrl/⌘ Z)" disabled={!history.canUndo} onClick={() => travel(false)}><PanelIcon name="undo" /></button>
        <button className="drawing-tool" aria-label="Redo drawing change" title="Redo (Ctrl/⌘ Shift Z)" disabled={!history.canRedo} onClick={() => travel(true)}><PanelIcon name="redo" /></button>
        <button className="drawing-tool" aria-label="More drawing options" title="More options" aria-expanded={popover === 'more'} aria-controls={`${id}-popover`}
          onClick={event => togglePopover('more', event.currentTarget)}><PanelIcon name="more" /></button>
        {popover && <div ref={popoverBox} id={`${id}-popover`} className={`drawing-popover is-${popover}`} role="dialog" aria-label={popover === 'color' ? 'Drawing color' : 'Drawing options'}
          onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !popoverTrigger.current?.contains(event.relatedTarget)) closePopover() }}>
          {popover === 'color' ? <><strong>Color</strong><PaletteControl theme={theme} value={color} label="Drawing color" onChange={value => { setColor(value!); closePopover(true) }} /><p>Applies to new strokes and labels.</p></>
            : morePage === 'clear' ? <><strong>Clear this drawing?</strong><p>All strokes and labels will be removed. You can undo this.</p><div className="drawing-popover-actions"><button onClick={() => setMorePage('options')}>Cancel</button><button className="drawing-danger" onClick={() => { setLabelDraft(null); if (drawing.strokes.length || drawing.labels.length) commit({ strokes: [], labels: [] }); closePopover(true) }}>Clear drawing</button></div></>
              : morePage === 'help' ? <><strong>Keyboard shortcuts</strong><dl><dt>P / E / L</dt><dd>Pen / Eraser / Label</dd><dt>Ctrl/⌘ Z</dt><dd>Undo</dd><dt>Ctrl/⌘ Shift Z / Ctrl Y</dt><dd>Redo</dd><dt>Enter on canvas</dt><dd>Add a label with Label selected</dd><dt>Escape</dt><dd>Dismiss options or close; cancel unfinished input</dd></dl><button onClick={() => setMorePage('options')}>Back</button></>
                : <><strong id={`${id}-background`}>Background</strong>
                  <div className="drawing-background" role="radiogroup" aria-labelledby={`${id}-background`}>
                    {([null, 'gray6'] as const).map(value => <label key={value ?? 'transparent'}>
                      <input type="radio" name={`${id}-background`} checked={drawing.background === value} onChange={() => commit({ background: value })} />
                      <span><i aria-hidden="true" data-solid={value ? '' : undefined} />{value ? 'Solid' : 'Transparent'}</span>
                    </label>)}
                  </div>
                  <button onClick={() => setMorePage('help')}>Keyboard shortcuts</button><button className="drawing-danger" disabled={!drawing.strokes.length && !drawing.labels.length} onClick={() => setMorePage('clear')}>Clear drawing…</button></>}
        </div>}
      </div>
    </footer>
  </dialog>
}
