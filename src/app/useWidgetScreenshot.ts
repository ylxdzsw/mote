import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isRecord, requestJSON, RequestError } from '../cloud/connection'
import type { useDocumentHistory } from '../document/history'
import type { FloatingHTMLWidget, MoteDocument } from '../document/model'

export interface ScreenshotStatus { objectId: string; pending: boolean; error: string }

export function useWidgetScreenshot(history: ReturnType<typeof useDocumentHistory>, editable: boolean, lockedIds: Set<string>) {
  const [status, setStatus] = useState<ScreenshotStatus | null>(null)
  const active = useRef<{ controller: AbortController; object: FloatingHTMLWidget; documentId: string; revision: number } | null>(null)
  const latest = useRef({ history, editable, lockedIds })
  latest.current = { history, editable, lockedIds }

  function matches(doc: MoteDocument | null) {
    const request = active.current
    const current = doc?.objects.find(object => object.id === request?.object.id)
    return request && doc?.id === request.documentId && current?.kind === 'html'
      && current.html === request.object.html && current.layout.width === request.object.layout.width && current.layout.height === request.object.layout.height
      && current.screenshot === request.object.screenshot && latest.current.history.revision === request.revision
      && latest.current.editable && !latest.current.lockedIds.has(current.id)
  }

  useLayoutEffect(() => {
    if (!active.current || matches(history.doc)) return
    const { object, controller } = active.current
    active.current = null; controller.abort()
    setStatus({ objectId: object.id, pending: false, error: 'Capture canceled because the widget or editing state changed. Update screenshot again.' })
  })
  useEffect(() => () => { active.current?.controller.abort(); active.current = null }, [])

  async function capture(object: FloatingHTMLWidget) {
    if (active.current || !editable || lockedIds.has(object.id) || !history.doc) return
    const request = { controller: new AbortController(), object, documentId: history.doc.id, revision: history.revision }
    active.current = request
    setStatus({ objectId: object.id, pending: true, error: '' })
    try {
      const result = await requestJSON<{ screenshot: string }>('/api/widgets/screenshot', 'POST',
        { html: object.html, width: object.layout.width, height: object.layout.height },
        value => isRecord(value) && typeof value.screenshot === 'string' && value.screenshot.length <= 14 * 1024 * 1024
          && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.screenshot),
        { signal: request.controller.signal, timeoutMs: 35_000 })
      if (active.current !== request || !matches(latest.current.history.doc)) return
      const currentHistory = latest.current.history
      currentHistory.boundary()
      currentHistory.setDoc(doc => matches(doc) ? { ...doc!, objects: doc!.objects.map(current => current.id === object.id
        ? { ...current, screenshot: result.screenshot } : current) } : doc)
      currentHistory.boundary()
    } catch (error) {
      if (active.current !== request) return
      const message = error instanceof RequestError && error.status === 401 ? 'Sign in, then try again.'
        : error instanceof Error ? error.message : 'Capture failed. Try again.'
      setStatus({ objectId: object.id, pending: false, error: `${message.replace(/[.!?]$/, '')}. The saved screenshot was kept.` })
    } finally {
      if (active.current === request) {
        active.current = null
        setStatus(current => current && ({ ...current, pending: false }))
      }
    }
  }

  return { status, capture }
}
