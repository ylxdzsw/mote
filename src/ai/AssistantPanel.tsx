import { useEffect, useRef, useState } from 'react'
import type { MoteDocument } from '../document/model'
import { ReadDocument } from '../canvas/ReadDocument'
import { candidateDocument, type useAssistant } from './useAssistant'
import type { AITask } from './types'
import './assistant.css'

export function AssistantPanel({ assistant, doc, onDraw, onSelection, onInsert, canSelect }: {
  assistant: ReturnType<typeof useAssistant>; doc: MoteDocument
  onDraw: () => void; onSelection: () => void; onInsert: () => void; canSelect: boolean
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const task = assistant.tasks.find(task => task.id === preview)
  return <aside className="inspector ai-panel" aria-label="AI assistant">
    <div className="inspector-heading">AI ASSISTANT<button aria-label="Close AI assistant" onClick={() => assistant.setOpen(false)}>×</button></div>
    <section className="panel-section">
      <div className="ai-actions">
        <button onClick={onDraw}>Draw AI area</button>
        <button disabled={!canSelect} onMouseDown={event => event.preventDefault()} onClick={onSelection}>Revise selection</button>
        <button onMouseDown={event => event.preventDefault()} onClick={onInsert}>Insert paragraphs</button>
      </div>
      <p className="hint">Each request sends the full document, its rendered snapshot, and your selected area to the authenticated Mu service. Nothing is sent until you generate.</p>
      <p className="hint">Content stays reserved until accepted or discarded. Other regions remain editable. Floating areas can move, but keep their size.</p>
      <a href="https://mote.ylxdzsw.com/ai-login" target="_blank" rel="noopener noreferrer">Sign in to AI service ↗</a>
    </section>
    {!assistant.tasks.length && <section className="panel-section"><p className="hint">Research a topic, illustrate a process, or build an interactive figure. Select an object or paragraphs, or draw an area to begin.</p></section>}
    {assistant.tasks.map(task => <TaskCard key={task.id} task={task} assistant={assistant} onPreview={() => setPreview(task.id)} />)}
    {task && <Preview task={task} doc={doc} onClose={() => setPreview(null)} />}
  </aside>
}

function TaskCard({ task, assistant, onPreview }: { task: AITask; assistant: ReturnType<typeof useAssistant>; onPreview: () => void }) {
  const [prompt, setPrompt] = useState(task.prompt)
  const busy = ['preparing', 'queued', 'running'].includes(task.status)
  return <section className="panel-section ai-task" data-ai-task={task.id}>
    <div className="ai-task-heading"><h2>{task.target.kind === 'object' ? task.target.isNew ? 'New figure' : 'Object revision' : task.target.insert ? 'New paragraphs' : 'Text revision'}</h2><span role="status">{task.status}</span></div>
    {task.target.kind === 'text' && <p className="hint">Whole selected paragraphs are reserved; the exact selection is included in the request.</p>}
    <label>Request<textarea aria-label="AI request" rows={4} value={prompt} disabled={busy} placeholder="Research… / Illustrate… / Make this interactive…"
      onChange={event => setPrompt(event.target.value)} onBlur={() => assistant.update(task.id, { prompt })} /></label>
    {task.progress && <p className="ai-progress" role="status">{task.progress}</p>}
    {task.error && <p className="ai-error" role="alert">{task.error}</p>}
    {task.candidate && <><p className="ai-summary">{task.candidate.summary}</p>
      {!!task.candidate.sources?.length && <details><summary>Sources</summary><ul>{task.candidate.sources.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></details>}</>}
    <div className="ai-actions">
      {busy ? <button onClick={() => void assistant.stop(task.id)}>Stop</button>
        : <button disabled={!prompt.trim()} onClick={() => void assistant.start(task.id, prompt)}>{task.submitted ? 'Revise / retry' : 'Generate'}</button>}
      {task.candidate && <><button onClick={onPreview}>Before / after</button><button disabled={busy} onClick={() => assistant.accept(task.id)}>Accept</button></>}
      <button onClick={() => assistant.discard(task.id)}>Discard</button>
    </div>
  </section>
}

function Preview({ task, doc, onClose }: { task: AITask; doc: MoteDocument; onClose: () => void }) {
  const [after, setAfter] = useState(true)
  const [visible, setVisible] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  let candidate: MoteDocument | undefined, error = ''
  try { candidate = candidateDocument(doc, task) } catch (cause) { error = (cause as Error).message }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current!.showModal()
    setVisible(true)
    return () => previous?.focus()
  }, [])
  return <dialog className="ai-preview" ref={dialog} aria-label="AI before and after preview" onCancel={onClose}>
    <header><strong>AI preview</strong><div role="group" aria-label="Preview version">
      <button aria-pressed={!after} onClick={() => setAfter(false)}>Original</button><button aria-pressed={after} disabled={!candidate} onClick={() => setAfter(true)}>Candidate</button>
    </div><button onClick={onClose}>Close preview</button></header>
    <p className="hint">A separate preview; the live document is unchanged. Interactive widgets run in isolated frames.</p>
    {error && <p role="alert">{error}</p>}
    <div className="ai-preview-document">{visible && <ReadDocument key={`${task.id}:${after}`} initial={after && candidate ? candidate : doc} onReady={() => requestAnimationFrame(() => {
      const target = task.target.kind === 'object' ? `[data-note-id="${task.target.objectId}"]` : `[data-id="${task.target.blockIds[0]}"]`
      dialog.current?.querySelector(target)?.scrollIntoView({ block: 'center' })
    })} />}</div>
  </dialog>
}
