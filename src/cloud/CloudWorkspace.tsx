import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ReadDocument } from '../canvas/ReadDocument'
import { initializeDocument } from '../document/initialize'
import { createDocument, type MoteDocument } from '../document/model'
import { loadDraft } from '../document/storage'
import { useMedia } from '../app/useMedia'
import { uiThemeVariables } from '../theme/ui'
import { CloudError, cloudRequest, mergeDocumentMeta, mergePrivacyMeta, normalizeDocumentMeta, type CloudDocument, type DocumentMeta } from './api'
import { FilesWindow } from './FilesWindow'
import { WorkingCopy } from './WorkingCopy'
import { deleteWorkingCopy, listWorkingCopies, loadWorkingCopy, saveWorkingCopy, workingSession, type WorkingRecord } from './workingCopies'
import './workspace.css'
import { connectionSnapshot } from './connection'

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
  const small = useMedia('(max-width: 1050px)')
  const style = useMemo(() => loaded && uiThemeVariables(loaded.document.theme), [loaded])
  useEffect(() => {
    let active = true
    void sharedDocument(token).then(value => { if (active) { setLoaded(value); document.title = `${value.name} · Mote` } },
      error => { if (active) setError(error instanceof CloudError && error.status === 404 ? 'This sharing link is unavailable or has been revoked.' : 'This shared document could not be opened.') })
    return () => { active = false }
  }, [token])
  if (!loaded) return <main className="loading"><h1>Mote</h1><p role={error ? 'alert' : 'status'}>{error || 'Opening shared document…'}</p></main>
  return <div className="app" style={style}><main className="workspace reader"><ReadDocument initial={loaded.document} minimap={!small} /></main></div>
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
  const [copy, setCopy] = useState<WorkingCopy>()
  const [filesOpen, setFilesOpen] = useState(!id)
  const [loading, setLoading] = useState(!!id)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [legacy, setLegacy] = useState<MoteDocument>()
  const [recoveries, setRecoveries] = useState<WorkingRecord[]>([])
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const navigation = useRef(0)
  const current = useRef({ copy, path })
  current.current = { copy, path }

  const refreshRecovery = () => listWorkingCopies().then(rows => setRecoveries(rows.filter(row => row.dirty || row.pending))).catch(() => setNotice('Local recovery storage could not be read.'))
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
    setError(''); setCopy(undefined); setLoading(!!id)
    if (!id) { setFilesOpen(true); return }
    async function open() {
      try {
        const session = await workingSession(), key = `${session}:${id}`
        let local = await loadWorkingCopy(key)
        if (!active) return
        const [cloudResult, privacyResult] = await Promise.allSettled([
          cloudRequest<CloudDocument>(`/api/documents/${id}`),
          cloudRequest<DocumentMeta>(`/api/documents/${id}/privacy`),
        ])
        const cloud = cloudResult.status === 'fulfilled' ? cloudResult.value : undefined
        const privacy = privacyResult.status === 'fulfilled' ? privacyResult.value : undefined
        const networkError = cloudResult.status === 'rejected' ? cloudResult.reason : undefined
        if (!active) return
        if (!local && !cloud) throw networkError
        // A dirty local copy is never replaced merely because the cloud has moved on.
        if (cloud && (!local || !local.dirty && !local.pending)) {
          const { document, ...meta } = cloud
          const pendingPrivacy = local?.pendingPrivacy
          local = { key, session, meta: local ? mergeDocumentMeta(local.meta, meta) : normalizeDocumentMeta(meta), document, dirty: false, updatedAt: Date.now(),
            ...(pendingPrivacy ? { pendingPrivacy } : {}) }
        }
        if (local) {
          local = { ...local, meta: normalizeDocumentMeta(local.meta) }
          if (cloud) local.meta = mergePrivacyMeta(local.meta, cloud)
          if (privacy) local.meta = mergePrivacyMeta(local.meta, privacy)
        }
        try { local!.document = initializeDocument(local!.document) }
        catch {
          if (!window.confirm('This V0 document could not be opened. Reset it to the example? This replaces both the local working copy and the cloud document.')) throw new Error('The saved document has not been changed.')
          if (!cloud) throw new Error('Connect to the server before resetting this document.')
          const document = { ...createDocument(), id }
          const reset = await cloudRequest<CloudDocument>(`/api/documents/${id}`, 'PUT', {
            baseRevision: cloud.revision, document, operationId: crypto.randomUUID(),
          })
          const { document: next, ...meta } = reset
          local = { key, session, meta: mergeDocumentMeta(local!.meta, meta), document: next, dirty: false, updatedAt: Date.now() }
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

  async function navigate(next: string, reload = false) {
    if (next === id && copy && !reload) { setFilesOpen(false); return }
    const request = ++navigation.current
    if (copy) {
      if (!connectionSnapshot().offline) await copy.sync()
      try { await copy.flushLocal() }
      catch { setNotice('Local saving failed. Keep this document open and retry before switching.'); return }
      if (copy.getSnapshot().record.dirty) setNotice('Changes to the previous document remain on this device. Open Local recovery to find them.')
    }
    if (request !== navigation.current) return
    const path = next ? `/d/${next}` : '/'
    history.pushState(null, '', path); onPath(path)
    if (next === id) setRetry(value => value + 1)
    await refreshRecovery()
  }
  async function importLegacy() {
    if (!legacy) return
    const document = initializeDocument(structuredClone(legacy)), id = crypto.randomUUID()
    await cloudRequest('/api/documents', 'POST', { id, document: { ...document, id }, name: 'Imported local draft', operationId: id })
    setLegacy(undefined)
    await navigate(id)
  }
  async function recover(record: WorkingRecord) {
    try {
      const session = await workingSession(), key = `${session}:${record.meta.id}`
      if (copy?.getSnapshot().record.key === record.key) { setRecoveryOpen(false); return }
      if (copy?.getSnapshot().record.key === key && copy.getSnapshot().record.dirty) {
        setNotice('Open this recovery in a new tab so it does not replace the current unsynced working copy.'); return
      }
      const existing = await loadWorkingCopy(key)
      if (existing?.dirty && existing.key !== record.key) { setNotice('This tab already has pending changes for that document. Open a new tab to recover this copy.'); return }
      await saveWorkingCopy({ ...record, key, session })
      setRecoveryOpen(false)
      await navigate(record.meta.id, true)
    } catch (error) { setNotice((error as Error).message) }
  }

  return <>
    {copy ? renderDocument(copy, () => { setFilesOpen(true); void refreshRecovery() }, next => void navigate(next)) : <main className="loading cloud-home"><h1>Mote</h1>
      <p>{loading ? 'Opening document…' : error || 'Your private document workspace.'}</p>
      {!!error && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}
      <button onClick={() => setFilesOpen(true)}>Files</button>
    </main>}
    {notice && <div className="cloud-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
    <FilesWindow open={filesOpen} onClose={() => setFilesOpen(false)} currentId={id} onOpen={next => void navigate(next)}
      onLocalRecovery={() => { setFilesOpen(false); void refreshRecovery(); setRecoveryOpen(true) }}
      hasLocalDraft={!!legacy} onImportLocal={importLegacy} pending={Object.fromEntries(recoveries.map(row => [row.meta.id, 'Changes on this device']))} />
    {recoveryOpen && <LocalRecovery onClose={() => setRecoveryOpen(false)}>
      <h2>Local recovery</h2><p>Independent working copies with changes not confirmed in the cloud. Recovering never merges versions.</p>
      {notice && <p role="alert">{notice}</p>}
      {recoveries.length === 0 && <p>No pending working copies.</p>}
      {recoveries.map(record => <div key={record.key}><strong>{record.meta.name}</strong><time>{new Date(record.updatedAt).toLocaleString()}</time>
        <button onClick={() => void recover(record)}>Open working copy</button>
        <button onClick={() => {
          if (record.key === copy?.getSnapshot().record.key) { setNotice('Use Discard local changes in the open document.'); return }
          if (window.confirm('Permanently discard this local working copy?')) void deleteWorkingCopy(record.key).then(refreshRecovery)
        }}>Discard</button></div>)}
      <button onClick={() => setRecoveryOpen(false)}>Close</button>
    </LocalRecovery>}
  </>
}

function LocalRecovery({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close() }, [])
  return <dialog ref={dialog} className="cloud-local-recovery" aria-label="Local recovery" onCancel={event => { event.preventDefault(); onClose() }}>{children}</dialog>
}
