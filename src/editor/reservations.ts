import { Extension, type JSONContent } from '@tiptap/core'
import { Plugin, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { RefObject } from 'react'
import type { useDocumentHistory } from '../document/history'
import { reviewControls, reviewKey, type AIReview } from '../ai/ReviewControls'
import type { AITask } from '../ai/types'

const candidates = new WeakMap<object, number>()
let nextCandidate = 0
function candidateKey(content: object) {
  if (!candidates.has(content)) candidates.set(content, ++nextCandidate)
  return candidates.get(content)
}

type SegmentPreview = NonNullable<AIReview['segmentPreviews']>[number]
type SegmentRange = NonNullable<AIReview['segmentRanges']>[number]

function segmentAttributes(range: SegmentRange, node: ProseMirrorNode, position: number, active: boolean, empty = false) {
  const attrs: Record<string, string> = {
    class: 'ai-reserved ai-segment-reserved',
    'data-ai-reservation': range.taskId,
    'data-ai-segment': range.taskId,
  }
  if (active) attrs['data-ai-active'] = 'true'
  if (empty) attrs['data-ai-empty'] = ''
  if (node.type.name === 'spacer') {
    const height = Math.max(0, Number(node.attrs.height) || 0)
    const start = position === range.from ? Math.max(0, Math.min(height, range.startOffset ?? (empty ? range.endOffset ?? 0 : 0))) : 0
    const end = position + node.nodeSize === range.to
      ? Math.max(start, Math.min(height, range.endOffset ?? height))
      : height
    attrs.style = `--ai-segment-start:${start}px;--ai-segment-end:${end}px;`
  }
  return attrs
}

function segmentRangeForNode(ranges: SegmentRange[], position: number, node: ProseMirrorNode) {
  return ranges.find(range => range.from < range.to
    ? position >= range.from && position + node.nodeSize <= range.to
    : node.type.name === 'spacer' && position === range.from && (range.startOffset !== undefined || range.endOffset !== undefined))
}

function candidateBlock(state: EditorState, serializer: DOMSerializer, json: JSONContent) {
  const node = state.schema.nodeFromJSON(json)
  const element = serializer.serializeNode(node) as HTMLElement
  const id = typeof node.attrs?.id === 'string' ? node.attrs.id : ''
  element.removeAttribute('data-id')
  element.dataset.aiBlock = id
  element.classList.add('ai-reserved', 'ai-candidate')
  if (node.type.name === 'paragraph') {
    element.classList.add('main-paragraph')
    if (element.tagName === 'PRE') {
      const content = element.firstElementChild ?? document.createElement('code')
      if (!content.parentElement) { content.append(...element.childNodes); element.append(content) }
      content.className = 'paragraph-content'
    } else {
      const content = document.createElement('span')
      content.className = 'paragraph-content'
      content.append(...element.childNodes)
      element.append(content)
    }
  } else if (node.type.name === 'spacer') {
    element.dataset.spacer = ''
  }
  element.tabIndex = 0
  element.setAttribute('aria-label', node.type.name === 'spacer' ? 'AI space preview' : 'AI paragraph preview')
  return element
}

function selectSegment(review: RefObject<AIReview | undefined>, taskId: string) {
  review.current?.selectSegment?.(taskId)
}

function segmentPreviewWidget(state: EditorState, preview: SegmentPreview, review: RefObject<AIReview | undefined>) {
  const root = document.createElement('div')
  const active = preview.taskIds.includes(review.current?.activeSegmentId ?? '')
  root.className = 'ai-segment-preview'
  root.contentEditable = 'false'
  root.tabIndex = 0
  root.dataset.aiPreview = preview.taskId
  root.dataset.aiSegmentPreview = preview.taskId
  root.dataset.aiSegmentTasks = preview.taskIds.join(' ')
  if (active) root.dataset.aiActive = ''
  if (preview.from <= 0) root.dataset.aiFirst = ''
  if (preview.to >= state.doc.content.size) root.dataset.aiLast = ''
  root.setAttribute('role', 'button')
  root.setAttribute('aria-label', 'AI segment preview')
  root.setAttribute('aria-selected', String(active))
  const select = (event: Event) => selectSegment(review, (event.target as Element).closest<HTMLElement>('[data-ai-segment-owner]')?.dataset.aiSegmentOwner ?? preview.taskId)
  root.onpointerdown = event => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); select(event)
    const target = (event.target as Element).closest<HTMLElement>('[data-ai-block]') ?? root.querySelector<HTMLElement>('[data-ai-block]') ?? root
    target.focus({ preventScroll: true })
  }
  root.onkeydown = event => event.stopPropagation()
  root.addEventListener('focusin', select)
  const serializer = DOMSerializer.fromSchema(state.schema)
  for (const block of preview.content) {
    const element = candidateBlock(state, serializer, block)
    element.dataset.aiSegmentOwner = preview.blockOwners[block.attrs!.id] ?? preview.taskId
    root.append(element)
  }
  if (!root.children.length) {
    const handle = document.createElement('button')
    handle.type = 'button'
    handle.className = 'ai-segment-preview-handle'
    handle.setAttribute('aria-label', 'Select empty AI segment preview')
    handle.onclick = event => { event.preventDefault(); selectSegment(review, preview.taskId) }
    root.append(handle)
  }
  return root
}

