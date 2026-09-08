import { useState } from 'react'

export interface ViewSettings {
  minimap: 'auto' | 'show' | 'hide'
  minimapSize: 'proportional' | 'fit'
}

const storageKey = 'mote-view-settings'
const defaults: ViewSettings = { minimap: 'auto', minimapSize: 'proportional' }

export function useViewSettings() {
  const [settings, setSettings] = useState<ViewSettings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      return {
        minimap: ['auto', 'show', 'hide'].includes(saved.minimap) ? saved.minimap : defaults.minimap,
        minimapSize: ['proportional', 'fit'].includes(saved.minimapSize) ? saved.minimapSize : defaults.minimapSize,
      }
    } catch { return defaults }
  })
  const [saveError, setSaveError] = useState(false)

  function update(next: ViewSettings) {
    setSettings(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setSaveError(false) }
    catch { setSaveError(true) }
  }

  return { settings, update, saveError }
}

export function GlobalSettings({ settings, onChange, saveError }: {
  settings: ViewSettings
  onChange: (settings: ViewSettings) => void
  saveError: boolean
}) {
  return <section className="panel-section">
    <h2>Global settings</h2>
    <label>Minimap
      <select aria-label="Minimap visibility" value={settings.minimap}
        onChange={event => onChange({ ...settings, minimap: event.target.value as ViewSettings['minimap'] })}>
        <option value="auto">Automatic</option>
        <option value="show">Show</option>
        <option value="hide">Hide</option>
      </select>
    </label>
    <label>Minimap sizing
      <select aria-label="Minimap sizing" value={settings.minimapSize}
        onChange={event => onChange({ ...settings, minimapSize: event.target.value as ViewSettings['minimapSize'] })}>
        <option value="proportional">Faithful proportions</option>
        <option value="fit">Fit whole document</option>
      </select>
    </label>
    <p className="hint">{settings.minimapSize === 'proportional'
      ? 'Keeps page proportions; the miniature scrolls with the document.'
      : 'Shows the whole document, compressing long notes vertically.'}</p>
    <p className="hint">Automatic hides on small screens. Settings stay in this browser.</p>
    {saveError && <p className="hint error" role="status">Couldn’t save these settings. They still apply until you reload.</p>}
  </section>
}
