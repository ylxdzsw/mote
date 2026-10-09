import { useEffect, useId, useRef, useState } from 'react'
import { createDocument, paragraph, type MoteDocument } from '../document/model'
import { CloudError, cloudRequest, mergeDocumentMeta, normalizeDocumentMeta, type CloudDocument, type DocumentMeta } from './api'
import { ManagementMenu } from './ManagementMenu'
import './cloud.css'

interface Props {
  open: boolean
  onClose: () => void
  onOpen: (id: string) => void
  currentId?: string
  pending?: Record<string, string>
  onImportLocal?: () => Promise<void>
  hasLocalDraft?: boolean
  onLocalRecovery?: () => void
}

const documentPath = (id: string) => `/api/documents/${encodeURIComponent(id)}`
const date = (time: number) => new Date(time).toLocaleString()
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed. Please try again.'
const mergeList = (current: DocumentMeta[], incoming: DocumentMeta[]) => {
  const previous = new Map(current.map(item => [item.id, item]))
  return incoming.map(item => {
    const meta = normalizeDocumentMeta(item), old = previous.get(meta.id)
    return old ? mergeDocumentMeta(old, meta) : meta
  })
}

export function FilesWindow({ open, ...props }: Props) {
  return open ? <FilesDialog {...props} /> : null
}

