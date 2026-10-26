import { patchObject, type FloatingObject, type FloatingPatch } from '../document/model'

// Resizing changes the drawing's bounds and point positions, never its pen widths.
// A patch that supplies strokes or labels with new bounds (editor crop/extend) is already in the new coordinates.
export function patchFloating(object: FloatingObject, patch: FloatingPatch): FloatingObject {
  if (object.kind !== 'drawing' || patch.width === undefined && patch.height === undefined
    || 'strokes' in patch || 'labels' in patch) return patchObject(object, patch)
  const width = patch.width ?? object.layout.width
  const height = patch.height ?? object.layout.height * width / object.layout.width
  const sx = width / object.layout.width, sy = height / object.layout.height
  return patchObject(object, { ...patch, width, height,
    strokes: (patch.strokes ?? object.strokes).map(stroke => ({ ...stroke, points: stroke.points.map(([x, y]) => [x * sx, y * sy]) })),
    labels: (patch.labels ?? object.labels).map(label => ({ ...label, x: label.x * sx, y: label.y * sy })),
  })
}
