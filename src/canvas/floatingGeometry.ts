import type { AttachmentSide, FloatingObject, LabelPosition, LineEnd } from '../document/model'

export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }
export interface Geometry extends Box { path?: Point[] }
export type Geometries = Record<string, Geometry>
export interface Anchor { id: string; top: number }
export const gridSize = 16
export const labelGap = 8
export const boxLabelPositions: LabelPosition[] = ['center', 'top-inside', 'top-outside', 'bottom-inside', 'bottom-outside']
export const lineLabelPositions: LabelPosition[] = ['center', 'left', 'right', 'above', 'below']
export const center = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

export function horizontalBounds(object: FloatingObject, box: Geometry) {
  const radius = 'strokeWidth' in object ? object.strokeWidth / 2 : 0
  const points: Point[] = []
  if (object.kind === 'line' && box.path) {
    const path = box.path
    if (object.arrowStart) points.push(...arrowPoints(path[0], path.find(p => distance(p, path[0]) > 0) ?? path.at(-1)!, object.strokeWidth))
    if (object.arrowEnd) points.push(...arrowPoints(path.at(-1)!, path.findLast(p => distance(p, path.at(-1)!) > 0) ?? path[0], object.strokeWidth))
  }
  return { left: Math.min(box.x - radius, ...points.map(p => p.x)), right: Math.max(box.x + box.width + radius, ...points.map(p => p.x)) }
}

export function boundedTranslation(objects: FloatingObject[], boxes: Geometries, ids: string[], delta: Point, pageWidth: number): Point {
  const moving = new Set(ids)
  for (const object of objects) {
    if (object.kind === 'line' && object.start.connection && object.end.connection
      && moving.has(object.start.connection.targetId) && moving.has(object.end.connection.targetId)) moving.add(object.id)
  }
  for (const object of objects) if (object.kind === 'label' && object.attachment && moving.has(object.attachment.targetId)) moving.add(object.id)
  const selected = objects.filter(object => moving.has(object.id))
  const bounds = selected.map(object => horizontalBounds(object, boxes[object.id]))
  const left = Math.min(...bounds.map(box => box.left)), right = Math.max(...bounds.map(box => box.right))
  // An existing oversized selection may move back toward the page, never farther out.
  const fits = right - left <= pageWidth
  const min = fits ? -left : Math.min(0, -left), max = fits ? pageWidth - right : Math.max(0, pageWidth - right)
  return { x: Math.max(min, Math.min(max, delta.x)), y: Math.max(-Math.min(...selected.map(object => boxes[object.id].y)), delta.y) }
}

export function arrowPoints(tip: Point, from: Point, width: number): Point[] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x), length = 8 + width * 2, half = 3 + width
  const base = { x: tip.x - Math.cos(angle) * length, y: tip.y - Math.sin(angle) * length }
  return [tip, { x: base.x - Math.sin(angle) * half, y: base.y + Math.cos(angle) * half }, { x: base.x + Math.sin(angle) * half, y: base.y - Math.cos(angle) * half }]
}

export function anchorPoint(point: Point, anchors: Anchor[]): LineEnd {
  const anchor = anchors.findLast(anchor => anchor.top <= point.y)
  return { x: point.x, y: Math.max(0, point.y - (anchor?.top ?? 0)), anchorId: anchor?.id ?? null }
}

export function boundary(box: Box, side: AttachmentSide, toward: Point, ellipse = false): Point {
  const c = center(box), rx = box.width / 2, ry = box.height / 2
  if (side === 'top') return { x: c.x, y: box.y }
  if (side === 'bottom') return { x: c.x, y: box.y + box.height }
  if (side === 'left') return { x: box.x, y: c.y }
  if (side === 'right') return { x: box.x + box.width, y: c.y }
  const dx = toward.x - c.x, dy = toward.y - c.y
  const denominator = ellipse ? Math.hypot(dx / (rx || 1), dy / (ry || 1)) : Math.max(Math.abs(dx) / (rx || 1), Math.abs(dy) / (ry || 1))
  return denominator ? { x: c.x + dx / denominator, y: c.y + dy / denominator } : { x: c.x + rx, y: c.y }
}

export function midpoint(path: Point[]): Point {
  const length = path.slice(1).reduce((sum, point, i) => sum + distance(path[i], point), 0)
  let remaining = length / 2
  for (let i = 1; i < path.length; i++) {
    const size = distance(path[i - 1], path[i])
    if (remaining <= size && size) return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * remaining / size, y: path[i - 1].y + (path[i].y - path[i - 1].y) * remaining / size }
    remaining -= size
  }
  return path[0]
}

export function labelPlacement(target: Geometry, size: Pick<Box, 'width' | 'height'>, position: LabelPosition): Point {
  const c = target.path ? midpoint(target.path) : center(target)
  const { width, height } = size
  switch (position) {
    case 'top-inside': return { x: c.x - width / 2, y: target.y + labelGap }
    case 'top-outside': return { x: c.x - width / 2, y: target.y - labelGap - height }
    case 'bottom-inside': return { x: c.x - width / 2, y: target.y + target.height - labelGap - height }
    case 'bottom-outside': return { x: c.x - width / 2, y: target.y + target.height + labelGap }
    case 'left': return { x: c.x - labelGap - width, y: c.y - height / 2 }
    case 'right': return { x: c.x + labelGap, y: c.y - height / 2 }
    case 'above': return { x: c.x - width / 2, y: c.y - labelGap - height }
    case 'below': return { x: c.x - width / 2, y: c.y + labelGap }
    default: return { x: c.x - width / 2, y: c.y - height / 2 }
  }
}

