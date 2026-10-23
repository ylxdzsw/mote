import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, MoteDocument } from '../document/model'
import type { AITarget, AITask } from './types'
import type { Node } from '@tiptap/pm/model'
import type { SegmentClipboard, SegmentPoint, SegmentRange } from '../document/segment'
import { patchFloating } from '../canvas/patchFloating.ts'

const supportsCaption = (object: FloatingObject): object is Extract<FloatingObject, { kind: 'image' | 'html' | 'table' }> =>
  object.kind === 'image' || object.kind === 'html' || object.kind === 'table'

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
// Placement and margins belong to the user; content and size belong to the reserved task.
export function objectContent(object: FloatingObject) {
  const { x, y, anchorId, placement, centered, margins, ...content } = object
  void x; void y; void anchorId; void placement; void centered; void margins
  if (supportsCaption(object) && object.caption) return { ...content, caption: { content: object.caption.content } }
  return content
}

export const canResizeReservation = (task: AITask) => !task.submitted && !task.requestSent && !task.pendingExecutor && ['draft', 'error', 'stopped'].includes(task.status)
export function reservedObjectContent(task: AITask, object: FloatingObject) {
  const content = objectContent(object)
  if (!canResizeReservation(task)) return content
  // Normalize only positions: repeated resize arithmetic must not release a draft.
  // Ten decimal places tolerate subpixel rounding while keeping all other data exact.
  const coordinate = (value: number, extent: number) => Number((value / extent).toFixed(10))
  return { ...content, width: undefined, height: undefined,
    ...(object.kind === 'drawing' && {
      strokes: object.strokes.map(stroke => ({ ...stroke, points: stroke.points.map(([x, y]) => [coordinate(x, object.width), coordinate(y, object.height)]) })),
      labels: object.labels.map(label => ({ ...label, x: coordinate(label.x, object.width), y: coordinate(label.y, object.height) })),
    }),
  }
}

function segmentTarget(target: AITarget) {
  return target.kind === 'segment' ? target : null
}

function segmentDocument(doc: Pick<MoteDocument, 'content' | 'floating'>): MoteDocument {
  return doc as MoteDocument
}

const segmentCompare = (a: SegmentPoint, b: SegmentPoint) => a.index - b.index || a.offset - b.offset
const segmentBlockHeight = (node: JSONContent) => typeof node.attrs?.height === 'number' ? node.attrs.height : 0
function resolveSegmentRange(doc: MoteDocument, target: Extract<AITarget, { kind: 'segment' }>): SegmentRange | null {
  const blocks = doc.content.content ?? []
  const point = (value: SegmentPoint) => {
    if (!Number.isInteger(value.index) || value.index < 0 || value.index > blocks.length || value.offset < 0) return null
    if (value.index === blocks.length) return value.offset === 0 ? value : null
    const block = blocks[value.index]
    if (block.type !== 'spacer') return value.offset === 0 ? { index: value.index, offset: 0 } : null
    if (value.offset > segmentBlockHeight(block)) return null
    return value.offset === segmentBlockHeight(block) ? { index: value.index + 1, offset: 0 } : value
  }
  const start = target.bookmarks ? (() => {
    const bookmark = target.bookmarks.start
    if (bookmark.blockId === null) return { index: bookmark.after ? blocks.length : 0, offset: 0 }
    const index = blocks.findIndex(node => node.attrs?.id === bookmark.blockId)
    if (index < 0) return null
    if (bookmark.after) return { index: index + 1, offset: 0 }
    return { index, offset: bookmark.offset }
  })() : target.range.start
  const end = target.bookmarks ? (() => {
    const bookmark = target.bookmarks.end
    if (bookmark.blockId === null) return { index: bookmark.after ? blocks.length : 0, offset: 0 }
    const index = blocks.findIndex(node => node.attrs?.id === bookmark.blockId)
    if (index < 0) return null
    if (bookmark.after) return { index: index + 1, offset: 0 }
    return { index, offset: bookmark.offset }
  })() : target.range.end
  const canonicalStart = start && point(start), canonicalEnd = end && point(end)
  return canonicalStart && canonicalEnd && segmentCompare(canonicalStart, canonicalEnd) <= 0 ? { start: canonicalStart, end: canonicalEnd } : null
}

function segmentBlockIds(doc: MoteDocument, range: SegmentRange) {
  const ids: string[] = [], blocks = doc.content.content ?? []
  for (let index = 0; index < blocks.length; index++) {
    const node = blocks[index], selected = node.type === 'spacer'
      ? index >= range.start.index && index <= range.end.index
        && Math.max(0, Math.min(segmentBlockHeight(node), range.end.index === index ? range.end.offset : segmentBlockHeight(node))
          - (range.start.index === index ? range.start.offset : 0)) > 0
      : index >= range.start.index && index < range.end.index
    if (selected && typeof node.attrs?.id === 'string') ids.push(node.attrs.id)
  }
  return ids
}

