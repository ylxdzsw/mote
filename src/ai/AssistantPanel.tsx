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
    <CloudStatus assistant={assistant} />
    {!!assistant.allTasks.length && <div className="ai-tabs" role="tablist" aria-label="Agents" ref={tabs} onKeyDown={event => {
      const index = assistant.allTasks.findIndex(task => task.id === assistant.activeId)
      const next = event.key === 'ArrowRight' ? (index + 1) % assistant.allTasks.length : event.key === 'ArrowLeft' ? (index + assistant.allTasks.length - 1) % assistant.allTasks.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? assistant.allTasks.length - 1 : -1
      if (next < 0) return
      event.preventDefault(); assistant.openTask(assistant.allTasks[next].id)
      tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus()
    }}>
      {assistant.allTasks.map(task => <button key={task.id} id={`ai-tab-${task.id}`} role="tab" aria-selected={assistant.activeId === task.id}
        aria-controls={`ai-panel-${task.id}`} tabIndex={assistant.activeId === task.id ? 0 : -1} title={`${taskTitle(task)} — ${statusLabel[task.status]}`}
        onClick={() => assistant.openTask(task.id)}>
        <span className={`ai-tab-status ${task.status}`} aria-label={statusLabel[task.status]}>{busyTask(task) ? '◌' : task.status === 'ready' ? '✓' : task.status === 'error' ? '!' : '○'}</span>
        <span className="ai-tab-title">{taskTitle(task)}</span>
      </button>)}
    </div>}
    {!assistant.allTasks.length && <div className="ai-empty">
      <h2>A little help with your note</h2>
      <p>Select text or a section, then choose <strong>AI generate</strong> in the toolbar.</p>
      <p>For a diagram, formula, or widget, use the floating-object AI tool to select an object or draw an area.</p>
    </div>}
    {assistant.allTasks.map(task => <TaskView key={task.id} task={task} active={assistant.activeId === task.id} assistant={assistant} onLocate={() => onLocate(task)} />)}
    <RecoveryArchives assistant={assistant} />
    <footer className="ai-footer">
      <details className="ai-info"><summary>Help & privacy</summary>
        <p>Documents and assistant tasks, including unsent requests and generated results, sync to your workspace. Generate sends a saved document revision, its rendered snapshot, and the reserved area to Mu.</p>
        <p>The area stays locked until you accept, discard, or delete it. Floating areas can move, and resize before their first request. Closing this panel does not stop work.</p>
      </details>
    </footer>
  </aside>
}

function TaskView({ task, active, assistant, onLocate }: { task: AITask; active: boolean; assistant: Assistant; onLocate: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null)
  const [activityCollapsed, setActivityCollapsed] = useState(true)
  const inactive = assistant.inactiveReason(task)
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
        <div className="ai-task-target"><span>{targetLabel(task)}</span><button disabled={!!inactive} onClick={onLocate}>Show in document ↗</button></div>
        <div className={`ai-status ${task.status}`} role="status"><span aria-hidden="true">{busy ? '◌' : task.status === 'ready' ? '✓' : task.status === 'error' ? '!' : '○'}</span>{inactive ? task.acceptance ? 'Applied locally · result retained' : 'Recovery only' : statusLabel[task.status]}</div>
      </div>
      {inactive && <p className="ai-note" role="status">{inactive}</p>}
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
        {task.error && <p className="ai-error" role="alert">{task.error}</p>}
      </div>}
      {task.candidate && <section className="ai-result" aria-label="Review changes">
        <h3>{inactive ? 'Retained result' : busy ? 'Previous result' : 'Review changes'}</h3>
        <p className="ai-summary">{task.candidate.summary}</p>
        {!!task.candidate.sources?.length && <details className="ai-sources"><summary>Sources</summary><ul>{task.candidate.sources.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></details>}
        {!inactive && <div className="ai-preview-switch" role="group" aria-label="Document view">
          <button type="button" aria-pressed={!task.preview} onClick={() => assistant.update(task.id, { preview: false })}>Original</button>
          <button type="button" aria-pressed={task.preview} onClick={() => assistant.update(task.id, { preview: true })}>Preview</button>
        </div>}
        <div className="ai-actions ai-review-actions">
          {!inactive && <button className="ai-primary" type="button" disabled={busy} onClick={() => assistant.accept(task.id)}>Accept changes</button>}
          <button className="ai-quiet" type="button" onClick={() => assistant.discard(task.id)}>Discard</button>
        </div>
      </section>}
      <RecoveryDetails task={task} />
      {assistant.canSyncAcceptance(task) && <div className="ai-note"><button onClick={() => void assistant.syncAcceptance(task.id)}>Retry saving accepted document</button></div>}
    </div>
    {inactive ? <div className="ai-composer ai-actions">
      {!task.candidate && <button type="button" onClick={() => assistant.discard(task.id)}>Discard task</button>}
      {busy && <button type="button" onClick={() => void assistant.stop(task.id)}>Stop</button>}
    </div> : <form className="ai-composer" onSubmit={event => { event.preventDefault(); if (!busy) void assistant.start(task.id, retry ? task.prompt : prompt) }}>
      <label htmlFor={`ai-request-${task.id}`}>{task.submitted ? 'Follow up' : 'What would you like to change?'}</label>
      {!task.submitted && <p className="ai-composer-hint">The result will preview on your document. You decide what to keep.</p>}
      <textarea ref={input} id={`ai-request-${task.id}`} aria-label="AI request" aria-describedby={!task.submitted ? `ai-privacy-${task.id}` : undefined} rows={task.submitted ? 3 : 5} value={prompt}
        placeholder={placeholder} onChange={event => assistant.update(task.id, { draftPrompt: event.target.value })} />
      <div className="ai-actions ai-compose-actions">
        {!task.candidate && <button className="ai-quiet" type="button" onClick={() => assistant.discard(task.id)}>Discard</button>}
        {busy ? <button key="stop" type="button" onClick={() => void assistant.stop(task.id)}>Stop</button>
          : <button key="submit" className={task.candidate ? '' : 'ai-primary'} type="submit" disabled={!!assistant.cloudConflict || task.remoteMissing || !(retry ? task.prompt : prompt).trim()}>{retry ? 'Retry' : task.submitted ? 'Revise' : 'Generate'}</button>}
      </div>
      {!task.submitted && <p className="ai-privacy" id={`ai-privacy-${task.id}`}>This request syncs to your workspace. Generate shares the saved document revision and a snapshot with Mu.</p>}
    </form>}
  </section>
}

