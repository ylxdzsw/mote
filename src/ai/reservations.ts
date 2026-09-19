import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, MoteDocument } from '../document/model'
import type { AITarget, AITask } from './types'
import type { Node } from '@tiptap/pm/model'

export function paragraphSelection(doc: Node, from: number, to: number) {
  const blockIds: string[] = []
  let start = -1, end = -1, crossesSpace = false
  doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== 'paragraph') { crossesSpace = true; return false }
    if (from !== to && position + 1 >= to) return false
    if (start < 0) start = position + 1
    end = position + node.nodeSize - 1
    blockIds.push(node.attrs.id)
    return false
  })
  return blockIds.length && !crossesSpace ? { blockIds, selection: { from: start, to: end }, selectedText: doc.textBetween(start, end, '\n') } : null
}

export const sameContent = (a: unknown, b: unknown) => JSON.stringify(a, sortedKeys) === JSON.stringify(b, sortedKeys)
function sortedKeys(_key: string, value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value
}
// Placement belongs to the user; content and size belong to the reserved task.
export function objectContent(object: FloatingObject) {
  const { x, y, anchorId, ...content } = object
  void x; void y; void anchorId
  if (content.kind === 'line') return { ...content, start: undefined, end: undefined, bend: undefined }
  if (content.kind === 'label') return { ...content, attachment: undefined }
  return content
}

export const canResizeReservation = (task: AITask) => !task.submitted && !task.requestSent && ['draft', 'error', 'stopped'].includes(task.status)
export function reservedObjectContent(task: AITask, object: FloatingObject) {
  const content = objectContent(object)
  return canResizeReservation(task) ? { ...content, width: undefined, height: undefined } : content
}

export function reservedText(content: JSONContent, ids: string[]) {
  const blocks = content.content ?? []
  const first = blocks.findIndex(node => node.attrs?.id === ids[0])
  const found = blocks.slice(first, first + ids.length)
  if (first < 0 || found.some((node, i) => node.attrs?.id !== ids[i])) return null
  return found.map(node => ({ ...node, attrs: { ...node.attrs, semantic: node.attrs?.semantic ?? 'body', listLevel: node.attrs?.listLevel ?? 0, minSegmentHeight: undefined } }))
}

export function overlaps(a: AITarget, b: AITarget) {
  return a.kind === 'object' && b.kind === 'object' ? a.objectId === b.objectId
    : a.kind === 'text' && b.kind === 'text' && a.blockIds.some(id => b.blockIds.includes(id))
}

export function permits(tasks: AITask[], before: MoteDocument, after: MoteDocument) {
  if (tasks.length && before.id !== after.id) return false
  return tasks.every(task => {
    const { target } = task
    if (target.kind === 'text') {
      const previous = reservedText(before.content, target.blockIds)
      const next = reservedText(after.content, target.blockIds)
      return previous !== null && next !== null && sameContent(previous, next)
    }
    const previous = before.floating.find(object => object.id === target.objectId)
    const next = after.floating.find(object => object.id === target.objectId)
    return !!previous && !!next && sameContent(reservedObjectContent(task, previous), reservedObjectContent(task, next))
  })
}

export function permitsEditor(tasks: AITask[], historyId: string, before: JSONContent, after: JSONContent) {
  if (historyId !== 'main') return !tasks.some(task => task.target.kind === 'object' && task.target.objectId === historyId) || sameContent(before, after)
  return tasks.every(task => task.target.kind !== 'text' || sameContent(reservedText(before, task.target.blockIds), reservedText(after, task.target.blockIds)) && reservedText(after, task.target.blockIds) !== null)
}

export function currentPlacement(candidate: FloatingObject, original: FloatingObject): FloatingObject {
  const result = { ...candidate, id: original.id, x: original.x, y: original.y, anchorId: original.anchorId, width: original.width, textFlow: original.textFlow }
  if ('height' in original && 'height' in result) result.height = original.height
  if (result.kind === 'line' && original.kind === 'line') return { ...result, start: original.start, end: original.end, bend: original.bend }
  if (result.kind === 'label' && original.kind === 'label') return { ...result, attachment: original.attachment }
  return result
}
