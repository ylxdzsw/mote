import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isText, type FloatingObject, type FloatingText, type FloatingKaTeX, type FloatingHTMLWidget, type FloatingPatch, type CaptionPosition, type Theme, type ThemeLength } from '../document/model'
import { WidgetEditor } from './WidgetEditor'
import { NumberField, pixels, classLabel } from '../theme/ThemePanel'
import { PaletteControl } from '../theme/PaletteControl'
import { ContextHeading, InspectorField, InspectorGroup, InspectorHelp, InspectorRow, TypographyPreview } from './Inspector'
import { PanelIcon } from './PanelIcon'
import { codeLanguages } from '../document/code'

interface Props {
  object: FloatingObject
  count: number
  theme: Theme
  defaultFontSize: number
  onChange: (patch: FloatingPatch) => void
  onAction: (action: 'remove' | 'duplicate' | 'detach') => void
  onCaption: (position?: CaptionPosition) => void
  onAttach: (targetId: string, position: CaptionPosition) => void
  caption?: FloatingText
  attachmentTargets: FloatingObject[]
  onFront: () => void
  onBack: () => void
  onHistoryBegin: (name: string) => void
  onHistoryEnd: () => void
  imageLoading: boolean
  maxWidth: number
  textStyle?: string
  tableControls: ReactNode
  onTheme: (className: string) => void
  onWidgetRun: (id: string) => void
  onReplaceScreenshot: (object: FloatingHTMLWidget) => void
  onReplaceImage: () => void
  onDrawingEdit: () => void
  onRevise?: () => void
  reviseDisabled?: boolean
}

const kindName = (object: FloatingObject) => object.kind === 'drawing' ? 'Drawing' : object.kind === 'code' ? 'Code' : object.kind === 'image' ? 'Image' : object.kind === 'table' ? 'Table' : object.kind === 'katex' ? 'KaTeX' : object.kind === 'html' ? 'HTML widget' : 'Text box'

