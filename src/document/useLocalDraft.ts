import { useEffect, useRef, useState } from 'react'
import { createDocument, type MoteDocument } from './model'
import { loadDraft } from './storage'
import { initializeDocument } from './initialize'

type Access = 'writer' | 'blocked' | 'reader'
type Session = { state: 'ready'; doc: MoteDocument; access: Access }
  | { state: 'loading' | 'storage-error' | 'document-error' | 'lock-error'; access: Access }

export function useLocalDraft(startEditing: boolean) {
  const [request, setRequest] = useState({ write: startEditing })
  const [session, setSession] = useState<Session>({ state: 'loading', access: 'reader' })
  const release = useRef<(() => void) | null>(null)

  useEffect(() => () => { release.current?.(); release.current = null }, [])

  useEffect(() => {
    let cancelled = false

    async function open(access: Access) {
      let draft: MoteDocument | undefined
      try { draft = await loadDraft() }
      catch {
        if (!cancelled) setSession({ state: 'storage-error', access })
        return
      }
      if (cancelled) return
      try {
        if (draft) draft = initializeDocument(draft)
      } catch {
        if (access !== 'writer' || !window.confirm('This local draft could not be opened. Replace it with the example?')) {
          setSession({ state: 'document-error', access })
          return
        }
        draft = undefined
      }
      setSession({ state: 'ready', doc: draft ?? createDocument(), access })
    }

    // Let a discarded mount clean up before requesting a non-waiting lock.
    queueMicrotask(() => {
      if (cancelled) return
      if (!request.write) void open('reader')
      else if (release.current || !navigator.locks) void open('writer')
      else void navigator.locks.request('mote-local-draft', { ifAvailable: true }, async lock => {
        if (cancelled) return
        if (!lock) { await open('blocked'); return }
        const held = new Promise<void>(resolve => { release.current = resolve })
        await open('writer')
        await held
      }).catch(() => {
        if (!cancelled) setSession({ state: 'lock-error', access: 'reader' })
      })
    })

    return () => { cancelled = true }
  }, [request])

  function retry(write = request.write) {
    setSession({ state: 'loading', access: 'reader' })
    setRequest({ write })
  }
  return { ...session, retry, tryEditing: () => retry(true) }
}
