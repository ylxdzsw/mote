import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isText, supportsCaption, tableStyles, type FloatingObject, type FloatingKaTeX, type FloatingHTMLWidget, type FloatingPatch, type Theme, type ThemeLength } from '../document/model'
import { WidgetEditor } from './WidgetEditor'
import { NumberField, pixels, classLabel } from '../theme/ThemePanel'
import { PaletteControl } from '../theme/PaletteControl'

import { ContextHeading, InspectorField, InspectorGroup, InspectorHelp, InspectorRow, InspectorStyles } from './Inspector'
import { PanelIcon } from './PanelIcon'
import { codeLanguages } from '../document/code'
import { WIDGET_SCREENSHOT_PLACEHOLDER } from '../document/widget'
import type { ScreenshotStatus } from './useWidgetScreenshot'

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
  textStyle?: string
  tableControls: ReactNode
  onTheme: (className: string) => void
  onWidgetRun: (id: string) => void
  onUpdateScreenshot: (object: FloatingHTMLWidget) => void
  screenshotStatus: ScreenshotStatus | null
  screenshotOffline: boolean
  onReplaceImage: () => void
  onDrawingEdit: () => void
  reserved?: boolean
  onOpenTask?: () => void
}

export const kindName = (object: FloatingObject) => object.kind === 'drawing' ? 'Drawing' : object.kind === 'code' ? 'Code' : object.kind === 'image' ? 'Image' : object.kind === 'table' ? 'Table' : object.kind === 'katex' ? 'Formula' : object.kind === 'html' ? 'HTML widget' : 'Text box'

