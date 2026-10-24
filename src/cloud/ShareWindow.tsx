import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { MoteDocument } from '../document/model'
import { DocumentFiles } from '../app/DocumentFiles'
import { CloudError, cloudRequest, type SharingState } from './api'
import { retryConnection, useConnection } from './connection'
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

type ShareAction = 'enable' | 'disable' | 'replace'
interface ShareChange { baseRevision: number; operationId: string; action: ShareAction }
const shareUrl = (token: string) => new URL(`/s/${encodeURIComponent(token)}`, window.location.origin).href
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed. Please try again.'

export function ShareWindow({ open, ...props }: Props) {
  return open ? <ShareDialog key={props.documentId} {...props} /> : null
}

function ShareDialog({ onClose, documentId, name, dirty, privateDocument, draft, sync, doc }: Omit<Props, 'open'>) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const toggleButton = useRef<HTMLButtonElement>(null)
  const copyButton = useRef<HTMLButtonElement>(null)
  const replaceButton = useRef<HTMLButtonElement>(null)
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
  const [sharing, setSharing] = useState<SharingState | null>(null)
  const [pending, setPending] = useState<ShareChange | null>(null)
  const [confirm, setConfirm] = useState<'disable' | 'replace' | null>(null)
  const path = `/api/documents/${encodeURIComponent(documentId)}/shares`
  const unavailable = privateDocument || connection.offline || !!draft
  const linkBusy = !!busy || shareLoading || unavailable
  const share = sharing?.share

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
    if (privateDocument) setTab('file')
    if (privateDocument || connection.offline) setConfirm(null)
    if (privateDocument) { setSharing(null); setPending(null); setError(''); setConfirm(null) }
  }, [privateDocument, connection.offline])

  useEffect(() => {
    if (tab !== 'link' || unavailable || pending) {
      setShareLoading(false)
      return
    }
    let canceled = false
    setShareLoading(true)
    setSharing(null)
    setConfirm(null)
    setResult('')
    void cloudRequest<SharingState>(path)
      .then(data => { if (!canceled) setSharing(data) })
      .catch(error => { if (!canceled) setError(message(error)) })
      .finally(() => { if (!canceled) setShareLoading(false) })
    return () => { canceled = true; setShareLoading(false) }
  }, [path, tab, unavailable, pending, refresh])

  async function run(label: string, task: () => Promise<void>) {
    if (privateDocument) { setError('Private documents cannot be shared. Turn off Private in Document settings first.'); return }
    if (shareLoading || locked.current || !active.current) return
    locked.current = true
    setBusy(label); setError(''); setResult('')
    try { await task() }
    catch (error) { if (active.current) setError(message(error)) }
    finally { locked.current = false; if (active.current) setBusy('') }
  }

  async function sendChange(change: ShareChange) {
    setConfirm(null)
    setBusy(change.action === 'enable' ? 'Enabling sharing…' : change.action === 'disable' ? 'Disabling sharing…' : 'Replacing link…')
    try {
      const state = await cloudRequest<SharingState>(path, 'PUT', change)
      if (!active.current) return
      setPending(null)
      setSharing(state)
      setResult(state.share ? 'Sharing enabled. The current link is ready to copy.' : 'Sharing disabled.')
      requestAnimationFrame(() => (state.share ? copyButton : toggleButton).current?.focus())
    } catch (error) {
      if (!active.current) return
      setSharing(null)
      if (error instanceof CloudError && error.status >= 400) {
        setPending(null)
        setRefresh(value => value + 1)
        throw error
      }
      setPending(change)
      throw new Error(`The sharing change could not be confirmed. Reconnect, then retry to confirm its result. ${message(error)}`)
    }
  }

  function changeSharing(action: ShareAction) {
    if (!sharing || pending) return
    const change = { baseRevision: sharing.revision, operationId: crypto.randomUUID(), action }
    void run(action === 'enable' ? 'Saving current document…' : 'Updating sharing…', async () => {
      if (action === 'enable') {
        const saved = await sync()
        if (!saved?.revision) throw new Error('The current document could not be saved to the cloud. Sharing was not enabled. Resolve the sync issue, then try again.')
      }
      if (active.current) await sendChange(change)
    })
  }

  function copyLink() {
    if (!share) return
    void run('Copying link…', async () => {
      try {
        if (!navigator.clipboard) throw new Error('Clipboard unavailable')
        await navigator.clipboard.writeText(shareUrl(share.token))
      } catch { throw new Error('Could not copy the link. Select the URL below and copy it manually.') }
      setResult('Link copied.')
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
    <header className="cloud-heading"><h1 id={titleId} title={`Share — ${name}`}>Share — {name}</h1>
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
      <section id={`${titleId}-link-panel`} role="tabpanel" aria-labelledby={`${titleId}-link-tab`} hidden={tab !== 'link'}>
        {unavailable ? <p id={`${titleId}-hint`} className="cloud-hint">{draft
          ? 'This draft is not saved to the cloud. Add content or change document settings, then sync before enabling sharing. Local export is available now.'
          : privateDocument ? 'Public sharing is disabled for Private documents. Local export is still available.'
          : 'You’re offline. Reconnect to manage sharing, or use Export to download a copy.'}</p>
          : sharing ? <>
            <div className="cloud-sharing-heading">
              <strong>Public sharing</strong>
              <button ref={toggleButton} type="button" className="cloud-button cloud-sharing-toggle" role="switch" aria-label="Public sharing"
                aria-checked={!!share} disabled={linkBusy || !!pending || !!confirm}
                onClick={() => share ? setConfirm('disable') : changeSharing('enable')}>{share ? 'On' : 'Off'}</button>
            </div>
            <p id={`${titleId}-hint`} className="cloud-hint">{share
              ? 'Anyone with this link can read the latest cloud-saved version. Readers must reload to see later changes.'
              : 'Sharing disabled. Enable sharing to let anyone with the link read this document.'}</p>
            {share && <>
              <div className="cloud-sharing-link">
                <input className="cloud-link" type="text" readOnly disabled={linkBusy} value={shareUrl(share.token)} aria-label="Share URL"
                  onFocus={event => event.currentTarget.select()} />
                <button ref={copyButton} type="button" className="cloud-button" disabled={linkBusy} onClick={copyLink}>Copy link</button>
              </div>
              {dirty && <p className="cloud-pending" role="status">Your latest changes aren’t shared until they sync.</p>}
              <button ref={replaceButton} type="button" className="cloud-button" disabled={linkBusy || !!confirm} onClick={() => setConfirm('replace')}>Replace link…</button>
            </>}
            <p className="cloud-sharing-note cloud-detail">Internal Notes are excluded.{share && ' Disabling sharing cannot recall copies already opened or downloaded.'}</p>
          </> : <p id={`${titleId}-hint`} className="cloud-hint">{pending ? 'Sharing status is unconfirmed.' : shareLoading ? 'Loading sharing status…' : 'Sharing status is unavailable.'}</p>}
        {confirm && <section className="cloud-confirm" aria-label={confirm === 'disable' ? 'Disable sharing' : 'Replace link'}>
          <p className="cloud-hint">{confirm === 'disable'
            ? 'Disable sharing? The current link will stop working. Enabling sharing again will create a new link.'
            : 'Replace link? The current link will stop working. You’ll need to send the new link to readers.'}</p>
          <div className="cloud-actions">
            <button type="button" className="cloud-button" disabled={linkBusy} onClick={() => {
              const button = confirm === 'disable' ? toggleButton : replaceButton
              setConfirm(null)
              requestAnimationFrame(() => button.current?.focus())
            }}>Cancel</button>
            <button type="button" className="cloud-button cloud-danger" disabled={linkBusy} onClick={() => changeSharing(confirm)}>{confirm === 'disable' ? 'Disable sharing' : 'Replace link'}</button>
          </div>
        </section>}
        {connection.offline && <button type="button" className="cloud-button" disabled={!!busy || connection.checking}
          onClick={() => void retryConnection()}>{connection.checking ? 'Checking connection…' : 'Retry connection'}</button>}
        {!unavailable && !sharing && !shareLoading && <button type="button" className="cloud-button" disabled={linkBusy} onClick={() => {
          if (pending) void run('Confirming sharing…', () => sendChange(pending))
          else { setError(''); setRefresh(value => value + 1) }
        }}>{pending ? 'Retry sharing change' : 'Check sharing status'}</button>}
      </section>
      <section id={`${titleId}-file-panel`} role="tabpanel" aria-labelledby={`${titleId}-file-tab`} hidden={tab !== 'file'}>
        <DocumentFiles doc={doc} onBusyChange={setFileBusy} />
      </section>
    </div>
    {tab === 'link' && (busy || result || error) && <footer className="cloud-feedback">
      <p className="cloud-status" role="status">{busy || result}</p>
      {error && <p className="cloud-error" role="alert">{error}</p>}
    </footer>}
  </dialog>
}
