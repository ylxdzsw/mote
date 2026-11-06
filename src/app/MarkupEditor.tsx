import { useEffect, useState } from 'react'
import type { FloatingDrawing, FloatingHTMLWidget, FloatingImage, ObjectMarkup, Theme } from '../document/model'
import { DrawingEditor } from './DrawingEditor'

interface Props {
  object: FloatingImage | FloatingHTMLWidget
  size: { width: number; height: number }
  theme: Theme
  onChange: (markup: ObjectMarkup | null) => void
  onClose: () => void
}

export function MarkupEditor({ object, size, theme, onChange, onClose }: Props) {
  // Keep the reference space stable when undo removes the first mark or Clear removes all marks.
  const [reference] = useState(() => object.markup ?? { ...size, strokes: [], labels: [] })
  const [imageInset] = useState(object.layout.width - size.width)
  const [imageRatio, setImageRatio] = useState(size.width / size.height)
  const src = object.kind === 'image' ? object.src : object.screenshot
  useEffect(() => {
    if (object.kind !== 'image') return
    const image = new Image()
    image.onload = () => setImageRatio(image.naturalWidth / image.naturalHeight)
    image.src = src
    return () => { image.onload = null }
  }, [object.kind, src])
  const width = object.kind === 'html' ? object.layout.width : Math.max(1, object.layout.width - imageInset)
  const height = object.kind === 'html' ? object.layout.height : width / imageRatio
  const markup = object.markup ?? { ...reference, strokes: [], labels: [] }
  const drawing: FloatingDrawing = { id: object.id, kind: 'drawing',
    layout: { width: markup.width, height: markup.height, placement: { type: 'flow', x: 0 } },
    strokes: markup.strokes, labels: markup.labels, background: null }
  return <DrawingEditor drawing={drawing} theme={theme} maxWidth={markup.width} signedY={false}
    lockedBackground={{ src, width, height,
      hint: object.kind === 'html' ? 'Saved screenshot' : undefined }}
    onChange={patch => {
      const strokes = patch.strokes ?? markup.strokes, labels = patch.labels ?? markup.labels
      onChange(strokes.length || labels.length ? { width: markup.width, height: markup.height, strokes, labels } : null)
    }} onClose={onClose} />
}
