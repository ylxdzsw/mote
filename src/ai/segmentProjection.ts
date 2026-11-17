import type { Editor, JSONContent } from '@tiptap/core'
import type { MoteDocument } from '../document/model'
import type { AITask } from './types'
import { selectedCandidateVersion } from './candidates'
import type { SegmentContext } from './segments'
import { candidateDocument } from './useAssistant'
import { makeSegmentTarget, mapReservations, mapSegmentTarget, resolveSegmentRange } from './segments'
import { segmentEdit, segmentPointAt, segmentPosition } from '../document/segment'

export interface SegmentPreview {
  taskId: string; taskIds: string[]; from: number; to: number; content: JSONContent[]; blockOwners: Record<string, string>
}

// Keep the real editor document intact. Only changed top-level chunks are
// rendered by decoration widgets; objects candidates use the same projection.
export function projectSegments(doc: MoteDocument, tasks: AITask[], editor: Editor | null, context: SegmentContext) {
  const previews: SegmentPreview[] = [], owners = new Map<string, string>()
  const failures: { taskId: string; error: unknown }[] = [], applied: AITask[] = []
  let document = doc
  const blockOwners: Record<string, string> = {}
  const displayTargets = new Map(tasks.flatMap(task => task.target.kind === 'segment' ? [[task.id, task.target] as const] : []))
  const displayedRanges = () => [...displayTargets].flatMap(([taskId, target]) => {
    const range = resolveSegmentRange(document, target)
    return range ? [{ taskId, range }] : []
  })
  if (!editor || !tasks.length) return { document: doc, previews, owners, failures, ranges: displayedRanges() }
  const original = editor.schema.nodeFromJSON(doc.content), positions = [0]
  original.forEach(node => positions.push(positions.at(-1)! + node.nodeSize))
  let remaining = tasks
  for (const originalTask of tasks) {
    const task = remaining.find(task => task.id === originalTask.id)!
    const candidate = selectedCandidateVersion(task)?.candidate
    if (task.target.kind !== 'segment' || !task.preview || !candidate?.segment) continue
    let next: MoteDocument
    try { next = candidateDocument(document, task, candidate, context) }
    catch (error) { failures.push({ taskId: task.id, error }); continue }
    const mapped = mapReservations(document, next, remaining.filter(other => other.id !== task.id))
    if (!mapped) { failures.push({ taskId: task.id, error: new Error('This proposal changes another reserved interval.') }); continue }
    remaining = mapped
    const oldRange = resolveSegmentRange(document, task.target)!
    const beforeBlocks = document.content.content!, afterBlocks = next.content.content!
    const start = segmentPosition(beforeBlocks, oldRange.start)
    const inserted = segmentPosition(afterBlocks, { index: afterBlocks.length, offset: 0 })
      - segmentPosition(beforeBlocks, { index: beforeBlocks.length, offset: 0 })
      + segmentPosition(beforeBlocks, oldRange.end) - start
    for (const [id, target] of displayTargets) {
      const display = id === task.id ? makeSegmentTarget(next, {
        start: segmentPointAt(afterBlocks, start), end: segmentPointAt(afterBlocks, start + inserted),
      }, target.area) : mapSegmentTarget(document, next, target)
      if (display) displayTargets.set(id, display)
    }
    applied.push(originalTask)
    const oldBlocks = new Set(document.content.content!.map(node => node.attrs!.id))
    const edit = segmentEdit(document.content, next.content)
    for (const block of next.content.content!) if (!oldBlocks.has(block.attrs!.id) && !edit?.retainedBlockIds.has(block.attrs!.id)) blockOwners[block.attrs!.id] = task.id
    // An explicit empty owner prevents retained spacer fragments falling back
    // to the task owning the surrounding replacement widget.
    for (const id of edit?.retainedBlockIds ?? []) if (!blockOwners[id]) blockOwners[id] = ''
    const oldObjects = new Set(document.objects.map(object => object.id))
    for (const object of next.objects) if (!oldObjects.has(object.id)) owners.set(object.id, task.id)
    document = next
  }
  const content = editor.schema.nodeFromJSON(document.content), originalIndices = new Map<string, number>()
  original.forEach((node, _offset, index) => originalIndices.set(node.attrs.id, index))
  let oldStart = 0, newStart = 0
  function add(oldEnd: number, newEnd: number) {
    if (oldStart === oldEnd && newStart === newEnd) return
    const replacement: JSONContent[] = []
    for (let i = newStart; i < newEnd; i++) replacement.push(content.child(i).toJSON())
    const ids = new Set(replacement.map(node => blockOwners[node.attrs!.id]).filter(Boolean))
    for (const task of applied) if (task.target.kind === 'segment') {
      const range = resolveSegmentRange(doc, task.target)
      if (range && range.start.index <= oldEnd && range.end.index >= oldStart) ids.add(task.id)
    }
    const taskIds = [...ids]
    previews.push({ taskId: taskIds[0], taskIds, from: positions[oldStart], to: positions[oldEnd], content: replacement, blockOwners })
  }
  content.forEach((node, _offset, index) => {
    const oldIndex = originalIndices.get(node.attrs.id)
    if (oldIndex === undefined || oldIndex < oldStart || !original.child(oldIndex).eq(node)) return
    add(oldIndex, index)
    oldStart = oldIndex + 1; newStart = index + 1
  })
  add(original.childCount, content.childCount)
  return { document, previews, owners, failures, ranges: displayedRanges() }
}