function downloadRecovery(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function JsonRecovery({ label, value }: { label: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false)
  return <details onToggle={event => setExpanded(event.currentTarget.open)}><summary>{label}</summary>
    {expanded && <textarea aria-label={label} readOnly value={JSON.stringify(value, null, 2)} rows={8} />}
  </details>
}

function RecoveryDetails({ task }: { task: AITask }) {
  return <details className="ai-recovery-details"><summary>Request, original & result</summary>
    <p className="ai-progress">{task.prompt || task.draftPrompt || 'No request sent.'}</p>
    {task.prompt && task.draftPrompt && <p className="ai-progress">Unsent: {task.draftPrompt}</p>}
    <p className="ai-note">Document: {task.documentId}{task.baseRevision ? ` · Revision: ${task.baseRevision}` : ''}</p>
    <JsonRecovery label="Original target (read-only)" value={task.original} />
    {task.snapshotDocument && <JsonRecovery label="Original full snapshot (read-only)" value={task.snapshotDocument} />}
    {task.candidate && <JsonRecovery label="Candidate result (read-only)" value={task.candidate} />}
    {task.acceptance && <JsonRecovery label="Locally accepted document (read-only)" value={task.acceptance.document} />}
    <button type="button" onClick={() => downloadRecovery(task, `mote-ai-${task.id}.json`)}>Save recovery JSON</button>
  </details>
}

function CloudStatus({ assistant }: { assistant: Assistant }) {
  return <div className="ai-cloud-status">
    {assistant.cloudWarning && <p className="ai-error" role="alert">{assistant.cloudWarning}</p>}
    {assistant.cloudWarning && !assistant.cloudConflict && <button onClick={assistant.retryCloud}>Retry cloud connection</button>}
    {assistant.cloudConflict && <>
      <details><summary>Inspect cloud tasks ({assistant.cloudConflict.tasks.length})</summary>
        {assistant.cloudConflict.tasks.map(task => <div key={task.id}><h3>{taskTitle(task)}</h3><RecoveryDetails task={task} /></div>)}
      </details>
      <p>Choose which task list to keep. The other copy stays in this browser’s recovery archive; execution artifacts are not deleted.</p>
      <div className="ai-actions">
        <button onClick={() => assistant.resolveCloudConflict('cloud')}>Use cloud tasks</button>
        <button onClick={() => assistant.resolveCloudConflict('local')}>Publish this task list</button>
        <button onClick={() => downloadRecovery({ local: assistant.allTasks, cloud: assistant.cloudConflict }, 'mote-ai-conflict.json')}>Save both copies</button>
      </div>
    </>}
  </div>
}

function RecoveryArchives({ assistant }: { assistant: Assistant }) {
  if (!assistant.archives.length) return null
  return <details className="ai-archives"><summary>Saved recovery copies ({assistant.archives.length})</summary>
    <p>These copies are retained in this browser, without locks or automatic application.</p>
    {assistant.archives.map(archive => <details key={archive.id}><summary>{archive.label} · {archive.tasks.length} tasks</summary>
      {archive.tasks.map(task => <div key={task.id}><h3>{taskTitle(task)}</h3><RecoveryDetails task={task} /></div>)}
      <div className="ai-actions"><button onClick={() => downloadRecovery(archive, `mote-ai-recovery-${archive.id}.json`)}>Save recovery copy</button>
        <button onClick={() => { if (window.confirm('Discard this saved recovery copy from this browser? This cannot be undone.')) assistant.discardArchive(archive.id) }}>Discard recovery copy</button></div>
    </details>)}
  </details>
}
