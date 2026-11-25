import { useEffect, useRef, useState } from 'react'
import { publishDocument } from '../../shared/document.mjs'
import type { MoteDocument } from '../document/model'

export const previewPath = '/preview'
const ready = 'mote-preview-ready'

export function receivePreview(render: (snapshot: MoteDocument, revision: number) => void) {
  const opener = window.opener as Window | null
  if (!opener) return false
  const { port1, port2 } = new MessageChannel()
  let revision = 0
  port1.onmessage = ({ data }: MessageEvent<MoteDocument>) => render(data, ++revision)
  window.opener = null
  opener.postMessage(ready, location.origin, [port2])
  return true
}

function previewPort(target: Window, signal: AbortSignal) {
  return new Promise<MessagePort>((resolve, reject) => {
    window.addEventListener('message', event => {
      if (event.source === target && event.origin === location.origin && event.data === ready && event.ports[0]) resolve(event.ports[0])
    }, { signal })
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

interface PreviewWindow { target: Window; page: Document; port: MessagePort }
function stillOpen({ target, page }: PreviewWindow) {
  try { return !target.closed && target.document === page }
  catch { return false } // The preview tab may have navigated to another origin.
}

export function usePreview() {
  const preview = useRef<PreviewWindow | null>(null)
  const pending = useRef<AbortController | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => () => { pending.current?.abort(); preview.current?.port.close() }, [])

  async function open(doc: MoteDocument) {
    if (pending.current) return
    setError('')
    let snapshot: MoteDocument
    try { snapshot = publishDocument(doc) }
    catch { setError('This document could not be previewed. Your work is unchanged.'); return }
    const current = preview.current
    if (current && stillOpen(current)) {
      current.port.postMessage(snapshot)
      current.target.focus()
      return
    }
    current?.port.close()
    preview.current = null
    const target = window.open(previewPath, '_blank')
    if (!target) { setError('Allow pop-ups for Mote, then try Preview again.'); return }
    const attempt = pending.current = new AbortController()
    setBusy(true)
    try {
      const port = await previewPort(target, AbortSignal.any([attempt.signal, AbortSignal.timeout(10000)]))
      preview.current = { target, page: target.document, port }
      port.postMessage(snapshot)
      target.focus()
    } catch {
      target.close()
      if (!attempt.signal.aborted) setError('The preview reader could not open. Check your connection and try again.')
    } finally {
      if (!attempt.signal.aborted) setBusy(false)
      attempt.abort()
      pending.current = null
    }
  }

  return { open, busy, error, dismiss: () => setError('') }
}
