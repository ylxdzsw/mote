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
  : target.kind === 'text' ? `${target.blockIds.length} paragraph${target.blockIds.length === 1 ? '' : 's'}` : target.isNew ? 'Floating area'
  : !Array.isArray(original) && 'id' in original ? `${kindName(original)} revision` : 'Object revision'
const taskTitle = (task: AITask) => task.title || task.target.selectedText?.trim().split('\n')[0].slice(0, 40) || targetLabel(task)
const statusLabel = { draft: 'Not sent', preparing: 'Preparing…', queued: 'Queued', running: 'Working…', waiting: 'Waiting for result', ready: 'Ready to review', stopped: 'Stopped', error: 'Needs attention' }
const displayedStatus = (task: AITask) => task.executor === 'external' && ['preparing', 'queued', 'running'].includes(task.status) ? 'waiting' : task.status
const routineProgress = new Set(['Running builtin agent', 'Queued', 'Queued revision', 'Saving document and preparing snapshot…'])
const busyTask = (task: AITask) => (task.executor ?? 'builtin') === 'builtin' && ['preparing', 'queued', 'running'].includes(task.status)

export interface ReservationSelection {
  title: string
  detail?: string
  canReserve: boolean
}

export function AssistantPanel({ assistant, activeId, selection, onReserve, onLocate }: {
  assistant: Assistant; activeId: string | null; selection: ReservationSelection; onReserve: () => void; onLocate: (task: AITask) => void
}) {
  const recoveryTasks = assistant.allTasks.filter(task => !!assistant.inactiveReason(task))
  return <div className="ai-panel" aria-label="AI assistant">
    <CloudStatus assistant={assistant} />
    {!activeId && <div className="ai-empty">
      <ContextHeading title={selection.title} subtitle={selection.detail} />
      {selection.canReserve && <button className="ai-primary ai-reserve" title="Lock this content for a task without starting generation." onClick={onReserve}>Reserve for Assistant <PanelIcon name="spark" /></button>}
    </div>}
    {assistant.allTasks.map(task => <TaskView key={task.id} task={task} active={activeId === task.id} assistant={assistant} onLocate={() => onLocate(task)} />)}
    <RecoveryArchives assistant={assistant} />
    <footer className="ai-footer">
      {!!recoveryTasks.length && <details className="ai-recovery-tasks"><summary>Recovery ({recoveryTasks.length})</summary>
        {recoveryTasks.map(task => <button key={task.id} aria-pressed={activeId === task.id} onClick={() => assistant.openTask(task.id)}>{taskTitle(task)}</button>)}
      </details>}
      <details className="ai-info"><summary>Help & privacy</summary>
        <p>Documents and assistant tasks, including unsent requests and generated results, sync to your workspace. Preview candidate sends a saved document revision, its rendered snapshot, and the reserved area to Mu.</p>
        <p>External links grant access to the full immutable snapshot and scoped candidate submission. Workspace reads are separately off by default and expose only non-Private sources. Access pauses 24 hours after the document is closed; reopening resumes the same link. Switching agents, releasing or accepting the reservation, or enabling Private permanently revokes access. Downloaded copies cannot be recalled.</p>
        <p>Select a reserved area to view its task. For a new area, choose Add → AI object. Reserving does not start generation. Changes preview in place for your review. The area stays locked until you accept, discard, or delete it. Floating areas can move, and resize before the first request or handoff. Closing this panel does not stop work.</p>
      </details>
    </footer>
  </div>
}

