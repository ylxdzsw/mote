import { useEffect, useRef, useState } from 'react'
import type { MoteDocument } from '../document/model'
import { exportHtml } from './export'

export function usePreview() {
  const preview = useRef<{ window: Window; url: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => () => { if (preview.current) URL.revokeObjectURL(preview.current.url) }, [])

  async function open(doc: MoteDocument) {
    setError('')
    const previous = preview.current
    const target = previous && !previous.window.closed ? previous.window : window.open('about:blank', '_blank')
    if (!target) { setError('Allow pop-ups for Mote, then try Preview again.'); return }
    target.opener = null
    setBusy(true)
    try {
      const url = URL.createObjectURL(await exportHtml(doc))
      target.location.replace(url)
      target.focus()
      preview.current = { window: target, url }
      if (previous) URL.revokeObjectURL(previous.url)
    } catch (error) {
      if (target !== previous?.window) target.close()
      setError(error instanceof Error ? error.message : 'Preview could not be opened. Please try again.')
    } finally { setBusy(false) }
  }

  return { open, busy, error, dismiss: () => setError('') }
}