function FilesDialog({ onClose, onOpen, currentId, pending = {}, onImportLocal, hasLocalDraft, onLocalRecovery }: Omit<Props, 'open'>) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const active = useRef(true)
  const locked = useRef(true)
  const [busy, setBusy] = useState('Loading files…')
  const [error, setError] = useState('')
  const [auth, setAuth] = useState(false)
  const [result, setResult] = useState('')
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState(currentId ?? '')
  const [action, setAction] = useState<'rename' | 'delete' | null>(null)
  const [name, setName] = useState('')
  const visible = documents.filter(item => item.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  const selected = visible.find(item => item.id === selectedId)

  useEffect(() => {
    let canceled = false
    const element = dialog.current!
    active.current = true
    element.showModal()
    void cloudRequest<{ documents: DocumentMeta[] }>('/api/documents')
      .then(data => { if (!canceled) setDocuments(current => mergeList(current, data.documents)) })
      .catch(error => { if (!canceled) { setError(message(error)); setAuth(error instanceof CloudError && error.status === 401) } })
      .finally(() => { if (!canceled) { locked.current = false; setBusy('') } })
    return () => { canceled = true; active.current = false; element.close() }
  }, [])

  async function refresh() {
    const data = await cloudRequest<{ documents: DocumentMeta[] }>('/api/documents')
    setDocuments(current => mergeList(current, data.documents))
  }

  async function run(label: string, task: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(label); setError(''); setResult(''); setAuth(false)
    try { await task() }
    catch (error) {
      let detail = message(error)
      setAuth(error instanceof CloudError && error.status === 401)
      if (active.current && error instanceof CloudError && [409, 410].includes(error.status)) {
        if (action === 'delete') setAction(null)
        try { await refresh(); detail += ' The file list has been refreshed; no overwrite was attempted.' }
        catch (refreshError) { detail += ` The file list could not be refreshed: ${message(refreshError)}` }
      }
      if (active.current) setError(detail)
    } finally {
      locked.current = false
      if (active.current) setBusy('')
    }
  }

  function openDocument(id: string) {
    if (!locked.current && active.current) onOpen(id)
  }

  async function create(source: MoteDocument, name: string) {
    const id = crypto.randomUUID()
    const created = await cloudRequest<CloudDocument>('/api/documents', 'POST', {
      id, name, document: { ...source, id }, operationId: crypto.randomUUID(),
    })
    if (!active.current) return
    setDocuments(items => {
      const meta = normalizeDocumentMeta(created), old = items.find(item => item.id === meta.id)
      return [old ? mergeDocumentMeta(old, meta) : meta, ...items.filter(item => item.id !== meta.id)]
    })
    setSelectedId(created.id); setFilter(''); setAction(null)
    setResult(`Created “${created.name}”.`)
    onOpen(created.id)
  }

  function newDocument(example = false) {
    void run('Creating document…', async () => {
      const document = createDocument()
      if (!example) { document.content = { type: 'doc', content: [paragraph('')] }; document.floating = [] }
      await create(document, example ? 'Example' : 'Untitled')
    })
  }

  function importFile(file: File) {
    void run('Importing as a new document…', async () => {
      const { decodeDocument } = await import('../document/file')
      const document = await decodeDocument(file)
      if (active.current) await create(document, file.name.replace(/\.(mote|html?)$/i, '').trim() || 'Untitled')
    })
  }

  return <dialog ref={dialog} className="cloud-dialog cloud-files" aria-labelledby={titleId} aria-busy={!!busy}
    onCancel={event => { event.preventDefault(); if (!locked.current) onClose() }} onKeyDown={event => event.stopPropagation()}>
    <header className="cloud-heading"><h1 id={titleId}>Files</h1>
      <button type="button" className="cloud-button cloud-close" aria-label="Close files" disabled={!!busy} onClick={onClose}>×</button>
    </header>
    <div className="cloud-body">
      <p className="cloud-hint">Import a .mote file or Mote-exported HTML as a new document. Existing files are unchanged.</p>
      <div className="cloud-actions">
        <button type="button" className="cloud-button" disabled={!!busy} onClick={() => newDocument()}>New document</button>
        <button type="button" className="cloud-button" disabled={!!busy} onClick={() => newDocument(true)}>Create from example</button>
        <button type="button" className="cloud-button" disabled={!!busy} onClick={() => input.current!.click()}>Import .mote / HTML…</button>
        <button type="button" className="cloud-button" disabled={!!busy} onClick={() => { void run('Refreshing files…', refresh) }}>Refresh</button>
        {onLocalRecovery && <button type="button" className="cloud-button" disabled={!!busy} onClick={onLocalRecovery}>Local recovery</button>}
      </div>
      <ManagementMenu />
      <input ref={input} type="file" accept=".mote,.html,.htm" hidden disabled={!!busy} aria-label="Import a Mote document or Mote-exported HTML" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) importFile(file)
      }} />
      {hasLocalDraft && onImportLocal && <div className="cloud-local-import">
        <p className="cloud-hint">A draft from this browser is available to import as a new cloud document.</p>
        <button type="button" className="cloud-button" disabled={!!busy} onClick={() => { void run('Importing local draft…', async () => {
          await onImportLocal(); if (active.current) { await refresh(); setResult('Local draft imported.') }
        }) }}>Import local draft</button>
      </div>}
      <label className="cloud-field">Filter by name<input type="search" value={filter} disabled={!!busy} onChange={event => {
        setFilter(event.target.value); setAction(null)
      }} /></label>
      <div className="cloud-file-list">
        <table className="cloud-table" aria-label="Cloud documents, most recently modified first">
          <thead><tr><th scope="col">Name</th><th scope="col">Modified</th></tr></thead>
          <tbody>{visible.map(item => <tr key={item.id} className={item.id === selectedId ? 'cloud-selected' : undefined}
            onClick={() => { if (!locked.current) { setSelectedId(item.id); setAction(null) } }} onDoubleClick={() => openDocument(item.id)}>
            <td><button type="button" className="cloud-file-choice" disabled={!!busy} aria-pressed={item.id === selectedId}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); openDocument(item.id) } }}>
              <span className="cloud-file-name">{item.name}</span>
              {item.private && <span className="cloud-private-badge">Private</span>}
              {item.id === currentId && <span className="cloud-detail">Current document</span>}
              {pending[item.id] && <span className="cloud-pending">{pending[item.id]}</span>}
            </button></td>
            <td><time dateTime={new Date(item.updatedAt).toISOString()}>{date(item.updatedAt)}</time></td>
          </tr>)}</tbody>
        </table>
        {!visible.length && <p className="cloud-empty">{busy ? 'Loading…' : filter.trim() ? 'No matching documents.' : 'No cloud documents yet.'}</p>}
      </div>
      <div className="cloud-actions">
        <button type="button" className="cloud-button" disabled={!!busy || !selected} onClick={() => openDocument(selected!.id)}>Open</button>
        <button type="button" className="cloud-button" disabled={!!busy || !selected} onClick={() => { setName(selected!.name); setAction('rename') }}>Rename</button>
        <button type="button" className="cloud-button cloud-danger" disabled={!!busy || !selected} onClick={() => setAction('delete')}>Delete</button>
      </div>
      {selected && action === 'rename' && <form className="cloud-confirm" onSubmit={event => {
        event.preventDefault()
        if (!name.trim()) return
        void run('Renaming document…', async () => {
          const renamed = await cloudRequest<DocumentMeta>(documentPath(selected.id), 'PATCH', { name: name.trim() })
          setDocuments(items => items.map(item => item.id === renamed.id ? mergeDocumentMeta(item, renamed) : item))
          setAction(null); setResult('Document renamed.')
        })
      }}>
        <label className="cloud-field">Document name<input autoFocus type="text" value={name} disabled={!!busy} onChange={event => setName(event.target.value)} /></label>
        <div className="cloud-actions"><button type="button" className="cloud-button" disabled={!!busy} onClick={() => setAction(null)}>Cancel</button>
          <button type="submit" className="cloud-button" disabled={!!busy || !name.trim()}>Save name</button></div>
      </form>}
      {selected && action === 'delete' && <section className="cloud-confirm" aria-label="Delete document">
        <p className="cloud-hint">Delete “{selected.name}”? All share links will be revoked. This cannot be undone.</p>
        {pending[selected.id] && <p className="cloud-pending">This document has pending local changes: {pending[selected.id]}</p>}
        <div className="cloud-actions"><button type="button" className="cloud-button" disabled={!!busy} onClick={() => setAction(null)}>Cancel</button>
          <button type="button" className="cloud-button cloud-danger" disabled={!!busy} onClick={() => { void run('Deleting document…', async () => {
            await cloudRequest(documentPath(selected.id), 'DELETE', { baseRevision: selected.revision })
            setDocuments(items => items.filter(item => item.id !== selected.id)); setSelectedId(''); setAction(null)
            setResult('Document deleted. All share links have been revoked.')
            if (active.current && selected.id === currentId) onOpen('')
          }) }}>Delete document</button></div>
      </section>}
    </div>
    <footer className="cloud-feedback">
      <p className="cloud-status" role="status">{busy || result}</p>
      {error && <p className="cloud-error" role="alert">{error}</p>}
      {auth && <a href="/" target="_blank" rel="noopener noreferrer">Sign in, then refresh Files</a>}
    </footer>
  </dialog>
}