export function resolveGeometry(objects: FloatingObject[], anchors: Anchor[], sizes: Record<string, { width: number; height: number }>, tops: Record<string, number>): Geometries {
  const result: Geometries = {}
  const byId = new Map(objects.map(object => [object.id, object]))
  for (const object of objects) {
    result[object.id] = { x: object.x, y: tops[object.id] ?? object.y, width: object.kind === 'label' ? sizes[object.id]?.width ?? 16 : object.width,
      height: object.kind === 'rectangle' || object.kind === 'ellipse' ? object.height : sizes[object.id]?.height ?? 24 }
  }
  const free = (end: LineEnd): Point => ({ x: end.x, y: (anchors.find(a => a.id === end.anchorId)?.top ?? 0) + end.y })
  for (const object of objects) {
    if (object.kind !== 'line') continue
    const target = (end: LineEnd) => end.connection && result[end.connection.targetId]
    const initial = (end: LineEnd) => { const box = target(end); return box ? center(box) : free(end) }
    const endpoint = (end: LineEnd, toward: Point) => {
      const box = target(end)
      return box ? boundary(box, end.connection!.side, toward, byId.get(end.connection!.targetId)?.kind === 'ellipse') : free(end)
    }
    const start = endpoint(object.start, initial(object.end)), end = endpoint(object.end, initial(object.start))
    const bendX = (start.x + end.x) / 2 + object.bend
    const path = object.route === 'straight' ? [start, end] : [start, { x: bendX, y: start.y }, { x: bendX, y: end.y }, end]
    const x = Math.min(...path.map(p => p.x)), y = Math.min(...path.map(p => p.y))
    result[object.id] = { x, y, width: Math.max(...path.map(p => p.x)) - x, height: Math.max(...path.map(p => p.y)) - y, path }
  }
  for (const object of objects) {
    if (object.kind !== 'label' || !object.attachment) continue
    const target = result[object.attachment.targetId]
    if (target) result[object.id] = { ...result[object.id], ...labelPlacement(target, result[object.id], object.attachment.position) }
  }
  return result
}

export function contains(box: Box, p: Point) { return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height }
export function visualBottom(object: FloatingObject, geometry: Geometry) {
  const bottom = geometry.y + geometry.height + ('strokeWidth' in object ? object.strokeWidth / 2 : 0)
  if (object.kind !== 'line' || !geometry.path) return bottom
  const path = geometry.path
  return Math.max(bottom,
    ...(object.arrowStart ? arrowPoints(path[0], path.find(p => distance(p, path[0]) > 0) ?? path.at(-1)!, object.strokeWidth).map(p => p.y) : []),
    ...(object.arrowEnd ? arrowPoints(path.at(-1)!, path.findLast(p => distance(p, path.at(-1)!) > 0) ?? path[0], object.strokeWidth).map(p => p.y) : []))
}
export function intersects(a: Box, b: Box) { return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y }
export function segmentIntersects(a: Point, b: Point, box: Box) {
  let low = 0, high = 1
  for (const axis of ['x', 'y'] as const) {
    const delta = b[axis] - a[axis], min = box[axis], max = min + (axis === 'x' ? box.width : box.height)
    if (!delta) { if (a[axis] < min || a[axis] > max) return false; continue }
    const t1 = (min - a[axis]) / delta, t2 = (max - a[axis]) / delta
    low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2))
    if (low > high) return false
  }
  return true
}

export function objectIntersects(object: FloatingObject, geometry: Geometry, box: Box) {
  if (geometry.path && object.kind === 'line') {
    const path = geometry.path, radius = object.strokeWidth / 2
    const expanded = { x: box.x - radius, y: box.y - radius, width: box.width + radius * 2, height: box.height + radius * 2 }
    if (path.slice(1).some((p, i) => segmentIntersects(path[i], p, expanded))) return true
    const arrows = [
      ...(object.arrowStart ? [arrowPoints(path[0], path.find(p => distance(p, path[0]) > 0) ?? path.at(-1)!, object.strokeWidth)] : []),
      ...(object.arrowEnd ? [arrowPoints(path.at(-1)!, path.findLast(p => distance(p, path.at(-1)!) > 0) ?? path[0], object.strokeWidth)] : []),
    ]
    return arrows.some(points => {
      if (points.some((p, i) => segmentIntersects(p, points[(i + 1) % 3], box))) return true
      const crosses = points.map((a, i) => { const b = points[(i + 1) % 3]; return (b.x - a.x) * (box.y - a.y) - (b.y - a.y) * (box.x - a.x) })
      return crosses.every(n => n >= 0) || crosses.every(n => n <= 0)
    })
  }
  if (!intersects(geometry, box)) return false
  if (object.kind === 'ellipse') {
    const c = center(geometry), rx = geometry.width / 2, ry = geometry.height / 2
    const x = Math.max(box.x, Math.min(c.x, box.x + box.width)), y = Math.max(box.y, Math.min(c.y, box.y + box.height))
    if (((x - c.x) / rx) ** 2 + ((y - c.y) / ry) ** 2 > 1) return false
    if (!object.fill && [box, { x: box.x + box.width, y: box.y }, { x: box.x, y: box.y + box.height }, { x: box.x + box.width, y: box.y + box.height }].every(p => ((p.x - c.x) / rx) ** 2 + ((p.y - c.y) / ry) ** 2 < 1)) return false
  }
  if (object.kind === 'rectangle' && !object.fill && box.x > geometry.x && box.y > geometry.y && box.x + box.width < geometry.x + geometry.width && box.y + box.height < geometry.y + geometry.height) return false
  return true
}
