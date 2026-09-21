import { useEffect, useState } from 'react'
import type { FloatingObject, FloatingShape, FloatingLine, FloatingLabel, FloatingKaTeX, FloatingHTMLWidget, FloatingPatch, LabelPosition, Theme, ThemeLength } from '../document/model'
import type { CanvasActions } from '../canvas/DocumentCanvas'
import { WidgetEditor } from './WidgetEditor'
import { NumberField, pixels } from '../theme/ThemePanel'
import { PaletteControl } from '../theme/PaletteControl'
import { neutralIds, softReference } from '../theme/palette'

interface Props {
  object: FloatingObject
  count: number
  theme: Theme
  defaultFontSize: number
  onChange: (patch: FloatingPatch) => void
  onAction: (action: Exclude<keyof CanvasActions, 'insert' | 'without'>) => void
  onFront: () => void
  onBack: () => void
  onHistoryBegin: (name: string) => void
  onHistoryEnd: () => void
  imageLoading: boolean
  maxWidth: number
  targetKind?: FloatingObject['kind']
  onTheme: (className: string) => void
  onWidgetRun: (id: string) => void
  onReplaceScreenshot: (object: FloatingHTMLWidget) => void
}

const kindName = (object: FloatingObject) => object.kind === 'rectangle' ? 'Rectangle' : object.kind === 'ellipse' ? 'Ellipse' : object.kind === 'line' ? 'Line' : object.kind === 'label' ? 'Label' : object.kind === 'image' ? 'Image' : object.kind === 'table' ? 'Table' : object.kind === 'katex' ? 'KaTeX' : object.kind === 'html' ? 'HTML widget' : 'Text'

