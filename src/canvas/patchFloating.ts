import { patchObject, type FloatingObject, type FloatingPatch } from '../document/model'

// A patch that supplies strokes or labels with new bounds (editor crop/extend) is already in the new coordinates.
export function patchFloating(object: FloatingObject, patch: FloatingPatch, markSizes: 'scale' | 'preserve' = 'scale'): FloatingObject {
  if (object.kind !== 'drawing' || patch.width === undefined && patch.height === undefined
    || 'strokes' in patch || 'labels' in patch) return patchObject(object, patch)
  const width = patch.width ?? object.layout.width
  const height = patch.height ?? object.layout.height * width / object.layout.width
  const sx = width / object.layout.width, sy = height / object.layout.height
  const scale = markSizes === 'scale' ? sx : 1
  return patchObject(object, { ...patch, width, height,
    strokes: object.strokes.map(stroke => ({ ...stroke, width: stroke.width * scale, points: stroke.points.map(([x, y]) => [x * sx, y * sy]) })),
    labels: object.labels.map(label => ({ ...label, x: label.x * sx, y: label.y * sy, size: label.size * scale })),
  })
}
