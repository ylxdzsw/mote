import { useState } from 'react'

export interface ViewSettings {
  minimap: 'auto' | 'show' | 'hide'
  minimapSize: 'proportional' | 'fit'
  notesOpen: boolean
  notesHeight: number
}

const storageKey = 'mote-view-settings'
const defaults: ViewSettings = { minimap: 'auto', minimapSize: 'proportional', notesOpen: false, notesHeight: 200 }

function readSettings(): ViewSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    return {
      minimap: ['auto', 'show', 'hide'].includes(saved.minimap) ? saved.minimap : defaults.minimap,
      minimapSize: ['proportional', 'fit'].includes(saved.minimapSize) ? saved.minimapSize : defaults.minimapSize,
      notesOpen: saved.notesOpen === true,
      notesHeight: typeof saved.notesHeight === 'number' && Number.isFinite(saved.notesHeight) ? Math.max(72, saved.notesHeight) : defaults.notesHeight,
    }
  } catch { return defaults }
}

// Each surface owns its preference keys, without rerendering unrelated surfaces.
export function useViewSettings<K extends keyof ViewSettings>(keys: readonly K[], persist = true) {
  const [settings, setSettings] = useState<Pick<ViewSettings, K>>(() => {
    const saved = persist ? readSettings() : defaults
    return Object.fromEntries(keys.map(key => [key, saved[key]])) as Pick<ViewSettings, K>
  })
  const [saveError, setSaveError] = useState(false)

  function update(next: Pick<ViewSettings, K>) {
    setSettings(next)
    if (!persist) return
    try { localStorage.setItem(storageKey, JSON.stringify({ ...readSettings(), ...next })); setSaveError(false) }
    catch { setSaveError(true) }
  }

  return { settings, update, saveError }
}

export function GlobalSettings({ settings, onChange, saveError, persist = true }: {
  settings: Pick<ViewSettings, 'minimap' | 'minimapSize'>
  onChange: (settings: Pick<ViewSettings, 'minimap' | 'minimapSize'>) => void
  saveError: boolean
  persist?: boolean
}) {
  return <section className="panel-section browser-properties">
    <h2>Display</h2>
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
    <p className="hint">Automatic hides on small screens. {persist ? 'Settings stay in this browser.' : 'Settings apply only until this reader is closed.'}</p>
    {saveError && <p className="hint error" role="status">Couldn’t save these settings. They still apply until you reload.</p>}
  </section>
}
