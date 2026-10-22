import type { JSONContent } from '@tiptap/core'
import type { Anchor, Geometries, Point } from '../canvas/floatingGeometry'
import { paragraph, type FloatingObject, type MoteDocument } from './model'

export interface FlowGeometryOptions {
  anchors?: readonly Anchor[]
  geometry?: Geometries
  textLeft?: number
  textWidth?: number
}

export function flowBlock(objectId: string, id = crypto.randomUUID()): JSONContent {
  return { type: 'flow', attrs: { id, objectId } }
}

const blocksOf = (doc: MoteDocument) => doc.content.content ?? []
const flowAt = (doc: MoteDocument, anchorId: string | null) => doc.floating.find(object => object.placement === 'flow' && object.anchorId === anchorId)
const anchorTop = (id: string | null, options: FlowGeometryOptions) => options.anchors?.find(anchor => anchor.id === id)?.top ?? 0

export function objectPagePosition(doc: MoteDocument, object: FloatingObject, options: FlowGeometryOptions = {}): Point {
  const box = options.geometry?.[object.id]
  if (box) return { x: box.x, y: box.y }
  if (object.placement === 'flow') {
    const left = options.textLeft ?? doc.margins.left
    const width = options.textWidth ?? doc.width - left - doc.margins.right
    return { x: left + (object.centered ? (width - object.width) / 2 : object.x), y: anchorTop(object.anchorId, options) }
  }
  const target = flowAt(doc, object.anchorId)
  const origin = target ? objectPagePosition(doc, target, options) : { x: 0, y: anchorTop(object.anchorId, options) }
  return { x: origin.x + object.x, y: origin.y + object.y }
}

// Flow anchors use both axes; ordinary anchors use only their measured top.
export function placementAtPoint(doc: MoteDocument, point: Point, anchorId: string | null, options: FlowGeometryOptions = {}) {
  const target = flowAt(doc, anchorId)
  const origin = target ? objectPagePosition(doc, target, options) : { x: 0, y: anchorTop(anchorId, options) }
  return { anchorId, x: point.x - origin.x, y: target ? point.y - origin.y : Math.max(0, point.y - origin.y) }
}

function precedingAnchor(doc: MoteDocument, content: JSONContent, removed: string | null) {
  const surviving = new Set((content.content ?? []).map(block => block.attrs?.id))
  const blocks = blocksOf(doc)
  const index = blocks.findIndex(block => block.attrs?.id === removed)
  return blocks.slice(0, index < 0 ? 0 : index).findLast(block => surviving.has(block.attrs?.id))?.attrs?.id as string | undefined ?? null
}

function reconcile(doc: MoteDocument, content: JSONContent, objects: FloatingObject[], options: FlowGeometryOptions): MoteDocument {
  const blockIds = new Set((content.content ?? []).map(block => block.attrs?.id))
  const oldFlowAnchors = new Set(doc.floating.filter(object => object.placement === 'flow').map(object => object.anchorId))
  const destination = { ...doc, content, floating: objects }
  const floating = objects.map(object => {
    const lostAnchor = object.anchorId !== null && oldFlowAnchors.has(object.anchorId) && !blockIds.has(object.anchorId)
    if (!lostAnchor) return object
    const original = doc.floating.find(candidate => candidate.id === object.id) ?? object
    const point = objectPagePosition(doc, original, options)
    let anchorId = lostAnchor ? precedingAnchor(doc, content, object.anchorId) : object.anchorId
    if (!flowAt(destination, anchorId) && anchorTop(anchorId, options) > point.y) {
      const ordinaryIds = new Set((content.content ?? []).filter(block => block.type !== 'flow').map(block => block.attrs?.id))
      anchorId = options.anchors?.findLast(anchor => ordinaryIds.has(anchor.id) && anchor.top <= point.y)?.id ?? null
    }
    return { ...object, ...placementAtPoint(destination, point, anchorId, options) }
  })
  return { ...destination, floating }
}

