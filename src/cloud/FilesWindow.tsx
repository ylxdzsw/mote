import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { PanelIcon } from '../app/PanelIcon'
import type { MoteDocument } from '../document/model'
import { decodeDocument } from '../document/file'
import { CloudError, cloudRequest, mergeDocumentMeta, normalizeDocumentMeta, type DocumentMeta } from './api'
import { connectionSnapshot, retryConnection } from './connection'
import { NewFileForm, type NewFileOptions } from './NewFileForm'
import { ShareWindow } from './ShareWindow'
import type { WorkingCopy } from './WorkingCopy'
import './cloud.css'
import './files.css'

interface Props {
  open: boolean
  onClose: () => void
  onOpen: (id: string) => void
  currentId?: string
  copy?: WorkingCopy
  onNew: (options: NewFileOptions) => Promise<void>
  onImport: (document: MoteDocument, name: string) => Promise<void>
  pending?: Record<string, string>
  recovery: ReactNode
  recoveryCount: number
  onRecoveryOpen: () => void
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

function FilesDialog({ onClose, onOpen, onNew, onImport, currentId, copy, pending = {}, recovery, recoveryCount, onRecoveryOpen }: Omit<Props, 'open'>) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const importTrigger = useRef<HTMLButtonElement>(null)
  const newTrigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const archiveToggle = useRef<HTMLButtonElement>(null)
  const archiveChanges = useRef(new Map<string, { archived: boolean; baseArchiveRevision: number; operationId: string }>())
  const returnFocus = useRef<string | null>(null)
  const errorFocus = useRef<HTMLElement | null>(null)
  const active = useRef(true)
  const locked = useRef(true)
  const [busy, setBusy] = useState<'loading' | 'working' | null>('loading')
  const [error, setError] = useState('')
  const [listFailed, setListFailed] = useState(false)
  const [auth, setAuth] = useState(false)
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState('modified')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [selectedId, setSelectedId] = useState(currentId ?? '')
  const [action, setAction] = useState<'rename' | 'delete' | 'import' | null>(null)
  const [newFile, setNewFile] = useState<boolean | null>(null)
  const [name, setName] = useState('')
  const [shareTarget, setShareTarget] = useState<DocumentMeta>()
  const query = filter.trim().toLocaleLowerCase()
  const matching = documents.filter(item => item.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => (sort === 'modified' ? b.updatedAt - a.updatedAt : 0) || a.name.localeCompare(b.name))
  const ordinary = matching.filter(item => !item.archived), archived = matching.filter(item => item.archived)
  const visible = archiveOpen ? [...ordinary, ...archived] : ordinary
  const selected = documents.find(item => item.id === selectedId)
  const mutating = busy === 'working'
  const creating = newFile !== null

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

  function dismissError() {
    setError('')
    if (returnFocus.current !== null) return
    requestAnimationFrame(() => {
      const target = errorFocus.current
      if (target?.isConnected && dialog.current?.contains(target)) target.focus()
      else search.current?.focus()
    })
  }

  function dismiss() {
    if (mutating) return
    if (creating) cancelNewFile()
    else if (action) finishAction()
    else onClose()
  }

  function cancelNewFile() {
    if (mutating || !creating) return
    setNewFile(null)
    requestAnimationFrame(() => newTrigger.current?.focus())
  }

  useEffect(() => {
    if (busy || error || action || returnFocus.current === null) return
    const target = returnFocus.current
    returnFocus.current = null
    if (target === 'import') importTrigger.current?.focus()
    else if (target === 'archived') archiveToggle.current?.focus()
    else focusFile(target, true)
  }, [busy, error, action])