export function FloatingInspector({ object, count, theme, defaultFontSize, onChange, onPlacement, onAction, onFront, onBack, onHistoryBegin, onHistoryEnd, imageLoading, onCaption, captionSelected, onCaptionWidth, captionMaxWidth, onSelectOwner, textStyle, tableControls, onTheme, onWidgetRun, onUpdateScreenshot, screenshotStatus, screenshotOffline, onReplaceImage, onDrawingEdit, reserved, onOpenTask }: Props) {
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
      <ContextHeading title={reserved ? 'Caption · Reserved for AI' : 'Caption'} actions={!reserved && <button className="icon-action delete-action" aria-label="Remove caption" title="Remove caption" onClick={() => onChange({ caption: null })}><PanelIcon name="trash" /></button>} />
      <InspectorRow>{reserved && onOpenTask && <button className="inspector-primary" onClick={onOpenTask}>Open AI task</button>}{!reserved && <button onClick={onCaption}>Edit caption</button>}<button onClick={onSelectOwner}>{ownerSelectionLabel}</button></InspectorRow>
      <InspectorGroup title="Layout">
        <InspectorField label="Width">
          <NumberField label="Caption width" value={object.caption.width ?? object.width} min={16} max={captionMaxWidth} onChange={onCaptionWidth} />
          <label className="inspector-check" title="Follow the owner's width instead of keeping a fixed caption width">
            <input type="checkbox" checked={object.caption.width === undefined} onChange={event => onCaptionWidth(event.target.checked ? null : object.width)} />
            <span>Match object width</span>
          </label>
        </InspectorField>
      </InspectorGroup>
      {!reserved && <InspectorStyles semantic="caption" onTheme={onTheme} />}
      <InspectorHelp>
        {reserved ? <p>Caption content stays reserved for the active AI task. Its width remains user-controlled.</p> : <>
        <p>Click once to select the caption, then click inside it to edit. Drag the caption box or its borders to move its owner; the right border resizes the caption while keeping it centered.</p>
        <p>Width follows the owner unless overridden; wider captions stay centered within the page.</p>
        <p>Delete removes the caption. Captions cannot be detached from their owners.</p>
        </>}
      </InspectorHelp>
    </div>
  }
  return <div className="context-inspector floating-inspector">
    <ContextHeading title={reserved ? 'Reserved for AI' : count > 1 ? `${count} objects` : name} subtitle={reserved ? name : undefined} actions={!reserved && <>
      <button className="icon-action" aria-label="Duplicate" title={count > 1 ? `Duplicate ${count} objects` : 'Duplicate'} onClick={() => onAction('duplicate')}><PanelIcon name="copy" /></button>
      <button className="icon-action delete-action" aria-label={count > 1 ? `Delete ${count} objects` : 'Delete'} title={count > 1 ? `Delete ${count} objects` : 'Delete'} onClick={() => onAction('remove')}><PanelIcon name="trash" /></button>
    </>} />
    {count === 1 && <>
      <div className="inspector-stack">
        <div className="placement-options" role="radiogroup" aria-label="Object placement">
          {(['flow', 'float'] as const).map(placement => <label key={placement} title={placement === 'flow' ? 'Between text blocks, in the document flow' : 'Position freely; main text stays to its left'}>
            <input type="radio" name={placementId} value={placement} checked={object.placement === placement}
              onChange={() => onPlacement(placement)} />
            <span>{placement === 'flow' ? 'Flow' : 'Float'}</span>
          </label>)}
        </div>
        {reserved && onOpenTask && <button className="inspector-primary" onClick={onOpenTask}>Open AI task</button>}
      </div>
      {!reserved && <>
      {object.kind === 'drawing' && <button onClick={onDrawingEdit}>Edit drawing…</button>}
      {object.kind === 'code' && <label className="inspector-field inspector-field-native"><span className="field-heading">Language</span><select aria-label="Code language" value={object.language} onChange={event => onChange({ language: event.target.value })}>
          {!codeLanguages.some(language => language.value === object.language) && <option value={object.language}>{object.language || 'Plain text'}</option>}
          {codeLanguages.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
        </select></label>}
      {widget && <HTMLWidgetControls value={widget} onChange={onChange} screenshotStatus={screenshotStatus} screenshotOffline={screenshotOffline} onUpdateScreenshot={onUpdateScreenshot}
        onRun={() => onWidgetRun(widget.id)} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
      {object.kind === 'image' && <InspectorGroup title="Content">
        <button disabled={imageLoading} onClick={onReplaceImage}>{imageLoading ? 'Opening image…' : 'Replace image…'}</button>
        <InspectorField label="Description" layout="stack">
          <input aria-label="Description" type="text" value={object.alt} onFocus={() => onHistoryBegin(`description:${object.id}`)} onBlur={onHistoryEnd}
            onChange={event => onChange({ alt: event.target.value })} />
        </InspectorField>
      </InspectorGroup>}
      {katex && <KaTeXControls value={katex} onChange={onChange} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />}
      {object.kind === 'table' && tableControls}
      {supportsCaption(object) && <button onClick={onCaption}>{object.caption ? 'Edit caption' : 'Add caption'}</button>}
      {object.kind === 'table' && <InspectorGroup title="Appearance">
        <InspectorField label="Style" className="inspector-field-segmented">
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
        <InspectorField label="Border" className="inspector-field-segmented">
          <div className="placement-options decoration-options" role="radiogroup" aria-label="Text box border">
            {(['none', 'left', 'box'] as const).map(kind => <label key={kind}>
              <input type="radio" name={decorationId} value={kind} checked={(object.decoration?.kind ?? 'none') === kind}
                onChange={() => onChange({ decoration: kind === 'none' ? null : { kind, color: object.decoration?.color ?? 'secondary' } })} />
              <span>{kind !== 'none' && <i aria-hidden="true" data-kind={kind} />}{{ none: 'None', left: 'Left', box: 'All sides' }[kind]}</span>
            </label>)}
          </div>
        </InspectorField>
        {object.decoration && <InspectorField label="Color" layout="stack">
          <PaletteControl theme={theme} label="Text box color" value={object.decoration.color} pairs
            onFocus={() => onHistoryBegin('floating-decoration-color')} onBlur={onHistoryEnd}
            onChange={color => color && onChange({ decoration: { ...object.decoration!, color } })} />
        </InspectorField>}
        <TextPadding value={object.padding ?? (object.decoration ? '0.75em' : 0)} base={defaultFontSize} onChange={padding => onChange({ padding })} />
      </InspectorGroup>}
      </>}
    </>}
    <InspectorGroup title="Layout" actions={<>
      <button className="icon-action" aria-label="Bring to front" title="Bring to front" onClick={onFront}><PanelIcon name="front" /></button>
      <button className="icon-action" aria-label="Send to back" title="Send to back" onClick={onBack}><PanelIcon name="back" /></button>
    </>}>
      {count === 1 && <ObjectMargins object={object} onChange={margins => onChange({ margins })} />}
    </InspectorGroup>
    {!reserved && count === 1 && <InspectorStyles semantic={text ? textStyle ?? 'body' : object.kind === 'table' ? 'table' : object.kind === 'code' ? 'code' : katex ? 'math' : undefined} onTheme={onTheme} />}
    <InspectorHelp key={count > 1 ? 'group' : object.kind ?? 'text'}>
      {reserved ? <p>Content and size stay reserved for the active AI task. Placement and margins remain user-controlled.</p> : <FloatingHelp object={object} count={count} />}
      {!reserved && count === 1 && <p>{object.placement === 'flow'
        ? 'Drag sideways to position; snap to the center. Drag up or down to move between document blocks.'
        : 'Position freely on the grid. Main text stays to its left. Moving onto a Flow object anchors it there.'}</p>}
      {!reserved && <>
        <p>With the object focused, Ctrl/⌘C copies, X cuts, and V pastes. Captions stay with their objects. While editing text, these shortcuts act on text instead.</p>
        <p>Delete/Backspace removes a focused object. Undo restores it.</p>
      </>}
    </InspectorHelp>
  </div>
}

function ObjectMargins({ object, onChange }: { object: FloatingObject; onChange: (margins: NonNullable<FloatingObject['margins']>) => void }) {
  const sides = ['top', 'right', 'bottom', 'left'] as const
  const margins = object.margins ?? { top: 0, right: 0, bottom: 0, left: 0 }
  return <div className="inspector-field inspector-field-stack object-margin-fieldset">
    <div className="field-heading">Margins</div>
    <div className="object-margins">
      {sides.map(side => <label key={side}>
        <span>{side[0].toUpperCase() + side.slice(1)}</span>
        <NumberField label={`${side} margin`} value={margins[side]} step="any"
          onChange={value => onChange({ ...margins, [side]: value })} />
      </label>)}
    </div>
  </div>
}

function TextPadding({ value, base, onChange }: { value: ThemeLength; base: number; onChange: (value: ThemeLength) => void }) {
  const unit = typeof value === 'string' && value.endsWith('em') ? 'em' : 'px'
  return <InspectorField label="Padding">
    <NumberField label="Padding" value={typeof value === 'number' ? value : parseFloat(value)} min={0} max={2000 / (unit === 'em' ? base : 1)}
      step={unit === 'em' ? .025 : 1} unit={unit} units={['em', 'px']}
      onChange={next => onChange(`${next}${unit}`)}
      onUnitChange={nextUnit => onChange(`${Number((pixels(value, base) / (nextUnit === 'em' ? base : 1)).toFixed(6))}${nextUnit as 'em' | 'px'}`)} />
  </InspectorField>
}

function KaTeXControls({ value, onChange, onHistoryBegin, onHistoryEnd }: { value: FloatingKaTeX; onChange: (patch: FloatingPatch) => void; onHistoryBegin: (name: string) => void; onHistoryEnd: () => void }) {
  return <InspectorField label="LaTeX" layout="stack">
    <textarea className="embed-source" aria-label="LaTeX" title="LaTeX without delimiters" rows={3} spellCheck={false} value={value.latex}
      onFocus={() => onHistoryBegin(`katex-source:${value.id}`)} onBlur={onHistoryEnd}
      onChange={event => onChange({ latex: event.target.value })} />
  </InspectorField>
}

function HTMLWidgetControls({ value, onChange, screenshotStatus, screenshotOffline, onUpdateScreenshot, onRun, onHistoryBegin, onHistoryEnd }: {
  value: FloatingHTMLWidget; onChange: (patch: FloatingPatch) => void; screenshotStatus: ScreenshotStatus | null; screenshotOffline: boolean
  onUpdateScreenshot: (object: FloatingHTMLWidget) => void; onRun: () => void
  onHistoryBegin: (name: string) => void; onHistoryEnd: () => void
}) {
  const [editorId, setEditorId] = useState<string | null>(null)
  useEffect(() => { if (editorId !== value.id) setEditorId(null) }, [editorId, value.id])
  const editorOpen = editorId === value.id
  const status = screenshotStatus?.objectId === value.id ? screenshotStatus : null

  return <>
    <InspectorGroup title="Content">
      <InspectorRow><button onClick={() => setEditorId(value.id)}>Edit code…</button><button onClick={onRun}>Run / Restart</button></InspectorRow>
      <button disabled={screenshotOffline || screenshotStatus?.pending} aria-busy={status?.pending || undefined}
        title="Capture a fresh run of saved code for the minimap and PNG export"
        onClick={() => onUpdateScreenshot(value)}>{status?.pending ? 'Capturing…' : 'Update screenshot'}</button>
      {value.screenshot === WIDGET_SCREENSHOT_PLACEHOLDER && <p className="hint">No screenshot yet.</p>}
      {screenshotOffline && <p className="hint">Reconnect to update the screenshot.</p>}
      {status?.error && <p className="field-error" role="alert">{status.error}</p>}
      <details className="inspector-details">
        <summary>Screenshot details</summary>
        <div>
          <div className="widget-preview"><img src={value.screenshot} alt={value.alt} /></div>
          <InspectorField label="Description" layout="stack">
            <input aria-label="Description" type="text" value={value.alt} onFocus={() => onHistoryBegin(`html-widget-alt:${value.id}`)} onBlur={onHistoryEnd}
              onChange={event => onChange({ alt: event.target.value })} />
          </InspectorField>
        </div>
      </details>
    </InspectorGroup>
    {editorOpen && createPortal(<WidgetEditor widget={value} onChange={html => onChange({ html })} onRun={onRun}
      onClose={() => setEditorId(null)} onHistoryBegin={onHistoryBegin} onHistoryEnd={onHistoryEnd} />, document.querySelector('.app')!)}
  </>
}

function FloatingHelp({ object, count }: { object: FloatingObject; count: number }) {
  if (count > 1) return <p>Drag any selected object to move the group. Select one object alone to edit its contents. Shift-click adds or removes objects from the selection.</p>
  switch (object.kind) {
    case 'drawing': return <><p>Click the centered pen, double-click, or press Enter to open the full-screen drawing editor. Done or Escape returns to the document. Each stroke can be undone.</p><p>Drag to move; the right border and corners resize with proportions intact. To crop or extend a side without stretching, drag the editor's edge handles. Pen widths stay in document pixels. Reserve the sketch in Assistant to turn it into a figure.</p></>
    case 'code': return <><p>Select the object, then click its source to edit. Enter / Shift+Enter inserts a line break; Tab / Shift+Tab indents or outdents. Paste keeps plain text and line breaks, not formatting.</p><p>Drag the language header to move it. The right border changes its width; height follows all source lines. Long lines scroll horizontally, with a scrollbar only when needed. Copy excludes the header and line numbers. Escape returns focus to the object.</p><p>Code style controls typography. Syntax colors follow the document's Light or Dark appearance, independently of the palette hues.</p></>
    case 'html': return <><p>Select the widget to interact with it. Click elsewhere to deselect, then drag its interior to move it. The top, left, and bottom borders move it; the right border or corner handles resize it.</p><p>The saved screenshot is used for the minimap and PNG export, not the widget’s current interaction state.</p><p>Changes to code save immediately. Run / Restart executes the saved source in a fresh widget. CDN resources may not work offline. Update screenshot runs the saved code separately on the server; it does not restart the widget on this page. Refresh it after changing code or dimensions.</p></>
    case 'image': return <><p>Drag the image or its top, left, or bottom border to move it. The right border resizes with proportions intact. Double-click the image to add or edit its caption.</p><p>Paste an external image, then click to place or drag to size. Enter places at the insertion point; Escape cancels. Up to 10 MB per image; images synchronize with the document.</p></>
    case 'table': return <><p>Select the table, then click a cell to edit. Enter / Shift+Enter adds a newline; Tab / Shift+Tab moves between cells. All cells use Table style, with bold, palette colors, and decorations.</p><p>Appearance → Style chooses Simple grid lines, Academic horizontal rules, or Business striped rows. Header row emphasizes the first row.</p><p>Internal dividers resize adjacent columns without changing table width. The right border resizes the whole table; the other borders move it. Click elsewhere to deselect and drag from any cell to move.</p></>
    case 'katex': return <p>Enter LaTeX without delimiters. Drag the formula or its top, left, or bottom border to move it. The right border changes its width; height follows its content. Long formulas do not wrap automatically. Math style applies to every formula.</p>
    default: return <><p>Select the box, then click or drag inside to edit text. Click elsewhere to deselect and drag its interior to move. The top, left, and bottom borders always move it; the right border resizes.</p><p>Padding applies to all sides; em follows the default font size.</p><p>Paragraph styles are document-wide. Tab turns Body paragraphs into list items; Shift+Tab outdents.</p></>
  }
}
