import type { FloatingObject, FloatingShape, FloatingLine, FloatingLabel, FloatingPatch, LabelPosition } from '../document/model'
import type { CanvasActions } from '../canvas/DocumentCanvas'

interface Props {
  object: FloatingObject
  count: number
  themeColor: string
  onChange: (patch: FloatingPatch) => void
  onAction: (action: keyof CanvasActions) => void
  onFront: () => void
  onBack: () => void
  onHistoryBegin: (name: string) => void
  onHistoryEnd: () => void
  targetKind?: FloatingObject['kind']
}

const kindName = (object: FloatingObject) => object.kind === 'rectangle' ? 'Rectangle' : object.kind === 'ellipse' ? 'Ellipse' : object.kind === 'line' ? 'Line' : object.kind === 'label' ? 'Label' : object.kind === 'image' ? 'Image' : object.kind === 'table' ? 'Table' : 'Text'
const colorValue = (value: string | null, fallback: string) => value ?? fallback

export function FloatingInspector({ object, count, themeColor, onChange, onAction, onFront, onBack, onHistoryBegin, onHistoryEnd, targetKind }: Props) {
  const shape = object.kind === 'rectangle' || object.kind === 'ellipse' ? object as FloatingShape : null
  const line = object.kind === 'line' ? object as FloatingLine : null
  const label = object.kind === 'label' ? object as FloatingLabel : null
  return <>
    <section className="panel-section floating-inspector">
      <h2>{count > 1 ? `${count} objects` : kindName(object)}</h2>
      {count > 1 ? <div className="object-actions"><button onClick={() => onAction('remove')}>Delete</button><button onClick={() => onAction('duplicate')}>Duplicate</button><button onClick={onFront}>Bring front</button><button onClick={onBack}>Send back</button></div> : <>
        {(!object.kind || ['text', 'image', 'table'].includes(object.kind)) && <label>Main text flow<select value={object.textFlow ?? 'overlap'} onChange={event => onChange({ textFlow: event.target.value as 'overlap' | 'repel' })}><option value="overlap">Overlap</option><option value="repel">Repel</option></select></label>}
        {object.kind === 'image' && <p className="hint">Drag the image interior to move it; drag the right edge to resize.</p>}
        {shape && <ShapeControls shape={shape} themeColor={themeColor} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
        {line && <LineControls line={line} themeColor={themeColor} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
        {label && <LabelControls label={label} targetKind={targetKind} onAction={onAction} onChange={onChange} />}
        <div className="object-actions"><button onClick={() => onAction('remove')}>Delete</button><button onClick={() => onAction('duplicate')}>Duplicate</button>{object.kind !== 'label' && <button onClick={() => onAction('label')}>Add label</button>}<button onClick={onFront}>Bring front</button><button onClick={onBack}>Send back</button></div>
      </>}
    </section>
  </>
}

function StrokeControls({ value, themeColor, onChange, onHistoryBegin, onHistoryEnd }: { value: { stroke: string | null; strokeWidth: number; dashed: boolean }; themeColor: string; onChange: (patch: FloatingPatch) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  return <>
    <label>Stroke color<div className="color-control"><input aria-label="Stroke color" type="color" value={colorValue(value.stroke, themeColor)} onFocus={() => onHistoryBegin('floating-stroke')} onBlur={onHistoryEnd} onChange={event => onChange({ stroke: event.target.value })} /><span>{value.stroke === null ? 'Default' : value.stroke}</span><button disabled={value.stroke === null} onClick={() => { onHistoryEnd(); onChange({ stroke: null }) }}>Default</button></div></label>
    <label>Stroke width <output>{value.strokeWidth}px</output><input aria-label="Stroke width" type="range" min=".5" max="16" step=".5" value={value.strokeWidth} onPointerDown={() => onHistoryBegin('floating-stroke-width')} onPointerUp={onHistoryEnd} onKeyDown={() => onHistoryBegin('floating-stroke-width')} onKeyUp={onHistoryEnd} onBlur={onHistoryEnd} onChange={event => onChange({ strokeWidth: Number(event.target.value) })} /></label>
    <label>Stroke style<select value={value.dashed ? 'dashed' : 'solid'} onChange={event => onChange({ dashed: event.target.value === 'dashed' })}><option value="solid">Solid</option><option value="dashed">Dashed</option></select></label>
  </>
}
function ShapeControls({ shape, themeColor, onChange, onHistoryBegin, onHistoryEnd }: { shape: FloatingShape; themeColor: string; onChange: (patch: FloatingPatch) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  return <><label>Fill<div className="color-control"><input aria-label="Fill color" type="color" value={shape.fill ?? '#ffffff'} onFocus={() => onHistoryBegin('floating-fill')} onBlur={onHistoryEnd} onChange={event => onChange({ fill: event.target.value })} /><span>{shape.fill ?? 'None'}</span><button disabled={shape.fill === null} onClick={() => { onHistoryEnd(); onChange({ fill: null }) }}>None</button></div></label><StrokeControls value={shape} themeColor={themeColor} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />{shape.kind === 'rectangle' && <label className="check-label"><input type="checkbox" checked={shape.rounded} onChange={event => onChange({ rounded: event.target.checked })} /> Rounded corners</label>}</>
}
function LineControls({ line, themeColor, onChange, onHistoryBegin, onHistoryEnd }: { line: FloatingLine; themeColor: string; onChange: (patch: FloatingPatch) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  return <><StrokeControls value={line} themeColor={themeColor} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} /><label>Route<select value={line.route} onChange={event => onChange({ route: event.target.value as 'straight' | 'elbow' })}><option value="straight">Straight</option><option value="elbow">Elbow</option></select></label><label className="check-label"><input type="checkbox" checked={line.arrowStart} onChange={event => onChange({ arrowStart: event.target.checked })} /> Arrow at start</label><label className="check-label"><input type="checkbox" checked={line.arrowEnd} onChange={event => onChange({ arrowEnd: event.target.checked })} /> Arrow at end</label></>
}
function LabelControls({ label, targetKind, onAction, onChange }: { label: FloatingLabel; targetKind?: FloatingObject['kind']; onAction: (action: keyof CanvasActions) => void; onChange: (patch: FloatingPatch) => void }) {
  const positions: LabelPosition[] = targetKind !== 'line' ? ['center', 'top-inside', 'top-outside', 'bottom-inside', 'bottom-outside'] : ['center', 'left', 'right', 'above', 'below']
  return <>{label.attachment ? <><label>Position<select value={label.attachment.position} onChange={event => onChange({ attachment: { ...label.attachment!, position: event.target.value as LabelPosition } })}>{positions.map(position => <option key={position} value={position}>{position.replaceAll('-', ' ')}</option>)}</select></label><button onClick={() => onAction('detach')}>Detach label</button></> : <p className="hint">Free label. Drag near an object to connect it. Alt bypasses snapping.</p>}<p className="hint">Double-click to edit. Enter finishes; Shift+Enter inserts a line break.</p></>
}
