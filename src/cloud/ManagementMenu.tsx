import { useEffect, useId, useRef, useState } from 'react'
import { requestJSON, RequestError } from './connection'

interface ModelSettings {
  builtin: string
  indexing: string
}

interface SettingsDraft {
  models: ModelSettings
  indexingEnabled: boolean
}

interface WorkspaceSettings {
  revision: number
  models: ModelSettings
  indexingEnabled: boolean
  serverDefaultModel: string | null
}

interface IndexedDocument {
  id: string
  name: string
  revision: string
  indexedRevision?: string
  status: string
  error?: string
}

interface IndexingStatus {
  enabled: boolean
  error?: string
  queued: number
  running: number
  ready: number
  failed: number
  documents: IndexedDocument[]
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
const sameSettings = (left: SettingsDraft, right: SettingsDraft) =>
  left.indexingEnabled === right.indexingEnabled && sameModels(left.models, right.models)

function parseSettings(value: unknown, status: number): WorkspaceSettings {
  if (!value || typeof value !== 'object') throw new SettingsRequestError('The workspace settings response was invalid.', status)
  const result = value as Partial<WorkspaceSettings>
  if (!Number.isSafeInteger(result.revision) || result.revision! < 0 || !result.models ||
    typeof result.models.builtin !== 'string' || result.models.builtin.length > 256 ||
    typeof result.models.indexing !== 'string' || result.models.indexing.length > 256 ||
    typeof result.indexingEnabled !== 'boolean' ||
    !(typeof result.serverDefaultModel === 'string' || result.serverDefaultModel === null)) {
    throw new SettingsRequestError('The workspace settings response was invalid.', status)
  }
  return result as WorkspaceSettings
}

function parseIndexingStatus(value: unknown): IndexingStatus {
  if (!value || typeof value !== 'object') throw new SettingsRequestError('The workspace indexing response was invalid.')
  const result = value as Partial<IndexingStatus>
  const count = (entry: unknown) => Number.isSafeInteger(entry) && (entry as number) >= 0
  if (typeof result.enabled !== 'boolean' || !count(result.queued) || !count(result.running) || !count(result.ready) || !count(result.failed) || !Array.isArray(result.documents)) {
    throw new SettingsRequestError('The workspace indexing response was invalid.')
  }
  const documents = result.documents.map((entry): IndexedDocument => {
    if (!entry || typeof entry !== 'object') throw new SettingsRequestError('The workspace indexing response was invalid.')
    const item = entry as Partial<IndexedDocument>
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.revision !== 'string' || typeof item.status !== 'string' ||
      item.indexedRevision !== undefined && typeof item.indexedRevision !== 'string' || item.error !== undefined && typeof item.error !== 'string') {
      throw new SettingsRequestError('The workspace indexing response was invalid.')
    }
    return item as IndexedDocument
  })
  return { enabled: result.enabled, error: typeof result.error === 'string' ? result.error : undefined,
    queued: result.queued!, running: result.running!, ready: result.ready!, failed: result.failed!, documents }
}

async function managementRequest<T>(path: string, method: string, body: unknown, controller: AbortController, parse: (value: unknown) => T): Promise<T> {
  try {
    const value = await requestJSON<unknown>(path, method, body, value => {
      try { parse(value); return true } catch { return false }
    }, { signal: controller.signal })
    return parse(value)
  } catch (error) {
    if (!(error instanceof RequestError)) throw error
    throw new SettingsRequestError(error.status === 401 ? 'Sign in to manage the workspace, then retry.'
      : error.status === 409 ? 'Workspace settings changed. Reload before saving.' : error.message, error.status)
  }
}
function requestIndexing(path: string, method: 'GET' | 'POST', controller: AbortController) {
  return managementRequest(path, method, undefined, controller, parseIndexingStatus)
}
function requestSettings(method: 'GET' | 'PUT', body: unknown, controller: AbortController) {
  return managementRequest('/api/settings', method, body, controller, value => parseSettings(value, 0))
}