export function FloatingInspector({ object, count, theme, defaultFontSize, onChange, onAction, onFront, onBack, onHistoryBegin, onHistoryEnd, imageLoading, maxWidth, caption, attachmentTargets, onCaption, onAttach, textStyle, tableControls, onTheme, onWidgetRun, onReplaceScreenshot, onReplaceImage, onDrawingEdit, onRevise, reviseDisabled }: Props) {
  const attached = isText(object) ? object.attachment : null
  const katex = object.kind === 'katex' ? object as FloatingKaTeX : null
  const widget = object.kind === 'html' ? object as FloatingHTMLWidget : null
  const text = isText(object)
  const hasFlow = text || ['image', 'table', 'katex', 'html', 'code', 'drawing'].includes(object.kind!)
  const name = kindName(object)
  return <div className="context-inspector floating-inspector">
    <ContextHeading title={count > 1 ? `${count} objects` : name} subtitle={count > 1 ? 'Multiple selection' : attached ? 'Attached caption' : text ? 'Native rich text' : undefined} />
    {count === 1 && <>
      {object.kind === 'drawing' && <InspectorGroup title="Content">
        <button onClick={onDrawingEdit}>Edit drawing…</button>
        <p className="hint">Sketch freely, then ask Assistant to turn it into a figure.</p>
      </InspectorGroup>}
      {object.kind === 'code' && <InspectorGroup title="Content">
        <label className="inspector-field">Language<select aria-label="Code language" value={object.language} onChange={event => onChange({ language: event.target.value })}>
          {!codeLanguages.some(language => language.value === object.language) && <option value={object.language}>{object.language || 'Plain text'}</option>}
          {codeLanguages.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
        </select></label>
        <label className="inspector-field">Color scheme<select aria-label="Code color scheme" value={object.scheme} onChange={event => onChange({ scheme: event.target.value as 'light' | 'dark' })}>
          <option value="light">Light</option><option value="dark">Dark</option>
        </select></label>
        <button onClick={() => onTheme('code')}>Code style…</button>
      </InspectorGroup>}
      {widget && <HTMLWidgetControls value={widget} onChange={onChange} imageLoading={imageLoading} onReplaceScreenshot={onReplaceScreenshot}
        onRun={() => onWidgetRun(widget.id)} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
      {object.kind === 'image' && <InspectorGroup title="Content">
        <label className="inspector-field">Description
          <input type="text" value={object.alt} onFocus={() => onHistoryBegin(`description:${object.id}`)} onBlur={onHistoryEnd}
            onChange={event => onChange({ alt: event.target.value })} />
        </label>
        <button disabled={imageLoading} onClick={onReplaceImage}>{imageLoading ? 'Opening image…' : 'Replace image…'}</button>
      </InspectorGroup>}
      {object.kind === 'table' && tableControls}
      {text && <InspectorGroup title="Appearance">
        {(['background', 'borderColor'] as const).map(property => {
          const name = property === 'background' ? 'Background color' : 'Border color'
          return <InspectorField label={name} key={property}><PaletteControl theme={theme} label={name} value={object[property] ?? null} optional="none"
            onFocus={() => onHistoryBegin(`floating-${property}`)} onBlur={onHistoryEnd} onChange={value => onChange({ [property]: value })} /></InspectorField>
        })}
        <TextPadding value={object.padding ?? 0} base={defaultFontSize} onChange={padding => onChange({ padding })} />
      </InspectorGroup>}
      {text && <AttachmentControls object={object} targets={attachmentTargets} onAttach={onAttach} onDetach={() => onAction('detach')} onChange={onChange} />}
      {!attached && <InspectorGroup title="Caption">
        {caption ? <button onClick={() => onCaption()}>Edit caption</button> : <InspectorRow>
          <button onClick={() => onCaption('above')}>Add caption above</button>
          <button onClick={() => onCaption('below')}>Add caption below</button>
        </InspectorRow>}
      </InspectorGroup>}
      {katex && <KaTeXControls value={katex} onChange={onChange} onTheme={onTheme} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
      {hasFlow && <InspectorGroup title="Layout">
        {object.kind === 'drawing' && <InspectorRow>
          <InspectorField label="Width"><NumberField label="Drawing width" value={object.width} min={16} max={maxWidth} onChange={width => onChange({ width })} /></InspectorField>
          <InspectorField label="Height"><NumberField label="Drawing height" value={object.height} min={16} max={4000} onChange={height => onChange({ height })} /></InspectorField>
        </InspectorRow>}
        {object.kind === 'code' && <InspectorField label="Width"><NumberField label="Code width" value={object.width} min={120} max={Math.max(120, maxWidth)} onChange={width => onChange({ width })} /></InspectorField>}
        {widget && <InspectorRow>
          <InspectorField label="Width"><NumberField label="Widget width" value={widget.width} min={16} max={maxWidth} onChange={width => onChange({ width })} /></InspectorField>
          <InspectorField label="Height"><NumberField label="Widget height" value={widget.height} min={16} max={4000} onChange={height => onChange({ height })} /></InspectorField>
        </InspectorRow>}
        <label className="inspector-field">Main text flow<select value={object.textFlow ?? 'overlap'} onChange={event => onChange({ textFlow: event.target.value as 'overlap' | 'repel' })}><option value="overlap">Overlap</option><option value="repel">Repel</option></select></label>
      </InspectorGroup>}
      {!widget && !katex && object.kind !== 'code' && <InspectorGroup title={text || object.kind === 'table' ? 'Typography' : 'Colors'}>
        {(text || object.kind === 'table') && <>
          <TypographyPreview theme={theme} semantic={object.kind === 'table' ? 'table' : textStyle ?? (attached ? 'caption' : 'body')} />
          <button onClick={() => onTheme(object.kind === 'table' ? 'table' : textStyle ?? (attached ? 'caption' : 'body'))}>
            {object.kind === 'table' ? 'Table style' : textStyle ? `${classLabel(textStyle)} style` : attached ? 'Caption style' : 'Text styles'} <PanelIcon name="sliders" />
          </button>
        </>}
        <button className="quiet-action" onClick={() => onTheme('palette')}>Document palette <PanelIcon name="arrow" /></button>
      </InspectorGroup>}
      {onRevise && <InspectorGroup title="Assistant">
        <button onClick={onRevise} disabled={reviseDisabled}>Revise with AI <PanelIcon name="spark" /></button>
      </InspectorGroup>}
    </>}
    <InspectorGroup title="Object" divided={count === 1}>
      <InspectorRow><button onClick={onFront}>Bring to front</button><button onClick={onBack}>Send to back</button></InspectorRow>
      <InspectorRow><button onClick={() => onAction('duplicate')}>Duplicate <PanelIcon name="copy" /></button></InspectorRow>
      <button className="delete-action" onClick={() => onAction('remove')}>{count > 1 ? `Delete ${count} objects` : 'Delete'} <PanelIcon name="close" /></button>
    </InspectorGroup>
    <InspectorHelp key={count > 1 ? 'group' : object.kind ?? 'text'}>
      <FloatingHelp object={object} count={count} />
      <p>With the object focused, Ctrl/⌘C copies, X cuts, and V pastes. Attached captions travel with their targets. While editing text, these shortcuts act on text instead.</p>
      <p>Delete/Backspace removes a focused object. Undo restores it.</p>
    </InspectorHelp>
  </div>
}

function TextPadding({ value, base, onChange }: { value: ThemeLength; base: number; onChange: (value: ThemeLength) => void }) {
  const unit = typeof value === 'string' && value.endsWith('em') ? 'em' : 'px'
  return <InspectorField label="Padding">
    <NumberField label="Padding" value={typeof value === 'number' ? value : parseFloat(value)} min={0} max={2000 / (unit === 'em' ? base : 1)}
      step={unit === 'em' ? .025 : 1} unit={unit} units={['em', 'px']}
      onChange={next => onChange(`${next}${unit}`)}
      onUnitChange={nextUnit => onChange(`${Number((pixels(value, base) / (nextUnit === 'em' ? base : 1)).toFixed(6))}${nextUnit as 'em' | 'px'}`)} />
    <p className="hint">All sides. em follows the default font size.</p>
  </InspectorField>
}

function KaTeXControls({ value, onChange, onTheme, onHistoryBegin, onHistoryEnd }: { value: FloatingKaTeX; onChange: (patch: FloatingPatch) => void; onTheme: (className: string) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  return <InspectorGroup title="Formula">
    <div className="inspector-field">
      <label className="inspector-field">LaTeX
        <textarea className="embed-source" rows={5} spellCheck={false} value={value.latex}
          onFocus={() => onHistoryBegin(`katex-source:${value.id}`)} onBlur={onHistoryEnd}
          onChange={event => onChange({ latex: event.target.value })} />
      </label>
      <p className="hint">Enter LaTeX without delimiters.</p>
    </div>
    <button onClick={() => onTheme('math')}>Math style…</button>
  </InspectorGroup>
}

function HTMLWidgetControls({ value, onChange, imageLoading, onReplaceScreenshot, onRun, onHistoryBegin, onHistoryEnd }: {
  value: FloatingHTMLWidget; onChange: (patch: FloatingPatch) => void; imageLoading: boolean
  onReplaceScreenshot: (object: FloatingHTMLWidget) => void; onRun: () => void
  onHistoryBegin: (name: string) => void; onHistoryEnd: () => void
}) {
  const [editorId, setEditorId] = useState<string | null>(null)
  useEffect(() => { if (editorId !== value.id) setEditorId(null) }, [editorId, value.id])
  const editorOpen = editorId === value.id

  return <>
    <InspectorGroup title="Content">
      <InspectorRow><button onClick={() => setEditorId(value.id)}>Edit code…</button><button onClick={onRun}>Run / Restart</button></InspectorRow>
    </InspectorGroup>
    <InspectorGroup title="Screenshot">
      <div className="inspector-field">
        <div className="widget-preview"><img src={value.screenshot} alt={value.alt} /></div>
        <button disabled={imageLoading} onClick={() => onReplaceScreenshot(value)}>{imageLoading ? 'Opening screenshot…' : 'Replace screenshot…'}</button>
      </div>
      <div className="inspector-field">
        <label className="inspector-field">Description
          <input type="text" value={value.alt} onFocus={() => onHistoryBegin(`html-widget-alt:${value.id}`)} onBlur={onHistoryEnd}
            onChange={event => onChange({ alt: event.target.value })} />
        </label>
        <p className="hint">Used in the minimap and PNG export. Update manually when the widget changes.</p>
      </div>
    </InspectorGroup>
    {editorOpen && createPortal(<WidgetEditor widget={value} onChange={html => onChange({ html })} onRun={onRun}
      onClose={() => setEditorId(null)} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />, document.querySelector('.app')!)}
  </>
}

function AttachmentControls({ object, targets, onAttach, onDetach, onChange }: {
  object: FloatingText; targets: FloatingObject[]; onAttach: Props['onAttach']; onDetach: () => void; onChange: Props['onChange']
}) {
  const [targetId, setTargetId] = useState('')
  const targetName = (target: FloatingObject, index: number) => {
    const text = 'alt' in target ? target.alt : 'content' in target ? target.content.content?.flatMap(node => node.content?.map(child => child.text ?? '') ?? []).join('') : ''
    return `${kindName(target)} ${index + 1}${text ? ` — ${text.slice(0, 48)}` : ''}`
  }
  return <InspectorGroup title="Attachment">
    {object.attachment ? <>
      <label className="inspector-field">Position<select aria-label="Caption position" value={object.attachment.position}
        onChange={event => onChange({ attachment: { ...object.attachment!, position: event.target.value as CaptionPosition } })}>
        <option value="above">Above</option><option value="below">Below</option>
      </select></label>
      <button onClick={onDetach}>Detach caption</button>
      <p className="hint">Position and width follow the object. Detach to move or resize independently.</p>
    </> : <>
      <label className="inspector-field">Attach to object<select aria-label="Caption target" value={targetId} onChange={event => setTargetId(event.target.value)}>
        <option value="">Choose an object</option>
        {targets.map((target, index) => <option key={target.id} value={target.id}>{targetName(target, index)}</option>)}
      </select></label>
      <InspectorRow><button disabled={!targets.some(target => target.id === targetId)} onClick={() => onAttach(targetId, 'above')}>Attach above</button>
        <button disabled={!targets.some(target => target.id === targetId)} onClick={() => onAttach(targetId, 'below')}>Attach below</button></InspectorRow>
    </>}
  </InspectorGroup>
}

function FloatingHelp({ object, count }: { object: FloatingObject; count: number }) {
  if (count > 1) return <p>Drag any selected object to move the group. Select one object alone to edit its contents. Shift-click adds or removes objects from the selection.</p>
  if (isText(object) && object.attachment) return <p>Select the caption, then click its text to edit. Its width and position follow its object; use Attachment to switch above/below or detach.</p>
  switch (object.kind) {
    case 'drawing': return <><p>Click the centered pen, double-click, or press Enter to open the full-screen drawing editor. Done or Escape returns to the document. Each stroke can be undone.</p><p>Drag to move; use the right border to resize proportionally or corners to change the bounds. Pen widths stay in document pixels. Revise with AI can turn the sketch into a figure.</p></>
    case 'code': return <><p>Select the object, then click its source to edit. Enter / Shift+Enter inserts a line break; Tab / Shift+Tab indents or outdents. Paste keeps plain text and line breaks, not formatting.</p><p>Drag the language header to move it. The right border changes its width; height follows all source lines. Long lines scroll horizontally, with a scrollbar only when needed. Copy excludes the header and line numbers. Escape returns focus to the object.</p><p>Code style controls typography. The selected light or dark syntax scheme supplies its own colors independently of the document palette.</p></>
    case 'html': return <><p>Select the widget to interact with it. Click elsewhere to deselect, then drag its interior to move it. The top, left, and bottom borders move it; the right border or corner handles resize it.</p><p>Changes to code save immediately. Run / Restart executes the saved source in a fresh widget. CDN resources may not work offline. The screenshot is a manual preview, not a live capture.</p></>
    case 'image': return <><p>Drag the image or its top, left, or bottom border to move it. The right border resizes with proportions intact. Double-click to select or create a caption.</p><p>Paste an external image, then click to place or drag to size. Enter places at the insertion point; Escape cancels. Up to 10 MB per image; images synchronize with the document.</p></>
    case 'table': return <><p>Select the table, then click a cell to edit. Enter / Shift+Enter adds a newline; Tab / Shift+Tab moves between cells. All cells use Table style, with bold, palette colors, and decorations.</p><p>Internal dividers resize adjacent columns without changing table width. The right border resizes the whole table; the other borders move it. Click elsewhere to deselect and drag from any cell to move.</p></>
    case 'katex': return <p>Drag the formula or its top, left, or bottom border to move it. The right border changes its width; height follows its content. Long formulas do not wrap automatically. Math style applies to every formula.</p>
    default: return <><p>Select the box, then click or drag inside to edit text. Click elsewhere to deselect and drag its interior to move. The top, left, and bottom borders always move it; the right border resizes.</p><p>Paragraph styles are document-wide. Tab turns Body paragraphs into list items; Shift+Tab outdents.</p></>
  }
}
