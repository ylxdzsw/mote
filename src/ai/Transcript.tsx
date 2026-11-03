import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnsiUp } from 'ansi_up'
import { AIServiceError, transcriptRequest } from './api'
import { retryConnection, useConnection } from '../cloud/connection'
import { subscribeDocumentUpdates, type DocumentUpdate, type TranscriptEntry } from '../cloud/documentEvents'

const limit = 512 * 1024
function converter() {
  const ansi = new AnsiUp()
  ansi.use_classes = true
  // Agent output is text, never executable HTML or automatic links.
  ansi.url_allowlist = {}
  return ansi
}
function emptyRender() {
  return { attempt: -1, agentLabel: false, stdout: converter(), stderr: converter(), bytes: 0, nodes: [] as { element: HTMLElement; bytes: number }[] }
}

export default function Transcript({ taskId, documentId, active, submitted, onMissing }: {
  taskId: string; documentId: string; active: boolean; submitted: boolean; onMissing: () => void
}) {
  const network = useConnection()
  const networkRef = useRef(network)
  networkRef.current = network
  const scope = useRef({ taskId, documentId })
  scope.current = { taskId, documentId }
  const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null)
  const cursor = useRef(0), following = useRef(true)
  const reloadHistory = useRef<(() => Promise<void>) | undefined>(undefined)
  const missing = useRef(onMissing)
  missing.current = onMissing
  const [paused, setPaused] = useState(false), [connection, setConnection] = useState(''), [truncated, setTruncated] = useState(false)
  const [warning, setWarning] = useState(''), [retrying, setRetrying] = useState(false)
  const render = useRef(emptyRender())

  useLayoutEffect(() => {
    cursor.current = 0
    following.current = true
    root.current?.replaceChildren()
    render.current = emptyRender()
    setPaused(false); setTruncated(false); setWarning(''); setConnection('')
  }, [taskId, documentId])

  useEffect(() => {
    if (!active || !submitted) { reloadHistory.current = undefined; return }
    let disposed = false, reading = false, replaying = true, readAgain = false, frame = 0
    let pendingBytes = 0
    const pending = new Map<number, TranscriptEntry>()
    const buffered = new Map<number, TranscriptEntry>()
    let bufferedBytes = 0
    let transcriptClosed = false

    function flush() {
      frame = 0
      const state = render.current, container = root.current, scroll = viewport.current
      if (!container || !scroll) return
      const oldHeight = scroll.scrollHeight
      for (const entry of [...pending.values()].sort((a, b) => a.id - b.id)) {
        if (entry.attempt !== state.attempt) {
          state.attempt = entry.attempt; state.agentLabel = false; state.stdout = converter(); state.stderr = converter()
        }
        const block = document.createElement('div')
        block.className = `ai-transcript-entry ${entry.kind}`
        if (entry.kind === 'request') {
          const label = document.createElement('h3'); label.textContent = 'You'
          const text = document.createElement('div'); text.textContent = entry.text
          block.append(label, text)
        } else {
          if (!state.agentLabel) {
            const label = document.createElement('h3'); label.className = 'ai-agent-label'; label.textContent = 'Mu'
            container.append(label); state.nodes.push({ element: label, bytes: 0 }); state.agentLabel = true
          }
          block.innerHTML = state[entry.kind].ansi_to_html(entry.text)
          // Extended terminal colors bypass ANSI classes and may assume a dark
          // terminal. Use guarded UI colors; retain bold/italic formatting.
          for (const span of block.querySelectorAll<HTMLElement>('[style]')) {
            span.style.removeProperty('color')
            span.style.removeProperty('background-color')
            span.style.removeProperty('opacity')
          }
          block.setAttribute('aria-label', entry.kind === 'stderr' ? 'Agent diagnostic' : 'Agent output')
        }
        container.append(block); state.nodes.push({ element: block, bytes: entry.text.length }); state.bytes += entry.text.length
      }
      pending.clear(); pendingBytes = 0
      const beforeTrim = scroll.scrollHeight
      while ((state.bytes > limit || state.nodes.length > 2000) && state.nodes.length > 1) {
        const removed = state.nodes.shift()!; removed.element.remove(); state.bytes -= removed.bytes; setTruncated(true)
      }
      if (following.current) scroll.scrollTop = scroll.scrollHeight
      else if (beforeTrim !== scroll.scrollHeight) scroll.scrollTop -= beforeTrim - scroll.scrollHeight
      if (!following.current && oldHeight !== scroll.scrollHeight) setPaused(true)
    }

    function queue(entry: TranscriptEntry) {
      if (entry.id <= cursor.current) return
      cursor.current = entry.id
      pending.set(entry.id, entry); pendingBytes += entry.text.length
      if (pendingBytes >= 32768) { cancelAnimationFrame(frame); flush() }
      else if (!frame) frame = requestAnimationFrame(flush)
    }

    function buffer(entry: TranscriptEntry) {
      if (buffered.has(entry.id)) return
      buffered.set(entry.id, entry); bufferedBytes += entry.text.length
      while (buffered.size > 2000 || bufferedBytes > limit) {
        const oldestId = buffered.keys().next().value
        if (oldestId === undefined) break
        bufferedBytes -= buffered.get(oldestId)!.text.length
        buffered.delete(oldestId)
        setTruncated(true)
      }
    }

    function recentEntries(entries: Iterable<TranscriptEntry>) {
      const unique = new Map<number, TranscriptEntry>()
      for (const entry of entries) unique.set(entry.id, entry)
      const ordered = [...unique.values()].sort((a, b) => a.id - b.id)
      const recent: TranscriptEntry[] = []
      let bytes = 0, omitted = false
      for (let index = ordered.length - 1; index >= 0; index--) {
        const entry = ordered[index]
        if (recent.length === 2000 || bytes + entry.text.length > limit) { omitted = true; continue }
        recent.push(entry); bytes += entry.text.length
      }
      if (omitted) setTruncated(true)
      return recent.reverse()
    }

    async function readHistory() {
      if (disposed) return
      if (networkRef.current.offline) { setConnection('Offline · waiting to reconnect.'); return }
      if (reading) { readAgain = true; return }
      reading = true; replaying = true
      if (frame) { cancelAnimationFrame(frame); frame = 0 }
      flush()
      const after = cursor.current
      setConnection('Connecting…')
      try {
        const history = await transcriptRequest(taskId, after)
        if (disposed) return
        const floor = history.reset ? 0 : after
        if (history.reset) {
          root.current?.replaceChildren()
          render.current = emptyRender()
          cursor.current = 0
          setTruncated(true)
        }
        if (history.warning) setWarning(history.warning)
        const incoming = new Map<number, TranscriptEntry>()
        for (const entry of history.events) if (entry.id > floor) incoming.set(entry.id, entry)
        for (const entry of buffered.values()) if (entry.id > floor) incoming.set(entry.id, entry)
        buffered.clear(); bufferedBytes = 0
        replaying = false
        for (const entry of recentEntries(incoming.values())) queue(entry)
        if (!transcriptClosed) setConnection('')
      } catch (error) {
        if (disposed) return
        if (error instanceof AIServiceError && error.status === 404) {
          transcriptClosed = true
          missing.current()
          setConnection('This session’s transcript is no longer available.')
        } else {
          setConnection(error instanceof Error ? error.message : 'Transcript unavailable. Reconnect to try again.')
        }
      } finally {
        reading = false
        if (!disposed && readAgain) { readAgain = false; void readHistory() }
      }
    }

    function onUpdate(event: DocumentUpdate) {
      if (event.kind === 'ready') { replaying = true; void readHistory(); return }
      if (!('taskId' in event) || event.taskId !== taskId) return
      if (event.kind === 'transcript') {
        if (replaying) buffer(event.entry)
        else queue(event.entry)
      } else if (event.kind === 'transcript-warning') setWarning(event.message)
      else if (event.kind === 'transcript-closed') {
        transcriptClosed = true
        missing.current()
        setConnection('This session’s transcript is no longer available.')
      }
    }

    const unsubscribe = subscribeDocumentUpdates(documentId, onUpdate)
    reloadHistory.current = readHistory
    return () => {
      disposed = true; replaying = false
      if (frame) cancelAnimationFrame(frame)
      if (scope.current.taskId === taskId && scope.current.documentId === documentId
        && pending.size && root.current && viewport.current) flush()
      unsubscribe()
      if (reloadHistory.current === readHistory) reloadHistory.current = undefined
    }
  }, [taskId, documentId, active, submitted])

  useEffect(() => {
    if (!active || !submitted) return
    if (network.offline) { setConnection('Offline · waiting to reconnect.'); return }
    void reloadHistory.current?.()
  }, [taskId, documentId, active, submitted, network.offline, network.revision])

  useLayoutEffect(() => { if (active && following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }, [active, truncated])

  async function reconnect() {
    if (retrying) return
    setRetrying(true); setConnection('Connecting…')
    try {
      if (!await retryConnection()) { setConnection('Could not reconnect. Local changes and AI requests are retained.'); return }
    } finally { setRetrying(false) }
  }

  return <div className="ai-transcript-wrap">
    <div className="ai-transcript" ref={viewport} role="region" aria-label="Agent transcript" tabIndex={0} onScroll={() => {
      const element = viewport.current!
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
      setPaused(!following.current)
    }}>
      {!submitted && <p className="hint">Describe the result you want. The agent’s output will appear here; its candidate will preview on the document.</p>}
      {truncated && <p className="hint">Earlier output omitted. Showing recent activity.</p>}
      <div className="ai-transcript-content" ref={root} />
    </div>
    {paused && <button className="ai-latest" onClick={() => { following.current = true; setPaused(false); viewport.current!.scrollTop = viewport.current!.scrollHeight }}>↓ Latest</button>}
    {warning && <p className="ai-connection" role="status">{warning}</p>}
    {connection && <div className="ai-connection" role="status">{connection} {connection !== 'Connecting…' && <button disabled={retrying} onClick={() => void reconnect()}>{retrying ? 'Reconnecting…' : 'Reconnect'}</button>}</div>}
  </div>
}
