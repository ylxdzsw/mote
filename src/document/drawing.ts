export type DrawingPoint = [number, number]

const midpoint = (a: DrawingPoint, b: DrawingPoint): DrawingPoint => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

export function drawingPoint(clientX: number, clientY: number, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, width: number, height: number): DrawingPoint {
  return [Math.max(0, Math.min(width, (clientX - bounds.left) * width / bounds.width)),
    Math.max(0, Math.min(height, (clientY - bounds.top) * height / bounds.height))]
}

export function drawingStrokePath(points: DrawingPoint[]): string {
  if (!points.length) return ''
  let path = `M${points[0].join(' ')}`
  for (let i = 1; i < points.length - 1; i++) path += `Q${points[i].join(' ')} ${midpoint(points[i], points[i + 1]).join(' ')}`
  if (points.length > 1) path += `L${points.at(-1)!.join(' ')}`
  return path
}

function pointDistance(p: DrawingPoint, a: DrawingPoint, b: DrawingPoint): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

function segmentDistance(a: DrawingPoint, b: DrawingPoint, c: DrawingPoint, d: DrawingPoint): number {
  const cross = (p: DrawingPoint, q: DrawingPoint, r: DrawingPoint) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b))
}

// Test the same quadratic curves the SVG renders, including the eraser's swept path.
export function drawingStrokeHit(points: DrawingPoint[], from: DrawingPoint, to: DrawingPoint, radius: number): boolean {
  if (!points.length) return false
  if (points.length === 1) return pointDistance(points[0], from, to) <= radius
  const lineHit = (a: DrawingPoint, b: DrawingPoint) => segmentDistance(a, b, from, to) <= radius
  function curveHit(a: DrawingPoint, control: DrawingPoint, b: DrawingPoint): boolean {
    if (pointDistance(control, a, b) <= .25) return lineHit(a, b)
    const left = midpoint(a, control), right = midpoint(control, b), center = midpoint(left, right)
    return curveHit(a, left, center) || curveHit(center, right, b)
  }
  let start = points[0]
  for (let i = 1; i < points.length - 1; i++) {
    const end = midpoint(points[i], points[i + 1])
    if (curveHit(start, points[i], end)) return true
    start = end
  }
  return lineHit(start, points.at(-1)!)
}