function TaskView({ task, active, assistant, onLocate }: { task: AITask; active: boolean; assistant: Assistant; onLocate: () => void }) {
  const [activityCollapsed, setActivityCollapsed] = useState(true)
  const [copyNotice, setCopyNotice] = useState('')
  const [retryingExecutor, setRetryingExecutor] = useState(false)
  const inactive = assistant.inactiveReason(task)
  const busy = busyTask(task), executorBusy = assistant.executorBusy(task)
  const executor = task.executor ?? 'builtin', external = executor === 'external'
  const status = displayedStatus(task)
  const statusIssue = assistant.statusIssue(task.id)
  const candidateOptions = candidateVersions(task)
  const selectedCandidate = selectedCandidateVersion(task)
  const prompt = task.draftPrompt ?? (task.submitted ? '' : task.prompt)
  const agentLink = assistant.agentLink(task)
  const showProgress = !!task.progress && busy && !executorBusy && !assistant.offline && !routineProgress.has(task.progress)
  const retry = !!task.creation || !prompt.trim() && ['error', 'stopped'].includes(task.status)
  const workspaceReadBlocked = assistant.workspaceReadBlocked(task)
  const expanded = busy || !activityCollapsed
  const placeholder = task.submitted ? 'What should change?'
    : task.target.kind === 'segment' ? 'Describe the section you want to create…'
    : task.target.kind === 'text' ? 'Rewrite, expand, or explore these paragraphs…'
    : task.target.isNew ? 'Describe a diagram, formula, or interactive object…' : 'Describe how this object should change…'
  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyNotice(`${label} copied to clipboard.`)
    } catch {
      setCopyNotice(`Could not copy ${label.toLowerCase()}. Check clipboard permissions and try again.`)
    }
  }
  function switchExecutor(next: 'builtin' | 'external') {
    if (executorBusy || workspaceReadBlocked || inactive || next === executor) return
    setCopyNotice('')
    void assistant.switchExecutor(task.id, next).catch(() => {})
  }
  async function retryExecutor() {
    if (retryingExecutor) return
    setRetryingExecutor(true)
    try { await assistant.retryExecutor(task.id) } catch { /* The hook retains the confirmation error on the task. */ }
    finally { setRetryingExecutor(false) }
  }
  const instructions = agentLink && `Please help me with this Mote document: ${agentLink}\nSkill: https://mote.ylxdzsw.com/skills/external/SKILL.md${selectedCandidate?.id ? `\nCandidate to discuss: ${selectedCandidate.id} revision ${selectedCandidate.revision}.` : ''}`
  return <section className={`ai-task${task.submitted ? '' : ' ai-task-draft'}${external ? ' ai-task-external' : ''}`} data-ai-task={task.id} id={`ai-panel-${task.id}`} aria-label={taskTitle(task)} hidden={!active}>
    <div className="ai-task-body">
      <div className="ai-task-header">
        <div className="ai-task-title"><ContextHeading title={taskTitle(task)} /><button aria-label="Show in document" title="Show in document" disabled={!!inactive} onClick={onLocate}><PanelIcon name="arrow" /></button></div>
        <div className={`ai-status ${status}`} role="status"><span aria-hidden="true">{busy ? '◌' : task.status === 'ready' ? '✓' : task.status === 'error' ? '!' : '○'}</span>{inactive ? task.acceptance ? 'Applied locally · result retained' : 'Recovery only' : assistant.offline && (busy || task.status === 'waiting') ? 'Pending · offline' : external && status === 'waiting' ? 'Awaiting submission' : statusLabel[status]}</div>
        <div className="ai-executor">
          <span className="ai-executor-label" id={`ai-executor-label-${task.id}`}>Agent</span>
          <div className="ai-executor-switch" role="group" aria-labelledby={`ai-executor-label-${task.id}`}>
            <button type="button" aria-label="Use built-in agent" title="Work with Mote’s built-in agent using the full document snapshot." aria-pressed={executor === 'builtin'} disabled={executorBusy || workspaceReadBlocked || !!inactive}
              onClick={() => switchExecutor('builtin')}>Built-in</button>
            <button type="button" aria-label="Use external agent" title="Grant an external agent link access to the full document snapshot and candidate submission." aria-pressed={executor === 'external'} disabled={executorBusy || workspaceReadBlocked || !!inactive || assistant.externalBlocked}
              onClick={() => switchExecutor('external')}>External</button>
          </div>
          <WorkspaceReadControl task={task} assistant={assistant} external={external} />
          {assistant.externalBlocked && <p className="ai-external-unavailable" role="status">{assistant.privateDocument ? 'External handoff is unavailable while this document is private.' : 'External handoff is paused until the privacy change is confirmed.'}</p>}
          {executorBusy && <p className="ai-executor-state" role="status">{task.pendingExecutor?.executor === 'external' ? 'Confirming external access…' : task.pendingExecutor?.executor === 'builtin' ? 'Confirming built-in agent…' : external ? 'Confirming agent access…' : 'Confirming agent change…'}</p>}
          {task.pendingExecutor && <button type="button" className="ai-executor-retry" disabled={retryingExecutor || assistant.executorWorking(task) || assistant.externalBlocked && task.pendingExecutor.executor === 'external'}
            aria-label="Retry agent switch confirmation" onClick={() => void retryExecutor()}>{retryingExecutor ? 'Retrying confirmation…' : 'Retry confirmation'}</button>}
        </div>
      </div>
      {inactive && <p className="ai-note" role="status">{inactive}</p>}
      {task.submitted && !external && task.status !== 'waiting' && <div className={`ai-activity${expanded ? '' : ' is-collapsed'}`}>
        <button className="ai-activity-toggle" aria-expanded={expanded} aria-controls={`ai-activity-${task.id}`} disabled={busy} onClick={() => setActivityCollapsed(!activityCollapsed)}>
          <span>Activity</span><span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
        </button>
        <div className="ai-activity-body" id={`ai-activity-${task.id}`} hidden={!expanded}>
          <Suspense fallback={<p className="ai-note">Loading activity…</p>}>
            <Transcript taskId={task.id} active={active && expanded} submitted={task.submitted} onMissing={() => assistant.missingRemote(task.id)} />
          </Suspense>
        </div>
      </div>}
      {(task.error || showProgress) && <div className="ai-task-feedback">
        {showProgress && <p className="ai-progress" role="status">{task.progress}</p>}
        {task.error && <p className="ai-error" role="alert">{task.error}</p>}
      </div>}
      {statusIssue && <div className="ai-task-feedback">
        <p className="ai-progress" role="status">{statusIssue.message}</p>
        {statusIssue.paused && <button type="button" onClick={() => assistant.checkStatus(task.id)}>Check status</button>}
      </div>}
      {(candidateOptions.length > 0 || task.candidateNotice) && <section className="ai-result" aria-label="Review changes">
        <h3><PanelIcon name="spark" />{selectedCandidate ? inactive || task.error && !task.preview ? 'Retained result' : busy ? 'Previous result' : 'Ready to review' : 'Candidate selection'}</h3>
        {task.candidateNotice && <p className="ai-candidate-notice" role="status">{task.candidateNotice}</p>}
        {(candidateOptions.length > 1 || candidateOptions.length > 0 && !selectedCandidate) && <label className="ai-candidate-picker">
          <span>Candidate</span>
          <select aria-label="Select candidate revision" value={selectedCandidate?.id ? `${selectedCandidate.id}:${selectedCandidate.revision}` : ''}
            onChange={event => {
              const [id, revision] = event.target.value.split(':')
              if (id && Number.isSafeInteger(Number(revision))) assistant.selectCandidate(task.id, { id, revision: Number(revision) })
            }}>
            {!selectedCandidate && <option value="">Choose a candidate…</option>}
            <optgroup label="Current candidates">
              {candidateOptions.filter(option => option.current).map(option => <option key={`${option.id}:${option.revision}`} value={`${option.id}:${option.revision}`}>{candidateVersionName(option)}</option>)}
            </optgroup>
            {candidateOptions.some(option => !option.current) && <optgroup label="Earlier revisions">
              {candidateOptions.filter(option => !option.current).map(option => <option key={`${option.id}:${option.revision}`} value={`${option.id}:${option.revision}`}>{candidateVersionName(option)}</option>)}
            </optgroup>}
          </select>
        </label>}
        {selectedCandidate ? <>
          <p className="ai-candidate-meta">{candidateVersionName(selectedCandidate)}{!selectedCandidate.current && <span>Earlier revision</span>}</p>
          <p className="ai-summary">{selectedCandidate.candidate.summary}</p>
          {Array.isArray(selectedCandidate.candidate.sources) && !!selectedCandidate.candidate.sources.length && <details className="ai-sources"><summary>Sources</summary><ul>{selectedCandidate.candidate.sources.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></details>}
          {!inactive && <div className="ai-preview-switch" role="group" aria-label="Document view">
            <button type="button" aria-pressed={!task.preview} onClick={() => assistant.update(task.id, { preview: false })}>Original</button>
            <button type="button" aria-pressed={task.preview} onClick={() => assistant.update(task.id, { preview: true })}>Preview</button>
          </div>}
        </> : candidateOptions.length > 0 && <p className="ai-note" role="status">Original content is shown. Choose a remaining candidate to preview it.</p>}
        <div className="ai-actions ai-review-actions">
          {!inactive && selectedCandidate && <button className="ai-primary" type="button" disabled={busy || !task.remoteMissing && (executorBusy || workspaceReadBlocked)} onClick={() => assistant.accept(task.id)}>Accept this candidate <PanelIcon name="check" /></button>}
          <button className="ai-quiet" type="button" onClick={() => assistant.discard(task.id)}>Discard</button>
        </div>
      </section>}
      {task.submitted && <RecoveryDetails task={task} />}
      {assistant.canSyncAcceptance(task) && <div className="ai-note"><button onClick={() => void assistant.syncAcceptance(task.id)}>Retry saving accepted document</button></div>}
    </div>
    {external ? <div className="ai-composer ai-external-access">
      <div className="ai-actions ai-external-buttons">
        <button type="button" disabled={executorBusy || workspaceReadBlocked || !!inactive || !agentLink || !instructions}
          onClick={() => instructions && void copyText(instructions, 'Instructions')}>Copy instructions</button>
        <button type="button" disabled={executorBusy || workspaceReadBlocked || !!inactive || !agentLink}
          onClick={() => agentLink && void copyText(agentLink, 'Link')}>Copy link</button>
        {!candidateOptions.length && <button className="ai-quiet" type="button" onClick={() => assistant.discard(task.id)}>Discard task</button>}
      </div>
      {assistant.privateDocument ? <p className="ai-external-unavailable" role="status">External handoff and its access link are disabled while this document is private.</p>
        : !agentLink && !executorBusy && <p className="ai-external-unavailable" role="status">Agent access link is unavailable.</p>}
      {task.accessPaused && <p className="ai-external-unavailable" role="status">External access is paused. Reopen this document to resume the same link.</p>}
      {copyNotice && <p className="ai-copy-notice" role="status" aria-live="polite">{copyNotice}</p>}
      <p className="ai-privacy">This link grants access to the full immutable document snapshot and scoped candidate submission, not only the reserved area. Access pauses 24 hours after the document is closed; reopening resumes the same link. Switching agents, releasing or accepting the reservation, or enabling Private permanently revokes access. Downloaded copies cannot be recalled.</p>
    </div> : inactive ? <div className="ai-composer ai-actions">
      {!candidateOptions.length && <button type="button" onClick={() => assistant.discard(task.id)}>Discard task</button>}
      {busy && <button type="button" disabled={executorBusy} onClick={() => void assistant.stop(task.id)}>Stop</button>}
    </div> : <form className="ai-composer" onSubmit={event => { event.preventDefault(); if (!busy && !executorBusy) void assistant.start(task.id, retry ? task.prompt : prompt) }}>
      <label htmlFor={`ai-request-${task.id}`}>{task.submitted ? 'Follow-up' : 'Request'}</label>
      <textarea id={`ai-request-${task.id}`} aria-label="AI request" rows={task.submitted ? 3 : 5} value={prompt}
        placeholder={placeholder} disabled={executorBusy} onChange={event => assistant.update(task.id, { draftPrompt: event.target.value })} />
      <div className="ai-actions ai-compose-actions">
        {busy ? <button key="stop" type="button" disabled={executorBusy} onClick={() => void assistant.stop(task.id)}>Stop</button>
          : <button key="submit" className={candidateOptions.length ? '' : 'ai-primary'} type="submit" disabled={executorBusy || workspaceReadBlocked || !!assistant.cloudConflict || task.remoteMissing || task.submitted && candidateOptions.length > 0 && !selectedCandidate || !(retry ? task.prompt : prompt).trim()}>{retry ? 'Retry' : task.submitted ? 'Revise' : 'Preview candidate'} <PanelIcon name="spark" /></button>}
        {!candidateOptions.length && <button className="ai-quiet" type="button" onClick={() => assistant.discard(task.id)}>{task.status === 'draft' ? 'Cancel reservation' : 'Discard'}</button>}
      </div>
    </form>}
    {!task.submitted && <RecoveryDetails task={task} />}
  </section>
}

