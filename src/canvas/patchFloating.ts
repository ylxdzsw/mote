import type { FloatingObject, FloatingPatch } from '../document/model'

// Resizing changes the drawing's bounds and point positions, never its pen widths.
// A patch that supplies strokes or labels with new bounds (editor crop/extend) is already in the new coordinates.
export function patchFloating(object: FloatingObject, patch: FloatingPatch): FloatingObject {
  if (patch.caption === null) { const next = { ...object, ...patch }; delete next.caption; return next as FloatingObject }
  if (object.kind !== 'drawing' || patch.width === undefined && patch.height === undefined
    || 'strokes' in patch || 'labels' in patch) return { ...object, ...patch } as FloatingObject
  const width = patch.width ?? object.width
  const height = patch.height ?? object.height * width / object.width
  const sx = width / object.width, sy = height / object.height
  return { ...object, ...patch, width, height,
    strokes: (patch.strokes ?? object.strokes).map(stroke => ({ ...stroke, points: stroke.points.map(([x, y]) => [x * sx, y * sy]) })),
    labels: (patch.labels ?? object.labels).map(label => ({ ...label, x: label.x * sx, y: label.y * sy })),
  } as FloatingObject
}
