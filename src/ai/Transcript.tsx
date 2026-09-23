import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnsiUp } from 'ansi_up'
import { aiRequest, AIServiceError, transcriptSource } from './api'

interface Entry { id: number; attempt: number; kind: 'request' | 'stdout' | 'stderr'; text: string }
const limit = 512 * 1024
function converter() {
  const ansi = new AnsiUp()
  ansi.use_classes = true
  // Agent output is text, never executable HTML or automatic links.
  ansi.url_allowlist = {}
  return ansi
}

export default function Transcript({ taskId, active, submitted, onMissing }: { taskId: string; active: boolean; submitted: boolean; onMissing: () => void }) {
  const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null)
  const cursor = useRef(0), following = useRef(true)
  const [paused, setPaused] = useState(false), [connection, setConnection] = useState(''), [truncated, setTruncated] = useState(false)
  const [warning, setWarning] = useState('')
  const [retry, setRetry] = useState(0)
  const render = useRef({ attempt: -1, agentLabel: false, stdout: converter(), stderr: converter(), bytes: 0, nodes: [] as { element: HTMLElement; bytes: number }[] })
  useEffect(() => {
    if (!active || !submitted) return
    let disposed = false, source: EventSource | undefined, frame = 0, pending: Entry[] = [], pendingBytes = 0
    function flush() {
      frame = 0
      const state = render.current, container = root.current!, scroll = viewport.current!
      const oldHeight = scroll.scrollHeight
      for (const entry of pending) {
        if (entry.attempt !== state.attempt) { state.attempt = entry.attempt; state.agentLabel = false; state.stdout = converter(); state.stderr = converter() }
        const block = document.createElement('div')
        block.className = `ai-transcript-entry ${entry.kind}`
        if (entry.kind === 'request') {
          const label = document.createElement('h3'); label.textContent = 'You'
          const text = document.createElement('div'); text.textContent = entry.text
          block.append(label, text)
        } else {
          if (!state.agentLabel) {
            const label = document.createElement('h3'); label.className = 'ai-agent-label'; label.textContent = 'Agent'
            container.append(label); state.nodes.push({ element: label, bytes: 0 }); state.agentLabel = true
          }
          block.innerHTML = state[entry.kind].ansi_to_html(entry.text)
          // Extended terminal colors bypass ANSI classes and may assume a dark
          // terminal. Use the guarded UI colors; retain bold/italic formatting.
          for (const span of block.querySelectorAll<HTMLElement>('[style]')) {
            span.style.removeProperty('color')
            span.style.removeProperty('background-color')
            span.style.removeProperty('opacity')
          }
          block.setAttribute('aria-label', entry.kind === 'stderr' ? 'Agent diagnostic' : 'Agent output')
        }
        container.append(block); state.nodes.push({ element: block, bytes: entry.text.length }); state.bytes += entry.text.length
      }
      pending = []; pendingBytes = 0
      const beforeTrim = scroll.scrollHeight
      while ((state.bytes > limit || state.nodes.length > 2000) && state.nodes.length > 1) {
        const removed = state.nodes.shift()!; removed.element.remove(); state.bytes -= removed.bytes; setTruncated(true)
      }
      if (following.current) scroll.scrollTop = scroll.scrollHeight
      else if (beforeTrim !== scroll.scrollHeight) scroll.scrollTop -= beforeTrim - scroll.scrollHeight
      if (!following.current && oldHeight !== scroll.scrollHeight) setPaused(true)
    }
    setConnection('Connecting…')
    void aiRequest(`/tasks/${taskId}`).then(() => {
      if (disposed) return
      source = transcriptSource(taskId, cursor.current)
      source.onopen = () => { if (!disposed) setConnection('') }
      source.onerror = () => { if (!disposed) setConnection(source?.readyState === EventSource.CLOSED ? 'Transcript unavailable. Reconnect to try again.' : 'Connection interrupted. Reconnecting…') }
      source.addEventListener('warning', event => { if (!disposed) setWarning(JSON.parse((event as MessageEvent).data).message) })
      source.addEventListener('reset', () => {
        if (disposed) return
        pending = []; pendingBytes = 0; cursor.current = 0
        root.current!.replaceChildren()
        render.current = { attempt: -1, agentLabel: false, stdout: converter(), stderr: converter(), bytes: 0, nodes: [] }
        setTruncated(true)
      })
      source.addEventListener('transcript', event => {
        if (disposed) return
        const entry = JSON.parse((event as MessageEvent).data) as Entry
        if (entry.id <= cursor.current) return
        cursor.current = entry.id; pending.push(entry); pendingBytes += entry.text.length
        if (pendingBytes >= 32768) { cancelAnimationFrame(frame); flush() }
        else if (!frame) frame = requestAnimationFrame(flush)
      })
    }).catch(error => {
      if (disposed) return
      if (error instanceof AIServiceError && error.status === 404) { onMissing(); setConnection('This session’s transcript is no longer available.') }
      else setConnection((error as Error).message)
    })
    return () => { disposed = true; source?.close(); cancelAnimationFrame(frame); if (pending.length && root.current && viewport.current) flush() }
  }, [taskId, active, submitted, retry])
  useLayoutEffect(() => { if (active && following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }, [active, truncated])
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
    {connection && <div className="ai-connection" role="status">{connection} <button onClick={() => setRetry(value => value + 1)}>Reconnect</button>{/sign in/i.test(connection) && <> <a href="https://mote.ylxdzsw.com/ai-login" target="_blank" rel="noopener noreferrer">Sign in ↗</a></>}</div>}
  </div>
}