function segmentReviewWidget(task: AITask, review: RefObject<AIReview | undefined>, offset = 0) {
  const root = document.createElement('div')
  root.className = 'ai-segment-review'
  root.contentEditable = 'false'
  root.dataset.aiSegmentReview = task.id
  if (offset) root.style.transform = `translateY(${offset}px)`
  root.append(reviewControls(task, () => review.current!))
  return root
}

function segmentMarkerWidget(range: SegmentRange, review: RefObject<AIReview | undefined>) {
  const empty = range.from === range.to
  const root = document.createElement('div')
  const button = document.createElement('button')
  root.className = 'ai-segment-marker'
  root.contentEditable = 'false'
  root.dataset.aiSegment = range.taskId
  if (empty) root.dataset.aiEmpty = ''
  const offset = range.startOffset ?? range.endOffset
  if (empty && offset !== undefined) {
    root.dataset.aiOffset = String(offset)
    root.style.setProperty('--ai-segment-offset', `${offset}px`)
  }
  button.type = 'button'
  button.className = 'ai-segment-handle'
  button.setAttribute('aria-label', empty ? 'Select empty AI segment' : 'Select AI segment')
  const select = () => selectSegment(review, range.taskId)
  button.onclick = event => { event.preventDefault(); select() }
  root.onpointerdown = event => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); select()
  }
  root.addEventListener('focusin', select)
  root.append(button)
  return root
}