export function reconcileFlowContent(doc: MoteDocument, content: JSONContent, options: FlowGeometryOptions = {}): MoteDocument {
  const flowIds = new Set((content.content ?? []).filter(block => block.type === 'flow').map(block => block.attrs?.objectId))
  const floating = doc.floating.filter(object => object.placement !== 'flow' || flowIds.has(object.id))
  return reconcile(doc, content, floating, options)
}

export function reconcileObjectDeletions(doc: MoteDocument, objects: FloatingObject[], options: FlowGeometryOptions = {}): MoteDocument {
  const ids = new Set(objects.filter(object => object.placement === 'flow').map(object => object.id))
  const blocks = blocksOf(doc).filter(block => block.type !== 'flow' || ids.has(block.attrs?.objectId))
  const content = { ...doc.content, content: blocks.length ? blocks : [paragraph('')] }
  return reconcile(doc, content, objects, options)
}

export function insertDocumentObjects(doc: MoteDocument, objects: FloatingObject[], index = blocksOf(doc).length, blocks: JSONContent[] = []): MoteDocument {
  const inserted = structuredClone(objects)
  const content = structuredClone(blocks)
  const anchors = new Map<string, string>()
  for (const object of inserted) {
    if (object.placement !== 'flow') continue
    let block = content.find(block => block.type === 'flow' && block.attrs?.objectId === object.id)
    if (!block) { block = flowBlock(object.id); content.push(block) }
    if (object.anchorId !== null) anchors.set(object.anchorId, block.attrs!.id)
    object.anchorId = block.attrs!.id
    object.y = 0
  }
  for (const object of inserted) if (object.placement === 'float' && object.anchorId !== null && anchors.has(object.anchorId)) object.anchorId = anchors.get(object.anchorId)!
  const existing = blocksOf(doc)
  return { ...doc, content: { ...doc.content, content: [...existing.slice(0, index), ...content, ...existing.slice(index)] }, floating: [...doc.floating, ...inserted] }
}

export function insertFlowObject(doc: MoteDocument, object: FloatingObject, index = blocksOf(doc).length): MoteDocument {
  return insertDocumentObjects(doc, [{ ...object, placement: 'flow', y: 0 }], index)
}

export function convertObjectPlacement(doc: MoteDocument, id: string, placement: FloatingObject['placement'], options: FlowGeometryOptions & { index?: number; centered?: boolean } = {}): MoteDocument {
  const object = doc.floating.find(object => object.id === id)
  if (!object) return doc
  if (object.placement === placement) {
    return options.centered === undefined ? doc : { ...doc, floating: doc.floating.map(item => item.id === id ? { ...item, centered: options.centered } : item) }
  }
  const point = objectPagePosition(doc, object, options)
  if (placement === 'flow') {
    const block = flowBlock(id)
    const blocks = blocksOf(doc)
    const index = options.index ?? (object.anchorId === null ? 0 : blocks.findIndex(block => block.attrs?.id === object.anchorId) + 1)
    const next = { ...object, placement, anchorId: block.attrs!.id as string, x: point.x - (options.textLeft ?? doc.margins.left), y: 0,
      ...(options.centered !== undefined && { centered: options.centered }) }
    return { ...doc, content: { ...doc.content, content: [...blocks.slice(0, index), block, ...blocks.slice(index)] }, floating: doc.floating.map(item => item.id === id ? next : item) }
  }
  const content = { ...doc.content, content: blocksOf(doc).filter(block => block.type !== 'flow' || block.attrs?.objectId !== id) }
  const anchorId = precedingAnchor(doc, content, object.anchorId)
  const next = { ...object, placement, centered: false, ...placementAtPoint(doc, point, anchorId, options) }
  return reconcileObjectDeletions(doc, doc.floating.map(item => item.id === id ? next : item), options)
}
