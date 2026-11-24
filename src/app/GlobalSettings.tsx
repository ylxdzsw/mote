import { useState } from 'react'

export interface ViewSettings {
  minimap: 'auto' | 'show' | 'hide'
  minimapSize: 'proportional' | 'fit'
  formattingMarks: boolean
  verticalSpacers: boolean
  notesOpen: boolean
  notesHeight: number
}

const storageKey = 'mote-view-settings'
const defaults: ViewSettings = { minimap: 'auto', minimapSize: 'proportional', formattingMarks: false, verticalSpacers: false, notesOpen: false, notesHeight: 200 }

function readSettings(): ViewSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    return {
      minimap: ['auto', 'show', 'hide'].includes(saved.minimap) ? saved.minimap : defaults.minimap,
      minimapSize: ['proportional', 'fit'].includes(saved.minimapSize) ? saved.minimapSize : defaults.minimapSize,
      formattingMarks: saved.formattingMarks === true,
      verticalSpacers: saved.verticalSpacers === true,
      notesOpen: saved.notesOpen === true,
      notesHeight: typeof saved.notesHeight === 'number' && Number.isFinite(saved.notesHeight) ? Math.max(72, saved.notesHeight) : defaults.notesHeight,
    }
  } catch { return defaults }
}

// Each surface owns its preference keys, without rerendering unrelated surfaces.
export function useViewSettings<K extends keyof ViewSettings>(keys: readonly K[]) {
  const [settings, setSettings] = useState<Pick<ViewSettings, K>>(() => {
    const saved = readSettings()
    return Object.fromEntries(keys.map(key => [key, saved[key]])) as Pick<ViewSettings, K>
  })
  const [saveError, setSaveError] = useState(false)

  function update(next: Pick<ViewSettings, K>) {
    setSettings(next)
    try { localStorage.setItem(storageKey, JSON.stringify({ ...readSettings(), ...next })); setSaveError(false) }
    catch { setSaveError(true) }
  }

  return { settings, update, saveError }
}

export function GlobalSettings({ settings, onChange, saveError }: {
  settings: Omit<ViewSettings, 'notesOpen' | 'notesHeight'>
  onChange: (settings: Omit<ViewSettings, 'notesOpen' | 'notesHeight'>) => void
  saveError: boolean
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
    <p className="hint">Automatic hides on small screens. Settings stay in this browser.</p>
    <fieldset className="editing-guides"><legend>Editing guides</legend>
      <label><input type="checkbox" checked={settings.formattingMarks} onChange={event => onChange({ ...settings, formattingMarks: event.target.checked })} />Show formatting marks</label>
      <label><input type="checkbox" checked={settings.verticalSpacers} onChange={event => onChange({ ...settings, verticalSpacers: event.target.checked })} />Show vertical spacers</label>
    </fieldset>
    {saveError && <p className="hint error" role="status">Couldn’t save these settings. They still apply until you reload.</p>}
  </section>
}
