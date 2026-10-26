import { objectX, objectY, objectAnchorId } from '../document/model'
import { supportsCaption, type FloatingObject, type FloatingPatch } from '../document/model'

export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }
export interface Geometry extends Box { captionWidth?: number; margins?: FloatingObject['layout']['margins'] }
export type Geometries = Record<string, Geometry>
export interface Anchor { id: string; top: number; left?: number }
export const gridSize = 16
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

// Partial overlap is intentional; never hide either object completely on insertion.
export function fullyOverlaps(a: Geometry, b: Geometry) {
  const encloses = (outer: Box, inner: Box) => inner.x >= outer.x - .5 && inner.y >= outer.y - .5
    && inner.x + inner.width <= outer.x + outer.width + .5 && inner.y + inner.height <= outer.y + outer.height + .5
  const first = layoutBounds(a), second = layoutBounds(b)
  return first.width > 0 && first.height > 0 && second.width > 0 && second.height > 0 && (encloses(first, second) || encloses(second, first))
}

export function insertionPosition(box: Geometry, occupied: Geometry[], pageWidth: number): Point {
  const bounds = layoutBounds(box), inset = box.x - bounds.x
  let next = { ...box, x: Math.max(inset, Math.min(pageWidth - bounds.width + inset, box.x)), y: Math.max(box.y - bounds.y, box.y, 0) }
  while (occupied.some(other => fullyOverlaps(next, other))) next = { ...next, x: Math.max(inset, next.x - 24), y: next.y + 24 }
  return { x: next.x, y: next.y }
}

export function horizontalBounds(box: Geometry) {
  const extra = Math.max(0, ((box.captionWidth ?? box.width) - box.width) / 2)
  return { left: box.x - extra, right: box.x + box.width + extra }
}

// Content bounds stay independent of authored layout space: negative margins
// permit overlap, never crop the body or its caption.
export function layoutBounds(box: Geometry): Box {
  const { left, right } = horizontalBounds(box)
  const margins = box.margins
  return { x: left - (margins?.left ?? 0), y: box.y - (margins?.top ?? 0),
    width: Math.max(0, right - left + (margins?.left ?? 0) + (margins?.right ?? 0)),
    height: Math.max(0, box.height + (margins?.top ?? 0) + (margins?.bottom ?? 0)) }
}

export function extentBounds(box: Geometry): Box {
  const content = horizontalBounds(box), layout = layoutBounds(box)
  const x = Math.min(content.left, layout.x), y = Math.min(box.y, layout.y)
  return { x, y, width: Math.max(content.right, layout.x + layout.width) - x,
    height: Math.max(box.y + box.height, layout.y + layout.height) - y }
}

export function flowX(object: FloatingObject, columnWidth: number) {
  return (object.layout.placement.x === 'center') ? (columnWidth - object.layout.width + (object.layout.margins?.left ?? 0) - (object.layout.margins?.right ?? 0)) / 2 : objectX(object)
}

export function constrainCaptionResize(object: FloatingObject, patch: FloatingPatch, box: Box | undefined, pageWidth: number): FloatingPatch {
  if (!box || patch.width === undefined || !supportsCaption(object) || !object.caption?.width || object.layout.placement.type === 'flow' && (object.layout.placement.x === 'center')) return patch
  const captionWidth = object.caption.width
  const west = patch.x !== undefined && patch.x !== box.x
  const edge = west ? box.x + box.width : box.x
  const left = object.layout.margins?.left ?? 0, right = pageWidth - (object.layout.margins?.right ?? 0)
  const min = west ? 2 * edge - 2 * right + captionWidth : captionWidth + 2 * left - 2 * edge
  const max = west ? 2 * edge - captionWidth - 2 * left : 2 * right - captionWidth - 2 * edge
  const width = Math.max(Math.max(1, Math.min(object.layout.width, min)), Math.min(Math.max(object.layout.width, max), patch.width))
  return { ...patch, width, ...(west && { x: edge - width }) }
}

export function boundedTranslation(objects: FloatingObject[], boxes: Geometries, ids: string[], delta: Point, pageWidth: number): Point {
  const moving = new Set(ids)
  const selected = objects.filter(object => moving.has(object.id))
  const bounds = selected.map(object => layoutBounds(boxes[object.id]))
  const left = Math.min(...bounds.map(box => box.x)), right = Math.max(...bounds.map(box => box.x + box.width))
  // An existing oversized selection may move back toward the page, never farther out.
  const fits = right - left <= pageWidth
  const min = fits ? -left : Math.min(0, -left), max = fits ? pageWidth - right : Math.max(0, pageWidth - right)
  return { x: Math.max(min, Math.min(max, delta.x)), y: Math.max(-Math.min(...bounds.map(box => box.y), ...selected.map(object => boxes[object.id].y)), delta.y) }
}

export function anchorPoint(point: Point, anchors: Anchor[]): { x: number; y: number; anchorId: string | null } {
  const anchor = anchors.findLast(anchor => anchor.top <= point.y)
  return { x: point.x - (anchor?.left ?? 0), y: Math.max(0, point.y - (anchor?.top ?? 0)), anchorId: anchor?.id ?? null }
}

export function resolveGeometry(objects: FloatingObject[], sizes: Record<string, { width: number; height: number }>, tops: Record<string, number>, anchors: Anchor[] = [], column = { left: 0, width: 0 }): Geometries {
  const result: Geometries = {}
  for (const object of objects) {
    const x = object.layout.placement.type === 'flow'
      ? column.left + flowX(object, column.width)
      : objectX(object) + (anchors.find(anchor => anchor.id === objectAnchorId(object))?.left ?? 0)
    result[object.id] = { x, y: tops[object.id] ?? objectY(object), width: object.layout.width,
      ...(object.layout.margins && { margins: object.layout.margins }),
      ...(supportsCaption(object) && object.caption?.width !== undefined && { captionWidth: object.caption.width }),
      height: sizes[object.id]?.height ?? (object.kind === 'html' || object.kind === 'drawing' ? object.layout.height : 24) }
  }
  return result
}

export function contains(box: Box, p: Point) { return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height }
export function visualBottom(geometry: Geometry) {
  const bounds = extentBounds(geometry)
  return bounds.y + bounds.height
}
export function intersects(a: Geometry, b: Geometry) { return horizontalBounds(a).left <= horizontalBounds(b).right && horizontalBounds(a).right >= horizontalBounds(b).left && a.y <= b.y + b.height && a.y + a.height >= b.y }