export function ManagementMenu() {
  const panelId = useId()
  const [expanded, setExpanded] = useState(false)
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [operation, setOperation] = useState<'loading' | 'saving' | null>(null)
  const [error, setError] = useState('')
  const [auth, setAuth] = useState(false)
  const [status, setStatus] = useState('')
  const [needsReload, setNeedsReload] = useState(false)
  const settingsRef = useRef<WorkspaceSettings | null>(null)
  const draftRef = useRef<SettingsDraft | null>(null)
  const baselineRef = useRef<SettingsDraft | null>(null)
  const needsReloadRef = useRef(false)
  const locked = useRef(false)
  const mounted = useRef(true)
  const controllerRef = useRef<AbortController | null>(null)
  const [indexingExpanded, setIndexingExpanded] = useState(false)
  const [indexing, setIndexing] = useState<IndexingStatus | null>(null)
  const [indexingLoading, setIndexingLoading] = useState(false)
  const [indexingError, setIndexingError] = useState('')
  const [indexingStatus, setIndexingStatus] = useState('')
  const [retryNeedsRefresh, setRetryNeedsRefresh] = useState(false)
  const indexingLocked = useRef(false)
  const indexingController = useRef<AbortController | null>(null)
  const dirty = !!draft && !!baselineRef.current && !sameSettings(draft, baselineRef.current)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; controllerRef.current?.abort(); indexingController.current?.abort() }
  }, [])

  function setDraftSettings(value: SettingsDraft) {
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
    const baseline = baselineRef.current
    const hasChanges = !!currentDraft && !!baseline && !sameSettings(currentDraft, baseline)
    settingsRef.current = incoming
    setSettings(incoming)

    if (replaceDraft || !currentDraft) {
      const next = { models: incoming.models, indexingEnabled: incoming.indexingEnabled }
      baselineRef.current = next
      setDraftSettings(next)
      setReloadRequired(false)
    } else if (needsReloadRef.current) {
      return
    } else if (!hasChanges) {
      const next = { models: incoming.models, indexingEnabled: incoming.indexingEnabled }
      baselineRef.current = next
      setDraftSettings(next)
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
      (baselineRef.current && sameSettings(models, baselineRef.current))) return
    locked.current = true
    const controller = new AbortController()
    controllerRef.current = controller
    setOperation('saving')
    setError(''); setAuth(false); setStatus('')
    try {
      const result = await requestSettings('PUT', { baseRevision: current.revision, models: models.models, indexingEnabled: models.indexingEnabled }, controller)
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

  async function loadIndexing() {
    if (indexingLocked.current) return false
    indexingLocked.current = true
    const controller = new AbortController()
    indexingController.current = controller
    setIndexingLoading(true); setIndexingError(''); setIndexingStatus('')
    try {
      const incoming = parseIndexingStatus(await requestIndexing('/api/indexing', 'GET', controller))
      if (mounted.current) { setIndexing(incoming); setRetryNeedsRefresh(false) }
      return true
    } catch (cause) {
      if (mounted.current) setIndexingError((cause as Error).message)
      return false
    } finally {
      if (indexingController.current === controller) indexingController.current = null
      indexingLocked.current = false
      if (mounted.current) setIndexingLoading(false)
    }
  }

  async function retryIndexing() {
    if (indexingLocked.current || retryNeedsRefresh) return
    indexingLocked.current = true
    const controller = new AbortController()
    indexingController.current = controller
    setIndexingLoading(true); setIndexingError(''); setIndexingStatus('')
    let retryAccepted = false
    try {
      await requestIndexing('/api/indexing/retry', 'POST', controller)
      retryAccepted = true
      if (!mounted.current) return
      setIndexingStatus('Retry requested for failed or stopped indexing jobs.')
      setRetryNeedsRefresh(false)
      const status = parseIndexingStatus(await requestIndexing('/api/indexing', 'GET', controller))
      setIndexing(status)
    } catch (cause) {
      if (mounted.current) {
        setIndexingError(retryAccepted ? `Retry was accepted, but status could not be refreshed: ${(cause as Error).message}` : (cause as Error).message)
        setRetryNeedsRefresh(true)
      }
    } finally {
      if (indexingController.current === controller) indexingController.current = null
      indexingLocked.current = false
      if (mounted.current) setIndexingLoading(false)
    }
  }

  function toggleIndexingStatus() {
    if (indexingExpanded) setIndexingExpanded(false)
    else { setIndexingExpanded(true); void loadIndexing() }
  }

  const retryable = indexing?.documents.filter(item => item.status === 'failed' || item.status === 'stopped').length ?? 0
  const problemDocuments = indexing?.documents.filter(item => item.status === 'failed' || item.status === 'stopped') ?? []

  return <section className="cloud-management" aria-label="Workspace management">
    <button type="button" className="cloud-button cloud-management-toggle" aria-expanded={expanded}
      aria-controls={panelId} onClick={toggle}>
      <span>Management</span><span aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    <div className="cloud-management-panel" id={panelId} hidden={!expanded}>
      <p className="cloud-hint">Workspace model defaults. Document overrides take priority; existing agent sessions keep their model.</p>
      <label className="cloud-field">Built-in agent default model
        <input type="text" maxLength={256} spellCheck={false} autoComplete="off" value={draft?.models.builtin ?? ''}
          placeholder="provider/model:effort" disabled={!settings || operation !== null}
          onChange={event => setDraftSettings({ ...(draftRef.current ?? { models: { builtin: '', indexing: '' }, indexingEnabled: false }), models: { ...(draftRef.current?.models ?? { builtin: '', indexing: '' }), builtin: event.target.value } })} />
      </label>
      <p className="cloud-detail">Leave blank to use {settings?.serverDefaultModel ? <code>{settings.serverDefaultModel}</code> : 'Mu’s configured default'}.</p>
      <label className="cloud-field">Indexing model
        <input type="text" maxLength={256} spellCheck={false} autoComplete="off" value={draft?.models.indexing ?? ''}
          placeholder="provider/model:effort" disabled={!settings || operation !== null}
          onChange={event => setDraftSettings({ ...(draftRef.current ?? { models: { builtin: '', indexing: '' }, indexingEnabled: false }), models: { ...(draftRef.current?.models ?? { builtin: '', indexing: '' }), indexing: event.target.value } })} />
      </label>
      <p className="cloud-detail">Blank inherits the built-in agent default.</p>
      <p className="cloud-detail">Use <code>provider/model:effort</code>, or <code>model:effort</code> for configured provider fallback. Settings do not test model availability. Enabling auto-indexing authorizes background model calls.</p>
      <label className="cloud-check-field">
        <input type="checkbox" checked={draft?.indexingEnabled ?? false} disabled={!settings || operation !== null}
          onChange={event => setDraftSettings({ ...(draftRef.current ?? { models: { builtin: '', indexing: '' }, indexingEnabled: false }), indexingEnabled: event.target.checked })} />
        <span><strong>Auto-index documents</strong><small>Index full saved documents, including Private documents. The trusted indexing model may receive their full content. Work starts after 100 seconds without a cloud content save; disabling pauses jobs without deleting indexes or disabling retrieval.</small></span>
      </label>
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
      <section className="cloud-indexing-status">
        <button type="button" className="cloud-button cloud-indexing-toggle" aria-expanded={indexingExpanded}
          onClick={toggleIndexingStatus}><span>Indexing status</span><span aria-hidden="true">{indexingExpanded ? '−' : '+'}</span></button>
        {indexingExpanded && <div className="cloud-indexing-body">
          <div className="cloud-actions">
            <button type="button" className="cloud-button" disabled={indexingLoading} onClick={() => { void loadIndexing() }}>Refresh status</button>
            <button type="button" className="cloud-button" disabled={indexingLoading || retryNeedsRefresh || !indexing?.enabled || !retryable}
              onClick={() => { void retryIndexing() }}>Retry failed/stopped{retryable ? ` (${retryable})` : ''}</button>
          </div>
          {indexingLoading && <p className="cloud-status" role="status">{indexing ? 'Refreshing indexing status…' : 'Loading indexing status…'}</p>}
          {indexing && <>
            {indexing.error && <p className="cloud-error" role="alert">{indexing.error}</p>}
            <p className="cloud-indexing-counts" role="status">Auto-indexing {indexing.enabled ? 'enabled' : 'paused'} · {indexing.queued} queued · {indexing.running} running · {indexing.ready} ready · {indexing.failed} failed</p>
            {(indexing.queued > 0 || indexing.running > 0) && <p className="cloud-detail">Documents are queued after 100 seconds without a cloud content save. Private documents are included for trusted indexing.</p>}
            {!!problemDocuments.length && <ul className="cloud-indexing-problems">{problemDocuments.map(item => <li key={item.id}>
              <strong>{item.name}</strong> <span>({item.status})</span>{item.error && <p>{item.error}</p>}
            </li>)}</ul>}
            {!problemDocuments.length && !indexing.queued && !indexing.running && <p className="cloud-detail">No failed, stopped, or pending indexing jobs.</p>}
          </>}
          {indexingStatus && <p className="cloud-status" role="status">{indexingStatus}</p>}
          {indexingError && <p className="cloud-error" role="alert">{indexingError}</p>}
          {retryNeedsRefresh && <p className="cloud-management-conflict" role="status">Indexing state needs refreshing before another retry.</p>}
        </div>}
      </section>
    </div>
  </section>
}
