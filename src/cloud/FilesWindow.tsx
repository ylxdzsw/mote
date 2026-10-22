import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { PanelIcon } from '../app/PanelIcon'
import { createDocument, paragraph, type MoteDocument } from '../document/model'
import { CloudError, cloudRequest, mergeDocumentMeta, normalizeDocumentMeta, type CloudDocument, type DocumentMeta } from './api'
import './cloud.css'
import './files.css'

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
function date(time: number) {
  const now = new Date(), then = new Date(time), elapsed = Math.max(0, Date.now() - time)
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (then.toDateString() === now.toDateString()) return `${Math.floor(elapsed / 3_600_000)}h ago`
  now.setDate(now.getDate() - 1)
  if (then.toDateString() === now.toDateString()) return 'Yesterday'
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(then.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}
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
  const importTrigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<string | null>(null)
  const active = useRef(true)
  const locked = useRef(true)
  const [busy, setBusy] = useState('Loading files…')
  const [error, setError] = useState('')
  const [auth, setAuth] = useState(false)
  const [result, setResult] = useState('')
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState('modified')
  const [selectedId, setSelectedId] = useState(currentId ?? '')
  const [action, setAction] = useState<'rename' | 'delete' | 'import' | null>(null)
  const [name, setName] = useState('')
  const visible = documents.filter(item => item.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    .sort((a, b) => (sort === 'modified' ? b.updatedAt - a.updatedAt : 0) || a.name.localeCompare(b.name))
  const selected = documents.find(item => item.id === selectedId)
  const recoveryCount = Object.keys(pending).length
  const mutating = !!busy && !['Loading files…', 'Refreshing files…'].includes(busy)

  function focusFile(id: string, menu = false) {
    requestAnimationFrame(() => {
      const row = list.current?.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(id)}"]`)
      const target = row?.querySelector<HTMLButtonElement>(menu ? '[aria-haspopup="menu"]' : '.cloud-file-choice')
      if (target && !target.disabled) target.focus()
      else search.current?.focus()
    })
  }

  function finishAction() {
    returnFocus.current = action === 'import' ? 'import' : selectedId
    setAction(null)
  }

  function dismiss() {
    if (mutating) return
    if (action) finishAction()
    else onClose()
  }

  useEffect(() => {
    if (busy || action || returnFocus.current === null) return
    const target = returnFocus.current
    returnFocus.current = null
    if (target === 'import') importTrigger.current?.focus()
    else focusFile(target, true)
  }, [busy, action])

  function navigateFiles(event: KeyboardEvent, index = -1) {
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, visible.length - 1)
      : event.key === 'ArrowUp' ? (index < 0 ? visible.length - 1 : Math.max(index - 1, 0))
        : index >= 0 && event.key === 'Home' ? 0 : index >= 0 && event.key === 'End' ? visible.length - 1 : -1
    if (next >= 0 && !busy && !action) { event.preventDefault(); focusFile(visible[next].id) }
  }

  useEffect(() => {
    let canceled = false
    const element = dialog.current!
    active.current = true
    element.showModal()
    search.current?.focus()
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
        if (action === 'delete' || action === 'rename' && error.status === 410) finishAction()
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
    onCancel={event => { event.preventDefault(); dismiss() }} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); dismiss() }
    }}>
    <header className="cloud-heading"><h1 id={titleId}>Files</h1>
      <div className="cloud-actions">
        <button ref={importTrigger} type="button" className="cloud-button files-quiet" disabled={!!busy || !!action} onClick={() => setAction('import')}>Import</button>
        <div className="files-new">
          <button type="button" className="cloud-button" disabled={!!busy || !!action} onClick={() => newDocument()}><PanelIcon name="plus" />New</button>
          <FilesMenu label="New document options" disabled={!!busy || !!action} icon="chevron">
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => newDocument(true)}>From example</button>
          </FilesMenu>
        </div>
        <button type="button" className="cloud-button cloud-close" aria-label="Close files" disabled={mutating} onClick={onClose}><PanelIcon name="close" /></button>
      </div>
    </header>
    <div className="files-search">
      <input ref={search} autoFocus type="search" aria-label="Search documents" placeholder="Search documents…" value={filter} disabled={!!action || mutating}
        onKeyDown={navigateFiles} onChange={event => setFilter(event.target.value)} />
      <div className="files-list-heading">
        <span>{visible.length} {visible.length === 1 ? 'document' : 'documents'}</span>
        <select aria-label="Sort documents" value={sort} disabled={!!action} onChange={event => setSort(event.target.value)}>
          <option value="modified">Recently modified</option><option value="name">Name A–Z</option>
        </select>
      </div>
    </div>
    <div ref={list} className="files-scroll">
      <input ref={input} type="file" accept=".mote,.html,.htm" hidden disabled={!!busy} aria-label="Import a Mote document or Mote-exported HTML" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) importFile(file)
      }} />
      {!action && <ul className="files-list" aria-label="Documents">
        {visible.map((item, index) => <li key={item.id} data-file-id={item.id}>
          <button type="button" className="cloud-file-choice" disabled={!!busy} onClick={() => openDocument(item.id)} onKeyDown={event => navigateFiles(event, index)}
            title={`Open ${item.name} · Modified ${new Date(item.updatedAt).toLocaleString()}`}>
            <span className="files-name-line"><span className="cloud-file-name">{item.name}</span>
              {item.id === currentId && <span className="files-current">Current</span>}
              {item.private && <span className="cloud-private-badge"><PanelIcon name="lock" />Private</span>}
            </span>
            <time dateTime={new Date(item.updatedAt).toISOString()} aria-label={`Modified ${new Date(item.updatedAt).toLocaleString()}`}>{date(item.updatedAt)}</time>
            {pending[item.id] && <span className="cloud-pending">{pending[item.id]}</span>}
          </button>
          <FilesMenu label={`Actions for ${item.name}`} disabled={!!busy}>
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setSelectedId(item.id); setName(item.name); setAction('rename') }}>Rename</button>
            <button type="button" role="menuitem" tabIndex={-1} className="cloud-danger" onClick={() => { setSelectedId(item.id); setAction('delete') }}>Delete…</button>
          </FilesMenu>
        </li>)}
      </ul>}
      {!action && !visible.length && <div className="cloud-empty">
        <p>{busy ? 'Loading documents…' : filter.trim() ? 'No matching documents.' : error ? 'No documents to show.' : 'Your documents start here.'}</p>
        {!busy && !error && <span>{filter.trim() ? 'Try a different name.' : 'Create a document or import one to get started.'}</span>}
      </div>}
      {action === 'import' && <section className="cloud-confirm" aria-label="Import document">
        <h2>Import a document</h2>
        <p className="cloud-hint">Choose a .mote file or Mote-exported HTML. It opens as a new document; existing documents stay unchanged.</p>
        <div className="cloud-actions">
          <button type="button" className="cloud-button" disabled={!!busy} onClick={finishAction}>Cancel</button>
          <button type="button" autoFocus className="cloud-button files-primary" disabled={!!busy} onClick={() => input.current!.click()}>Choose file…</button>
        </div>
      </section>}
      {selected && action === 'rename' && <form className="cloud-confirm" onSubmit={event => {
        event.preventDefault()
        if (!name.trim()) return
        void run('Renaming document…', async () => {
          const renamed = await cloudRequest<DocumentMeta>(documentPath(selected.id), 'PATCH', { name: name.trim() })
          setDocuments(items => items.map(item => item.id === renamed.id ? mergeDocumentMeta(item, renamed) : item))
          finishAction(); setResult('Document renamed.')
        })
      }}>
        <h2>Rename document</h2>
        <label className="cloud-field">Document name<input autoFocus type="text" value={name} disabled={!!busy} onFocus={event => event.target.select()} onChange={event => setName(event.target.value)} /></label>
        <div className="cloud-actions"><button type="button" className="cloud-button" disabled={!!busy} onClick={finishAction}>Cancel</button>
          <button type="submit" className="cloud-button files-primary" disabled={!!busy || !name.trim()}>Save name</button></div>
      </form>}
      {selected && action === 'delete' && <section className="cloud-confirm" aria-label="Delete document">
        <h2>Delete document?</h2>
        <p className="cloud-hint">Delete “{selected.name}”? All share links will be revoked. This cannot be undone.</p>
        {pending[selected.id] && <p className="cloud-pending">This document has pending local changes: {pending[selected.id]}</p>}
        <div className="cloud-actions"><button type="button" autoFocus className="cloud-button" disabled={!!busy} onClick={finishAction}>Cancel</button>
          <button type="button" className="cloud-button cloud-danger" disabled={!!busy} onClick={() => { void run('Deleting document…', async () => {
            await cloudRequest(documentPath(selected.id), 'DELETE', { baseRevision: selected.revision })
            setDocuments(items => items.filter(item => item.id !== selected.id)); setSelectedId(''); finishAction()
            setResult('Document deleted. All share links have been revoked.')
            if (active.current && selected.id === currentId) onOpen('')
          }) }}>Delete document</button></div>
      </section>}
    </div>
    <footer className="cloud-feedback files-footer">
      {hasLocalDraft && onImportLocal && <div className="files-legacy">
        <span>A draft from this browser is available.</span>
        <button type="button" className="cloud-button files-quiet" disabled={!!busy || !!action} onClick={() => { void run('Importing local draft…', async () => {
          await onImportLocal(); if (active.current) { await refresh(); setResult('Local draft imported.') }
        }) }}>Import draft</button>
      </div>}
      <div className="files-footer-actions">
        {onLocalRecovery && <button type="button" className={`cloud-button files-quiet${recoveryCount ? ' files-recovery-pending' : ''}`} disabled={mutating} onClick={onLocalRecovery}
          title={recoveryCount ? `${recoveryCount} documents with changes on this device` : 'Find unsynced working copies on this device'}>
          Local recovery{recoveryCount > 0 && <span className="files-count">{recoveryCount}</span>}
        </button>}
        <button type="button" className="cloud-button files-quiet files-refresh" aria-label="Refresh files" title="Refresh files" disabled={!!busy || !!action} onClick={() => { void run('Refreshing files…', refresh) }}><PanelIcon name="reset" /></button>
      </div>
      <p className="cloud-status" role="status">{busy || result}</p>
      {error && <p className="cloud-error" role="alert">{error}</p>}
      {auth && <a href="/" target="_blank" rel="noopener noreferrer">Sign in, then refresh Files</a>}
    </footer>
  </dialog>
}

function FilesMenu({ label, disabled, icon = 'more', children }: { label: string; disabled: boolean; icon?: 'more' | 'chevron'; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  function close(restore = false) { setOpen(false); if (restore) trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    const element = menu.current!, rect = trigger.current!.getBoundingClientRect()
    element.style.left = `${Math.max(8, rect.right - element.offsetWidth)}px`
    element.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - element.offsetHeight - 8))}px`
    element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close() }
    const reposition = () => close(true)
    document.addEventListener('pointerdown', outside, true)
    const scroll = trigger.current!.closest('.files-scroll')
    scroll?.addEventListener('scroll', reposition)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      scroll?.removeEventListener('scroll', reposition)
      window.removeEventListener('resize', reposition)
    }
  }, [open])
  return <div className="files-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close() }}>
    <button ref={trigger} type="button" className="cloud-button files-quiet" disabled={disabled} aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}><PanelIcon name={icon} /></button>
    {open && <div ref={menu} id={id} className="files-menu-panel" role="menu" aria-label={label} onClick={() => close(true)} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return }
      if (event.key === 'Tab') { close(true); return }
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
      if (next >= 0) { event.preventDefault(); buttons[next].focus() }
    }}>{children}</div>}
  </div>
}