export function FloatingInspector({ object, count, theme, defaultFontSize, onChange, onAction, onFront, onBack, onHistoryBegin, onHistoryEnd, imageLoading, maxWidth, targetKind, onTheme, onWidgetRun, onReplaceScreenshot }: Props) {
  const shape = object.kind === 'rectangle' || object.kind === 'ellipse' ? object as FloatingShape : null
  const line = object.kind === 'line' ? object as FloatingLine : null
  const label = object.kind === 'label' ? object as FloatingLabel : null
  const katex = object.kind === 'katex' ? object as FloatingKaTeX : null
  const widget = object.kind === 'html' ? object as FloatingHTMLWidget : null
  return <>
    <section className="panel-section floating-inspector">
      <h2>{count > 1 ? `${count} objects` : kindName(object)}</h2>
      <p className="hint">Unselected objects and selected groups move when dragged. Select one object alone to edit its text or interact with its contents; click elsewhere on the page to deselect. Images, shapes, and formulas remain draggable when selected.</p>
      <p className="hint">With the object focused: Ctrl/⌘C copies, X cuts, and V pastes. Attached labels travel with their targets. While editing text, these shortcuts act on text instead.</p>
      {count > 1 ? <div className="object-actions"><button onClick={() => onAction('remove')}>Delete</button><button onClick={() => onAction('duplicate')}>Duplicate</button><button onClick={onFront}>Bring front</button><button onClick={onBack}>Send back</button></div> : <>
        {(!object.kind || ['text', 'image', 'table', 'katex', 'html'].includes(object.kind)) && <label>Main text flow<select value={object.textFlow ?? 'overlap'} onChange={event => onChange({ textFlow: event.target.value as 'overlap' | 'repel' })}><option value="overlap">Overlap</option><option value="repel">Repel</option></select></label>}
        {object.kind === 'image' && <p className="hint">Drag the image interior to move it; drag the right edge to resize.</p>}
        {(!object.kind || object.kind === 'text') && <TextPadding value={object.padding ?? 0} base={defaultFontSize} onChange={padding => onChange({ padding })} />}
        {(!object.kind || object.kind === 'text') && (['background', 'borderColor'] as const).map(property => {
          const name = property === 'background' ? 'Background color' : 'Border color'
          return <div className="palette-field" key={property}><div className="field-heading">{name}</div><PaletteControl theme={theme} label={name} value={object[property] ?? null} optional="none"
            onFocus={() => onHistoryBegin(`floating-${property}`)} onBlur={onHistoryEnd} onChange={value => onChange({ [property]: value })} /></div>
        })}
        {shape && <ShapeControls shape={shape} theme={theme} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
        {line && <LineControls line={line} theme={theme} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
        {label && <LabelControls label={label} targetKind={targetKind} onAction={onAction} onChange={onChange} />}
        {katex && <KaTeXControls value={katex} onChange={onChange} onTheme={onTheme} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
        {widget && <HTMLWidgetControls value={widget} onChange={onChange} imageLoading={imageLoading} maxWidth={maxWidth} onReplaceScreenshot={onReplaceScreenshot}
          onRun={() => onWidgetRun(widget.id)} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
        <div className="object-actions"><button onClick={() => onAction('remove')}>Delete</button><button onClick={() => onAction('duplicate')}>Duplicate</button>{object.kind !== 'label' && <button onClick={() => onAction('label')}>Add label</button>}<button onClick={onFront}>Bring front</button><button onClick={onBack}>Send back</button></div>
      </>}
    </section>
  </>
}

function TextPadding({ value, base, onChange }: { value: ThemeLength; base: number; onChange: (value: ThemeLength) => void }) {
  const unit = typeof value === 'string' && value.endsWith('em') ? 'em' : 'px'
  return <div className="style-field">
    <div className="field-heading">Padding</div>
    <NumberField label="Padding" value={typeof value === 'number' ? value : parseFloat(value)} min={0} max={2000 / (unit === 'em' ? base : 1)}
      step={unit === 'em' ? .025 : 1} unit={unit} units={['em', 'px']}
      onChange={next => onChange(`${next}${unit}`)}
      onUnitChange={nextUnit => onChange(`${Number((pixels(value, base) / (nextUnit === 'em' ? base : 1)).toFixed(6))}${nextUnit as 'em' | 'px'}`)} />
    <p className="hint">All sides. em follows the global default font size.</p>
  </div>
}

function KaTeXControls({ value, onChange, onTheme, onHistoryBegin, onHistoryEnd }: { value: FloatingKaTeX; onChange: (patch: FloatingPatch) => void; onTheme: (className: string) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  return <>
    <label>LaTeX
      <textarea className="embed-source" rows={5} spellCheck={false} value={value.latex}
        onFocus={() => onHistoryBegin(`katex-source:${value.id}`)} onBlur={onHistoryEnd}
        onChange={event => onChange({ latex: event.target.value })} />
    </label>
    <p className="hint">Enter LaTeX without delimiters.</p>
    <div className="style-actions embed-style-action"><button onClick={() => onTheme('math')}>Math style…</button></div>
  </>
}

function HTMLWidgetControls({ value, onChange, imageLoading, maxWidth, onReplaceScreenshot, onRun, onHistoryBegin, onHistoryEnd }: {
  value: FloatingHTMLWidget; onChange: (patch: FloatingPatch) => void; imageLoading: boolean; maxWidth: number
  onReplaceScreenshot: (object: FloatingHTMLWidget) => void; onRun: () => void
  onHistoryBegin: (name: string) => void; onHistoryEnd: () => void
}) {
  const [editorId, setEditorId] = useState<string | null>(null)
  useEffect(() => { if (editorId !== value.id) setEditorId(null) }, [editorId, value.id])
  const editorOpen = editorId === value.id

  return <>
    <div className="widget-preview"><img src={value.screenshot} alt={value.alt} /></div>
    <label>Image description
      <input type="text" value={value.alt} onFocus={() => onHistoryBegin(`html-widget-alt:${value.id}`)} onBlur={onHistoryEnd}
        onChange={event => onChange({ alt: event.target.value })} />
    </label>
    <button disabled={imageLoading} onClick={() => onReplaceScreenshot(value)}>{imageLoading ? 'Opening screenshot…' : 'Replace screenshot'}</button>
    <div className="embed-dimensions">
      <div><div className="field-heading">Width</div><NumberField label="Widget width" value={value.width} min={16} max={maxWidth} onChange={width => onChange({ width })} /></div>
      <div><div className="field-heading">Height</div><NumberField label="Widget height" value={value.height} min={16} max={4000} onChange={height => onChange({ height })} /></div>
    </div>
    <div className="object-actions widget-actions">
      <button onClick={() => setEditorId(value.id)}>Edit code…</button>
      <button onClick={onRun}>Run / Restart</button>
    </div>
    <p className="hint">CDN references are used as-is; online resources may not work offline. The screenshot is a manual preview and is not checked against the widget.</p>
    {editorOpen && <WidgetEditor widget={value} onChange={html => onChange({ html })} onRun={onRun}
      onClose={() => setEditorId(null)} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
  </>
}

function StrokeControls({ value, theme, onChange, onHistoryBegin, onHistoryEnd }: { value: { stroke: string | null; strokeWidth: number; dashed: boolean }; theme: Theme; onChange: (patch: FloatingPatch) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  return <>
    <div className="palette-field"><div className="field-heading">Stroke color</div><PaletteControl theme={theme} label="Stroke color" value={value.stroke} optional="default" fallback={theme.defaults.color}
      onFocus={() => onHistoryBegin('floating-stroke')} onBlur={onHistoryEnd} onChange={stroke => onChange({ stroke })} /></div>
    <label>Stroke width <output>{value.strokeWidth}px</output><input aria-label="Stroke width" type="range" min=".5" max="16" step=".5" value={value.strokeWidth} onPointerDown={() => onHistoryBegin('floating-stroke-width')} onPointerUp={onHistoryEnd} onKeyDown={() => onHistoryBegin('floating-stroke-width')} onKeyUp={onHistoryEnd} onBlur={onHistoryEnd} onChange={event => onChange({ strokeWidth: Number(event.target.value) })} /></label>
    <label>Stroke style<select value={value.dashed ? 'dashed' : 'solid'} onChange={event => onChange({ dashed: event.target.value === 'dashed' })}><option value="solid">Solid</option><option value="dashed">Dashed</option></select></label>
  </>
}

function ShapeControls({ shape, theme, onChange, onHistoryBegin, onHistoryEnd }: { shape: FloatingShape; theme: Theme; onChange: (patch: FloatingPatch) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  const strokeReference = shape.stroke ?? theme.defaults.color
  const strokeId = strokeReference.split(':')[0]
  const chromatic = !neutralIds.includes(strokeId as typeof neutralIds[number])
  return <>
    <div className="palette-field"><div className="field-heading">Fill</div><PaletteControl theme={theme} label="Fill color" value={shape.fill} optional="none"
      onFocus={() => onHistoryBegin('floating-fill')} onBlur={onHistoryEnd} onChange={fill => onChange({ fill })} /></div>
    {chromatic && <button className="matching-soft-action" onClick={() => { onHistoryEnd(); onChange({ fill: softReference(theme, strokeReference) }) }}>Use matching soft fill</button>}
    <StrokeControls value={shape} theme={theme} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />
    {shape.kind === 'rectangle' && <label className="check-label"><input type="checkbox" checked={shape.rounded} onChange={event => onChange({ rounded: event.target.checked })} /> Rounded corners</label>}
  </>
}

function LineControls({ line, theme, onChange, onHistoryBegin, onHistoryEnd }: { line: FloatingLine; theme: Theme; onChange: (patch: FloatingPatch) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  return <><StrokeControls value={line} theme={theme} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} /><label>Route<select value={line.route} onChange={event => onChange({ route: event.target.value as 'straight' | 'elbow' })}><option value="straight">Straight</option><option value="elbow">Elbow</option></select></label><label className="check-label"><input type="checkbox" checked={line.arrowStart} onChange={event => onChange({ arrowStart: event.target.checked })} /> Arrow at start</label><label className="check-label"><input type="checkbox" checked={line.arrowEnd} onChange={event => onChange({ arrowEnd: event.target.checked })} /> Arrow at end</label></>
}

function LabelControls({ label, targetKind, onAction, onChange }: { label: FloatingLabel; targetKind?: FloatingObject['kind']; onAction: (action: Exclude<keyof CanvasActions, 'insert' | 'without'>) => void; onChange: (patch: FloatingPatch) => void }) {
  const positions: LabelPosition[] = targetKind !== 'line' ? ['center', 'top-inside', 'top-outside', 'bottom-inside', 'bottom-outside'] : ['center', 'left', 'right', 'above', 'below']
  return <>{label.attachment ? <><label>Position<select value={label.attachment.position} onChange={event => onChange({ attachment: { ...label.attachment!, position: event.target.value as LabelPosition } })}>{positions.map(position => <option key={position} value={position}>{position.replaceAll('-', ' ')}</option>)}</select></label><button onClick={() => onAction('detach')}>Detach label</button></> : <p className="hint">Free label. Drag near an object to connect it. Alt bypasses snapping.</p>}<p className="hint">Double-click to edit. Enter finishes; Shift+Enter inserts a line break.</p></>
}