function WorkspaceReadControl({ task, assistant, external = false }: { task: AITask; assistant: Assistant; external?: boolean }) {
  const state = assistant.workspaceReadState(task)
  const busy = assistant.workspaceReadWorking(task.id)
  const blocked = assistant.workspaceReadBlocked(task)
  const inactive = assistant.inactiveReason(task)
  const executorChanging = !!task.pendingExecutor || assistant.executorBusy(task)
  const label = external ? 'Allow workspace reads' : 'Use workspace documents'
  const submittedOrUncertain = task.submitted || task.requestSent
  const disabled = !!inactive || assistant.executorBusy(task) || !!task.pendingExecutor || task.status === 'preparing' || busy
    || assistant.externalBlocked && external || submittedOrUncertain && !state.known
  const description = external
    ? 'Grant this external agent scoped access to non-Private workspace documents. Private sources stay unavailable. Turning this off blocks future reads but cannot recall fetched content.'
    : 'Let this built-in agent search and read non-Private workspace documents. Private sources remain limited to their own built-in agent. Turning this off blocks future reads but cannot erase context already fetched.'
  return <div className="ai-workspace-read">
    {state.known && !state.pending && !executorChanging ? <label className="ai-workspace-read-toggle" title={description}>
      <input type="checkbox" checked={state.enabled} disabled={disabled || blocked} aria-description={description}
        onChange={event => { void assistant.setWorkspaceRead(task.id, event.target.checked) }} />
      <span>{label}</span>
    </label> : <div className="ai-workspace-read-current">
      <strong>{label}</strong>
      <p role="status">{state.pending ? `Confirming ${state.pending.enabled ? 'enabled' : 'disabled'} workspace reads. The change is not yet confirmed.`
        : executorChanging ? 'Confirming the agent selection; its workspace-read setting may reset.' : 'Checking the server’s workspace-read setting…'}</p>
    </div>}
    {state.pending && <div className="ai-workspace-read-actions">
      {assistant.workspaceReadIssue(task.id) && <p role="status">{assistant.workspaceReadIssue(task.id)}</p>}
      <button type="button" disabled={busy || !!inactive} onClick={() => { void assistant.retryWorkspaceRead(task.id) }}>Retry access change</button>
      <button type="button" disabled={busy || !!inactive} onClick={() => { void assistant.refreshWorkspaceRead(task.id) }}>Refresh status</button>
    </div>}
    {!state.known && !state.pending && submittedOrUncertain && <div className="ai-workspace-read-actions">
      {assistant.workspaceReadIssue(task.id) && <p role="status">{assistant.workspaceReadIssue(task.id)}</p>}
      <button type="button" disabled={busy || !!inactive} onClick={() => { void assistant.refreshWorkspaceRead(task.id) }}>Refresh status</button>
    </div>}
    {!state.pending && state.known && assistant.workspaceReadIssue(task.id) && <p className="ai-workspace-read-message" role="status">{assistant.workspaceReadIssue(task.id)}</p>}
  </div>
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
