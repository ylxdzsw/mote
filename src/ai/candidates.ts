import type { AITask, RemoteTask, TaskVersion } from './types'

type CandidateState = Pick<AITask, 'protocol' | 'versions' | 'selectedVersion' | 'candidateNotice'>

export function candidateVersions(task: CandidateState): TaskVersion[] {
  return task.protocol === 'mote-agent-v5' ? task.versions ?? [] : []
}

export function selectedCandidateVersion(task: CandidateState): TaskVersion | undefined {
  const versions = candidateVersions(task)
  return task.selectedVersion ? versions.find(version => version.id === task.selectedVersion)
    : task.candidateNotice ? undefined : versions[0]
}

export function candidateVersionName(version: TaskVersion) {
  return `${version.id}${version.label ? ` · ${version.label}` : ''}`
}

export function reconcileCandidateState(task: AITask, remote: RemoteTask): Partial<AITask> {
  if (task.protocol !== 'mote-agent-v5' || remote.protocol !== 'mote-agent-v5' || !remote.versions) return {}
  const versions = remote.versions
  const selectedVersion = task.selectedVersion ?? selectedCandidateVersion(task)?.id
  if (selectedVersion) return versions.some(version => version.id === selectedVersion)
    ? { versions, selectedVersion }
    : { versions, selectedVersion, preview: false, candidateNotice: `Selected ${selectedVersion} is unavailable. Original content is shown; choose a version to preview.` }
  if (task.candidateNotice || !versions.length) return { versions }
  return { versions, selectedVersion: versions[0].id, preview: true }
}
