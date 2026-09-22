import { useLayoutEffect, useRef } from 'react'
import type { AITask } from './types'

export interface AIReview {
  tasks: AITask[]
  mainActive: boolean
  selectText: () => void
  accept: (id: string) => void
  discard: (id: string) => void
  stop: (id: string) => void
  toggle: (id: string) => void
  open: (id: string) => void
  deleteTarget?: (id: string) => void
}

export const reviewKey = (task: AITask) => `${task.id}:${task.status}:${task.preview}:${!!task.candidate}`

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
  if (task.candidate) {
    button(task.preview ? 'Original' : 'Candidate', () => actions().toggle(task.id))
    if (!busy) button('Accept', () => actions().accept(task.id))
  }
  if (busy) button('Stop', () => actions().stop(task.id))
  button('Discard', () => actions().discard(task.id))
  button('Request…', () => actions().open(task.id))
  if (actions().deleteTarget) button('Delete region', () => actions().deleteTarget!(task.id))
  return root
}

export function ReviewControls({ task, review }: { task: AITask; review: AIReview }) {
  const root = useRef<HTMLDivElement>(null), latest = useRef(review)
  latest.current = review
  const key = reviewKey(task)
  useLayoutEffect(() => { root.current!.replaceChildren(reviewControls(task, () => latest.current)) }, [key])
  return <div className="ai-object-review" ref={root} />
}
