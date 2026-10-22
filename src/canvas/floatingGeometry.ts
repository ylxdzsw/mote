import { supportsCaption, type FloatingObject, type FloatingPatch } from '../document/model'

export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }
export interface Geometry extends Box { captionWidth?: number }
export type Geometries = Record<string, Geometry>
export interface Anchor { id: string; top: number; left?: number }
export const gridSize = 16
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

// Partial overlap is intentional; never hide either object completely on insertion.
export function fullyOverlaps(a: Geometry, b: Geometry) {
  const encloses = (outer: Geometry, inner: Geometry) => horizontalBounds(inner).left >= horizontalBounds(outer).left - .5 && inner.y >= outer.y - .5
    && horizontalBounds(inner).right <= horizontalBounds(outer).right + .5 && inner.y + inner.height <= outer.y + outer.height + .5
  return encloses(a, b) || encloses(b, a)
}

export function insertionPosition(box: Geometry, occupied: Geometry[], pageWidth: number): Point {
  const extra = Math.max(0, ((box.captionWidth ?? box.width) - box.width) / 2)
  let next = { ...box, x: Math.max(extra, Math.min(pageWidth - box.width - extra, box.x)), y: Math.max(0, box.y) }
  while (occupied.some(other => fullyOverlaps(next, other))) next = { ...next, x: Math.max(extra, next.x - 24), y: next.y + 24 }
  return { x: next.x, y: next.y }
}

export function horizontalBounds(box: Geometry) {
  const extra = Math.max(0, ((box.captionWidth ?? box.width) - box.width) / 2)
  return { left: box.x - extra, right: box.x + box.width + extra }
}

export function constrainCaptionResize(object: FloatingObject, patch: FloatingPatch, box: Box | undefined, pageWidth: number): FloatingPatch {
  if (!box || patch.width === undefined || !supportsCaption(object) || !object.caption?.width || object.placement === 'flow' && object.centered) return patch
  const captionWidth = object.caption.width
  const west = patch.x !== undefined && patch.x !== box.x
  const edge = west ? box.x + box.width : box.x
  const min = west ? 2 * edge - 2 * pageWidth + captionWidth : captionWidth - 2 * edge
  const max = west ? 2 * edge - captionWidth : 2 * pageWidth - captionWidth - 2 * edge
  const width = Math.max(Math.max(1, Math.min(object.width, min)), Math.min(Math.max(object.width, max), patch.width))
  return { ...patch, width, ...(west && { x: edge - width }) }
}

export function boundedTranslation(objects: FloatingObject[], boxes: Geometries, ids: string[], delta: Point, pageWidth: number): Point {
  const moving = new Set(ids)
  const selected = objects.filter(object => moving.has(object.id))
  const bounds = selected.map(object => horizontalBounds(boxes[object.id]))
  const left = Math.min(...bounds.map(box => box.left)), right = Math.max(...bounds.map(box => box.right))
  // An existing oversized selection may move back toward the page, never farther out.
  const fits = right - left <= pageWidth
  const min = fits ? -left : Math.min(0, -left), max = fits ? pageWidth - right : Math.max(0, pageWidth - right)
  return { x: Math.max(min, Math.min(max, delta.x)), y: Math.max(-Math.min(...selected.map(object => boxes[object.id].y)), delta.y) }
}

export function anchorPoint(point: Point, anchors: Anchor[]): { x: number; y: number; anchorId: string | null } {
  const anchor = anchors.findLast(anchor => anchor.top <= point.y)
  return { x: point.x - (anchor?.left ?? 0), y: Math.max(0, point.y - (anchor?.top ?? 0)), anchorId: anchor?.id ?? null }
}

export function resolveGeometry(objects: FloatingObject[], sizes: Record<string, { width: number; height: number }>, tops: Record<string, number>, anchors: Anchor[] = [], column = { left: 0, width: 0 }): Geometries {
  const result: Geometries = {}
  for (const object of objects) {
    const x = object.placement === 'flow'
      ? column.left + (object.centered ? (column.width - object.width) / 2 : object.x)
      : object.x + (anchors.find(anchor => anchor.id === object.anchorId)?.left ?? 0)
    result[object.id] = { x, y: tops[object.id] ?? object.y, width: object.width,
      ...(supportsCaption(object) && object.caption?.width !== undefined && { captionWidth: object.caption.width }),
      height: sizes[object.id]?.height ?? (object.kind === 'html' || object.kind === 'drawing' ? object.height : 24) }
  }
  return result
}

export function contains(box: Box, p: Point) { return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height }
export function visualBottom(geometry: Geometry) {
  return geometry.y + geometry.height
}
export function intersects(a: Geometry, b: Geometry) { return horizontalBounds(a).left <= horizontalBounds(b).right && horizontalBounds(a).right >= horizontalBounds(b).left && a.y <= b.y + b.height && a.y + a.height >= b.y }
