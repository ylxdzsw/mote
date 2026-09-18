import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { shiftSpaceObjects, type FloatingObject, type FloatingPatch, type MoteDocument } from '../document/model'
import { spaceLayoutKey } from '../editor/spaces'
import { horizontalBounds, labelOutsideGap, resolveGeometry, visualBottom, type Anchor, type Geometries } from './floatingGeometry'
import { nativeSize } from './measurement'

export interface Placement { x: number; top: number }
export type FloatingPreview = FloatingPatch & { top?: number }
export type FloatingPreviews = Record<string, FloatingPreview>
interface Obstacle { left: number; right: number; top: number; bottom: number }
interface Layout { anchors: Anchor[]; tops: Record<string, number>; geometry: Geometries; minHeight: number; sideInsets: { left: number; right: number } }
const gap = 8
const origin: Layout = { anchors: [], tops: {}, geometry: {}, minHeight: 0, sideInsets: { left: 0, right: 0 } }

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

export function useFloatingLayout(doc: MoteDocument, editor: Editor | null, sheet: RefObject<HTMLDivElement | null>, preview: FloatingPreviews) {
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
      const floating = shiftSpaceObjects(doc.floating, spaceLayoutKey.getState(editor!.state)?.shift)
      const rect = surface.getBoundingClientRect()
      const scale = rect.width / nativeSize(surface).width
      const localTop = (element: Element) => (element.getBoundingClientRect().top - rect.top) / scale - surface.clientTop
      // A spacer separates margins that would otherwise collapse to their maximum.
      editor!.view.dom.querySelectorAll<HTMLElement>('[data-spacer]').forEach(element => {
        const before = element.previousElementSibling, after = element.nextElementSibling
        const overlap = Math.min(before ? parseFloat(getComputedStyle(before).marginBottom) : 0, after ? parseFloat(getComputedStyle(after).marginTop) : 0)
        property(element, '--space-overlap', `${overlap}px`)
      })
      const elements = new Set<Element>([editor!.view.dom])
      const heights = new Map<string, number>()
      const sizes: Record<string, { width: number; height: number }> = {}
      surface.querySelectorAll<HTMLElement>('.floating-note').forEach(element => {
        const size = nativeSize(element)
        heights.set(element.dataset.noteId!, size.height)
        sizes[element.dataset.noteId!] = size
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
      for (const note of floating) if (note.anchorId === null || override[note.id]?.top !== undefined) activate(note, 0)
      const blocks: { element: HTMLElement; ids: string[]; paragraph: boolean }[] = []
      const seen = new Set<Element>()
      editor!.state.doc.forEach((node, from) => {
        const original = editor!.view.nodeDOM(from) as HTMLElement
        const replacement = surface.querySelector<HTMLElement>(`[data-ai-block="${node.attrs.id}"]`)
        const preview = replacement?.closest('.ai-text-preview')
        if (preview) {
          if (seen.has(preview)) return
          seen.add(preview)
          for (const element of preview.children as HTMLCollectionOf<HTMLElement>) blocks.push({ element, paragraph: true,
            ids: [element.dataset.aiBlock!, ...[...element.querySelectorAll<HTMLElement>('[data-ai-block]')].map(anchor => anchor.dataset.aiBlock!)].filter(Boolean) })
        } else blocks.push({ element: original, ids: [node.attrs.id], paragraph: node.type.name === 'paragraph' })
      })
      for (const { element, ids, paragraph } of blocks) {
        const top = localTop(element)
        // Resolve existing alias attachments, but new placements prefer the visible survivor.
        anchors.push(...ids.toReversed().map(id => ({ id, top })))
        elements.add(element)
        for (const note of floating) if (note.anchorId !== null && ids.includes(note.anchorId) && override[note.id]?.top === undefined) activate(note, top)
        if (!paragraph) continue
        const content = element.firstElementChild as HTMLElement
        elements.add(content)
        const left = (element.getBoundingClientRect().left - rect.left) / scale - surface.clientLeft
        const shape = exclusion(obstacles, top, left, nativeSize(element).width)
        if (shape) {
          // Contain each proxy float, but derive paragraph height from its native
          // in-flow content rather than the (possibly much taller) proxy itself.
          if (!element.hasAttribute('data-repel')) {
            property(element, '--text-height', `${nativeSize(content).height}px`)
            element.setAttribute('data-repel', '')
          }
          property(element, '--repel-height', `${shape.height}px`)
          property(element, '--repel-shape', shape.shape)
          property(element, '--text-height', `${nativeSize(content).height}px`)
        } else if (element.hasAttribute('data-repel')) {
          element.removeAttribute('data-repel')
          for (const name of ['--repel-height', '--repel-shape', '--text-height']) element.style.removeProperty(name)
        }
      }
      for (const element of observed) if (!elements.has(element)) { observer.unobserve(element); observed.delete(element) }
      for (const element of elements) if (!observed.has(element)) { observer.observe(element); observed.add(element) }
      const objects = floating.map(note => ({ ...note, ...override[note.id] }) as FloatingObject)
      const geometry = resolveGeometry(objects, anchors, sizes, tops, labelOutsideGap(doc.theme))
      // Only unused side margins may collapse in reading; retain every on-page object.
      let left = doc.margins.left, right = doc.width - doc.margins.right
      for (const note of objects) {
        const bounds = horizontalBounds(note, geometry[note.id])
        const start = bounds.left + surface.clientLeft, end = bounds.right + surface.clientLeft
        if (end > 0 && start < doc.width) { left = Math.min(left, start); right = Math.max(right, end) }
      }
      // Display math can extend beyond its author-sized box on either side.
      surface.querySelectorAll<HTMLElement>('.katex-html > .katex-base, .katex-html > .katex-tag').forEach(element => {
        const box = element.getBoundingClientRect()
        const start = (box.left - rect.left) / scale, end = (box.right - rect.left) / scale
        if (end > 0 && start < doc.width) { left = Math.min(left, start); right = Math.max(right, end) }
      })
      const sideInsets = { left: Math.max(0, left), right: Math.max(0, doc.width - right) }
      const next = { anchors, tops, geometry, sideInsets, minHeight: Math.max(0, ...objects.map(note => visualBottom(note, geometry[note.id]))) + doc.margins.bottom + surface.clientTop * 2 }
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
  }, [doc, editor, sheet, preview])

  function attach(note: FloatingObject, placement: Placement): FloatingPatch {
    const { anchors } = measureRef.current({ ...preview, [note.id]: placement })
    const anchor = anchors.findLast(anchor => anchor.top <= placement.top - (note.textFlow === 'repel' ? gap : 0))
    return { x: placement.x, y: Math.max(0, placement.top - (anchor?.top ?? 0)), anchorId: anchor?.id ?? null }
  }

  const objects = shiftSpaceObjects(doc.floating, editor ? spaceLayoutKey.getState(editor.state)?.shift : null)
    .map(note => ({ ...note, ...preview[note.id] }) as FloatingObject)
  const tops = Object.fromEntries(objects.map(note => [note.id, preview[note.id]?.top ?? (layout.anchors.find(anchor => anchor.id === note.anchorId)?.top ?? 0) + note.y]))
  const geometry = resolveGeometry(objects, layout.anchors, layout.geometry, tops, labelOutsideGap(doc.theme))
  return { ...layout, tops, geometry, reflow, attach }
}
