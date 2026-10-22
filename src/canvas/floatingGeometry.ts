import { isText, type FloatingObject, type CaptionPosition } from '../document/model'

export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }
export type Geometry = Box
export type Geometries = Record<string, Geometry>
export interface Anchor { id: string; top: number; left?: number }
export const gridSize = 16
export const captionGap = 8
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

// Partial overlap is intentional; never hide either object completely on insertion.
export function fullyOverlaps(a: Box, b: Box) {
  const encloses = (outer: Box, inner: Box) => inner.x >= outer.x - .5 && inner.y >= outer.y - .5
    && inner.x + inner.width <= outer.x + outer.width + .5 && inner.y + inner.height <= outer.y + outer.height + .5
  return encloses(a, b) || encloses(b, a)
}

export function insertionPosition(box: Box, occupied: Box[], pageWidth: number): Point {
  let next = { ...box, x: Math.max(0, Math.min(pageWidth - box.width, box.x)), y: Math.max(0, box.y) }
  while (occupied.some(other => fullyOverlaps(next, other))) next = { ...next, x: Math.max(0, next.x - 24), y: next.y + 24 }
  return { x: next.x, y: next.y }
}

export function horizontalBounds(box: Geometry) {
  return { left: box.x, right: box.x + box.width }
}

export function boundedTranslation(objects: FloatingObject[], boxes: Geometries, ids: string[], delta: Point, pageWidth: number): Point {
  const moving = new Set(ids)
  for (const object of objects) if (isText(object) && object.attachment && moving.has(object.attachment.targetId)) moving.add(object.id)
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

export function captionPlacement(target: Geometry, height: number, position: CaptionPosition): Point {
  return { x: target.x, y: position === 'above' ? target.y - captionGap - height : target.y + target.height + captionGap }
}

export function resolveGeometry(objects: FloatingObject[], sizes: Record<string, { width: number; height: number }>, tops: Record<string, number>, anchors: Anchor[] = [], column = { left: 0, width: 0 }): Geometries {
  const result: Geometries = {}
  for (const object of objects) {
    const attached = isText(object) && object.attachment
    const x = object.placement === 'flow' && !attached
      ? column.left + (object.centered ? (column.width - object.width) / 2 : object.x)
      : object.x + (anchors.find(anchor => anchor.id === object.anchorId)?.left ?? 0)
    result[object.id] = { x, y: tops[object.id] ?? object.y, width: object.width,
      height: object.kind === 'html' || object.kind === 'drawing' ? object.height : sizes[object.id]?.height ?? 24 }
  }
  for (const object of objects) {
    if (!isText(object) || !object.attachment) continue
    const target = result[object.attachment.targetId]
    if (target) result[object.id] = { ...result[object.id], width: target.width, ...captionPlacement(target, result[object.id].height, object.attachment.position) }
  }
  return result
}

export function contains(box: Box, p: Point) { return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height }
export function visualBottom(geometry: Geometry) {
  return geometry.y + geometry.height
}
export function intersects(a: Box, b: Box) { return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y }
