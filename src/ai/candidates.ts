import type { AITask, Candidate, CandidateSelection, CandidateVersion, RemoteTask, TaskCandidate } from './types'

export interface CandidateOption extends CandidateVersion { id?: string; current: boolean; legacy?: boolean }

function validCandidate(value: unknown): value is Candidate {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { summary?: unknown }).summary === 'string'
}

function validVersion(value: unknown): value is CandidateVersion {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger((value as CandidateVersion).revision) && (value as CandidateVersion).revision >= 0
    && validCandidate((value as CandidateVersion).candidate)
}

function compareId(a: string, b: string) {
  const left = /^C(\d+)$/i.exec(a), right = /^C(\d+)$/i.exec(b)
  if (left && right) return Number(left[1]) - Number(right[1])
  return a.localeCompare(b)
}

export function candidateVersions(task: Pick<AITask, 'candidate' | 'candidates' | 'candidateRevision'>): CandidateOption[] {
  if (Array.isArray(task.candidates)) {
    const current: CandidateOption[] = [], history: CandidateOption[] = []
    for (const entry of task.candidates as TaskCandidate[]) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || !validVersion(entry)) continue
      current.push({ id: entry.id, revision: entry.revision, label: entry.label, candidate: entry.candidate, current: true })
      for (const version of Array.isArray(entry.history) ? entry.history : []) {
        if (!validVersion(version) || version.revision === entry.revision) continue
        history.push({ id: entry.id, revision: version.revision, label: version.label ?? entry.label, candidate: version.candidate, current: false })
      }
    }
    current.sort((a, b) => compareId(a.id!, b.id!))
    history.sort((a, b) => compareId(a.id!, b.id!) || b.revision - a.revision)
    return [...current, ...history]
  }
  return validCandidate(task.candidate)
    ? [{ revision: Number.isSafeInteger(task.candidateRevision) ? task.candidateRevision! : 0,
      candidate: task.candidate, current: true, legacy: true }]
    : []
}

export function sameCandidate(a: Candidate, b: Candidate) {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]))
      : value
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b))
}

export function defaultCandidateVersion(task: Pick<AITask, 'candidate' | 'candidates' | 'candidateRevision'>): CandidateOption | undefined {
  const current = candidateVersions(task).filter(version => version.current)
  if (task.candidate) {
    const alias = current.find(version => sameCandidate(version.candidate, task.candidate!))
    if (alias) return alias
  }
  return current.at(-1)
}

export function selectedCandidateVersion(task: Pick<AITask,
  'candidate' | 'candidates' | 'candidateRevision' | 'selectedCandidate' | 'candidateNotice'>): CandidateOption | undefined {
  const versions = candidateVersions(task)
  if (task.selectedCandidate) return versions.find(version => version.id === task.selectedCandidate!.id
    && version.revision === task.selectedCandidate!.revision)
  if (task.candidateNotice) return undefined
  return defaultCandidateVersion(task)
}

export function candidateSelection(version: CandidateOption | undefined): CandidateSelection | undefined {
  return version?.id ? { id: version.id, revision: version.revision } : undefined
}

export function candidateVersionName(version: CandidateOption) {
  return `${version.id ?? 'Candidate'}${version.label ? ` · ${version.label}` : ''} · r${version.revision}`
}

export function reconcileCandidateState(task: AITask, remote: RemoteTask): Partial<AITask> {
  if (!Array.isArray(remote.candidates)) return remote.candidate ? { candidate: remote.candidate } : {}
  const updated = { ...task, candidates: remote.candidates }
  const versions = candidateVersions(updated)
  const current = versions.filter(version => version.current)
  const alias = remote.candidate && current.find(version => sameCandidate(version.candidate, remote.candidate!))
  const latest = alias ?? current.at(-1)
  const patch: Partial<AITask> = {
    candidates: remote.candidates,
    candidate: latest?.candidate,
  }
  const previous = selectedCandidateVersion(task)
  const removedVersion = task.selectedCandidate
    ? `${task.selectedCandidate.id}${previous?.label ? ` · ${previous.label}` : ''} · r${task.selectedCandidate.revision}`
    : previous ? candidateVersionName(previous) : 'candidate'
  const removed = () => ({ ...patch, selectedCandidate: undefined, preview: false,
    candidateNotice: `Selected ${removedVersion} was removed. Original content is shown; choose a remaining candidate to preview.` })

  if (task.selectedCandidate) {
    const retained = versions.find(version => version.id === task.selectedCandidate!.id && version.revision === task.selectedCandidate!.revision)
    return retained ? { ...patch, selectedCandidate: task.selectedCandidate } : removed()
  }
  if (task.candidateNotice) return { ...patch, selectedCandidate: undefined, preview: false }
  if (previous) {
    const retained = previous.id
      ? versions.find(version => version.id === previous.id && version.revision === previous.revision)
      : versions.find(version => sameCandidate(version.candidate, previous.candidate))
    if (retained) return { ...patch, selectedCandidate: candidateSelection(retained) }
    return removed()
  }
  const initial = defaultCandidateVersion({ ...updated, candidate: latest?.candidate })
  if (!initial) return patch
  return { ...patch, selectedCandidate: candidateSelection(initial), preview: true }
}
