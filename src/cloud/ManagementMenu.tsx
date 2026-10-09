import { useEffect, useId, useRef, useState } from 'react'

interface ModelSettings {
  builtin: string
  indexing: string
}

interface WorkspaceSettings {
  revision: number
  models: ModelSettings
  serverDefaultModel: string | null
}

class SettingsRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'SettingsRequestError'
    this.status = status
  }
}

const sameModels = (left: ModelSettings, right: ModelSettings) =>
  left.builtin === right.builtin && left.indexing === right.indexing

function parseSettings(value: unknown, status: number): WorkspaceSettings {
  if (!value || typeof value !== 'object') throw new SettingsRequestError('The workspace settings response was invalid.', status)
  const result = value as Partial<WorkspaceSettings>
  if (!Number.isSafeInteger(result.revision) || result.revision! < 0 || !result.models ||
    typeof result.models.builtin !== 'string' || result.models.builtin.length > 256 ||
    typeof result.models.indexing !== 'string' || result.models.indexing.length > 256 ||
    !(typeof result.serverDefaultModel === 'string' || result.serverDefaultModel === null)) {
    throw new SettingsRequestError('The workspace settings response was invalid.', status)
  }
  return result as WorkspaceSettings
}

async function requestSettings(method: 'GET' | 'PUT', body: unknown, controller: AbortController): Promise<WorkspaceSettings> {
  let timedOut = false
  const timer = window.setTimeout(() => { timedOut = true; controller.abort() }, 15_000)
  try {
    const response = await fetch('/api/settings', {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let payload: unknown = null
    if (text) {
      try { payload = JSON.parse(text) }
      catch {
        if (response.ok) throw new SettingsRequestError('The workspace settings response was invalid.', response.status)
      }
    }
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error : `The cloud service returned an error (${response.status}). Please try again.`
      const message = response.status === 401 ? 'Sign in to manage workspace settings, then retry.'
        : response.status === 409 ? 'Workspace settings changed. Reload before saving.' : detail
      throw new SettingsRequestError(message, response.status)
    }
    return parseSettings(payload, response.status)
  } catch (error) {
    if (error instanceof SettingsRequestError) throw error
    if (timedOut) throw new SettingsRequestError('The workspace settings request timed out after 15 seconds. Retry when ready.')
    throw new SettingsRequestError('Could not reach workspace settings. Check your connection and retry.')
  } finally {
    window.clearTimeout(timer)
  }
}

export function ManagementMenu() {
  const panelId = useId()
  const [expanded, setExpanded] = useState(false)
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [draft, setDraft] = useState<ModelSettings | null>(null)
  const [operation, setOperation] = useState<'loading' | 'saving' | null>(null)
  const [error, setError] = useState('')
  const [auth, setAuth] = useState(false)
  const [status, setStatus] = useState('')
  const [needsReload, setNeedsReload] = useState(false)
  const settingsRef = useRef<WorkspaceSettings | null>(null)
  const draftRef = useRef<ModelSettings | null>(null)
  const baselineRef = useRef<ModelSettings | null>(null)
  const needsReloadRef = useRef(false)
  const locked = useRef(false)
  const mounted = useRef(true)
  const controllerRef = useRef<AbortController | null>(null)
  const dirty = !!draft && !!baselineRef.current && !sameModels(draft, baselineRef.current)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; controllerRef.current?.abort() }
  }, [])

  function setDraftModels(models: ModelSettings) {
    draftRef.current = models
    setDraft(models)
  }

  function setReloadRequired(value: boolean) {
    needsReloadRef.current = value
    setNeedsReload(value)
  }

  function acceptSettings(incoming: WorkspaceSettings, replaceDraft: boolean) {
    const previous = settingsRef.current
    const currentDraft = draftRef.current
    const baseline = baselineRef.current
    const hasChanges = !!currentDraft && !!baseline && !sameModels(currentDraft, baseline)
    settingsRef.current = incoming
    setSettings(incoming)

    if (replaceDraft || !currentDraft) {
      baselineRef.current = incoming.models
      setDraftModels(incoming.models)
      setReloadRequired(false)
    } else if (needsReloadRef.current) {
      return
    } else if (!hasChanges) {
      baselineRef.current = incoming.models
      setDraftModels(incoming.models)
    } else if (previous && previous.revision !== incoming.revision) {
      setReloadRequired(true)
    }
  }

  async function loadSettings(replaceDraft: boolean) {
    if (locked.current) return
    locked.current = true
    const controller = new AbortController()
    controllerRef.current = controller
    setOperation('loading')
    setError(''); setAuth(false); setStatus('')
    try {
      const incoming = await requestSettings('GET', undefined, controller)
      if (mounted.current) acceptSettings(incoming, replaceDraft)
    } catch (cause) {
      if (mounted.current) {
        const failure = cause instanceof SettingsRequestError ? cause : new SettingsRequestError('Could not load workspace settings.')
        setError(failure.message); setAuth(failure.status === 401)
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      locked.current = false
      if (mounted.current) setOperation(null)
    }
  }

  async function saveSettings() {
    const current = settingsRef.current
    const models = draftRef.current
    if (locked.current || !current || !models || needsReloadRef.current ||
      (baselineRef.current && sameModels(models, baselineRef.current))) return
    locked.current = true
    const controller = new AbortController()
    controllerRef.current = controller
    setOperation('saving')
    setError(''); setAuth(false); setStatus('')
    try {
      const result = await requestSettings('PUT', { baseRevision: current.revision, models }, controller)
      if (mounted.current) {
        acceptSettings(result, true)
        setStatus('Workspace settings saved.')
      }
    } catch (cause) {
      if (mounted.current) {
        const failure = cause instanceof SettingsRequestError ? cause : new SettingsRequestError('Could not save workspace settings.')
        if (failure.status === 409) setReloadRequired(true)
        setError(failure.message); setAuth(failure.status === 401)
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      locked.current = false
      if (mounted.current) setOperation(null)
    }
  }

  function toggle() {
    if (expanded) setExpanded(false)
    else {
      setExpanded(true)
      void loadSettings(false)
    }
  }

  return <section className="cloud-management" aria-label="Workspace management">
    <button type="button" className="cloud-button cloud-management-toggle" aria-expanded={expanded}
      aria-controls={panelId} onClick={toggle}>
      <span>Management</span><span aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    <div className="cloud-management-panel" id={panelId} hidden={!expanded}>
      <p className="cloud-hint">Workspace model defaults. Document overrides take priority; existing agent sessions keep their model.</p>
      <label className="cloud-field">Built-in agent default model
        <input type="text" maxLength={256} spellCheck={false} autoComplete="off" value={draft?.builtin ?? ''}
          placeholder="provider/model:effort" disabled={!settings || operation !== null}
          onChange={event => setDraftModels({ ...(draftRef.current ?? { builtin: '', indexing: '' }), builtin: event.target.value })} />
      </label>
      <p className="cloud-detail">Leave blank to use {settings?.serverDefaultModel ? <code>{settings.serverDefaultModel}</code> : 'Mu’s configured default'}.</p>
      <label className="cloud-field">Indexing model
        <input type="text" maxLength={256} spellCheck={false} autoComplete="off" value={draft?.indexing ?? ''}
          placeholder="provider/model:effort" disabled={!settings || operation !== null}
          onChange={event => setDraftModels({ ...(draftRef.current ?? { builtin: '', indexing: '' }), indexing: event.target.value })} />
      </label>
      <p className="cloud-detail">Reserved for future indexing; not running yet. Blank will inherit the built-in default.</p>
      <p className="cloud-detail">Use <code>provider/model:effort</code>, or <code>model:effort</code> for configured provider fallback. Saving makes no model calls and does not check availability.</p>
      <div className="cloud-actions cloud-management-actions">
        <button type="button" className="cloud-button" disabled={operation !== null}
          onClick={() => { void loadSettings(true) }}>{settings ? 'Reload settings' : 'Retry loading'}</button>
        <button type="button" className="cloud-button" disabled={!settings || !draft || !dirty || needsReload || operation !== null}
          onClick={() => { void saveSettings() }}>Save settings</button>
      </div>
      {needsReload && !error && <p className="cloud-management-conflict" role="status">Workspace settings changed. Reload before saving.</p>}
      {operation && <p className="cloud-status" role="status">{operation === 'loading' ? 'Loading workspace settings…' : 'Saving workspace settings…'}</p>}
      {!operation && status && <p className="cloud-status" role="status">{status}</p>}
      {error && <p className="cloud-error" role="alert">{error}</p>}
      {auth && <a className="cloud-management-signin" href="/" target="_blank" rel="noopener noreferrer">Sign in, then retry</a>}
    </div>
  </section>
}
