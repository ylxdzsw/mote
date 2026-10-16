import { useId, useState } from 'react'
import { type DocumentLanguage, type MoteDocument } from '../document/model'
import { useHistory } from '../document/history'
import { NumberField, ThemePanel, type ThemeClass } from '../theme/ThemePanel'
import type { PrivacyState } from '../cloud/WorkingCopy'

export function DocumentSettings({ doc, tab, onTab, selectedClass, onClass, onChange,
  privateDocument, privacy, onPrivateChange, onPrivacyRetry, onPrivacyReconcile }: {
  doc: MoteDocument; tab: 'layout' | 'theme'; onTab: (tab: 'layout' | 'theme') => void
  selectedClass: ThemeClass; onClass: (value: ThemeClass) => void; onChange: (doc: MoteDocument) => void
  privateDocument: boolean; privacy: PrivacyState; onPrivateChange: (value: boolean) => void
  onPrivacyRetry: () => void; onPrivacyReconcile: () => void
}) {
  const history = useHistory()
  const privateHintId = useId()
  const [linked, setLinked] = useState(doc.margins.left === doc.margins.right)
  function margin(side: 'left' | 'right', value: number) {
    onChange({ ...doc, margins: { ...doc.margins, ...(linked ? { left: value, right: value } : { [side]: value }) } })
  }
  const available = doc.width - 120
  return <div className="document-settings" id="document-settings">
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
    <div key={tab} className="document-settings-body" role="tabpanel" id={`${tab}-settings`} aria-labelledby={`${tab}-tab`}>
      <section className="privacy-setting" aria-label="Document privacy">
        <label><input type="checkbox" aria-label="Private" aria-describedby={privateHintId} checked={privateDocument} disabled={privacy.busy || !!privacy.pending}
          onChange={event => onPrivateChange(event.target.checked)} /><span><strong>Private</strong>
          <span id={privateHintId} className="hint">Blocks public sharing and external agents. The built-in agent remains available.</span></span></label>
        {privacy.busy && privacy.pending && <p className="hint" role="status">Saving privacy setting…</p>}
        {privacy.message && <p className="hint" role="status">{privacy.message}</p>}
        {privacy.error && <p className="hint error" role="alert">{privacy.error}</p>}
        {privacy.pending && !privacy.busy && <div className="privacy-actions">
          <button type="button" onClick={onPrivacyRetry}>Retry change</button>
          <button type="button" onClick={onPrivacyReconcile}>Check server status</button>
        </div>}
      </section>
      {tab === 'layout' ? <section className="panel-section layout-properties">
        <h2>Page</h2>
        <div className="paired-fields">
          <div>
            <div className="style-field"><div className="field-heading">Document width</div>
              <NumberField label="Document width" value={doc.width} min={Math.max(320, doc.margins.left + doc.margins.right + 120)} max={2400}
                onChange={width => onChange({ ...doc, width })} /></div>
            <p className="hint">A continuous page, as tall as your content.</p>
          </div>
          <div>
            <div className="style-field"><div className="field-heading">Text language</div>
              <select aria-label="Text language" value={doc.language ?? 'en'} onChange={event => {
                history.boundary(); onChange({ ...doc, language: event.target.value as DocumentLanguage })
              }}><option value="en">English</option><option value="zh-Hans">Simplified Chinese</option></select>
            </div>
            <p className="hint">For document text, not the interface. Mixed English and Chinese are supported.</p>
          </div>
        </div>
        <h2 className="subheading">Margins</h2>
        <div className="paired-fields">
          {(['top', 'bottom'] as const).map(side => <div className="style-field" key={side}>
            <div className="field-heading">{side === 'top' ? 'Top' : 'Bottom'}</div>
            <NumberField label={`${side === 'top' ? 'Top' : 'Bottom'} margin`} value={doc.margins[side]}
              min={0} max={2400} onChange={value => onChange({ ...doc, margins: { ...doc.margins, [side]: value } })} />
          </div>)}
        </div>
        <div className="paired-fields">
          {(['left', 'right'] as const).map(side => <div className="style-field" key={side}>
            <div className="field-heading">{side === 'left' ? 'Left' : 'Right'}</div>
            <NumberField label={`${side === 'left' ? 'Left' : 'Right'} margin`} value={doc.margins[side]}
              min={0} max={linked ? available / 2 : available - doc.margins[side === 'left' ? 'right' : 'left']}
              onChange={value => margin(side, value)} />
          </div>)}
        </div>
        <label className="link-margins"><input type="checkbox" checked={linked} onChange={event => {
          history.boundary(); setLinked(event.target.checked)
          if (event.target.checked) {
            const value = Math.min(doc.margins.left, available / 2)
            onChange({ ...doc, margins: { ...doc.margins, left: value, right: value } })
          }
        }} /> Link left and right</label>
        <p className="hint">Top precedes the main text; bottom follows the last text or floating object.</p>
        <p className="hint">At least 120px stays available for main text. Floating objects keep their document-space positions; narrower pages can leave them outside the page.</p>
        <h2 className="subheading">AI assistant</h2>
        <div className="style-field"><div className="field-heading">Mu model (optional)</div>
          <input type="text" maxLength={256} spellCheck={false} autoComplete="off" aria-label="AI assistant Mu model"
            value={doc.aiModel ?? ''} placeholder="Workspace default" onFocus={() => history.begin('document-ai-model')} onBlur={history.boundary}
            onChange={event => onChange({ ...doc, aiModel: event.target.value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '') })} />
        </div>
        <p className="hint">Leave blank to use the workspace default; a value here overrides it for this document. AI runs only when you explicitly request generation, and the full document is sent to the selected Mu model.</p>
      </section> : <div className="document-theme"><ThemePanel theme={doc.theme} language={doc.language ?? 'en'} selected={selectedClass} onSelect={onClass} onChange={theme => onChange({ ...doc, theme })} /></div>}
    </div>
  </div>
}
