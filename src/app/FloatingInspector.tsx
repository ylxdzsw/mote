import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isText, supportsCaption, tableStyles, type FloatingObject, type FloatingKaTeX, type FloatingHTMLWidget, type FloatingPatch, type Theme, type ThemeLength } from '../document/model'
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

  onPlacement: (placement: 'flow' | 'float') => void
  onAction: (action: 'remove' | 'duplicate') => void
  onCaption: () => void
  captionSelected?: boolean
  onCaptionWidth: (width: number | null) => void
  captionMaxWidth: number
  onSelectOwner: () => void
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

export function FloatingInspector({ object, count, theme, defaultFontSize, onChange, onPlacement, onAction, onFront, onBack, onHistoryBegin, onHistoryEnd, imageLoading, maxWidth, onCaption, captionSelected, onCaptionWidth, captionMaxWidth, onSelectOwner, textStyle, tableControls, onTheme, onWidgetRun, onReplaceScreenshot, onReplaceImage, onDrawingEdit, onRevise, reviseDisabled }: Props) {
  const katex = object.kind === 'katex' ? object as FloatingKaTeX : null
  const widget = object.kind === 'html' ? object as FloatingHTMLWidget : null
  const text = isText(object)
  const placementId = useId()
  const decorationId = useId()
  const tableStyleId = useId()
  const name = kindName(object)
  if (captionSelected && supportsCaption(object) && object.caption) {
    const ownerSelectionLabel = object.kind === 'image' ? 'Select image' : object.kind === 'table' ? 'Select table' : 'Select widget'
    return <div className="context-inspector floating-inspector">
      <ContextHeading title="Caption" subtitle={`Owned by ${name}`} />
      <InspectorGroup title="Content">
        <InspectorRow><button onClick={onCaption}>Edit caption</button><button onClick={onSelectOwner}>{ownerSelectionLabel}</button></InspectorRow>
        <InspectorField label="Width">
          <NumberField label="Caption width" value={object.caption.width ?? object.width} min={16} max={captionMaxWidth} onChange={onCaptionWidth} />
          <p className="hint">Follows the owner unless overridden; wider captions stay centered within the page.</p>
          <button onClick={() => onCaptionWidth(null)}>Match object width</button>
        </InspectorField>
        <button className="delete-action" onClick={() => onChange({ caption: null })}>Remove caption</button>
      </InspectorGroup>
      <InspectorGroup title="Typography">
        <TypographyPreview theme={theme} semantic="caption" />
        <button onClick={() => onTheme('caption')}>Caption style… <PanelIcon name="sliders" /></button>
        <button className="quiet-action" onClick={() => onTheme('palette')}>Document palette <PanelIcon name="arrow" /></button>
      </InspectorGroup>
      <InspectorHelp>
        <p>Click once to select the caption, then click inside it to edit. Drag the caption box or its borders to move its owner; the right border resizes the caption while keeping it centered.</p>
        <p>Delete removes the caption. Captions cannot be detached from their owners.</p>
      </InspectorHelp>
    </div>
  }
  return <div className="context-inspector floating-inspector">
    <ContextHeading title={count > 1 ? `${count} objects` : name} subtitle={count > 1 ? 'Multiple selection' : object.placement === 'flow' ? 'Flow object' : 'Float object'} />
    {count === 1 && <>
      <InspectorGroup title="Placement">
        <div className="placement-options" role="radiogroup" aria-label="Object placement" aria-describedby={`${placementId}-hint`}>
          {(['flow', 'float'] as const).map(placement => <label key={placement}>
            <input type="radio" name={placementId} value={placement} checked={object.placement === placement}
              onChange={() => onPlacement(placement)} />
            <span>{placement === 'flow' ? 'Flow' : 'Float'}</span>
          </label>)}
        </div>
        <p className="hint" id={`${placementId}-hint`}>{object.placement === 'flow'
          ? 'In the document flow, between text blocks.'
          : 'Position freely; main text stays to its left.'}</p>
      </InspectorGroup>
      {object.kind === 'drawing' && <InspectorGroup title="Content">
        <button onClick={onDrawingEdit}>Edit drawing…</button>
        <p className="hint">Sketch freely, then ask Assistant to turn it into a figure.</p>
      </InspectorGroup>}
      {object.kind === 'code' && <InspectorGroup title="Content">
        <label className="inspector-field">Language<select aria-label="Code language" value={object.language} onChange={event => onChange({ language: event.target.value })}>
          {!codeLanguages.some(language => language.value === object.language) && <option value={object.language}>{object.language || 'Plain text'}</option>}
          {codeLanguages.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
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
      {object.kind === 'table' && <InspectorGroup title="Appearance">
        <InspectorField label="Style">
          <div className="placement-options decoration-options" role="radiogroup" aria-label="Table style">
            {tableStyles.map(style => <label key={style}>
              <input type="radio" name={tableStyleId} value={style} checked={(object.style ?? 'simple') === style} onChange={() => onChange({ style })} />
              <span>{classLabel(style)}</span>
            </label>)}
          </div>
        </InspectorField>
        <label className="inspector-check">
          <input type="checkbox" checked={!!object.headerRow} onChange={event => onChange({ headerRow: event.target.checked })} />
          <span>Header row</span>
        </label>
      </InspectorGroup>}
      {text && <InspectorGroup title="Appearance">
        <InspectorField label="Border">
          <div className="placement-options decoration-options" role="radiogroup" aria-label="Text box border">
            {(['none', 'left', 'box'] as const).map(kind => <label key={kind}>
              <input type="radio" name={decorationId} value={kind} checked={(object.decoration?.kind ?? 'none') === kind}
                onChange={() => onChange({ decoration: kind === 'none' ? null : { kind, color: object.decoration?.color ?? 'secondary' } })} />
              <span>{kind !== 'none' && <i aria-hidden="true" data-kind={kind} />}{{ none: 'None', left: 'Left', box: 'All sides' }[kind]}</span>
            </label>)}
          </div>
        </InspectorField>
        {object.decoration && <InspectorField label="Color">
          <PaletteControl theme={theme} label="Text box color" value={object.decoration.color} pairs
            onFocus={() => onHistoryBegin('floating-decoration-color')} onBlur={onHistoryEnd}
            onChange={color => color && onChange({ decoration: { ...object.decoration!, color } })} />
        </InspectorField>}
        <TextPadding value={object.padding ?? (object.decoration ? '0.75em' : 0)} base={defaultFontSize} onChange={padding => onChange({ padding })} />
      </InspectorGroup>}
      {supportsCaption(object) && <InspectorGroup title="Caption">
        {object.caption ? <InspectorRow>
          <button onClick={onCaption}>Edit caption</button>
          <button onClick={() => onChange({ caption: null })}>Remove caption</button>
        </InspectorRow> : <button onClick={onCaption}>Add caption</button>}
        <TypographyPreview theme={theme} semantic="caption" />
        <button onClick={() => onTheme('caption')}>Caption style… <PanelIcon name="sliders" /></button>
      </InspectorGroup>}
      {katex && <KaTeXControls value={katex} onChange={onChange} onTheme={onTheme} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
      {(object.placement === 'flow' || ['drawing', 'code', 'html'].includes(object.kind ?? 'text')) && <InspectorGroup title="Layout">
        {object.kind === 'drawing' && <InspectorRow>
          <InspectorField label="Width"><NumberField label="Drawing width" value={object.width} min={16} max={maxWidth} onChange={width => onChange({ width })} /></InspectorField>
          <InspectorField label="Height"><NumberField label="Drawing height" value={object.height} min={16} max={4000} onChange={height => onChange({ width: height * object.width / object.height })} /></InspectorField>
        </InspectorRow>}
        {object.kind === 'drawing' && <p className="hint">Resizing keeps proportions. Crop or extend in the drawing editor.</p>}
        {object.kind === 'code' && <InspectorField label="Width"><NumberField label="Code width" value={object.width} min={120} max={Math.max(120, maxWidth)} onChange={width => onChange({ width })} /></InspectorField>}
        {widget && <InspectorRow>
          <InspectorField label="Width"><NumberField label="Widget width" value={widget.width} min={16} max={maxWidth} onChange={width => onChange({ width })} /></InspectorField>
          <InspectorField label="Height"><NumberField label="Widget height" value={widget.height} min={16} max={4000} onChange={height => onChange({ height })} /></InspectorField>
        </InspectorRow>}
        {object.placement === 'flow' && <>
          {!['drawing', 'code', 'html', 'table'].includes(object.kind ?? 'text') && <InspectorField label="Width"><NumberField label="Object width" value={object.width} min={16} max={maxWidth} onChange={width => onChange({ width })} /></InspectorField>}
          <button aria-pressed={!!object.centered} onClick={() => { if (!object.centered) onChange({ centered: true }) }}>Center in text column</button>
        </>}
      </InspectorGroup>}
      {!widget && !katex && object.kind !== 'code' && <InspectorGroup title={text || object.kind === 'table' ? 'Typography' : 'Colors'}>
        {(text || object.kind === 'table') && <>
          <TypographyPreview theme={theme} semantic={object.kind === 'table' ? 'table' : textStyle ?? 'body'} />
          <button onClick={() => onTheme(object.kind === 'table' ? 'table' : textStyle ?? 'body')}>
            {object.kind === 'table' ? 'Table style' : textStyle ? `${classLabel(textStyle)} style` : 'Text styles'} <PanelIcon name="sliders" />
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
      {count === 1 && <p>{object.placement === 'flow'
        ? 'Drag sideways to position; snap to the center. Drag up or down to move between document blocks.'
        : 'Position freely on the grid. Main text stays to its left. Moving onto a Flow object anchors it there.'}</p>}
      <p>With the object focused, Ctrl/⌘C copies, X cuts, and V pastes. Captions stay with their objects. While editing text, these shortcuts act on text instead.</p>
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

function FloatingHelp({ object, count }: { object: FloatingObject; count: number }) {
  if (count > 1) return <p>Drag any selected object to move the group. Select one object alone to edit its contents. Shift-click adds or removes objects from the selection.</p>
  switch (object.kind) {
    case 'drawing': return <><p>Click the centered pen, double-click, or press Enter to open the full-screen drawing editor. Done or Escape returns to the document. Each stroke can be undone.</p><p>Drag to move; the right border and corners resize with proportions intact. To crop or extend a side without stretching, drag the editor's edge handles. Pen widths stay in document pixels. Revise with AI can turn the sketch into a figure.</p></>
    case 'code': return <><p>Select the object, then click its source to edit. Enter / Shift+Enter inserts a line break; Tab / Shift+Tab indents or outdents. Paste keeps plain text and line breaks, not formatting.</p><p>Drag the language header to move it. The right border changes its width; height follows all source lines. Long lines scroll horizontally, with a scrollbar only when needed. Copy excludes the header and line numbers. Escape returns focus to the object.</p><p>Code style controls typography. Syntax colors follow the document's Light or Dark appearance, independently of the palette hues.</p></>
    case 'html': return <><p>Select the widget to interact with it. Click elsewhere to deselect, then drag its interior to move it. The top, left, and bottom borders move it; the right border or corner handles resize it.</p><p>Changes to code save immediately. Run / Restart executes the saved source in a fresh widget. CDN resources may not work offline. The screenshot is a manual preview, not a live capture.</p></>
    case 'image': return <><p>Drag the image or its top, left, or bottom border to move it. The right border resizes with proportions intact. Double-click the image to add or edit its caption.</p><p>Paste an external image, then click to place or drag to size. Enter places at the insertion point; Escape cancels. Up to 10 MB per image; images synchronize with the document.</p></>
    case 'table': return <><p>Select the table, then click a cell to edit. Enter / Shift+Enter adds a newline; Tab / Shift+Tab moves between cells. All cells use Table style, with bold, palette colors, and decorations.</p><p>Appearance → Style chooses Simple grid lines, Academic horizontal rules, or Business striped rows. Header row emphasizes the first row.</p><p>Internal dividers resize adjacent columns without changing table width. The right border resizes the whole table; the other borders move it. Click elsewhere to deselect and drag from any cell to move.</p></>
    case 'katex': return <p>Drag the formula or its top, left, or bottom border to move it. The right border changes its width; height follows its content. Long formulas do not wrap automatically. Math style applies to every formula.</p>
    default: return <><p>Select the box, then click or drag inside to edit text. Click elsewhere to deselect and drag its interior to move. The top, left, and bottom borders always move it; the right border resizes.</p><p>Paragraph styles are document-wide. Tab turns Body paragraphs into list items; Shift+Tab outdents.</p></>
  }
}
