import { lazy, Suspense, useState } from 'react'
import type { useAssistant } from './useAssistant'
import type { AITask } from './types'
import { candidateVersionName, candidateVersions, selectedCandidateVersion } from './candidates'
import { ContextHeading } from '../app/Inspector'
import { PanelIcon } from '../app/PanelIcon'
import { kindName } from '../app/FloatingInspector'
import './assistant.css'

const Transcript = lazy(() => import('./Transcript'))
type Assistant = ReturnType<typeof useAssistant>
const targetLabel = ({ target, original }: AITask) => target.kind === 'segment'
  ? target.range.start.index === target.range.end.index && target.range.start.offset === target.range.end.offset ? 'New section' : 'Document section'
  : target.kind === 'text' ? `${target.blockIds.length} paragraph${target.blockIds.length === 1 ? '' : 's'}` : target.isNew ? 'AI object'
  : !Array.isArray(original) && 'id' in original ? `${kindName(original)} revision` : 'Object revision'
const taskTitle = (task: AITask) => task.title || task.target.selectedText?.trim().split('\n')[0].slice(0, 40) || targetLabel(task)
const statusLabel = { draft: 'Reservation pending', preparing: 'Preparing…', queued: 'Queued', running: 'Working…', waiting: 'Ready for agents', ready: 'Ready to review', stopped: 'Stopped', error: 'Needs attention' }
export interface ReservationSelection { title: string; detail?: string; canReserve: boolean }

export function AssistantPanel({ assistant, activeId, selection, onReserve, onLocate }: {
  assistant: Assistant; activeId: string | null; selection: ReservationSelection; onReserve: () => void; onLocate: (task: AITask) => void
}) {
  const retained = assistant.allTasks.filter(task => !!assistant.inactiveReason(task))
  return <div className="ai-panel" aria-label="AI assistant">
    <CloudStatus assistant={assistant} />
    {!activeId && <div className="ai-empty"><ContextHeading title={selection.title} subtitle={selection.detail} />
      {selection.canReserve && <button className="ai-primary ai-reserve" onClick={onReserve}>Reserve for Assistant <PanelIcon name="spark" /></button>}
    </div>}
    {assistant.allTasks.map(task => <TaskView key={task.id} task={task} active={activeId === task.id} assistant={assistant} onLocate={() => onLocate(task)} />)}
    <RecoveryArchives assistant={assistant} />
    <footer className="ai-footer">
      {!!retained.length && <details className="ai-recovery-tasks"><summary>Retained tasks ({retained.length})</summary>
        {retained.map(task => <button key={task.id} aria-pressed={activeId === task.id} onClick={() => assistant.openTask(task.id)}>{taskTitle(task)}</button>)}
      </details>}
      <details className="ai-info"><summary>Help & privacy</summary>
        <p>Reservations, task permissions, Accept, and Discard are undoable document edits. They request an early debounced sync; cloud conflicts preserve your local changes. Agent access follows the last saved task state.</p>
        <p>Built-in and external agents can work together. These tabs only change the controls shown; switching tabs does not stop work or change access. Proposals share one version list and never edit your document automatically.</p>
        <p>The task link can read the latest saved document and, when allowed, non-Private workspace sources. Each request checks current access. Private blocks the public endpoint; the internal built-in socket still works. Downloaded content cannot be recalled.</p>
        <p>Accept replaces the reserved content and releases its reservation in one local undo step. Discard releases without changing content. Undo restores the same task; it never restarts generation. Proposals remain available independently of document saving.</p>
      </details>
    </footer>
  </div>
}

