import { useState } from 'react'
import type { MoteDocument } from '../document/model'
import { useHistory } from '../document/history'
import { NumberField, ThemePanel, type ThemeClass } from '../theme/ThemePanel'

export function DocumentSettings({ doc, tab, onTab, selectedClass, onClass, onChange, onClose }: {
  doc: MoteDocument; tab: 'layout' | 'theme'; onTab: (tab: 'layout' | 'theme') => void
  selectedClass: ThemeClass; onClass: (value: ThemeClass) => void; onChange: (doc: MoteDocument) => void; onClose: () => void
}) {
  const history = useHistory()
  const [linked, setLinked] = useState(doc.margins.left === doc.margins.right)
  function margin(side: 'left' | 'right', value: number) {
    onChange({ ...doc, margins: linked ? { left: value, right: value } : { ...doc.margins, [side]: value } })
  }
  const available = doc.width - 120
  return <aside className="inspector document-settings" id="document-settings" aria-label="Document settings">
    <div className="inspector-heading">DOCUMENT<button aria-label="Close document settings" onClick={onClose}>×</button></div>
    <div className="settings-tabs" role="tablist" aria-label="Document settings section">
      {(['layout', 'theme'] as const).map(name => <button key={name} role="tab" id={`${name}-tab`} aria-selected={tab === name}
        tabIndex={tab === name ? 0 : -1} aria-controls={`${name}-settings`}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault(); history.boundary()
          const next = event.key === 'Home' ? 'layout' : event.key === 'End' ? 'theme' : tab === 'layout' ? 'theme' : 'layout'
          onTab(next); document.getElementById(`${next}-tab`)?.focus()
        }} onClick={() => { history.boundary(); onTab(name) }}>{name === 'layout' ? 'Layout' : 'Theme'}</button>)}
    </div>
    <div role="tabpanel" id={`${tab}-settings`} aria-labelledby={`${tab}-tab`}>
      {tab === 'layout' ? <section className="panel-section layout-properties">
        <h2>Page</h2>
        <div className="style-field"><div className="field-heading">Document width</div>
          <NumberField label="Document width" value={doc.width} min={Math.max(320, doc.margins.left + doc.margins.right + 120)} max={2400}
            onChange={width => onChange({ ...doc, width })} /></div>
        <p className="hint">A continuous page, as tall as your content. Reading mode fits the page without rearranging it.</p>
        <h2 className="subheading">Main-text margins</h2>
        <label className="link-margins"><input type="checkbox" checked={linked} onChange={event => {
          history.boundary(); setLinked(event.target.checked)
          if (event.target.checked) {
            const value = Math.min(doc.margins.left, available / 2)
            onChange({ ...doc, margins: { left: value, right: value } })
          }
        }} /> Link left and right</label>
        <div className="paired-fields">
          {(['left', 'right'] as const).map(side => <div className="style-field" key={side}>
            <div className="field-heading">{side === 'left' ? 'Left' : 'Right'}</div>
            <NumberField label={`${side === 'left' ? 'Left' : 'Right'} margin`} value={doc.margins[side]}
              min={0} max={linked ? available / 2 : available - doc.margins[side === 'left' ? 'right' : 'left']}
              onChange={value => margin(side, value)} />
          </div>)}
        </div>
        <p className="hint">At least 120px stays available for main text. Floating objects keep their document-space positions; narrower pages can leave them outside the page.</p>
      </section> : <ThemePanel theme={doc.theme} selected={selectedClass} onSelect={onClass} onChange={theme => onChange({ ...doc, theme })} />}
    </div>
  </aside>
}
