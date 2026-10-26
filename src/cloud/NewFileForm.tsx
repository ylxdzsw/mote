import { useId, useState, type FormEvent } from 'react'

export interface NewFileOptions {
  name: string
  mode: 'light' | 'dark'
  language: 'en' | 'zh-Hans'
  private: boolean
  example: boolean
  modified: boolean
}

type Preferences = Pick<NewFileOptions, 'mode' | 'language'>

const preferenceKey = 'mote-new-file-preferences'
const defaults: Preferences = { mode: 'light', language: 'en' }

function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}') as Partial<Preferences> | null
    return {
      mode: saved?.mode === 'dark' ? 'dark' : 'light',
      language: saved?.language === 'zh-Hans' ? 'zh-Hans' : 'en',
    }
  } catch { return defaults }
}

function rememberPreferences(preferences: Preferences) {
  try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)) } catch { /* Preferences are optional. */ }
}

export function NewFileForm({ example, busy, onCreate, onCancel }: {
  example: boolean
  busy: boolean
  onCreate: (options: NewFileOptions) => Promise<void>
  onCancel: () => void
}) {
  const [preferences] = useState(readPreferences)
  const [name, setName] = useState(example ? 'Example' : '')
  const [mode, setMode] = useState<Preferences['mode']>(preferences.mode)
  const [language, setLanguage] = useState<Preferences['language']>(preferences.language)
  const [isPrivate, setPrivate] = useState(false)
  const [modified, setModified] = useState(false)
  const appearanceName = useId()
  const languageName = useId()
  const privacyDescription = useId()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const options: NewFileOptions = { name, mode, language, private: isPrivate, example, modified }
    try { await onCreate(options) }
    catch { return }
    rememberPreferences({ mode, language })
  }

  return <form className="files-create-form" onSubmit={event => void submit(event)}>
    <label className="files-form-row files-name-row">
      <span className="files-form-label">Name</span>
      <input autoFocus className="files-name-input" type="text" maxLength={1024} placeholder="Untitled" value={name} disabled={busy}
        onChange={event => { setName(event.target.value); setModified(true) }} />
    </label>
    <div className="files-form-row">
      <span className="files-form-label" aria-hidden="true">Appearance</span>
      <fieldset className="files-choice-group" aria-labelledby={appearanceName} disabled={busy}>
        <legend id={appearanceName} className="files-form-sr-only">Appearance</legend>
        <div className="files-choice-segments">
          <label><input type="radio" name="new-file-mode" value="light" checked={mode === 'light'}
            onChange={() => { setMode('light'); setModified(true) }} /><span>Light</span></label>
          <label><input type="radio" name="new-file-mode" value="dark" checked={mode === 'dark'}
            onChange={() => { setMode('dark'); setModified(true) }} /><span>Dark</span></label>
        </div>
      </fieldset>
    </div>
    <div className="files-form-row files-language-row">
      <span className="files-form-label" aria-hidden="true">Text language</span>
      <div className="files-language-choice">
        <fieldset className="files-choice-group" aria-labelledby={languageName} disabled={busy}>
          <legend id={languageName} className="files-form-sr-only">Text language</legend>
          <div className="files-choice-segments">
            <label><input type="radio" name="new-file-language" value="en" checked={language === 'en'}
              onChange={() => { setLanguage('en'); setModified(true) }} /><span>English</span></label>
            <label><input type="radio" name="new-file-language" value="zh-Hans" checked={language === 'zh-Hans'}
              onChange={() => { setLanguage('zh-Hans'); setModified(true) }} /><span lang="zh-Hans">简体中文</span></label>
          </div>
        </fieldset>
        <small>For document text, not the interface.</small>
      </div>
    </div>
    <div className="files-form-row files-private-row">
      <span className="files-form-label" aria-hidden="true">Privacy</span>
      <label className="files-private-choice">
        <input type="checkbox" aria-label="Private" aria-describedby={privacyDescription} checked={isPrivate} disabled={busy}
          onChange={event => { setPrivate(event.target.checked); setModified(true) }} />
        <span><strong>Private</strong><small id={privacyDescription}>Blocks public sharing, external agents, and access by agents working on other documents. The built-in assistant remains available. Unchecked does not make the file public.</small></span>
      </label>
    </div>
    <div className="files-create-actions">
      <button type="button" className="cloud-button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" className="cloud-button files-primary" disabled={busy}>Create</button>
    </div>
  </form>
}