function TaskView({ task, active, assistant, onLocate }: { task: AITask; active: boolean; assistant: Assistant; onLocate: () => void }) {
  const [activityCollapsed, setActivityCollapsed] = useState(true)
  const [copyNotice, setCopyNotice] = useState('')
  const inactive = assistant.inactiveReason(task)
  const busy = ['preparing', 'queued', 'running'].includes(task.status)
  const external = task.executor === 'external'
  const versions = candidateVersions(task), selected = selectedCandidateVersion(task)
  const prompt = task.draftPrompt ?? ''
  const link = assistant.agentLink(task)
  const expanded = busy || !activityCollapsed
  const instructions = link && `Please help with this Mote task: ${link}\nSkill: https://mote.ylxdzsw.com/skills/external/SKILL.md\nOptional document and workspace reads return latest cloud content. Submit one or more proposals; each receives a server-assigned version ID. Other agents may submit concurrently. The owner reviews and accepts proposals as document edits.${selected ? `\nSelected version for context: ${selected.id}.` : ''}`
  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setCopyNotice(`${label} copied.`) }
    catch { setCopyNotice(`Could not copy ${label.toLowerCase()}. Check clipboard permissions and retry.`) }
  }
  const expiry = task.expiresAt ? new Date(task.expiresAt - new Date(task.expiresAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''
  return <section className={`ai-task${external ? ' ai-task-external' : ''}`} data-ai-task={task.id} aria-label={taskTitle(task)} hidden={!active}>
    <div className="ai-task-body">
      <div className="ai-task-header">
        <div className="ai-task-title"><ContextHeading title={taskTitle(task)} /><button aria-label="Show in document" disabled={!!inactive} onClick={onLocate}><PanelIcon name="arrow" /></button></div>
        <div className={`ai-status ${task.status}`} role="status">{task.released ? 'Released · proposals retained' : statusLabel[task.status]}</div>
        <div className="ai-executor">
          <span className="ai-executor-label">Agent</span>
          <div className="ai-executor-switch" role="tablist" aria-label="Agent controls">
            <button type="button" role="tab" aria-selected={!external} onClick={() => assistant.update(task.id, { executor: 'builtin' })}>Built-in</button>
            <button type="button" role="tab" aria-selected={external} onClick={() => assistant.update(task.id, { executor: 'external' })}>External</button>
          </div>
          <label className="ai-workspace-read-toggle" title="Allow any agent using this task to search and read non-Private workspace documents. Changes take effect after ordinary document sync.">
            <input type="checkbox" checked={task.workspaceRead} disabled={!!task.released} onChange={event => assistant.setWorkspaceRead(task.id, event.target.checked)} />
            <span>Allow workspace reads</span>
          </label>
          <details className="ai-info"><summary>Task access</summary>
            <label>Expires <input type="datetime-local" aria-label="Task expiration" value={expiry} disabled={!!task.released}
              onChange={event => assistant.setExpiration(task.id, event.target.value ? new Date(event.target.value).getTime() : undefined)} /></label>
            <p>Empty means no expiration. Access follows the saved task state; undo can restore the same link.</p>
          </details>
          {!task.released && assistant.permissionPending(task) && <p className="ai-note" role="status">Access changes are pending document sync.</p>}
        </div>
      </div>
      {inactive && <p className="ai-note" role="status">{inactive}</p>}
      {!external && (task.submitted || busy) && <div className={`ai-activity${expanded ? '' : ' is-collapsed'}`}>
        <button className="ai-activity-toggle" aria-expanded={expanded} disabled={busy} onClick={() => setActivityCollapsed(!activityCollapsed)}><span>Activity</span><span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button>
        <div className="ai-activity-body" hidden={!expanded}><Suspense fallback={<p className="ai-note">Loading activity…</p>}>
          <Transcript taskId={task.id} documentId={task.documentId} active={active && expanded} submitted={task.submitted} onMissing={() => assistant.missingRemote(task.id)} />
        </Suspense></div>
      </div>}
      {task.error && <p className="ai-error" role="alert">{task.error}</p>}
      {assistant.statusIssue(task.id) && <div className="ai-task-feedback"><p role="status">{assistant.statusIssue(task.id)}</p><button onClick={() => assistant.checkStatus(task.id)}>Check status</button></div>}
      {(versions.length > 0 || task.candidateNotice) && <section className="ai-result" aria-label="Review changes">
        <h3><PanelIcon name="spark" />{task.released ? 'Retained proposals' : 'Review proposals'}</h3>
        {task.candidateNotice && <p className="ai-candidate-notice" role="status">{task.candidateNotice}</p>}
        {!!versions.length && <label className="ai-candidate-picker"><span>Version</span>
          <select aria-label="Select version" value={selected?.id ?? ''} onChange={event => assistant.selectVersion(task.id, event.target.value)}>
            {!selected && <option value="">Choose a version…</option>}
            {versions.map(version => <option key={version.id} value={version.id}>{candidateVersionName(version)}</option>)}
          </select>
        </label>}
        {selected && <>
          <p className="ai-summary">{selected.candidate.summary}</p>
          {!!selected.candidate.sources?.length && <details className="ai-sources"><summary>Sources</summary><ul>{selected.candidate.sources.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></details>}
          {!inactive && <div className="ai-preview-switch" role="group" aria-label="Document view">
            <button aria-pressed={!task.preview} onClick={() => assistant.update(task.id, { preview: false })}>Original</button>
            <button aria-pressed={task.preview} onClick={() => assistant.update(task.id, { preview: true, error: undefined })}>Preview version</button>
          </div>}
        </>}
        {!task.released && <div className="ai-actions ai-review-actions">
          {!inactive && selected && <button className="ai-primary" onClick={() => assistant.accept(task.id)}>Accept version <PanelIcon name="check" /></button>}
          <button className="ai-quiet" onClick={() => assistant.discard(task.id)}>Discard</button>
        </div>}
      </section>}
      <RecoveryDetails task={task} />
    </div>
    {external ? <div className="ai-composer ai-external-access">
      <div className="ai-actions ai-external-buttons">
        <button disabled={!instructions} onClick={() => instructions && void copy(instructions, 'Instructions')}>Copy instructions</button>
        <button disabled={!link} onClick={() => link && void copy(link, 'Link')}>Copy link</button>
      </div>
      {copyNotice && <p className="ai-copy-notice" role="status">{copyNotice}</p>}
      {assistant.externalBlocked ? <p role="status">Public task access is unavailable while the document is Private or a privacy change is pending. Built-in access is separate.</p>
        : !link && !task.released ? <p role="status">The link becomes available after the reservation is saved. Check the document’s sync status if it remains unavailable.</p> : null}
      <p className="ai-privacy">This link allows access to the latest saved document, not only the reserved area. Each request checks saved permissions and task lifetime. Built-in and external agents share the same proposal list. Switching tabs changes no access.</p>
      {!versions.length && !task.released && <button onClick={() => assistant.discard(task.id)}>Discard reservation</button>}
    </div> : <form className="ai-composer" onSubmit={event => { event.preventDefault(); void assistant.start(task.id, prompt) }}>
      {!task.released && <>
        <label htmlFor={`ai-request-${task.id}`}>{task.submitted ? 'Follow-up' : 'Request'}</label>
        <textarea id={`ai-request-${task.id}`} aria-label="AI request" rows={3} value={prompt} placeholder="Describe the change or refer to any version…"
          onChange={event => assistant.update(task.id, { draftPrompt: event.target.value })} />
      </>}
      <div className="ai-actions ai-compose-actions">
        {busy ? <button type="button" disabled={task.status === 'preparing'} onClick={() => void assistant.stop(task.id)}>{task.status === 'preparing' ? 'Sending…' : 'Stop'}</button>
          : !task.released && <button className="ai-primary" type="submit" disabled={!task.pendingRun && !prompt.trim()}>{task.pendingRun ? 'Retry request' : 'Generate'} <PanelIcon name="spark" /></button>}
        {!versions.length && !task.released && <button className="ai-quiet" type="button" onClick={() => assistant.discard(task.id)}>Discard reservation</button>}
      </div>
    </form>}
  </section>
}

function downloadRecovery(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function RecoveryDetails({ task }: { task: AITask }) {
  return <div className="ai-recovery-details"><button type="button" className="ai-quiet" title="Download the request, original snapshot, and result as JSON." onClick={() => downloadRecovery(task, `mote-ai-${task.id}.json`)}>Download task JSON</button></div>
}

function CloudStatus({ assistant }: { assistant: Assistant }) {
  return assistant.cloudWarning ? <div className="ai-cloud-status"><p className="ai-error" role="alert">{assistant.cloudWarning}</p><button onClick={assistant.retryCloud}>Retry local saving</button></div> : null
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
