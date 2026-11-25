import { useEffect, useRef, useState } from 'react'
import { isRecord, requestJSON, RequestError } from './connection'
import { ModelField } from '../app/ModelField'

interface WorkspaceSettings {
  revision: number
  models: { builtin: string }
}

function requestSettings(method: 'GET' | 'PUT', body: unknown, controller: AbortController) {
  return requestJSON<WorkspaceSettings>('/api/settings', method, body, value => isRecord(value) && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0 && isRecord(value.models) && typeof value.models.builtin === 'string' && value.models.builtin.length <= 256,
  { signal: controller.signal })
}

export function WorkspaceSettings({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [operation, setOperation] = useState<'loading' | 'saving' | null>(null)
  const [error, setError] = useState('')
  const [auth, setAuth] = useState(false)
  const [status, setStatus] = useState('')
  const [needsReload, setNeedsReload] = useState(false)
  const settingsRef = useRef<WorkspaceSettings | null>(null)
  const draftRef = useRef<string | null>(null)
  const baselineRef = useRef<string | null>(null)
  const needsReloadRef = useRef(false)
  const locked = useRef(false)
  const mounted = useRef(true)
  const controllerRef = useRef<AbortController | null>(null)
  const dirty = draft !== null && draft !== baselineRef.current

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; controllerRef.current?.abort() }
  }, [])

  function setDraftSettings(value: string) {
    draftRef.current = value
    setDraft(value)
  }

  function setReloadRequired(value: boolean) {
    needsReloadRef.current = value
    setNeedsReload(value)
  }

  function acceptSettings(incoming: WorkspaceSettings, replaceDraft: boolean) {
    const previous = settingsRef.current
    const currentDraft = draftRef.current
    const hasChanges = currentDraft !== null && currentDraft !== baselineRef.current
    settingsRef.current = incoming
    setSettings(incoming)

    if (replaceDraft || !hasChanges && !needsReloadRef.current) {
      baselineRef.current = incoming.models.builtin
      setDraftSettings(incoming.models.builtin)
      setReloadRequired(false)
    } else if (previous && previous.revision !== incoming.revision) {
      setReloadRequired(true)
    }
  }

  function reportError(cause: unknown, fallback: string) {
    const code = cause instanceof RequestError ? cause.status : 0
    if (code === 409) setReloadRequired(true)
    setAuth(code === 401)
    setError(code === 401 ? 'Sign in to manage the workspace, then retry.'
      : code === 409 ? 'Workspace settings changed. Reload before saving.'
      : cause instanceof RequestError ? cause.message : fallback)
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
      if (mounted.current) reportError(cause, 'Could not load workspace settings.')
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      locked.current = false
      if (mounted.current) setOperation(null)
    }
  }

  async function saveSettings() {
    const current = settingsRef.current
    const builtin = draftRef.current
    if (locked.current || !current || builtin === null || needsReloadRef.current || builtin === baselineRef.current) return
    locked.current = true
    const controller = new AbortController()
    controllerRef.current = controller
    setOperation('saving')
    setError(''); setAuth(false); setStatus('')
    try {
      const result = await requestSettings('PUT', { baseRevision: current.revision, models: { builtin } }, controller)
      if (mounted.current) {
        acceptSettings(result, true)
        setStatus('Workspace settings saved.')
      }
    } catch (cause) {
      if (mounted.current) reportError(cause, 'Could not save workspace settings.')
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      locked.current = false
      if (mounted.current) setOperation(null)
    }
  }

  useEffect(() => {
    if (!active) return
    let canceled = false
    queueMicrotask(() => { if (!canceled) void loadSettings(false) })
    return () => { canceled = true }
  }, [active])

  return <section className="cloud-management" aria-label="Workspace management">
    <div className="cloud-management-panel">
      <p className="cloud-hint">Document model overrides take priority. Existing agent sessions keep their model.</p>
      <div className="cloud-field"><span>Built-in agent default model</span>
        <ModelField label="Built-in agent default model" value={draft ?? ''}
          placeholder="provider/model:effort" disabled={!settings || operation !== null}
          onChange={setDraftSettings} />
      </div>
      <p className="cloud-detail">Set a model here or in Document settings to use the built-in agent. Use <code>provider/model:effort</code> or <code>model:effort</code>.</p>
      <div className="cloud-actions cloud-management-actions">
        <button type="button" className="cloud-button" disabled={operation !== null}
          onClick={() => { void loadSettings(true) }}>{settings ? 'Reload settings' : 'Retry loading'}</button>
        <button type="button" className="cloud-button" disabled={!settings || !dirty || needsReload || operation !== null}
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