export function reservationExtension(history: ReturnType<typeof useDocumentHistory>, id: string, review: RefObject<AIReview | undefined>) {
  return Extension.create({
    name: 'aiReservations',
    addProseMirrorPlugins: () => [new Plugin({
      filterTransaction(transaction, state) {
        return !transaction.docChanged || transaction.getMeta('historyRestore')
          || history.guardEditor.current(id, state.doc.toJSON(), transaction.doc.toJSON())
      },
      props: {
        handleDOMEvents: { pointerdown(view, event) {
          const target = (event.target as Element).closest<HTMLElement>('[data-ai-segment]')
          if (!target || event.button !== 0 || !review.current?.selectSegment) return false
          event.preventDefault()
          view.focus(); selectSegment(review, target.dataset.aiSegment!)
          return true
        } },
        decorations(state) {
        if (id !== 'main') return DecorationSet.empty
        const current = review.current
        const previews = current?.segmentPreviews ?? []
        const ranges = current?.segmentRanges ?? []
        const previewTasks = new Set(previews.flatMap(preview => preview.taskIds))
        const segmentTasks = new Set([...previewTasks, ...ranges.map(range => range.taskId)])
        const tasks = current?.tasks ?? []
        const decorations: Decoration[] = []
        const selected = new Set<string>()
        if (current?.mainActive) state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
          if (node.type.name === 'paragraph' && (state.selection.empty || position + 1 < state.selection.to)) selected.add(node.attrs.id)
          return false
        })

        state.doc.forEach((node, position) => {
          const preview = previews.find(candidate => previewCovers(candidate, position, node.nodeSize))
          const segmentRange = segmentRangeForNode(ranges, position, node)
          if (preview) {
            decorations.push(Decoration.node(position, position + node.nodeSize, {
              class: 'ai-original-hidden', 'data-ai-reservation': preview.taskId, 'data-ai-segment': preview.taskId,
            }))
            return
          }
          if (segmentRange && !previewTasks.has(segmentRange.taskId)) {
            decorations.push(Decoration.node(position, position + node.nodeSize,
              segmentAttributes(segmentRange, node, position, current?.activeSegmentId === segmentRange.taskId, segmentRange.from === segmentRange.to)))
            return
          }
          const task = tasks.find(task => !segmentTasks.has(task.id) && task.target.kind === 'text' && task.target.blockIds.includes(node.attrs.id))
          if (!task || task.target.kind !== 'text') return
          const ids = task.target.blockIds
          const candidate = task.preview && task.candidate?.content
          const first = position === 0, last = state.doc.lastChild?.attrs.id === ids.at(-1)
          decorations.push(Decoration.node(position, position + node.nodeSize, {
            class: candidate ? 'ai-original-hidden' : 'ai-reserved', 'data-ai-reservation': task.id,
          }))
          if (candidate && node.attrs.id === ids[0]) decorations.push(Decoration.widget(position, view => {
            const root = document.createElement('div')
            root.className = 'ai-text-preview'
            root.contentEditable = 'false'
            root.dataset.aiPreview = task.id
            const select = () => {
              let from = 0, to = 0
              view.state.doc.forEach((block, offset) => {
                if (block.attrs.id === ids[0]) from = offset + 1
                if (block.attrs.id === ids.at(-1)) to = offset + block.nodeSize - 1
              })
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
              review.current!.selectText()
            }
            root.onpointerdown = event => { if (event.button === 0) { event.preventDefault(); select(); view.focus() } }
            root.addEventListener('focusin', select)
            if (first) root.dataset.aiFirst = ''
            if (last) root.dataset.aiLast = ''
            const serializer = DOMSerializer.fromSchema(state.schema)
            for (const [index, paragraph] of candidate.entries()) {
              const element = serializer.serializeNode(state.schema.nodeFromJSON(paragraph)) as HTMLElement
              element.removeAttribute('data-id')
              element.dataset.aiBlock = ids[index] ?? ''
              element.className = 'main-paragraph ai-reserved ai-candidate'
              element.tabIndex = 0
              element.setAttribute('aria-label', 'AI paragraph preview')
              const content = element.tagName === 'PRE' ? element.firstElementChild! : document.createElement('span')
              if (element.tagName !== 'PRE') { content.append(...element.childNodes); element.append(content) }
              content.className = 'paragraph-content'
              root.append(element)
            }
            // Removed anchors follow the final replacement paragraph, as on acceptance.
            if (root.lastElementChild) for (const id of ids.slice(candidate.length)) {
              const anchor = document.createElement('span'); anchor.dataset.aiBlock = id
              root.lastElementChild!.firstElementChild!.append(anchor)
            }
            return root
          }, { key: `candidate:${task.id}:${candidateKey(candidate)}:${first}:${last}`, side: -1, stopEvent: () => true }))
          if (node.attrs.id === ids[0] && ids.some(id => selected.has(id))) decorations.push(Decoration.widget(position, () => {
            const root = document.createElement('div')
            root.className = 'ai-text-review'
            root.contentEditable = 'false'
            root.append(reviewControls(task, () => review.current!))
            return root
          }, { key: reviewKey(task), side: -2, stopEvent: () => true }))
        })

        for (const preview of previews) {
          const task = tasks.find(candidate => candidate.id === current?.activeSegmentId && preview.taskIds.includes(candidate.id))
          decorations.push(Decoration.widget(preview.from, () => segmentPreviewWidget(state, preview, review), {
            key: `segment-preview:${preview.taskId}:${candidateKey(preview.content as object)}:${current?.activeSegmentId}`,
            side: -1, stopEvent: () => true,
          }))
          if (task) decorations.push(Decoration.widget(preview.from,
            () => segmentReviewWidget(task, review), { key: `segment-review:${reviewKey(task)}:${preview.taskId}`, side: -2, stopEvent: () => true }))
        }
        for (const range of ranges) {
          if (previewTasks.has(range.taskId)) continue
          decorations.push(Decoration.widget(range.from, () => segmentMarkerWidget(range, review), {
            key: `segment-marker:${range.taskId}:${range.from}:${range.to}:${range.startOffset ?? ''}:${range.endOffset ?? ''}:${current?.activeSegmentId === range.taskId}`,
            side: -3, stopEvent: () => true,
          }))
          const task = tasks.find(candidate => candidate.id === range.taskId)
          if (task && current?.activeSegmentId === range.taskId) decorations.push(Decoration.widget(range.from,
            () => segmentReviewWidget(task, review, range.startOffset), { key: `segment-review:${reviewKey(task)}:${range.taskId}:${range.startOffset}`, side: -2, stopEvent: () => true }))
        }
        return DecorationSet.create(state.doc, decorations)
      } },
    })],
  })
}

function previewCovers(preview: SegmentPreview, position: number, size: number) {
  return preview.from < preview.to && position >= preview.from && position + size <= preview.to
}