  function navigateFiles(event: KeyboardEvent, index = -1) {
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, visible.length - 1)
      : event.key === 'ArrowUp' ? (index < 0 ? visible.length - 1 : Math.max(index - 1, 0))
        : index >= 0 && event.key === 'Home' ? 0 : index >= 0 && event.key === 'End' ? visible.length - 1 : -1
    if (next >= 0 && !busy && !action) { event.preventDefault(); focusFile(visible[next].id) }
    else if (event.key === 'ArrowDown' && !visible.length && archived.length && !busy && !action) {
      event.preventDefault(); archiveToggle.current?.focus()
    }
  }

  useEffect(() => {
    let canceled = false
    const element = dialog.current!
    active.current = true
    element.showModal()
    search.current?.focus()
    void cloudRequest<{ documents: DocumentMeta[] }>('/api/documents')
      .then(data => { if (!canceled) setDocuments(current => mergeList(current, data.documents)) })
      .catch(error => { if (!canceled) { setListFailed(true); setError(message(error)); setAuth(error instanceof CloudError && error.status === 401) } })
      .finally(() => { if (!canceled) { locked.current = false; setBusy(null) } })
    return () => { canceled = true; active.current = false; element.close() }
  }, [])

  async function refresh() {
    try {
      if (connectionSnapshot().offline) await retryConnection()
      const data = await cloudRequest<{ documents: DocumentMeta[] }>('/api/documents')
      setDocuments(current => mergeList(current, data.documents)); setListFailed(false)
    } catch (error) { setListFailed(true); throw error }
  }

  async function run(task: () => Promise<void>, propagate = false, operation: 'loading' | 'working' = 'working') {
    if (locked.current) {
      if (propagate) throw new Error('Another Files operation is in progress.')
      return
    }
    locked.current = true
    errorFocus.current = document.activeElement as HTMLElement
    setBusy(operation); setError(''); setAuth(false)
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
      if (propagate) throw error
    } finally {
      locked.current = false
      if (active.current) setBusy(null)
    }
  }

  function retryList() {
    void run(async () => { await refresh(); search.current?.focus() }, false, 'loading')
  }

  async function runCreation(options: NewFileOptions) {
    await run(() => onNew(options), true)
  }

  function openDocument(id: string) {
    if (!locked.current && active.current) onOpen(id)
  }

  function newDocument(example = false) {
    setNewFile(example)
  }

  function importFile(file: File) {
    void run(async () => {
      const document = await decodeDocument(file)
      if (active.current) await onImport(document, file.name.replace(/\.(mote|html?)$/i, '').trim() || 'Untitled')
    })
  }

  function toggleArchive(item: DocumentMeta) {
    void run(async () => {
      const previous = archiveChanges.current.get(item.id)
      const change = previous?.baseArchiveRevision === item.archiveRevision ? previous
        : { archived: !item.archived, baseArchiveRevision: item.archiveRevision, operationId: crypto.randomUUID() }
      archiveChanges.current.set(item.id, change)
      let updated: DocumentMeta
      try {
        if (connectionSnapshot().offline) await retryConnection()
        updated = await cloudRequest<DocumentMeta>(`${documentPath(item.id)}/archive`, 'PUT', change)
      }
      catch (error) {
        if (error instanceof CloudError && error.status === 0) throw new Error(`${message(error)} Archive state was not confirmed. Close and reopen Files to check or retry the action.`)
        throw error
      }
      archiveChanges.current.delete(item.id)
      setDocuments(items => items.map(old => old.id === item.id ? mergeDocumentMeta(old, updated) : old))
      const index = ordinary.findIndex(old => old.id === item.id)
      returnFocus.current = item.archived ? item.id : ordinary[index + 1]?.id ?? ordinary[index - 1]?.id ?? 'archived'
    })
  }

  function renderFiles(items: DocumentMeta[], label: string) {
    return <ul className="files-list" aria-label={label}>
      {items.map(item => <li key={item.id} data-file-id={item.id}>
        <button type="button" className="cloud-file-choice" disabled={!!busy} onClick={() => openDocument(item.id)} onKeyDown={event => navigateFiles(event, visible.findIndex(row => row.id === item.id))}
          title={`Open ${item.name} · Modified ${new Date(item.updatedAt).toLocaleString()}`}>
          <span className="files-name-line"><span className="cloud-file-name">{item.name}</span>
            {item.id === currentId && <span className="files-current">Current</span>}
            {item.private && <span className="cloud-private-badge"><PanelIcon name="lock" />Private</span>}
          </span>
          <time dateTime={new Date(item.updatedAt).toISOString()} aria-label={`Modified ${new Date(item.updatedAt).toLocaleString()}`}>{date(item.updatedAt)}</time>
          {pending[item.id] && <span className="cloud-pending">{pending[item.id]}</span>}
        </button>
        <FilesMenu label={`Actions for ${item.name}`} disabled={!!busy}>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => setShareTarget(item)}>Share…</button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setSelectedId(item.id); setName(item.name); setAction('rename') }}>Rename</button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => toggleArchive(item)}>{item.archived ? 'Unarchive' : 'Archive'}</button>
          <button type="button" role="menuitem" tabIndex={-1} className="cloud-danger" onClick={() => { setSelectedId(item.id); setAction('delete') }}>Delete…</button>
        </FilesMenu>
      </li>)}
    </ul>
  }

  return <><dialog ref={dialog} className={`cloud-dialog cloud-files${creating ? ' files-creating' : ''}`} aria-labelledby={titleId} aria-busy={!!busy}
    onCancel={event => { event.preventDefault(); dismiss() }} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); dismiss() }
    }}>
    <header className="cloud-heading"><h1 id={titleId}>{creating ? 'New file' : 'Files'}</h1>
      <div className="cloud-actions">
        {!creating && <>
          <button ref={importTrigger} type="button" className="cloud-button files-quiet" disabled={!!busy || !!action} onClick={() => setAction('import')}>Import</button>
          <div className="files-new">
            <button ref={newTrigger} type="button" className="cloud-button" disabled={!!busy || !!action} onClick={() => newDocument()}><PanelIcon name="plus" />New</button>
            <FilesMenu label="New document options" disabled={!!busy || !!action} icon="chevron">
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => newDocument(true)}>From example</button>
            </FilesMenu>
          </div>
        </>}
        <button type="button" className="cloud-button cloud-close" aria-label={creating ? 'Cancel new file' : 'Close files'} disabled={mutating} onClick={creating ? cancelNewFile : onClose}><PanelIcon name="close" /></button>
      </div>
    </header>
    <div className="files-search" hidden={creating}>
      <input ref={search} autoFocus type="search" aria-label="Search documents" placeholder="Search documents…" value={filter} disabled={!!action || mutating}
        onKeyDown={navigateFiles} onChange={event => setFilter(event.target.value)} />
      <div className="files-list-heading">
        <span>{ordinary.length} {ordinary.length === 1 ? 'document' : 'documents'}</span>
        <select aria-label="Sort documents" value={sort} disabled={!!action} onChange={event => setSort(event.target.value)}>
          <option value="modified">Recently modified</option><option value="name">Name A–Z</option>
        </select>
      </div>
    </div>
    <div className="files-new-view" hidden={!creating}>
      {creating && <NewFileForm example={newFile === true} busy={!!busy} onCreate={runCreation} onCancel={cancelNewFile} />}
    </div>
    <div ref={list} className="files-scroll" hidden={creating}>
      <input ref={input} type="file" accept=".mote,.html,.htm" hidden disabled={!!busy} aria-label="Import a Mote document or Mote-exported HTML" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) importFile(file)
      }} />
      {!action && renderFiles(ordinary, 'Documents')}
      {!action && !ordinary.length && <div className="cloud-empty">
        <p>{busy ? 'Loading documents…' : query ? archived.length ? 'Matches are in Archived.' : 'No matching documents.'
          : listFailed ? 'Files could not be loaded.' : documents.length ? 'No unarchived documents.' : 'Your documents start here.'}</p>
        {!busy && !listFailed && !archived.length && <span>{query ? 'Try a different name.' : 'Create a document or import one to get started.'}</span>}
      </div>}
      {!action && listFailed && <button type="button" className="cloud-button files-retry" disabled={!!busy} onClick={retryList}>Retry loading files</button>}
      {!action && <div className="files-secondary">
        <FilesDisclosure label="Archived" count={archived.length} open={archiveOpen} onToggle={() => setArchiveOpen(!archiveOpen)} disabled={!!busy} buttonRef={archiveToggle}>
          {renderFiles(archived, 'Archived documents')}
          {!archived.length && <p className="files-section-empty">{query ? 'No matching archived documents.' : 'No archived documents.'}</p>}
        </FilesDisclosure>
        <FilesDisclosure label="Local recovery" count={recoveryCount} warning={recoveryCount > 0} open={recoveryOpen} disabled={mutating}
          onToggle={() => { if (!recoveryOpen) onRecoveryOpen(); setRecoveryOpen(!recoveryOpen) }}>
          {recovery}
        </FilesDisclosure>
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
        void run(async () => {
          const renamed = await cloudRequest<DocumentMeta>(documentPath(selected.id), 'PATCH', { name: name.trim() })
          setDocuments(items => items.map(item => item.id === renamed.id ? mergeDocumentMeta(item, renamed) : item))
          finishAction()
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
          <button type="button" className="cloud-button cloud-danger" disabled={!!busy} onClick={() => { void run(async () => {
            await cloudRequest(documentPath(selected.id), 'DELETE', { baseRevision: selected.revision })
            setDocuments(items => items.filter(item => item.id !== selected.id)); setSelectedId(''); finishAction()
            if (active.current && selected.id === currentId) onOpen('')
          }) }}>Delete document</button></div>
      </section>}
    </div>
  </dialog>
  {error && !busy && <FilesError message={error} auth={auth} onClose={dismissError} onRetry={listFailed ? retryList : undefined} />}
  {shareTarget && <ShareWindow open documentId={shareTarget.id} name={shareTarget.name} privateDocument={shareTarget.private}
    copy={shareTarget.id === currentId ? copy : undefined} pendingLocal={!!pending[shareTarget.id]}
    onClose={() => { setShareTarget(undefined); focusFile(shareTarget.id, true) }} />}
  </>
}

function FilesError({ message, auth, onClose, onRetry }: { message: string; auth: boolean; onClose: () => void; onRetry?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId(), messageId = useId()
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  return <dialog ref={dialog} className="cloud-dialog files-error" role="alertdialog" aria-labelledby={titleId} aria-describedby={messageId}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <header className="cloud-heading"><h1 id={titleId}>File operation failed</h1></header>
    <div className="cloud-body">
      <p id={messageId} className="cloud-hint">{message}</p>
      {auth && <a className="cloud-management-signin" href="/" target="_blank" rel="noopener noreferrer">Sign in, then retry</a>}
      <div className="cloud-actions">
        {onRetry && <button type="button" className="cloud-button" onClick={onRetry}>Retry</button>}
        <button type="button" className="cloud-button" autoFocus onClick={onClose}>Close</button>
      </div>
    </div>
  </dialog>
}

function FilesDisclosure({ label, count, open, onToggle, disabled, warning, buttonRef, children }: {
  label: string; count: number; open: boolean; onToggle: () => void; disabled: boolean; warning?: boolean; buttonRef?: Ref<HTMLButtonElement>; children: ReactNode
}) {
  const id = useId()
  return <section className="files-section">
    <button ref={buttonRef} type="button" className={`cloud-button files-quiet files-section-toggle${warning ? ' files-recovery-pending' : ''}`}
      disabled={disabled} aria-expanded={open} aria-controls={id} onClick={onToggle}>
      <PanelIcon name="chevron" /><span>{label}</span><span className="files-count">{count}</span>
    </button>
    <div id={id} hidden={!open}>{open && children}</div>
  </section>
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