function segmentObjectIds(doc: MoteDocument, range: SegmentRange) {
  const blocks = doc.content.content ?? [], selected = new Set(segmentBlockIds(doc, range)), ids = new Set<string>()
  const selectedAnchor = (anchorId: string | null, y: number) => {
    if (anchorId === null) return range.start.index === 0 && range.start.offset === 0 && segmentCompare(range.start, range.end) < 0
    if (!selected.has(anchorId)) return false
    const index = blocks.findIndex(node => node.attrs?.id === anchorId), block = blocks[index]
    if (!block || block.type !== 'spacer') return true
    const start = index === range.start.index ? range.start.offset : 0
    const end = index === range.end.index ? range.end.offset : segmentBlockHeight(block)
    return y >= start && (y < end || end === segmentBlockHeight(block) && y >= segmentBlockHeight(block))
  }
  for (const object of doc.floating) {
    if (selectedAnchor(object.anchorId, object.y)) ids.add(object.id)
  }
  return ids
}

function segmentBlocks(doc: Pick<MoteDocument, 'content' | 'floating'>, target: Extract<AITarget, { kind: 'segment' }>) {
  const range = resolveSegmentRange(segmentDocument(doc), target)
  if (!range) return null
  const blocks = doc.content.content ?? [], ids = segmentBlockIds(segmentDocument(doc), range)
  if (ids.length !== target.blockIds.length || ids.some((id, index) => id !== target.blockIds[index])) return null
  return { range, blocks: ids.map(id => blocks.find(block => block.attrs?.id === id)!) }
}

function segmentOriginalBlocks(task: AITask): JSONContent[] {
  if (task.segmentOriginalBlocks) return task.segmentOriginalBlocks
  return task.original && !Array.isArray(task.original) && 'type' in task.original && task.original.type === 'segment'
    ? (task.original as SegmentClipboard).content : []
}

function normalizedBlock(block: JSONContent) {
  return { ...block, attrs: block.attrs ? { ...block.attrs, minSegmentHeight: undefined } : block.attrs }
}

function segmentMainIntact(task: AITask, content: JSONContent, floating: FloatingObject[] = []): boolean {
  const target = segmentTarget(task.target)
  if (!target) return true
  const current = segmentBlocks({ content, floating }, target)
  if (!current) return false
  const original = segmentOriginalBlocks(task)
  if (!target.blockIds.length) return true
  if (original.length !== current.blocks.length) return false
  return current.blocks.every((block, index) => sameContent(normalizedBlock(block), normalizedBlock(original[index])))
}

function segmentObjectsIntact(task: AITask, doc: MoteDocument, range: SegmentRange) {
  const target = segmentTarget(task.target)!
  const actualIds = [...segmentObjectIds(doc, range)]
  if (actualIds.length !== target.objectIds.length || actualIds.some(id => !target.objectIds.includes(id))) return false
  const current = target.objectIds.map(id => doc.floating.find(object => object.id === id))
  if (current.some(object => !object)) return false
  const original = task.segmentOriginalObjects ?? (task.original && !Array.isArray(task.original) && 'type' in task.original && task.original.type === 'segment'
    ? (task.original as SegmentClipboard).floating : [])
  if (original.length !== current.length) return false
  return current.every((object, index) => {
    const source = original.find(candidate => candidate.id === target.objectIds[index]) ?? original[index]
    if (!source) return false
    return sameContent(object, source)
  })
}

export function segmentReservationIntact(task: AITask, doc: MoteDocument): boolean {
  const target = segmentTarget(task.target)
  if (!target || doc.id !== task.documentId) return false
  const current = segmentBlocks(doc, target)
  return !!current && segmentMainIntact(task, doc.content, doc.floating)
    && segmentObjectsIntact(task, doc, current.range)
}

export function reservedText(content: JSONContent, ids: string[]) {
  const blocks = content.content ?? []
  const first = blocks.findIndex(node => node.attrs?.id === ids[0])
  const found = blocks.slice(first, first + ids.length)
  if (first < 0 || found.some((node, i) => node.attrs?.id !== ids[i])) return null
  return found.map(node => ({ ...node, attrs: { ...node.attrs, semantic: node.attrs?.semantic ?? 'body', listLevel: node.attrs?.listLevel ?? 0, minSegmentHeight: undefined } }))
}

export function inactiveTaskReason(task: AITask, doc: MoteDocument): string | null {
  if (task.documentId !== doc.id) return 'This task belongs to another document. Its request and result are retained for recovery.'
  if (task.acceptance) return 'Applied to a local working copy. The result is retained until that exact document is saved to the cloud; it does not lock this document.'
  if (task.released) return 'This reservation has been released. Its original input and result remain available for recovery, without document locks or agent access.'
  const target = task.target
  const intact = target.kind === 'object' ? (() => {
    const object = doc.floating.find(object => object.id === target.objectId)
    return !!object && sameContent(reservedObjectContent(task, object), reservedObjectContent(task, task.original as FloatingObject))
  })() : target.kind === 'segment' ? segmentReservationIntact(task, doc)
    : !!reservedText(doc.content, target.blockIds) && sameContent(reservedText(doc.content, target.blockIds), reservedText({ type: 'doc', content: task.original as JSONContent[] }, target.blockIds))
  return intact ? null : 'The original target has changed or is missing. This task is recovery-only: no document locks, preview, or application. Its original snapshot and result remain available.'
}

