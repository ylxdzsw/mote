import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import type { JSONContent } from '@tiptap/core'
import type { AITask } from './types'

export interface AIReview {
  tasks: AITask[]
  mainActive: boolean
  segmentPreviews?: Array<{ taskId: string; taskIds: string[]; from: number; to: number; content: JSONContent[]; blockOwners: Record<string, string> }>
  segmentRanges?: Array<{ taskId: string; from: number; to: number; startOffset?: number; endOffset?: number }>
  activeSegmentId?: string | null
  selectSegment?: (id: string) => void
  selectText: () => void
  previewFailed: (id: string, error: unknown) => void
  accept: (id: string) => void
  discard: (id: string) => void
  stop: (id: string) => void
  toggle: (id: string) => void
  open: (id: string) => void
  deleteTarget?: (id: string) => void
}

export const reviewKey = (task: AITask) => `${task.id}:${task.status}:${task.preview}:${!!task.candidate}:${!!task.remoteMissing}:${!!task.pendingExecutor}:${!!task.pendingWorkspaceRead}:${task.workspaceReadConfirmed ?? ''}:${task.workspaceReadRevision ?? ''}`

// Shared by editor decoration widgets and floating objects; never document content.
export function reviewControls(task: AITask, actions: () => AIReview) {
  const root = document.createElement('div')
  root.className = 'ai-review-controls'
  root.contentEditable = 'false'
  root.dataset.aiControls = task.id
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', 'AI reservation review')
  root.onpointerdown = event => event.stopPropagation()
  root.onmousedown = event => event.preventDefault()
  root.ondblclick = event => event.stopPropagation()
  root.onkeydown = event => event.stopPropagation()
  const button = (label: string, action: () => void) => {
    const element = document.createElement('button')
    element.type = 'button'; element.textContent = label; element.onclick = action
    root.append(element)
  }
  const busy = ['preparing', 'queued', 'running'].includes(task.status)
  const workspacePermissionUnconfirmed = !!task.pendingWorkspaceRead || !!task.submitted && task.workspaceReadConfirmed !== true
  if (task.candidate) {
    button(task.preview ? 'Original' : 'Candidate', () => actions().toggle(task.id))
    if (!busy && (task.remoteMissing || !task.pendingExecutor && !workspacePermissionUnconfirmed)) button('Accept', () => actions().accept(task.id))
  }
  if (busy && !task.pendingExecutor && task.executor !== 'external') button('Stop', () => actions().stop(task.id))
  button(task.status === 'draft' ? 'Cancel reservation' : 'Discard', () => actions().discard(task.id))
  button('Request…', () => actions().open(task.id))
  if (actions().deleteTarget) button('Delete region', () => actions().deleteTarget!(task.id))
  return root
}

export function ReviewControls({ task, review, style }: { task: AITask; review: AIReview; style: CSSProperties }) {
  const root = useRef<HTMLDivElement>(null), latest = useRef(review)
  latest.current = review
  const key = reviewKey(task)
  useLayoutEffect(() => { root.current!.replaceChildren(reviewControls(task, () => latest.current)) }, [key])
  return <div className="ai-object-review" ref={root} style={style} />
}
