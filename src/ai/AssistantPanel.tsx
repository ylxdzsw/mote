import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { useAssistant } from './useAssistant'
import type { AITask } from './types'
import './assistant.css'

const Transcript = lazy(() => import('./Transcript'))
type Assistant = ReturnType<typeof useAssistant>
const targetLabel = ({ target }: AITask) => target.kind === 'segment'
  ? target.range.start.index === target.range.end.index && target.range.start.offset === target.range.end.offset ? 'New section' : 'Document section'
  : target.kind === 'text' ? `${target.blockIds.length} paragraph${target.blockIds.length === 1 ? '' : 's'}` : target.isNew ? 'Floating area' : 'Object revision'
const taskTitle = (task: AITask) => task.title || task.target.selectedText?.trim().split('\n')[0].slice(0, 40) || targetLabel(task)
const statusLabel = { draft: 'Not sent', preparing: 'Preparing…', queued: 'Queued', running: 'Working…', ready: 'Ready to review', stopped: 'Stopped', error: 'Needs attention' }
const busyTask = (task: AITask) => ['preparing', 'queued', 'running'].includes(task.status)

export function AssistantPanel({ assistant, onLocate }: { assistant: Assistant; onLocate: (task: AITask) => void }) {
  const tabs = useRef<HTMLDivElement>(null)
  useEffect(() => { tabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [assistant.activeId])
  return <aside className="inspector ai-panel" aria-label="AI assistant">
    <div className="inspector-heading">Assistant<button aria-label="Close AI assistant" onClick={() => assistant.setOpen(false)}>×</button></div>
    {!!assistant.tasks.length && <div className="ai-tabs" role="tablist" aria-label="Agents" ref={tabs} onKeyDown={event => {
      const index = assistant.tasks.findIndex(task => task.id === assistant.activeId)
      const next = event.key === 'ArrowRight' ? (index + 1) % assistant.tasks.length : event.key === 'ArrowLeft' ? (index + assistant.tasks.length - 1) % assistant.tasks.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? assistant.tasks.length - 1 : -1
      if (next < 0) return
      event.preventDefault(); assistant.openTask(assistant.tasks[next].id)
      tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus()
    }}>
      {assistant.tasks.map(task => <button key={task.id} id={`ai-tab-${task.id}`} role="tab" aria-selected={assistant.activeId === task.id}
        aria-controls={`ai-panel-${task.id}`} tabIndex={assistant.activeId === task.id ? 0 : -1} title={`${taskTitle(task)} — ${statusLabel[task.status]}`}
        onClick={() => assistant.openTask(task.id)}>
        <span className={`ai-tab-status ${task.status}`} aria-label={statusLabel[task.status]}>{busyTask(task) ? '◌' : task.status === 'ready' ? '✓' : task.status === 'error' ? '!' : '○'}</span>
        <span className="ai-tab-title">{taskTitle(task)}</span>
      </button>)}
    </div>}
    {!assistant.tasks.length && <div className="ai-empty">
      <h2>A little help with your note</h2>
      <p>Select text or a section, then choose <strong>AI generate</strong> in the toolbar.</p>
      <p>For a diagram, formula, or widget, use the floating-object AI tool to select an object or draw an area.</p>
    </div>}
    {assistant.tasks.map(task => <TaskView key={task.id} task={task} active={assistant.activeId === task.id} assistant={assistant} onLocate={() => onLocate(task)} />)}
    <footer className="ai-footer">
      <details className="ai-info"><summary>Help & privacy</summary>
        <p>Generate sends the full document, its rendered snapshot, and the reserved area to Mu. Nothing is sent when you select an area.</p>
        <p>The area stays locked until you accept, discard, or delete it. Floating areas can move, and resize before their first request. Closing this panel does not stop work.</p>
      </details>
      <a href="https://mote.ylxdzsw.com/ai-login" target="_blank" rel="noopener noreferrer">Sign in ↗</a>
    </footer>
  </aside>
}

function TaskView({ task, active, assistant, onLocate }: { task: AITask; active: boolean; assistant: Assistant; onLocate: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null)
  const [activityCollapsed, setActivityCollapsed] = useState(true)
  const busy = busyTask(task), prompt = task.draftPrompt ?? (task.submitted ? '' : task.prompt)
  const retry = !prompt.trim() && ['error', 'stopped'].includes(task.status)
  const expanded = busy || !activityCollapsed
  const placeholder = task.submitted ? 'What should change?'
    : task.target.kind === 'segment' ? 'Describe the section you want to create…'
    : task.target.kind === 'text' ? 'Rewrite, expand, or explore these paragraphs…'
    : task.target.isNew ? 'Describe a diagram, formula, or interactive object…' : 'Describe how this object should change…'
  useEffect(() => { if (active && task.status === 'draft') input.current?.focus() }, [])
  return <section className={`ai-task${task.submitted ? '' : ' ai-task-draft'}`} data-ai-task={task.id} id={`ai-panel-${task.id}`} role="tabpanel" aria-labelledby={`ai-tab-${task.id}`} hidden={!active}>
    <div className="ai-task-body">
      <div className="ai-task-header">
        <div className="ai-task-target"><span>{targetLabel(task)}</span><button onClick={onLocate}>Show in document ↗</button></div>
        <div className={`ai-status ${task.status}`} role="status"><span aria-hidden="true">{busy ? '◌' : task.status === 'ready' ? '✓' : task.status === 'error' ? '!' : '○'}</span>{statusLabel[task.status]}</div>
      </div>
      {task.submitted && <div className={`ai-activity${expanded ? '' : ' is-collapsed'}`}>
        <button className="ai-activity-toggle" aria-expanded={expanded} aria-controls={`ai-activity-${task.id}`} disabled={busy} onClick={() => setActivityCollapsed(!activityCollapsed)}>
          <span>Activity</span><span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
        </button>
        <div className="ai-activity-body" id={`ai-activity-${task.id}`} hidden={!expanded}>
          <Suspense fallback={<p className="ai-note">Loading activity…</p>}>
            <Transcript taskId={task.id} active={active && expanded} submitted={task.submitted} onMissing={() => assistant.missingRemote(task.id)} />
          </Suspense>
        </div>
      </div>}
      {(task.error || busy && task.progress) && <div className="ai-task-feedback">
        {busy && task.progress && <p className="ai-progress" role="status">{task.progress}</p>}
        {task.error && <p className="ai-error" role="alert">{task.error}{/sign in/i.test(task.error) && <> <a href="https://mote.ylxdzsw.com/ai-login" target="_blank" rel="noopener noreferrer">Sign in ↗</a></>}</p>}
      </div>}
      {task.candidate && <section className="ai-result" aria-label="Review changes">
        <h3>{busy ? 'Previous result' : 'Review changes'}</h3>
        <p className="ai-summary">{task.candidate.summary}</p>
        {!!task.candidate.sources?.length && <details className="ai-sources"><summary>Sources</summary><ul>{task.candidate.sources.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></details>}
        <div className="ai-preview-switch" role="group" aria-label="Document view">
          <button type="button" aria-pressed={!task.preview} onClick={() => assistant.update(task.id, { preview: false })}>Original</button>
          <button type="button" aria-pressed={task.preview} onClick={() => assistant.update(task.id, { preview: true })}>Preview</button>
        </div>
        <div className="ai-actions ai-review-actions">
          <button className="ai-primary" type="button" disabled={busy} onClick={() => assistant.accept(task.id)}>Accept changes</button>
          <button className="ai-quiet" type="button" onClick={() => assistant.discard(task.id)}>Discard</button>
        </div>
      </section>}
    </div>
    <form className="ai-composer" onSubmit={event => { event.preventDefault(); if (!busy) void assistant.start(task.id, retry ? task.prompt : prompt) }}>
      <label htmlFor={`ai-request-${task.id}`}>{task.submitted ? 'Follow up' : 'What would you like to change?'}</label>
      {!task.submitted && <p className="ai-composer-hint">The result will preview on your document. You decide what to keep.</p>}
      <textarea ref={input} id={`ai-request-${task.id}`} aria-label="AI request" aria-describedby={!task.submitted ? `ai-privacy-${task.id}` : undefined} rows={task.submitted ? 3 : 5} value={prompt}
        placeholder={placeholder} onChange={event => assistant.update(task.id, { draftPrompt: event.target.value })} />
      <div className="ai-actions ai-compose-actions">
        {!task.candidate && <button className="ai-quiet" type="button" onClick={() => assistant.discard(task.id)}>Discard</button>}
        {busy ? <button key="stop" type="button" onClick={() => void assistant.stop(task.id)}>Stop</button>
          : <button key="submit" className={task.candidate ? '' : 'ai-primary'} type="submit" disabled={task.remoteMissing || !(retry ? task.prompt : prompt).trim()}>{retry ? 'Retry' : task.submitted ? 'Revise' : 'Generate'}</button>}
      </div>
      {!task.submitted && <p className="ai-privacy" id={`ai-privacy-${task.id}`}>Generate shares the full document and a snapshot with Mu.</p>}
    </form>
  </section>
}
