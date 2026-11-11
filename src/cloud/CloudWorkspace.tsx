import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ReaderPage } from '../reader/ReaderPage'
import { validateDocument } from '../document/validate'
import { initializeDocument } from '../document/initialize'
import { DOCUMENT_VERSION, migrationBreaking } from '../../shared/document.mjs'
import type { Reservation } from '../ai/types'
import { createDocument, createBlankDocument, type MoteDocument } from '../document/model'
import { setSlides } from '../document/slides'
import { loadDraft } from '../document/storage'
import { useMedia } from '../app/useMedia'
import { uiThemeVariables } from '../theme/ui'
import { CloudError, cloudRequest, mergeDocumentMeta, mergeDocumentFlags, normalizeDocumentMeta, type CloudDocument, type DocumentMeta } from './api'
import { FilesWindow } from './FilesWindow'
import type { NewFileOptions } from './NewFileForm'
import { WorkingCopy } from './WorkingCopy'
import { createCopyRecord, deleteWorkingCopy, forkWorkingCopy, listWorkingCopies, loadWorkingCopy, saveWorkingCopy, workingSession, type WorkingRecord } from './workingCopies'
import { loadAssistantRecovery, listAssistantRecoveries } from '../ai/storage'
import './workspace.css'
import { connectionSnapshot, isRecord, requestJSON } from './connection'

export const loginURL = () => location.pathname
const shareRequests = new Map<string, Promise<{ name: string; document: MoteDocument }>>()
function sharedDocument(token: string) {
  let request = shareRequests.get(token)
  if (!request) {
    request = cloudRequest<{ name: string; document: MoteDocument }>(`/api/shared/${encodeURIComponent(token)}`)
      .then(value => ({ ...value, document: initializeDocument(value.document) }))
    shareRequests.set(token, request)
  }
  return request
}

function SharedPage({ token }: { token: string }) {
  const [loaded, setLoaded] = useState<{ name: string; document: MoteDocument }>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void sharedDocument(token).then(value => { if (active) { setLoaded(value); document.title = `${value.name} · Mote` } },
      error => { if (active) setError(error instanceof CloudError && error.status === 404 ? 'This sharing link is unavailable or has been revoked.' : error instanceof Error ? `${error.message}. Ask the owner for a supported V1–V6 document.` : 'This shared document could not be opened.') })
    return () => { active = false }
  }, [token])
  if (!loaded) return <main className="loading"><h1>Mote</h1><p role={error ? 'alert' : 'status'}>{error || 'Opening shared document…'}</p></main>
  return <ReaderPage initial={loaded.document} />
}

// Release through the same document CAS; legacy assistant checkpoints are inert.
async function releaseTasks(record: WorkingRecord, tasks: Reservation[]) {
  const saved = await loadWorkingCopy(record.key)
  const copy = new WorkingCopy(saved && (saved.dirty || saved.pending || saved.pendingCreate) ? saved : record)
  const current = copy.getSnapshot().record, ids = new Set(tasks.map(task => task.id))
  copy.update(current.document, current.reservations.map(task => ids.has(task.id) ? { ...task, released: true } : task))
  if (!await copy.sync(true)) throw new Error(copy.getSnapshot().error || 'The release could not be confirmed. Retry to continue.')
}

type RenderDocument = (copy: WorkingCopy, files: () => void, open: (id: string) => void) => ReactNode
export function CloudWorkspace({ renderDocument }: { renderDocument: RenderDocument }) {
  const [path, setPath] = useState(location.pathname)
  const shared = /^\/s\/([^/]+)\/?$/.exec(path)
  if (shared) return <SharedPage key={shared[1]} token={shared[1]} />
  return <PrivateWorkspace path={path} onPath={setPath} renderDocument={renderDocument} />
}

