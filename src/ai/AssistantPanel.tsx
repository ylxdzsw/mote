import { useState } from 'react'
import type { useAssistant } from './useAssistant'
import type { AITask } from './types'
import './assistant.css'

export function AssistantPanel({ assistant, onDraw, onSelection, canSelect }: {
  assistant: ReturnType<typeof useAssistant>
  onDraw: () => void; onSelection: () => void; canSelect: boolean
}) {
  return <aside className="inspector ai-panel" aria-label="AI assistant">
    <div className="inspector-heading">AI ASSISTANT<button aria-label="Close AI assistant" onClick={() => assistant.setOpen(false)}>×</button></div>
    <section className="panel-section">
      <div className="ai-actions">
        <button onClick={onDraw}>Draw AI area</button>
        <button disabled={!canSelect} onMouseDown={event => event.preventDefault()} onClick={onSelection}>Use selection</button>
      </div>
      <p className="hint">Each request sends the full document, its rendered snapshot, and your selected area to the authenticated Mu service. Nothing is sent until you generate.</p>
      <p className="hint">Content stays reserved until accepted or discarded. Other regions remain editable. Floating areas can move, and can be resized before their first request.</p>
      <a href="https://mote.ylxdzsw.com/ai-login" target="_blank" rel="noopener noreferrer">Sign in to AI service ↗</a>
    </section>
    {!assistant.tasks.length && <section className="panel-section"><p className="hint">Research a topic, write a KaTeX formula, create a table, or build an interactive object. Select an object or paragraphs, use the paragraph at the caret, or draw an area to begin.</p></section>}
    {assistant.tasks.map(task => <TaskCard key={task.id} task={task} assistant={assistant} />)}
  </aside>
}

function TaskCard({ task, assistant }: { task: AITask; assistant: ReturnType<typeof useAssistant> }) {
  const [prompt, setPrompt] = useState(task.prompt)
  const busy = ['preparing', 'queued', 'running'].includes(task.status)
  return <section className="panel-section ai-task" data-ai-task={task.id}>
    <div className="ai-task-heading"><h2>{task.target.kind === 'object' ? task.target.isNew ? 'New floating object' : 'Object revision' : 'Paragraphs'}</h2><span role="status">{task.status}</span></div>
    {task.target.kind === 'text' && <p className="hint">Whole paragraphs are reserved and replaced together. An empty selection uses the paragraph at the caret.</p>}
    <label>Request<textarea aria-label="AI request" rows={4} value={prompt} disabled={busy} placeholder="Research… / Write a formula… / Make this interactive…"
      onChange={event => setPrompt(event.target.value)} onBlur={() => assistant.update(task.id, { prompt })} /></label>
    {task.progress && <p className="ai-progress" role="status">{task.progress}</p>}
    {task.error && <p className="ai-error" role="alert">{task.error}</p>}
    {task.candidate && <><p className="ai-summary">{task.candidate.summary}</p>
      {!!task.candidate.sources?.length && <details><summary>Sources</summary><ul>{task.candidate.sources.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></details>}</>}
    <div className="ai-actions">
      {busy ? <button onClick={() => void assistant.stop(task.id)}>Stop</button>
        : <button disabled={!prompt.trim()} onClick={() => void assistant.start(task.id, prompt)}>{task.submitted ? 'Revise / retry' : 'Generate'}</button>}
      {task.candidate && <><button onClick={() => assistant.update(task.id, { preview: !task.preview })}>{task.preview ? 'Show original' : 'Show candidate'}</button><button disabled={busy} onClick={() => assistant.accept(task.id)}>Accept</button></>}
      <button onClick={() => assistant.discard(task.id)}>Discard</button>
    </div>
  </section>
}
