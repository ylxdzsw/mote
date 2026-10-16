import { useEffect, useId, useRef, useState } from 'react'
import { cloudRequest, type Share } from './api'
import './cloud.css'

interface Props {
  open: boolean
  onClose: () => void
  documentId: string
  name: string
  dirty: boolean
  privateDocument: boolean
  sync: () => Promise<{ revision: string } | null>
}

const labels = { snapshot: 'Current snapshot', latest: 'Latest version' }
const shareUrl = (token: string) => new URL(`/s/${encodeURIComponent(token)}`, window.location.origin).href
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed. Please try again.'

export function ShareWindow({ open, ...props }: Props) {
  return open ? <ShareDialog key={props.documentId} {...props} /> : null
}

function ShareDialog({ onClose, documentId, name, dirty, privateDocument, sync }: Omit<Props, 'open'>) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const active = useRef(true)
  const locked = useRef(true)
  const [busy, setBusy] = useState('Loading share links…')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [shares, setShares] = useState<Share[]>([])
  const [mode, setMode] = useState<Share['mode']>('snapshot')
  const [revoke, setRevoke] = useState<string | null>(null)
  const path = `/api/documents/${encodeURIComponent(documentId)}/shares`

  useEffect(() => {
    let canceled = false
    const element = dialog.current!
    active.current = true
    if (!element.open) element.showModal()
    setBusy(privateDocument ? '' : 'Loading share links…')
    locked.current = !privateDocument
    if (privateDocument) {
      setShares([]); setError(''); setResult(''); setBusy(''); locked.current = false
      return () => { canceled = true; active.current = false; element.close() }
    }
    void cloudRequest<{ shares: Share[] }>(path)
      .then(data => { if (!canceled) setShares(data.shares) })
      .catch(error => { if (!canceled) setError(message(error)) })
      .finally(() => { if (!canceled) { locked.current = false; setBusy('') } })
    return () => { canceled = true; active.current = false; element.close() }
  }, [path, privateDocument])

  async function run(label: string, task: () => Promise<void>) {
    if (privateDocument) { setError('Private documents cannot be shared. Turn off Private in Document settings first.'); return }
    if (locked.current) return
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

  return <dialog ref={dialog} className="cloud-dialog cloud-share" aria-labelledby={titleId} aria-describedby={`${titleId}-hint`} aria-busy={!!busy}
    onCancel={event => { event.preventDefault(); if (!locked.current) onClose() }} onKeyDown={event => event.stopPropagation()}>
    <header className="cloud-heading"><h1 id={titleId}>Share — {name}</h1>
      <button type="button" className="cloud-button cloud-close" aria-label="Close sharing" disabled={!!busy} onClick={onClose}>×</button>
    </header>
    <div className="cloud-body">
      <p id={`${titleId}-hint`} className="cloud-hint">{privateDocument
        ? 'Private documents cannot be shared. Turn off Private in Document settings to create or use share links.'
        : 'Anyone with a link can read this document without signing in. Internal notes are excluded. Revoke a link to stop future access.'}</p>
      <fieldset className="cloud-share-modes" disabled={!!busy || privateDocument}>
        <legend>Link type</legend>
        <label className="cloud-share-mode"><input type="radio" name={`${titleId}-mode`} value="snapshot" checked={mode === 'snapshot'} onChange={() => setMode('snapshot')} />
          <span><strong>Current snapshot</strong><span className="cloud-detail">Saves your changes first, then pins that exact revision. Later edits will not change this link.</span></span>
        </label>
        <label className="cloud-share-mode"><input type="radio" name={`${titleId}-mode`} value="latest" checked={mode === 'latest'} onChange={() => setMode('latest')} />
          <span><strong>Latest version</strong><span className="cloud-detail">Shows the cloud copy saved when the link opens. An open link does not refresh in the background. An existing Latest version link is reused.</span></span>
        </label>
      </fieldset>
      {!privateDocument && dirty && <p className="cloud-pending" role="status">Unsynced changes are not included in Latest version links.</p>}
      <div className="cloud-actions"><button type="button" className="cloud-button" disabled={!!busy || privateDocument || !documentId} onClick={createLink}>Create link</button></div>
      {!privateDocument && <section className="cloud-shares" aria-labelledby={`${titleId}-existing`}>
        <div className="cloud-preview-heading"><h2 id={`${titleId}-existing`} className="cloud-section-title">Existing links</h2>
          <button type="button" className="cloud-button" disabled={!!busy || privateDocument} onClick={() => { void run('Refreshing share links…', async () => {
            const data = await cloudRequest<{ shares: Share[] }>(path)
            setShares(data.shares); setRevoke(null)
          }) }}>Refresh</button>
        </div>
        {!shares.length && <p className="cloud-empty">{busy ? 'Loading…' : 'No share links yet.'}</p>}
        <ul className="cloud-share-list">
          {[...shares].sort((a, b) => b.createdAt - a.createdAt).map(share => <li key={share.id}>
            <strong>{labels[share.mode]}</strong>
            <span className="cloud-detail">Created <time dateTime={new Date(share.createdAt).toISOString()}>{new Date(share.createdAt).toLocaleString()}</time>
              {share.revision !== null && <> · Revision {share.revision}</>}</span>
            <input className="cloud-link" type="text" readOnly disabled={!!busy} value={shareUrl(share.token)} aria-label={`${labels[share.mode]} URL`}
              onFocus={event => event.currentTarget.select()} />
            <div className="cloud-actions"><button type="button" className="cloud-button" disabled={!!busy} onClick={() => copyLink(share)}>Copy link</button>
              <button type="button" className="cloud-button cloud-danger" disabled={!!busy} onClick={() => setRevoke(share.id)}>Revoke</button></div>
            {revoke === share.id && <section className="cloud-confirm" aria-label="Revoke share link">
              <p className="cloud-hint">Revoke this link? It will stop opening the document. Copies already viewed or downloaded cannot be recalled.</p>
              <div className="cloud-actions"><button type="button" className="cloud-button" disabled={!!busy} onClick={() => setRevoke(null)}>Cancel</button>
                <button type="button" className="cloud-button cloud-danger" disabled={!!busy} onClick={() => { void run('Revoking link…', async () => {
                  await cloudRequest(`${path}/${encodeURIComponent(share.id)}`, 'DELETE')
                  setShares(items => items.filter(item => item.id !== share.id)); setRevoke(null); setResult('Share link revoked.')
                }) }}>Revoke link</button></div>
            </section>}
          </li>)}
        </ul>
      </section>}
    </div>
    <footer className="cloud-feedback">
      <p className="cloud-status" role="status">{busy || result}</p>
      {error && <p className="cloud-error" role="alert">{error}</p>}
    </footer>
  </dialog>
}
