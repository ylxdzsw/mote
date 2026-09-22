import { lazy, Suspense, useEffect, useRef } from 'react'
import type { useAssistant } from './useAssistant'
import type { AITask } from './types'
import './assistant.css'

const Transcript = lazy(() => import('./Transcript'))
type Assistant = ReturnType<typeof useAssistant>
const targetLabel = (task: AITask) => task.target.kind === 'segment' ? 'Segment' : task.target.kind === 'text' ? 'Paragraphs' : task.target.isNew ? 'Floating area' : 'Object revision'
const taskTitle = (task: AITask) => task.title || task.target.selectedText?.trim().split('\n')[0].slice(0, 40) || `${targetLabel(task)} · ${task.id.slice(0, 4)}`
const busyTask = (task: AITask) => ['preparing', 'queued', 'running'].includes(task.status)

export function AssistantPanel({ assistant, onLocate }: { assistant: Assistant; onLocate: (task: AITask) => void }) {
  const tabs = useRef<HTMLDivElement>(null)
  useEffect(() => { tabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [assistant.activeId])
  return <aside className="inspector ai-panel" aria-label="AI assistant">
    <div className="inspector-heading">AI ASSISTANT<button aria-label="Close AI assistant" onClick={() => assistant.setOpen(false)}>×</button></div>
    {!!assistant.tasks.length && <div className="ai-tabs" role="tablist" aria-label="Agents" ref={tabs} onKeyDown={event => {
      const index = assistant.tasks.findIndex(task => task.id === assistant.activeId)
      const next = event.key === 'ArrowRight' ? (index + 1) % assistant.tasks.length : event.key === 'ArrowLeft' ? (index + assistant.tasks.length - 1) % assistant.tasks.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? assistant.tasks.length - 1 : -1
      if (next < 0) return
      event.preventDefault(); assistant.openTask(assistant.tasks[next].id)
      tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus()
    }}>
      {assistant.tasks.map(task => <button key={task.id} id={`ai-tab-${task.id}`} role="tab" aria-selected={assistant.activeId === task.id}
        aria-controls={`ai-panel-${task.id}`} tabIndex={assistant.activeId === task.id ? 0 : -1} title={`${taskTitle(task)} — ${task.status}`}
        onClick={() => assistant.openTask(task.id)}>
        <span className={`ai-tab-status ${task.status}`} aria-label={task.status}>{busyTask(task) ? '●' : task.status === 'ready' ? '✓' : task.status === 'error' ? '!' : '○'}</span>
        <span className="ai-tab-title">{taskTitle(task)}</span>
      </button>)}
    </div>}
    {!assistant.tasks.length && <p className="hint ai-empty">Select a segment or place the text caret, then use the generate button in the toolbar. Use the floating-object AI button to work on one object or a drawn area.</p>}
    {assistant.tasks.map(task => <TaskView key={task.id} task={task} active={assistant.activeId === task.id} assistant={assistant} onLocate={() => onLocate(task)} />)}
    <details className="ai-info"><summary>About AI · Sign in</summary>
      <p className="hint">Generate sends the full document, its rendered snapshot, and the reserved area to Mu. Nothing is sent when you create a reservation. Content stays locked until accepted, discarded, or deleted. Floating areas can move, and resize before their first request.</p>
      <a href="https://mote.ylxdzsw.com/ai-login" target="_blank" rel="noopener noreferrer">Sign in to AI service ↗</a>
    </details>
  </aside>
}

function TaskView({ task, active, assistant, onLocate }: { task: AITask; active: boolean; assistant: Assistant; onLocate: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null)
  const busy = busyTask(task), prompt = task.draftPrompt ?? (task.submitted ? '' : task.prompt)
  const retry = !prompt.trim() && ['error', 'stopped'].includes(task.status)
  useEffect(() => { if (active && task.status === 'draft') input.current?.focus() }, [])
  return <section className="ai-task" data-ai-task={task.id} id={`ai-panel-${task.id}`} role="tabpanel" aria-labelledby={`ai-tab-${task.id}`} hidden={!active}>
    <div className="ai-task-header">
      <div className="ai-task-heading"><h2>{taskTitle(task)}</h2><span role="status">{task.status}</span></div>
      <div className="ai-task-target"><span>{targetLabel(task)} · Mu</span><button onClick={onLocate}>Locate ↗</button></div>
    </div>
    <Suspense fallback={<p className="hint ai-empty">Loading transcript…</p>}>
      <Transcript taskId={task.id} active={active} submitted={task.submitted} onMissing={() => assistant.missingRemote(task.id)} />
    </Suspense>
    <div className="ai-task-result">
      {task.progress && <p className="ai-progress" role="status">{task.progress}</p>}
      {task.error && <p className="ai-error" role="alert">{task.error}{/sign in/i.test(task.error) && <> <a href="https://mote.ylxdzsw.com/ai-login" target="_blank" rel="noopener noreferrer">Sign in ↗</a></>}</p>}
      {task.candidate && <><p className="ai-summary">{task.candidate.summary}</p>
        {!!task.candidate.sources?.length && <details><summary>Sources</summary><ul>{task.candidate.sources.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></details>}</>}
    </div>
    <form className="ai-composer" onSubmit={event => { event.preventDefault(); if (!busy) void assistant.start(task.id, retry ? task.prompt : prompt) }}>
      <label htmlFor={`ai-request-${task.id}`}>{task.submitted ? 'Follow-up request' : 'Request'}</label>
      <textarea ref={input} id={`ai-request-${task.id}`} aria-label="AI request" rows={3} value={prompt}
        placeholder={task.submitted ? 'What should change?' : 'Research… / Write a formula… / Make this interactive…'}
        onChange={event => assistant.update(task.id, { draftPrompt: event.target.value })} />
      <div className="ai-actions">
        {busy ? <button type="button" onClick={() => void assistant.stop(task.id)}>Stop</button>
          : <button type="submit" disabled={task.remoteMissing || !(retry ? task.prompt : prompt).trim()}>{retry ? 'Retry' : task.submitted ? 'Revise' : 'Generate'}</button>}
        {task.candidate && <><button type="button" onClick={() => assistant.update(task.id, { preview: !task.preview })}>{task.preview ? 'Original' : 'Candidate'}</button><button type="button" disabled={busy} onClick={() => assistant.accept(task.id)}>Accept</button></>}
        <button type="button" onClick={() => assistant.discard(task.id)}>Discard</button>
      </div>
    </form>
  </section>
}
