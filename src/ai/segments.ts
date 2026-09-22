import type { JSONContent } from '@tiptap/core'
import type { MoteDocument } from '../document/model'
import { initializeDocument } from '../document/initialize'
import { replaceSegment, segmentObjectIds, type SegmentClipboard, type SegmentPoint, type SegmentRange, type Geometries } from '../document/segment'
import type { Area, SegmentBookmark, SegmentTarget } from './types'

export interface SegmentContext {
  anchors: { id: string; top: number; bottom?: number }[]
  geometry: Geometries
}

const blocksOf = (doc: MoteDocument) => doc.content.content ?? []
const blockId = (node: JSONContent) => typeof node.attrs?.id === 'string' ? node.attrs.id : null
const spacer = (node: JSONContent) => node.type === 'spacer'
const height = (node: JSONContent) => typeof node.attrs?.height === 'number' && Number.isFinite(node.attrs.height) ? node.attrs.height : 0
const compare = (a: SegmentPoint, b: SegmentPoint) => a.index - b.index || a.offset - b.offset
const edge = (index: number): SegmentPoint => ({ index, offset: 0 })

function canonicalPoint(point: SegmentPoint, blocks: JSONContent[]): SegmentPoint | null {
  if (!Number.isInteger(point.index) || point.index < 0 || point.index > blocks.length) return null
  if (!Number.isFinite(point.offset) || point.offset < 0) return null
  if (point.index === blocks.length) return point.offset === 0 ? edge(blocks.length) : null
  const node = blocks[point.index]
  if (!spacer(node)) return point.offset === 0 ? edge(point.index) : null
  if (point.offset > height(node)) return null
  return point.offset === height(node) ? edge(point.index + 1) : { ...point }
}

function canonicalRange(doc: MoteDocument, range: SegmentRange): SegmentRange | null {
  const blocks = blocksOf(doc), start = canonicalPoint(range.start, blocks), end = canonicalPoint(range.end, blocks)
  return start && end && compare(start, end) <= 0 ? { start, end } : null
}

function touchedBlocks(blocks: JSONContent[], range: SegmentRange) {
  const ids: string[] = []
  for (let index = 0; index < blocks.length; index++) {
    const node = blocks[index]
    const selected = spacer(node)
      ? index >= range.start.index && index <= range.end.index
        && Math.max(0, Math.min(height(node), range.end.index === index ? range.end.offset : height(node))
          - (range.start.index === index ? range.start.offset : 0)) > 0
      : index >= range.start.index && index < range.end.index
    if (selected && blockId(node)) ids.push(blockId(node)!)
  }
  return ids
}

function textOf(node: JSONContent): string {
  if (node.type === 'hardBreak') return '\n'
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(textOf).join('')
}

function selectedText(blocks: JSONContent[], range: SegmentRange) {
  return blocks.slice(range.start.index, range.end.index).filter(node => !spacer(node)).map(textOf).join('\n') || undefined
}

function bookmarkAt(blocks: JSONContent[], point: SegmentPoint, side: 'start' | 'end'): SegmentBookmark {
  if (point.index === blocks.length) {
    const previous = blocks.at(-1), id = previous && blockId(previous)
    return id ? { blockId: id, offset: 0, after: true } : { blockId: null, offset: 0, after: true }
  }
  const node = blocks[point.index], id = blockId(node)
  if (!id) return { blockId: null, offset: side === 'end' ? 0 : 0, after: side === 'end' }
  if (spacer(node) && point.offset > 0) return { blockId: id, offset: point.offset }
  if (side === 'end' && point.index > 0) {
    const previous = blockId(blocks[point.index - 1])
    if (previous) return { blockId: previous, offset: 0, after: true }
  }
  return { blockId: id, offset: 0, after: false }
}

function resolveBookmark(blocks: JSONContent[], bookmark: SegmentBookmark): SegmentPoint | null {
  if (bookmark.blockId === null) return bookmark.after ? edge(blocks.length) : edge(0)
  const index = blocks.findIndex(node => blockId(node) === bookmark.blockId)
  if (index < 0 || !Number.isFinite(bookmark.offset) || bookmark.offset < 0) return null
  const node = blocks[index]
  if (bookmark.after) return { index: index + 1, offset: 0 }
  if (!spacer(node)) return bookmark.offset === 0 ? edge(index) : null
  return bookmark.offset <= height(node) ? { index, offset: bookmark.offset } : null
}

export function segmentBlockIds(doc: MoteDocument, range: SegmentRange): string[] {
  const canonical = canonicalRange(doc, range)
  return canonical ? touchedBlocks(blocksOf(doc), canonical) : []
}

export function makeSegmentTarget(doc: MoteDocument, range: SegmentRange, area: Area): SegmentTarget {
  const canonical = canonicalRange(doc, range)
  if (!canonical) throw new Error('Invalid segment range.')
  const blocks = blocksOf(doc)
  return {
    kind: 'segment', range: canonical, blockIds: touchedBlocks(blocks, canonical),
    objectIds: [...segmentObjectIds(doc, canonical)], area: { ...area },
    selectedText: selectedText(blocks, canonical),
    bookmarks: { start: bookmarkAt(blocks, canonical.start, 'start'), end: bookmarkAt(blocks, canonical.end, 'end') },
  }
}

export function resolveSegmentRange(doc: MoteDocument, target: SegmentTarget): SegmentRange | null {
  const blocks = blocksOf(doc)
  if (target.bookmarks) {
    const start = resolveBookmark(blocks, target.bookmarks.start), end = resolveBookmark(blocks, target.bookmarks.end)
    if (!start || !end || compare(start, end) > 0) return null
    return canonicalRange(doc, { start, end })
  }
  return canonicalRange(doc, target.range)
}

export function applySegmentCandidate(doc: MoteDocument, target: SegmentTarget, payload: SegmentClipboard | null, context: SegmentContext): MoteDocument {
  const range = resolveSegmentRange(doc, target)
  if (!range) throw new Error('The reserved segment is no longer available.')
  const next = replaceSegment(doc, range, payload && !payload.content.length && !payload.floating.length ? null : payload, context.anchors, context.geometry)
  return initializeDocument(structuredClone(next))
}

export type { Geometries }
