import type { Editor, JSONContent } from '@tiptap/core'
import type { MoteDocument } from '../document/model'
import type { AITask } from './types'
import type { SegmentContext } from './segments'
import { candidateDocument } from './useAssistant'
import { resolveSegmentRange } from './segments'

export interface SegmentPreview {
  taskId: string; taskIds: string[]; from: number; to: number; content: JSONContent[]; blockOwners: Record<string, string>
}

// Keep the real editor document intact. Only changed top-level chunks are
// rendered by decoration widgets; floating candidates use the same projection.
export function projectSegments(doc: MoteDocument, tasks: AITask[], editor: Editor | null, context: SegmentContext) {
  const previews: SegmentPreview[] = [], owners = new Map<string, string>()
  let document = doc
  const blockOwners: Record<string, string> = {}
  if (!editor || !tasks.length) return { document: doc, previews, owners }
  const original = editor.schema.nodeFromJSON(doc.content), positions = [0]
  original.forEach(node => positions.push(positions.at(-1)! + node.nodeSize))
  for (const task of tasks) {
    if (task.target.kind !== 'segment' || !task.preview || !task.candidate?.segment) continue
    const next = candidateDocument(document, task, task.candidate, context)
    const oldBlocks = new Set(document.content.content!.map(node => node.attrs!.id))
    for (const block of next.content.content!) if (!oldBlocks.has(block.attrs!.id)) blockOwners[block.attrs!.id] = task.id
    const oldObjects = new Set(document.floating.map(object => object.id))
    for (const object of next.floating) if (!oldObjects.has(object.id)) owners.set(object.id, task.id)
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
    for (const task of tasks) if (task.target.kind === 'segment') {
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
  return { document, previews, owners }
}