export function compatibleTasks(tasks: AITask[], doc: MoteDocument) {
  const active: AITask[] = []
  for (const task of tasks) if (!inactiveTaskReason(task, doc) && !active.some(other => overlaps(other.target, task.target, doc))) active.push(task)
  return active
}

export function overlaps(a: AITarget, b: AITarget, doc?: MoteDocument): boolean {
  if (doc && (a.kind === 'segment' || b.kind === 'segment') && a.kind !== 'object' && b.kind !== 'object') {
    const rangeOf = (target: typeof a) => {
      if (target.kind === 'segment') return resolveSegmentRange(doc, target)
      const blocks = doc.content.content ?? [], first = blocks.findIndex(node => node.attrs?.id === target.blockIds[0])
      return first < 0 ? null : { start: { index: first, offset: 0 }, end: { index: first + target.blockIds.length, offset: 0 } }
    }
    const left = rangeOf(a), right = rangeOf(b)
    if (left && right && (segmentCompare(left.start, left.end) === 0 || segmentCompare(right.start, right.end) === 0)) {
      if (segmentCompare(left.start, right.end) <= 0 && segmentCompare(right.start, left.end) <= 0) return true
    }
  }
  if (a.kind === 'object' && b.kind === 'object') return a.objectId === b.objectId
  if (a.kind === 'text' && b.kind === 'text') return a.blockIds.some(id => b.blockIds.includes(id))
  if (a.kind === 'segment' && b.kind === 'segment') {
    return a.blockIds.some(id => b.blockIds.includes(id)) || a.objectIds.some(id => b.objectIds.includes(id))
      || (!a.blockIds.length && !a.objectIds.length && sameContent(a.bookmarks, b.bookmarks))
  }
  if (a.kind === 'segment' && b.kind === 'text') return a.blockIds.some(id => b.blockIds.includes(id))
  if (a.kind === 'text' && b.kind === 'segment') return a.blockIds.some(id => b.blockIds.includes(id))
  if (a.kind === 'segment' && b.kind === 'object') return a.objectIds.includes(b.objectId)
  if (a.kind === 'object' && b.kind === 'segment') return b.objectIds.includes(a.objectId)
  return false
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
    if (target.kind === 'segment') return segmentReservationIntact(task, before) && segmentReservationIntact(task, after)
    const previous = before.floating.find(object => object.id === target.objectId)
    const next = after.floating.find(object => object.id === target.objectId)
    return !!previous && !!next && sameContent(reservedObjectContent(task, previous), reservedObjectContent(task, next))
  })
}

export function permitsEditor(tasks: AITask[], historyId: string, before: JSONContent, after: JSONContent) {
  if (historyId.includes(':caption:')) historyId = historyId.split(':caption:')[0]
  if (historyId !== 'main') return !tasks.some(task => (task.target.kind === 'object' && task.target.objectId === historyId)
    || (task.target.kind === 'segment' && task.target.objectIds.includes(historyId))) || sameContent(before, after)
  return tasks.every(task => {
    if (task.target.kind === 'text') return sameContent(reservedText(before, task.target.blockIds), reservedText(after, task.target.blockIds)) && reservedText(after, task.target.blockIds) !== null
    if (task.target.kind === 'segment') return segmentMainIntact(task, before) && segmentMainIntact(task, after)
    const objectId = task.target.objectId
    const flows = (content: JSONContent) => (content.content ?? []).filter(node => node.type === 'flow' && node.attrs?.objectId === objectId)
    return sameContent(flows(before), flows(after))
  })
}

export function currentPlacement(candidate: FloatingObject, original: FloatingObject): FloatingObject {
  const resized = candidate.kind === 'drawing' ? patchFloating(candidate, { width: original.width, ...('height' in original && { height: original.height }) }) : candidate
  const result: FloatingObject = { ...resized, id: original.id, x: original.x, y: original.y, anchorId: original.anchorId, width: original.width, placement: original.placement, centered: original.centered }
  if (original.centered === undefined) delete result.centered
  if (original.margins === undefined) delete result.margins
  else result.margins = { ...original.margins }
  if ('height' in original && 'height' in result) result.height = original.height
  if (supportsCaption(result)) {
    const originalCaption = supportsCaption(original) ? original.caption : undefined
    if (result.caption === undefined && originalCaption) result.caption = originalCaption
    if (result.caption && originalCaption) {
      const { width: _candidateWidth, ...caption } = result.caption
      result.caption = originalCaption.width === undefined ? caption : { ...caption, width: originalCaption.width }
    }
    if (result.caption?.content.type === 'doc' && result.caption.content.content?.length === 1
      && result.caption.content.content[0].type === 'paragraph' && !result.caption.content.content[0].content?.length) delete result.caption
  }
  return result
}