function PrivateWorkspace({ path, onPath, renderDocument }: {
  path: string; onPath: (path: string) => void; renderDocument: RenderDocument
}) {
  const id = /^\/d\/([\da-f-]+)\/?$/.exec(path)?.[1] ?? ''
  const mobile = useMedia('(max-width: 767px)')
  const [copy, setCopy] = useState<WorkingCopy>()
  const [filesOpen, setFilesOpen] = useState(!id)
  const [loading, setLoading] = useState(!!id)
  const [error, setError] = useState('')
  const [unopened, setUnopened] = useState<WorkingRecord>()
  const [upgrade, setUpgrade] = useState<{ record: WorkingRecord; tasks: Reservation[]; busy?: boolean; error?: string }>()
  const [readOnly, setReadOnly] = useState<{ record: WorkingRecord; document: MoteDocument }>()
  const [upgradeChoice, setUpgradeChoice] = useState<'upgrade' | 'decline'>()
  const [retry, setRetry] = useState(0)
  const [legacy, setLegacy] = useState<unknown>()
  const [recoveries, setRecoveries] = useState<WorkingRecord[]>([])
  const [notice, setNotice] = useState('')
  const navigation = useRef(0)
  const current = useRef({ copy, path })
  current.current = { copy, path }
  useEffect(() => () => copy?.cancelEarlySync(), [copy])

  const refreshRecovery = () => Promise.all([listWorkingCopies(), listAssistantRecoveries().catch(() => {
    setNotice('Assistant recovery storage could not be read. Document recovery is still available.')
    return []
  })]).then(([rows, assistants]) => {
    const pending = new Set(assistants.filter(record => record.dirty || record.pending).map(record => record.workingCopyId))
    setRecoveries(rows.filter(row => {
      try { validateDocument(row.document) } catch { return true }
      return row.dirty || row.pending || row.pendingCreate || row.pendingPrivacy || row.pendingCopy || pending.has(row.key)
    }))
  }).catch(() => setNotice('Local recovery storage could not be read.'))
  useEffect(() => {
    void loadDraft().then(setLegacy).catch(() => {})
    void refreshRecovery()
    const pop = async () => {
      const request = ++navigation.current, target = location.pathname, previous = current.current
      if (previous.copy) {
        if (!connectionSnapshot().offline) await previous.copy.sync()
        try { await previous.copy.flushLocal() }
        catch {
          if (request !== navigation.current) return
          history.pushState(null, '', previous.path)
          setNotice('Local saving failed. Back navigation was canceled to preserve your edits. Keep this tab open and retry.')
          return
        }
      }
      if (request === navigation.current) onPath(target)
    }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [onPath])

  useEffect(() => {
    let active = true
    setError(''); setUnopened(undefined); setUpgrade(undefined); setReadOnly(undefined); setCopy(undefined); setLoading(!!id)
    const choice = upgradeChoice; setUpgradeChoice(undefined)
    if (!id) { setFilesOpen(true); return }
    async function open() {
      try {
        const session = await workingSession(), key = `${session}:${id}`
        let local = await loadWorkingCopy(key)
        if (!local) {
          const draft = (await listWorkingCopies()).find(record => record.meta.id === id && record.draft)
          if (draft) local = await forkWorkingCopy(draft, session)
        }
        if (!active) return
        const [cloudResult, privacyResult] = local?.draft ? [] : await Promise.allSettled([
          cloudRequest<CloudDocument>(`/api/documents/${id}`),
          cloudRequest<DocumentMeta>(`/api/documents/${id}/privacy`),
        ])
        const cloud = cloudResult?.status === 'fulfilled' ? cloudResult.value : undefined
        const privacy = privacyResult?.status === 'fulfilled' ? privacyResult.value : undefined
        const networkError = cloudResult?.status === 'rejected' ? cloudResult.reason : undefined
        if (!active) return
        if (!local && !cloud) throw networkError
        // A dirty local copy is never replaced merely because the cloud has moved on.
        if (cloud && (!local || !local.dirty && !local.pending)) {
          const { document, reservations = [], ...meta } = cloud
          const pendingPrivacy = local?.pendingPrivacy
          const pendingCopy = local?.pendingCopy
          local = { key, session, meta: local ? mergeDocumentMeta(local.meta, meta) : normalizeDocumentMeta(meta), document, reservations, dirty: false, updatedAt: Date.now(),
            ...(pendingPrivacy ? { pendingPrivacy } : {}), ...(pendingCopy ? { pendingCopy } : {}) }
        }
        if (local) {
          local = { ...local, meta: normalizeDocumentMeta(local.meta) }
          if (cloud) local.meta = mergeDocumentFlags(local.meta, cloud)
          if (privacy) local.meta = mergeDocumentFlags(local.meta, privacy)
        }
        const stored = local!.document
        try {
          // A breaking upgrade of a document with unresolved AI tasks waits for the owner.
          if (stored.version < DOCUMENT_VERSION && migrationBreaking(stored.version) && choice !== 'upgrade') {
            const document = initializeDocument(stored, true)
            if (choice === 'decline') { setReadOnly({ record: local!, document }); setLoading(false); return }
            const tasks = local!.reservations.filter(task => !task.released)
            if (!active) return
            if (tasks.length) { setUpgrade({ record: local!, tasks }); setLoading(false); return }
          }
          local!.document = initializeDocument(stored)
          // Loading never writes to the cloud; the next ordinary save persists the upgrade.
          if (local!.document !== stored) local!.migratedFrom ??= stored
        } catch (error) {
          setUnopened(local)
          throw new Error(`${error instanceof Error ? error.message.replace(/[.\s]+$/, '') : 'Unsupported document format'}. Pending AI work and local data are retained. Download recovery below, or open a supported V1–V6 document.`)
        }
        if (!active) return
        await saveWorkingCopy(local!)
        if (!active) return
        const opened = new WorkingCopy(local!)
        setCopy(opened); setFilesOpen(false); setLoading(false)
        document.title = `${local!.meta.name} · Mote`
        if (networkError) setNotice('Showing the local working copy. Cloud access is currently unavailable.')
      } catch (error) {
        if (!active) return
        if (error instanceof CloudError && error.status === 401) { location.assign(loginURL()); return }
        setError(error instanceof Error ? error.message : 'The document could not be opened.'); setLoading(false)
      }
    }
    void open()
    return () => { active = false }
  }, [id, retry])

  async function confirmUpgrade() {
    if (!upgrade) return
    setUpgrade({ ...upgrade, busy: true, error: '' })
    try { await releaseTasks(upgrade.record, upgrade.tasks); setUpgradeChoice('upgrade'); setRetry(value => value + 1) }
    catch (error) { setUpgrade({ ...upgrade, busy: false, error: `${error instanceof Error ? error.message : 'Release failed'}. The upgrade has not continued. Local edits and release retry details are retained.` }) }
  }

  async function navigate(next: string, reload = false, draft?: WorkingRecord) {
    if (next === id && copy && !reload) { setFilesOpen(false); return true }
    const request = ++navigation.current
    if (copy) {
      if (!connectionSnapshot().offline) await copy.sync()
      try { await copy.flushLocal() }
      catch { setNotice('Local saving failed. Keep this document open and retry before switching.'); return false }
      if (copy.getSnapshot().record.dirty) setNotice('Changes to the previous document remain on this device. Open Local recovery to find them.')
    }
    if (request !== navigation.current) return false
    if (draft) await forkWorkingCopy(draft, await workingSession())
    const path = next ? `/d/${next}` : '/'
    history.pushState(null, '', path); onPath(path)
    if (next === id) setRetry(value => value + 1)
    await refreshRecovery()
    return true
  }
  async function newDocument(options: NewFileOptions) {
    let document = initializeDocument(options.example ? createDocument(options) : createBlankDocument())
    document.theme.appearance.mode = options.mode
    document.language = options.language
    if (!options.example && options.slideHeight !== undefined) document = setSlides(document, true, options.slideHeight)
    const session = await workingSession(), now = Date.now(), name = options.name.trim() || (options.example ? 'Example' : 'Untitled')
    const retain = options.example || options.modified
    const record: WorkingRecord = { key: `${session}:${document.id}`, session, document, reservations: [], dirty: retain, draft: true, updatedAt: now,
      draftDefaults: { mode: options.mode, language: options.language },
      ...(retain ? { pendingCreate: { id: document.id, operationId: crypto.randomUUID(), name, document, reservations: [], private: options.private } } : {}),
      meta: { id: document.id, name, revision: '', createdAt: now, updatedAt: now, private: false, privacyRevision: 0, archived: false, archiveRevision: 0 } }
    if (!await navigate(document.id, false, record)) throw new Error('The current document could not be left safely. Retry after saving its local changes.')
  }
  async function importDocument(document: MoteDocument, name: string) {
    const record = createCopyRecord(document, name, await workingSession())
    if (!await navigate(record.meta.id, false, record)) throw new Error('The current document could not be left safely. Retry after saving its local changes.')
  }
  async function downloadRecovery(record: WorkingRecord) {
    const results = await Promise.allSettled([
      loadAssistantRecovery(record.key, record.meta.id),
      record.draft ? Promise.resolve(undefined) : requestJSON<{ revision: string; tasks: unknown[] }>(`/api/documents/${encodeURIComponent(record.meta.id)}/assistant`, 'GET', undefined,
        value => isRecord(value) && typeof value.revision === 'string' && Array.isArray(value.tasks)),
    ])
    const [local, cloud] = results
    const unavailable = results.flatMap((result, index) => result.status === 'rejected'
      ? [`${index ? 'Cloud' : 'Local'} assistant recovery: ${result.reason instanceof Error ? result.reason.message : 'unavailable'}`] : [])
    downloadJSON({ workingCopy: record,
      ...(local.status === 'fulfilled' && local.value && { assistant: local.value }),
      ...(cloud.status === 'fulfilled' && cloud.value && { cloudAssistant: cloud.value }),
      ...(unavailable.length && { unavailable }) }, `mote-recovery-${record.meta.id}.json`)
    if (unavailable.length) setNotice(`Working copy downloaded. ${unavailable.join(' ')} The retained data has not been changed.`)
  }

  async function recover(record: WorkingRecord) {
    try {
      const session = await workingSession(), key = `${session}:${record.meta.id}`
      if (copy?.getSnapshot().record.key === record.key) { setFilesOpen(false); return }
      if (copy?.getSnapshot().record.key === key) {
        setNotice('Open this recovery in a new tab so it does not replace the current working copy or assistant input.'); return
      }
      const existing = await loadWorkingCopy(key)
      if (existing && (existing.dirty || existing.pending || existing.pendingCreate || existing.pendingPrivacy || existing.pendingCopy) && existing.key !== record.key) { setNotice('This tab already has pending changes for that document. Open a new tab to recover this copy.'); return }
      if (await navigate(record.meta.id, true, record)) setFilesOpen(false)
    } catch (error) { setNotice((error as Error).message) }
  }

  return <>
    {readOnly ? <ReaderPage initial={readOnly.document} notice={<div className="cloud-sync-actions" role="status">
      <p>Read-only at V{readOnly.document.version}. Upgrading needs your confirmation because unresolved AI tasks would be released.</p>
      <button onClick={() => void downloadRecovery(readOnly.record)}>Download recovery</button>
      <button onClick={() => setRetry(value => value + 1)}>Review upgrade</button>
      <button onClick={() => setFilesOpen(true)}>Files</button>
    </div>} />
    : upgrade ? <main className="loading cloud-home"><h1>Upgrade document?</h1>
      <p>This document is V{upgrade.record.document.version}. Upgrading to V{DOCUMENT_VERSION} releases {upgrade.tasks.length === 1 ? 'its unresolved AI task' : `its ${upgrade.tasks.length} unresolved AI tasks`} and
        permanently revokes their agent access. Their inputs and candidates stay downloadable. Open read-only to keep them at the stored version.</p>
      {upgrade.error && <p role="alert">{upgrade.error}</p>}
      <button disabled={upgrade.busy} onClick={() => void confirmUpgrade()}>Upgrade and release</button>
      <button disabled={upgrade.busy} onClick={() => { setUpgradeChoice('decline'); setRetry(value => value + 1) }}>Open read-only</button>
      <button disabled={upgrade.busy} onClick={() => void downloadRecovery(upgrade.record)}>Download recovery</button>
    </main>
    : copy ? renderDocument(copy, () => { setFilesOpen(true); void refreshRecovery() }, next => void navigate(next)) : <main className="loading cloud-home"><h1>Mote</h1>
      <p>{loading ? 'Opening document…' : error || 'Your private document workspace.'}</p>
      {!!error && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}
      {unopened && <button onClick={() => void downloadRecovery(unopened)}>Download recovery</button>}
      {(!mobile || !id) && <button onClick={() => setFilesOpen(true)}>Files</button>}
    </main>}
    <WorkspaceOverlays copy={copy}>
    {notice && <div className="cloud-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
    <FilesWindow open={filesOpen && (!mobile || !id)} onClose={() => setFilesOpen(false)} currentId={id} copy={copy} onOpen={next => void navigate(next)} onNew={newDocument} onImport={importDocument}
      onRecoveryOpen={() => void refreshRecovery()} recoveryCount={recoveries.length}
      pending={Object.fromEntries(recoveries.map(row => [row.meta.id, 'Changes on this device']))}
      recovery={<div className="files-recovery">
        <p className="cloud-hint">Working copies with changes not confirmed in the cloud. Recovering never merges versions.</p>
        {notice && <p className="cloud-error" role="alert">{notice}</p>}
        {recoveries.length === 0 && <p className="files-section-empty">No pending working copies.</p>}
        {legacy !== undefined && <button type="button" className="cloud-button" onClick={() => downloadJSON(legacy, 'mote-local-draft.json')}>Download earlier local draft</button>}
        <ul className="files-recovery-list" aria-label="Local working copies">
          {recoveries.map(record => <li key={record.key}>
            <strong>{record.meta.name}</strong><time dateTime={new Date(record.updatedAt).toISOString()}>{new Date(record.updatedAt).toLocaleString()}</time>
            <div className="cloud-actions">
              <button type="button" className="cloud-button" onClick={() => void recover(record)}>Open working copy</button>
              <button type="button" className="cloud-button" onClick={() => { void downloadRecovery(record).catch(error => setNotice((error as Error).message)) }}>Download recovery</button>
              <button type="button" className="cloud-button files-quiet cloud-danger" onClick={event => {
                if (record.key === copy?.getSnapshot().record.key) { setNotice('Use Discard local changes in the open document.'); return }
                const toggle = event.currentTarget.closest('.files-section')?.querySelector<HTMLButtonElement>('.files-section-toggle')
                if (window.confirm('Permanently discard this local working copy?')) void deleteWorkingCopy(record.key).then(refreshRecovery)
                  .then(() => toggle?.focus()).catch(error => setNotice((error as Error).message))
              }}>Discard</button>
            </div>
          </li>)}
        </ul>
      </div>} />
    </WorkspaceOverlays>
  </>
}

const noSubscription = () => () => {}
const noSnapshot = () => undefined
function WorkspaceOverlays({ copy, children }: { copy?: WorkingCopy; children: ReactNode }) {
  const state = useSyncExternalStore(copy?.subscribe ?? noSubscription, copy?.getSnapshot ?? noSnapshot)
  const theme = state?.record.document.theme, language = state?.record.document.language
  const style = useMemo(() => theme && uiThemeVariables(theme, language ?? 'en'), [theme, language])
  return <div className="workspace-overlays" style={style}>{children}</div>
}

function downloadJSON(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
