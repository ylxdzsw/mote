import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { MoteDocument } from '../document/model'
import { DocumentFiles } from '../app/DocumentFiles'
import { cloudRequest, type Share } from './api'
import { useConnection } from './connection'
import './cloud.css'

interface Props {
  open: boolean
  onClose: () => void
  documentId: string
  name: string
  dirty: boolean
  privateDocument: boolean
  draft?: boolean
  sync: () => Promise<{ revision: string } | null>
  doc: MoteDocument
}

type Tab = 'link' | 'file'

const labels = { snapshot: 'Current snapshot', latest: 'Latest version' }
const shareUrl = (token: string) => new URL(`/s/${encodeURIComponent(token)}`, window.location.origin).href
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed. Please try again.'

export function ShareWindow({ open, ...props }: Props) {
  return open ? <ShareDialog key={props.documentId} {...props} /> : null
}

function ShareDialog({ onClose, documentId, name, dirty, privateDocument, draft, sync, doc }: Omit<Props, 'open'>) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const tabButtons = useRef<Record<Tab, HTMLButtonElement | null>>({ link: null, file: null })
  const active = useRef(true)
  const locked = useRef(false)
  const connection = useConnection()
  const [tab, setTab] = useState<Tab>(() => privateDocument || draft || connection.offline ? 'file' : 'link')
  const [busy, setBusy] = useState('')
  const [fileBusy, setFileBusy] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [shares, setShares] = useState<Share[]>([])
  const [mode, setMode] = useState<Share['mode']>('snapshot')
  const [revoke, setRevoke] = useState<string | null>(null)
  const path = `/api/documents/${encodeURIComponent(documentId)}/shares`
  const linkBusy = !!busy || shareLoading || connection.offline || !!draft

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    active.current = true
    if (!element.open) element.showModal()
    return () => {
      active.current = false
      if (element.open) element.close()
    }
  }, [])

  useEffect(() => {
    if (privateDocument || connection.offline) setTab('file')
    if (privateDocument) { setShares([]); setError(''); setRevoke(null) }
  }, [privateDocument, connection.offline])

  useEffect(() => {
    if (tab !== 'link' || privateDocument || draft || connection.offline) {
      setShareLoading(false)
      return
    }
    let canceled = false
    setShareLoading(true)
    setError('')
    void cloudRequest<{ shares: Share[] }>(path)
      .then(data => { if (!canceled) setShares(data.shares) })
      .catch(error => { if (!canceled) setError(message(error)) })
      .finally(() => { if (!canceled) setShareLoading(false) })
    return () => { canceled = true; setShareLoading(false) }
  }, [path, tab, privateDocument, draft, connection.offline, refresh])

  async function run(label: string, task: () => Promise<void>) {
    if (privateDocument) { setError('Private documents cannot be shared. Turn off Private in Document settings first.'); return }
    if (shareLoading || locked.current || !active.current) return
    locked.current = true
    setBusy(label); setError(''); setResult('')
    try { await task() }
    catch (error) { if (active.current) setError(message(error)) }
    finally { locked.current = false; if (active.current) setBusy('') }
  }

  function createLink() {
    void run(mode === 'snapshot' ? 'Saving current document…' : 'Creating share link…', async () => {
      let revision: string | undefined
      if (mode === 'snapshot') {
        const saved = await sync()
        if (!saved?.revision) throw new Error('The current document could not be saved to the cloud. No share link was created. Try syncing again.')
        revision = saved.revision
      }
      if (!active.current) return
      setBusy('Creating share link…')
      const share = await cloudRequest<Share>(path, 'POST', mode === 'snapshot' ? { mode, revision } : { mode })
      setShares(items => [share, ...items.filter(item => item.id !== share.id)])
      setResult(`${labels[share.mode]} link is ready to copy.`)
      setRevoke(null)
    })
  }

  function copyLink(share: Share) {
    void run('Copying link…', async () => {
      try {
        if (!navigator.clipboard) throw new Error('Clipboard unavailable')
        await navigator.clipboard.writeText(shareUrl(share.token))
      } catch { throw new Error('Could not copy the link. Select the URL below and copy it manually.') }
      setResult(`${labels[share.mode]} link copied.`)
    })
  }

  function closeDialog() {
    if (locked.current || fileBusy) return
    onClose()
  }

  function selectTab(next: Tab) {
    if (next === 'link' && privateDocument) return
    if (busy || fileBusy) return
    setTab(next)
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const order: Tab[] = privateDocument ? ['file'] : ['link', 'file']
    const current = order.indexOf(tab)
    if (current < 0) return
    let next = current
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % order.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current + order.length - 1) % order.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = order.length - 1
    else return
    event.preventDefault()
    const nextTab = order[next]
    selectTab(nextTab)
    requestAnimationFrame(() => tabButtons.current[nextTab]?.focus())
  }

  return <dialog ref={dialog} className="cloud-dialog cloud-share" aria-labelledby={titleId} aria-describedby={tab === 'link' ? `${titleId}-hint` : undefined}
    aria-busy={!!busy || shareLoading || fileBusy}
    onCancel={event => { event.preventDefault(); closeDialog() }} onKeyDown={event => event.stopPropagation()}>
    <header className="cloud-heading"><h1 id={titleId}>Share — {name}</h1>
      <button type="button" className="cloud-button cloud-close" aria-label="Close share dialog" disabled={!!busy || fileBusy} onClick={closeDialog}>×</button>
    </header>
    <div className="cloud-body">
      <div className="settings-tabs cloud-tabs" role="tablist" aria-label="Share options" onKeyDown={onTabKeyDown}>
        <button ref={element => { tabButtons.current.link = element }} type="button" className="cloud-tab" role="tab" id={`${titleId}-link-tab`}
          aria-controls={`${titleId}-link-panel`} aria-selected={tab === 'link'} tabIndex={tab === 'link' ? 0 : -1}
          disabled={privateDocument || !!busy || fileBusy} title={privateDocument ? 'Link sharing is disabled for Private documents.' : undefined} onClick={() => selectTab('link')}>Link</button>
        <button ref={element => { tabButtons.current.file = element }} type="button" className="cloud-tab" role="tab" id={`${titleId}-file-tab`}
          aria-controls={`${titleId}-file-panel`} aria-selected={tab === 'file'} tabIndex={tab === 'file' ? 0 : -1}
          disabled={!!busy || fileBusy} onClick={() => selectTab('file')}>Export</button>
      </div>
      {tab === 'link' && <p id={`${titleId}-hint`} className="cloud-hint">{draft
        ? 'This draft is not saved to the cloud. Add content or change document settings, then sync before creating a link. Local export is available now.' : connection.offline
        ? 'You’re offline. Reconnect to manage links, or use Export to download a copy.'
        : 'Anyone with a link can read this document without signing in. Internal notes are excluded. Revoke a link to stop future access.'}</p>}
      <section id={`${titleId}-link-panel`} role="tabpanel" aria-labelledby={`${titleId}-link-tab`} hidden={tab !== 'link'}>
        <fieldset className="cloud-share-modes" disabled={linkBusy || privateDocument}>
          <legend>Link type</legend>
          <label className="cloud-share-mode"><input type="radio" name={`${titleId}-mode`} value="snapshot" checked={mode === 'snapshot'} onChange={() => setMode('snapshot')} />
            <span><strong>Current snapshot</strong><span className="cloud-detail">Saves your changes first, then pins that exact revision. Later edits will not change this link.</span></span>
          </label>
          <label className="cloud-share-mode"><input type="radio" name={`${titleId}-mode`} value="latest" checked={mode === 'latest'} onChange={() => setMode('latest')} />
            <span><strong>Latest version</strong><span className="cloud-detail">Shows the cloud copy saved when the link opens. An open link does not refresh in the background. An existing Latest version link is reused.</span></span>
          </label>
        </fieldset>
        {!privateDocument && dirty && <p className="cloud-pending" role="status">Unsynced changes are not included in Latest version links.</p>}
        <div className="cloud-actions"><button type="button" className="cloud-button" disabled={linkBusy || privateDocument || !documentId} onClick={createLink}>Create link</button></div>
        {!privateDocument && <section className="cloud-shares" aria-labelledby={`${titleId}-existing`}>
          <div className="cloud-preview-heading"><h2 id={`${titleId}-existing`} className="cloud-section-title">Existing links</h2>
            <button type="button" className="cloud-button" disabled={linkBusy || privateDocument}
              onClick={() => { setRevoke(null); setRefresh(value => value + 1) }}>Refresh</button>
          </div>
          {!shares.length && <p className="cloud-empty">{shareLoading ? 'Loading…' : 'No share links yet.'}</p>}
          <ul className="cloud-share-list">
            {[...shares].sort((a, b) => b.createdAt - a.createdAt).map(share => <li key={share.id}>
              <strong>{labels[share.mode]}</strong>
              <span className="cloud-detail">Created <time dateTime={new Date(share.createdAt).toISOString()}>{new Date(share.createdAt).toLocaleString()}</time>
                {share.revision !== null && <> · Revision {share.revision}</>}</span>
              <input className="cloud-link" type="text" readOnly disabled={linkBusy} value={shareUrl(share.token)} aria-label={`${labels[share.mode]} URL`}
                onFocus={event => event.currentTarget.select()} />
              <div className="cloud-actions"><button type="button" className="cloud-button" disabled={linkBusy} onClick={() => copyLink(share)}>Copy link</button>
                <button type="button" className="cloud-button cloud-danger" disabled={linkBusy} onClick={() => setRevoke(share.id)}>Revoke</button></div>
              {revoke === share.id && <section className="cloud-confirm" aria-label="Revoke share link">
                <p className="cloud-hint">Revoke this link? It will stop opening the document. Copies already viewed or downloaded cannot be recalled.</p>
                <div className="cloud-actions"><button type="button" className="cloud-button" disabled={linkBusy} onClick={() => setRevoke(null)}>Cancel</button>
                  <button type="button" className="cloud-button cloud-danger" disabled={linkBusy} onClick={() => { void run('Revoking link…', async () => {
                    await cloudRequest(`${path}/${encodeURIComponent(share.id)}`, 'DELETE')
                    setShares(items => items.filter(item => item.id !== share.id)); setRevoke(null); setResult('Share link revoked.')
                  }) }}>Revoke link</button></div>
              </section>}
            </li>)}
          </ul>
        </section>}
      </section>
      <section id={`${titleId}-file-panel`} role="tabpanel" aria-labelledby={`${titleId}-file-tab`} hidden={tab !== 'file'}>
        <DocumentFiles doc={doc} onBusyChange={setFileBusy} />
      </section>
    </div>
    {tab === 'link' && <footer className="cloud-feedback">
      <p className="cloud-status" role="status">{busy || (shareLoading ? 'Loading share links…' : result)}</p>
      {error && <p className="cloud-error" role="alert">{error}</p>}
    </footer>}
  </dialog>
}
