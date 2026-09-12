import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import type { FloatingObject, FloatingPatch, MoteDocument } from '../document/model'
import { resolveGeometry, visualBottom, type Anchor, type Geometries } from './floatingGeometry'

export interface Placement { x: number; top: number }
export type FloatingPreview = FloatingPatch & { top?: number }
export type FloatingPreviews = Record<string, FloatingPreview>
interface Obstacle { left: number; right: number; top: number; bottom: number }
interface Layout { anchors: Anchor[]; tops: Record<string, number>; geometry: Geometries; minHeight: number }
const gap = 8
const origin: Layout = { anchors: [], tops: {}, geometry: {}, minHeight: 0 }

function property(element: HTMLElement, name: string, value: string) {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value)
}

// One left-hand text interval per vertical band. Disconnected obstacles join only
// along the column's right edge, so text regains its full width between them.
function exclusion(obstacles: Obstacle[], top: number, left: number, width: number) {
  const boxes = obstacles.filter(box => box.bottom > top && box.left < left + width && box.right > left)
  if (!boxes.length) return null
  const stops = [...new Set([0, ...boxes.flatMap(box => [Math.max(0, box.top - top), box.bottom - top])])].sort((a, b) => a - b)
  const points = [`${width}px 0px`]
  for (let index = 0; index < stops.length - 1; index++) {
    const start = stops[index], end = stops[index + 1]
    const edge = Math.max(0, Math.min(width, ...boxes.filter(box => box.top < top + end && box.bottom > top + start).map(box => box.left - left)))
    points.push(`${edge}px ${start}px`, `${edge}px ${end}px`)
  }
  const height = stops.at(-1)!
  points.push(`${width}px ${height}px`)
  return { height, shape: `polygon(${points.join(',')})` }
}

export function useFloatingLayout(doc: MoteDocument, editor: Editor | null, sheet: RefObject<HTMLDivElement | null>, scale: number, preview: FloatingPreviews) {
  const [layout, setLayout] = useState(origin)
  const measureRef = useRef<(override?: FloatingPreviews) => Layout>(() => origin)
  const reflow = useCallback(() => measureRef.current(), [])

  useLayoutEffect(() => {
    if (!editor) return
    const surface = sheet.current!
    let frame = 0
    const observed = new Set<Element>()
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const observer = new ResizeObserver(schedule)
    function measure(override = preview) {
      const rect = surface.getBoundingClientRect()
      const localTop = (element: Element) => (element.getBoundingClientRect().top - rect.top) / scale - surface.clientTop
      // A spacer separates margins that would otherwise collapse to their maximum.
      editor!.view.dom.querySelectorAll<HTMLElement>('[data-spacer]').forEach(element => {
        const before = element.previousElementSibling, after = element.nextElementSibling
        const overlap = Math.min(before ? parseFloat(getComputedStyle(before).marginBottom) : 0, after ? parseFloat(getComputedStyle(after).marginTop) : 0)
        property(element, '--space-overlap', `${overlap}px`)
      })
      const elements = new Set<Element>([editor!.view.dom, surface.parentElement!])
      const heights = new Map<string, number>()
      const sizes: Record<string, { width: number; height: number }> = {}
      surface.querySelectorAll<HTMLElement>('.floating-note').forEach(element => {
        heights.set(element.dataset.noteId!, element.getBoundingClientRect().height / scale)
        sizes[element.dataset.noteId!] = { width: element.getBoundingClientRect().width / scale, height: element.getBoundingClientRect().height / scale }
        elements.add(element)
      })
      const anchors: Anchor[] = []
      const tops: Record<string, number> = {}
      const obstacles: Obstacle[] = []
      const activate = (note: FloatingObject, anchorTop: number) => {
        const moving = override[note.id]
        const top = moving?.top ?? anchorTop + note.y
        const left = moving?.x ?? note.x
        const width = moving?.width ?? note.width
        tops[note.id] = top
        if (note.textFlow === 'repel') obstacles.push({
          left: left - gap, right: left + width + gap,
          top: Math.max(anchorTop, top - gap), bottom: top + (heights.get(note.id) ?? 0) + gap,
        })
      }
      // A dragged object has a fixed document-space position until release.
      for (const note of doc.floating) if (note.anchorId === null || override[note.id]?.top !== undefined) activate(note, 0)
      editor!.state.doc.forEach((node, from) => {
        const element = editor!.view.nodeDOM(from) as HTMLElement
        const top = localTop(element)
        anchors.push({ id: node.attrs.id, top })
        elements.add(element)
        for (const note of doc.floating) if (note.anchorId === node.attrs.id && override[note.id]?.top === undefined) activate(note, top)
        if (node.type.name !== 'paragraph') return
        const content = element.firstElementChild as HTMLElement
        elements.add(content)
        const left = (element.getBoundingClientRect().left - rect.left) / scale - surface.clientLeft
        const shape = exclusion(obstacles, top, left, element.getBoundingClientRect().width / scale)
        if (shape) {
          // Contain each proxy float, but derive paragraph height from its native
          // in-flow content rather than the (possibly much taller) proxy itself.
          if (!element.hasAttribute('data-repel')) {
            property(element, '--text-height', `${content.getBoundingClientRect().height / scale}px`)
            element.setAttribute('data-repel', '')
          }
          property(element, '--repel-height', `${shape.height}px`)
          property(element, '--repel-shape', shape.shape)
          property(element, '--text-height', `${content.getBoundingClientRect().height / scale}px`)
        } else if (element.hasAttribute('data-repel')) {
          element.removeAttribute('data-repel')
          for (const name of ['--repel-height', '--repel-shape', '--text-height']) element.style.removeProperty(name)
        }
      })
      for (const element of observed) if (!elements.has(element)) { observer.unobserve(element); observed.delete(element) }
      for (const element of elements) if (!observed.has(element)) { observer.observe(element); observed.add(element) }
      const objects = doc.floating.map(note => ({ ...note, ...override[note.id] }) as FloatingObject)
      const geometry = resolveGeometry(objects, anchors, sizes, tops)
      const next = { anchors, tops, geometry, minHeight: Math.max(0, ...objects.map(note => visualBottom(note, geometry[note.id]))) + surface.clientTop * 2 }
      setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      return next
    }
    measureRef.current = measure
    measure()
    editor.on('transaction', schedule)
    document.fonts.addEventListener('loadingdone', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      editor.off('transaction', schedule)
      document.fonts.removeEventListener('loadingdone', schedule)
    }
  }, [doc, editor, sheet, scale, preview])

  function attach(note: FloatingObject, placement: Placement): FloatingPatch {
    const { anchors } = measureRef.current({ ...preview, [note.id]: placement })
    const anchor = anchors.findLast(anchor => anchor.top <= placement.top - (note.textFlow === 'repel' ? gap : 0))
    return { x: placement.x, y: Math.max(0, placement.top - (anchor?.top ?? 0)), anchorId: anchor?.id ?? null }
  }

  const objects = doc.floating.map(note => ({ ...note, ...preview[note.id] }) as FloatingObject)
  const tops = Object.fromEntries(objects.map(note => [note.id, preview[note.id]?.top ?? (layout.anchors.find(anchor => anchor.id === note.anchorId)?.top ?? 0) + note.y]))
  const geometry = resolveGeometry(objects, layout.anchors, layout.geometry, tops)
  return { ...layout, tops, geometry, reflow, attach }
}
