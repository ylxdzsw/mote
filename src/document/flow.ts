import { patchObject, objectX, objectY, objectAnchorId } from './model'
import type { JSONContent } from '@tiptap/core'
import { flowX, type Anchor, type Geometries, type Point } from '../canvas/floatingGeometry'
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
const flowAt = (doc: MoteDocument, anchorId: string | null) => doc.objects.find(object => object.layout.placement.type === 'flow' && objectAnchorId(object, doc.content) === anchorId)
const anchorTop = (id: string | null, options: FlowGeometryOptions) => options.anchors?.find(anchor => anchor.id === id)?.top ?? 0

export function objectPagePosition(doc: MoteDocument, object: FloatingObject, options: FlowGeometryOptions = {}): Point {
  const box = options.geometry?.[object.id]
  if (box) return { x: box.x, y: box.y }
  if (object.layout.placement.type === 'flow') {
    const left = options.textLeft ?? doc.page.margins.left
    const width = options.textWidth ?? doc.page.width - left - doc.page.margins.right
    const anchor = options.anchors?.findLast(candidate => candidate.id === objectAnchorId(object, doc.content))
    return { x: left + flowX(object, width), y: anchor?.top ?? object.layout.margins?.top ?? 0 }
  }
  const target = flowAt(doc, objectAnchorId(object, doc.content))
  const origin = target ? objectPagePosition(doc, target, options) : { x: 0, y: anchorTop(objectAnchorId(object, doc.content), options) }
  return { x: origin.x + objectX(object), y: origin.y + objectY(object) }
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
  const oldFlowAnchors = new Set(doc.objects.filter(object => object.layout.placement.type === 'flow').map(object => objectAnchorId(object, doc.content)))
  const destination = { ...doc, content, objects: objects }
  const reconciled = objects.map(object => {
    const lostAnchor = objectAnchorId(object, doc.content) !== null && oldFlowAnchors.has(objectAnchorId(object, doc.content)) && !blockIds.has(objectAnchorId(object, doc.content))
    if (object.layout.placement.type === 'flow' || !lostAnchor) return object
    const original = doc.objects.find(candidate => candidate.id === object.id) ?? object
    const point = objectPagePosition(doc, original, options)
    let anchorId = lostAnchor ? precedingAnchor(doc, content, objectAnchorId(object, doc.content)) : objectAnchorId(object, doc.content)
    if (!flowAt(destination, anchorId) && anchorTop(anchorId, options) > point.y) {
      const ordinaryIds = new Set((content.content ?? []).filter(block => block.type !== 'flow').map(block => block.attrs?.id))
      anchorId = options.anchors?.findLast(anchor => ordinaryIds.has(anchor.id) && anchor.top <= point.y)?.id ?? null
    }
    return patchObject(object, placementAtPoint(destination, point, anchorId, options))
  })
  return { ...destination, objects: reconciled }
}

export function reconcileFlowContent(doc: MoteDocument, content: JSONContent, options: FlowGeometryOptions = {}): MoteDocument {
  const flowIds = new Set((content.content ?? []).filter(block => block.type === 'flow').map(block => block.attrs?.objectId))
  const objects = doc.objects.filter(object => object.layout.placement.type !== 'flow' || flowIds.has(object.id))
  return reconcile(doc, content, objects, options)
}

export function reconcileObjectDeletions(doc: MoteDocument, objects: FloatingObject[], options: FlowGeometryOptions = {}): MoteDocument {
  const ids = new Set(objects.filter(object => object.layout.placement.type === 'flow').map(object => object.id))
  const blocks = blocksOf(doc).filter(block => block.type !== 'flow' || ids.has(block.attrs?.objectId))
  const content = { ...doc.content, content: blocks.length ? blocks : [paragraph('')] }
  return reconcile(doc, content, objects, options)
}

export function insertDocumentObjects(doc: MoteDocument, objects: FloatingObject[], index = blocksOf(doc).length, blocks: JSONContent[] = []): MoteDocument {
  const inserted = structuredClone(objects)
  const content = structuredClone(blocks)
  for (const object of inserted) {
    if (object.layout.placement.type !== 'flow') continue
    if (!content.some(block => block.type === 'flow' && block.attrs?.objectId === object.id)) content.push(flowBlock(object.id))
  }
  const existing = blocksOf(doc)
  return { ...doc, content: { ...doc.content, content: [...existing.slice(0, index), ...content, ...existing.slice(index)] }, objects: [...doc.objects, ...inserted] }
}

export function insertFlowObject(doc: MoteDocument, object: FloatingObject, index = blocksOf(doc).length): MoteDocument {
  return insertDocumentObjects(doc, [patchObject(object, { placement: 'flow' })], index)
}

export function convertObjectPlacement(doc: MoteDocument, id: string, placement: FloatingObject['layout']['placement']['type'], options: FlowGeometryOptions & { index?: number; centered?: boolean } = {}): MoteDocument {
  const object = doc.objects.find(object => object.id === id)
  if (!object) return doc
  if (object.layout.placement.type === placement) {
    return options.centered === undefined ? doc : { ...doc, objects: doc.objects.map(item => item.id === id ? patchObject(item, { centered: options.centered }) : item) }
  }
  const point = objectPagePosition(doc, object, options)
  if (placement === 'flow') {
    const block = flowBlock(id)
    const blocks = blocksOf(doc)
    const index = options.index ?? (objectAnchorId(object, doc.content) === null ? 0 : blocks.findIndex(block => block.attrs?.id === objectAnchorId(object, doc.content)) + 1)
    const next = patchObject(object, { placement, x: point.x - (options.textLeft ?? doc.page.margins.left), y: 0,
      ...(options.centered !== undefined && { centered: options.centered }) })
    return { ...doc, content: { ...doc.content, content: [...blocks.slice(0, index), block, ...blocks.slice(index)] }, objects: doc.objects.map(item => item.id === id ? next : item) }
  }
  const content = { ...doc.content, content: blocksOf(doc).filter(block => block.type !== 'flow' || block.attrs?.objectId !== id) }
  const anchorId = precedingAnchor(doc, content, objectAnchorId(object, doc.content))
  const next = patchObject(object, { placement, centered: false, ...placementAtPoint(doc, point, anchorId, options) })
  return reconcileObjectDeletions(doc, doc.objects.map(item => item.id === id ? next : item), options)
}
