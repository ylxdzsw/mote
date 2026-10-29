import { patchObject, objectX, objectY, objectAnchorId } from '../document/model'
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { supportsCaption, shiftSpaceObjects, type FloatingObject, type FloatingPatch, type MoteDocument } from '../document/model'
import { spaceLayoutKey } from '../editor/spaces'
import { extentBounds, layoutBounds, resolveGeometry, slideAtPoint, visualBottom, type Anchor, type Geometries, type SlideGeometry } from './floatingGeometry'
import { layoutPixel, nativeSize } from './measurement'
import { objectSlideIndex, slideRanges } from '../document/slides'
import './SlideRulers.css'

export interface Placement { x: number; top: number }
export type FloatingPreview = FloatingPatch & { top?: number }
export type FloatingPreviews = Record<string, FloatingPreview>
interface Obstacle { left: number; right: number; top: number; bottom: number }
interface Layout { anchors: Anchor[]; tops: Record<string, number>; geometry: Geometries; minHeight: number; sideInsets: { left: number; right: number }; flowMounts: Record<string, HTMLElement>; slides: SlideGeometry[] }
interface VisibleBlock { element: HTMLElement; ids: string[]; paragraph: boolean; slideIndex: number }
const gap = 8
const origin: Layout = { anchors: [], tops: {}, geometry: {}, minHeight: 0, sideInsets: { left: 0, right: 0 }, flowMounts: {}, slides: [] }

function property(element: HTMLElement, name: string, value: string) {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value)
}

function layoutBlock(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.matches('.main-paragraph, [data-spacer], [data-flow], [data-slide-break]')
}

function blockIds(element: HTMLElement, fallback?: string) {
  const ids = [element.dataset.aiBlock, element.dataset.id, fallback].filter((id): id is string => !!id)
  for (const anchor of element.matches('[data-flow]') ? [] : element.querySelectorAll<HTMLElement>('[data-ai-block]')) {
    if (anchor.dataset.aiBlock) ids.push(anchor.dataset.aiBlock)
  }
  return [...new Set(ids)]
}

function previewObjects(objects: FloatingObject[], preview: FloatingPreviews, anchors: Anchor[], columnLeft: number) {
  return objects.map(note => {
    const moving = preview[note.id]
    const { top: _top, ...patch } = moving ?? {}
    const object = patchObject(note, patch)
    if (moving?.x !== undefined && moving.centered !== true) object.layout.placement.x = moving.x - (object.layout.placement.type === 'flow'
      ? columnLeft : anchors.find(anchor => anchor.id === objectAnchorId(object))?.left ?? 0)
    return object
  })
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

export function useFloatingLayout(doc: MoteDocument, editor: Editor | null, sheet: RefObject<HTMLDivElement | null>, preview: FloatingPreviews, editable: boolean) {
  const [layout, setLayout] = useState(origin)
  const measuredSlides = useRef<SlideGeometry[]>([])
  const measureRef = useRef<(override?: FloatingPreviews) => Layout>(() => origin)
  const reflow = useCallback(() => measureRef.current(), [])

  useLayoutEffect(() => {
    if (!editor) return
    const surface = sheet.current!
    const slideHeight = doc.page.slideHeight && doc.page.slideHeight > 0 ? doc.page.slideHeight : 0
    const ranges = slideHeight ? slideRanges(doc) : []
    if (slideHeight) surface.setAttribute('data-slides', '')
    else surface.removeAttribute('data-slides')
    let frame = 0
    const observed = new Set<Element>()
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const observer = new ResizeObserver(schedule)
    // Portals arrive after their mounts are reported; preview DOM can also be
    // replaced without changing its dimensions. Neither requires a document edit.
    const mutations = new MutationObserver(schedule)
    mutations.observe(editor.view.dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-id', 'data-object-id', 'data-ai-block', 'class'] })
    function measure(override = preview) {
      const objects = shiftSpaceObjects(doc.objects, spaceLayoutKey.getState(editor!.state)?.shift, doc.content)
      const rect = surface.getBoundingClientRect()
      const scale = rect.width / nativeSize(surface).width
      const localTop = (element: Element) => layoutPixel((element.getBoundingClientRect().top - rect.top) / scale - surface.clientTop)
      const localLeft = (element: Element) => layoutPixel((element.getBoundingClientRect().left - rect.left) / scale - surface.clientLeft)
      const column = { left: doc.page.margins.left, width: surface.clientWidth - doc.page.margins.left - doc.page.margins.right }
      const elements = new Set<Element>([editor!.view.dom])
      const heights = new Map<string, number>()
      const notes = new Map<string, HTMLElement>()
      const sizes: Record<string, { width: number; height: number }> = {}
      surface.querySelectorAll<HTMLElement>('.floating-note').forEach(element => {
        if (element.closest('.ai-original-hidden')) return
        const size = nativeSize(element)
        notes.set(element.dataset.noteId!, element)
        heights.set(element.dataset.noteId!, size.height)
        const caption = element.querySelector<HTMLElement>('.object-caption')
        if (caption) {
          elements.add(caption)
        }
        sizes[element.dataset.noteId!] = size
        elements.add(element)
      })
      const anchors: Anchor[] = []
      const tops: Record<string, number> = {}
      const flowMounts: Record<string, HTMLElement> = {}
      const slides: SlideGeometry[] = []
      const obstacles = new Map<string, Obstacle>()
      const activate = (note: FloatingObject, anchorTop: number, anchorLeft = 0) => {
        if (note.layout.placement.type === 'flow') return
        const moving = override[note.id]
        const top = moving?.top ?? anchorTop + objectY(note)
        const left = moving?.x ?? anchorLeft + objectX(note)
        const width = moving?.width ?? note.layout.width
        tops[note.id] = top
        const height = heights.get(note.id) ?? 0
        const caption = moving?.caption ?? (supportsCaption(note) ? note.caption : undefined)
        const bounds = layoutBounds({ x: left, y: top, width, height, captionWidth: caption?.width, margins: moving?.margins ?? note.layout.margins })
        if (bounds.width > 0 && bounds.height > 0) obstacles.set(note.id, {
          left: bounds.x - gap, right: bounds.x + bounds.width + gap,
          top: Math.max(anchorTop, bounds.y - gap), bottom: bounds.y + bounds.height + gap,
        })
        else obstacles.delete(note.id)
      }
      // A dragged object has a fixed document-space position until release.
      if (!slideHeight) for (const note of objects) if (objectAnchorId(note) === null || override[note.id]?.top !== undefined) activate(note, 0)
      const originalIds: string[] = []
      editor!.state.doc.forEach(node => originalIds.push(node.attrs.id))
      const blocks: VisibleBlock[] = []
      const breaks = new Map<number, HTMLElement>()
      let slideIndex = 0
      let originalIndex = 0
      const addBlock = (element: HTMLElement, fallback?: string) => {
        if (element.classList.contains('ai-original-hidden')) return
        const ids = blockIds(element, fallback)
        if (slideHeight && element.hasAttribute('data-slide-break')) { breaks.set(++slideIndex, element); return }
        blocks.push({ element, ids, paragraph: element.classList.contains('main-paragraph'), slideIndex })
      }
      const addPreview = (preview: HTMLElement) => {
        for (const element of [...preview.children]) if (layoutBlock(element)) addBlock(element)
      }
      for (const element of [...editor!.view.dom.children]) {
        if (element.hasAttribute('data-space-preview')) { addBlock(element as HTMLElement); continue }
        if (element.matches('.ai-text-preview, .ai-segment-preview')) addPreview(element as HTMLElement)
        else if (layoutBlock(element)) {
          const fallback = originalIds[originalIndex++]
          addBlock(element, fallback)
        }
      }
      // Widget wrappers and zero-height reservation controls are not flow
      // boundaries. Resolve paragraph edge margins from visible block order.
      for (const [index, { element, paragraph }] of blocks.entries()) if (paragraph || element.hasAttribute('data-flow')) {
        const before = paragraph ? 'var(--text-spaceBefore)' : 'var(--flow-spaceBefore)'
        const after = paragraph ? 'var(--text-spaceAfter)' : 'var(--flow-spaceAfter)'
        // Page padding already supplies its margin; retain only excess style
        // spacing. Object margins stay inside the Flow mount's footprint.
        property(element, 'margin-top', index === 0 || blocks[index - 1].slideIndex !== blocks[index].slideIndex ? `max(0px, calc(${before} - var(--margin-top)))` : before)
        property(element, 'margin-bottom', index === blocks.length - 1 || blocks[index + 1].slideIndex !== blocks[index].slideIndex ? `max(0px, calc(${after} - var(--margin-bottom)))` : after)
      }
      // A spacer separates margins that would otherwise collapse to their maximum.
      const visible = new Set(blocks.map(block => block.element))
      editor!.view.dom.querySelectorAll<HTMLElement>('[data-spacer]').forEach(element => {
        if (!visible.has(element)) { element.style.removeProperty('--space-overlap'); return }
        const index = blocks.findIndex(block => block.element === element)
        const before = index > 0 && blocks[index - 1].slideIndex === blocks[index].slideIndex ? blocks[index - 1].element : undefined
        const after = index + 1 < blocks.length && blocks[index + 1].slideIndex === blocks[index].slideIndex ? blocks[index + 1].element : undefined
        const overlap = Math.min(before ? parseFloat(getComputedStyle(before).marginBottom) || 0 : 0, after ? parseFloat(getComputedStyle(after).marginTop) || 0 : 0)
        property(element, '--space-overlap', `${overlap}px`)
      })
      // Repulsion starts at the anchor: an object must not reflow preceding
      // content that establishes its own position (a cyclic layout dependency).
      // Relative offsets preserve each block's native measurement and editing DOM.
      // Reading may move a whole slide back over the preceding slide's overflow;
      // that overflow is clipped separately, never allowed to move its successor.
      const groups = slideHeight ? ranges.map(range => blocks.filter(block => block.slideIndex === range.index)) : [blocks]
      for (const [groupIndex, group] of groups.entries()) {
        const range = ranges[groupIndex]
        const slideTop = slides.at(-1) ? slides.at(-1)!.top + slides.at(-1)!.height : 0
        if (slideHeight) {
          obstacles.clear()
          if (range.id) anchors.push({ id: range.id, top: slideTop, slideIndex: groupIndex })
          const first = group[0]?.element
          const shift = first ? slideTop + doc.page.margins.top + (parseFloat(getComputedStyle(first).marginTop) || 0)
            - localTop(first) + (parseFloat(first.style.getPropertyValue('--slide-offset')) || 0) : 0
          for (const { element } of group) property(element, '--slide-offset', `${layoutPixel(shift)}px`)
          const boundary = breaks.get(groupIndex)
          if (boundary) property(boundary, '--slide-offset', `${layoutPixel(slideTop - localTop(boundary) + (parseFloat(boundary.style.getPropertyValue('--slide-offset')) || 0))}px`)
          for (const note of objects) {
            const movingTop = override[note.id]?.top
            const owner = movingTop === undefined ? objectSlideIndex(doc, note)
              : slideAtPoint(measuredSlides.current, movingTop)?.index ?? objectSlideIndex(doc, note)
            if (owner === groupIndex && (objectAnchorId(note) === null || objectAnchorId(note) === range.id || movingTop !== undefined)) activate(note, slideTop)
          }
        }
        for (const { element, ids, paragraph } of group) {
          let top = localTop(element)
          let left: number | undefined
          if (element.hasAttribute('data-flow')) {
            const id = element.dataset.objectId!
            const mount = element.querySelector<HTMLElement>('[data-flow-mount]')!
            flowMounts[id] = mount
            elements.add(mount)
            const object = objects.find(note => note.id === id)
            const target = notes.get(id)
            if (target && mount.contains(target)) {
              top = localTop(target)
              left = localLeft(target)
            } else if (object) {
              const projected = previewObjects([object], override, anchors, column.left)
              left = resolveGeometry(projected, sizes, {}, anchors, column)[id].x
            }
            tops[id] = top
          }
          // Resolve aliases for removed original blocks, but prefer the visible candidate.
          anchors.push(...ids.toReversed().map(id => ({ id, top, ...(left === undefined ? {} : { left }), ...(slideHeight && { slideIndex: groupIndex }) })))
          elements.add(element)
          for (const note of objects) if (objectAnchorId(note) !== null && ids.includes(objectAnchorId(note, doc.content)!) && override[note.id]?.top === undefined) activate(note, top, left)
          if (!paragraph) continue
          const content = element.firstElementChild as HTMLElement
          elements.add(content)
          const shape = exclusion([...obstacles.values()], top, localLeft(element), nativeSize(element).width)
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
        if (slideHeight) {
          let contentBottom = slideTop + doc.page.margins.top
          for (const { element } of group) {
            contentBottom = Math.max(contentBottom, localTop(element) + nativeSize(element).height + Math.max(0, parseFloat(getComputedStyle(element).marginBottom) || 0))
            const note = notes.get(element.dataset.objectId!)
            const object = objects.find(object => object.id === element.dataset.objectId)
            if (note && object) contentBottom = Math.max(contentBottom, localTop(note) + nativeSize(note).height + Math.max(0, object.layout.margins?.bottom ?? 0))
          }
          slides.push({ ...range, top: slideTop, savedHeight: slideHeight, contentBottom,
            height: editable ? Math.max(slideHeight, contentBottom - slideTop + doc.page.margins.bottom) : slideHeight })
        }
      }
      for (const element of observed) if (!elements.has(element)) { observer.unobserve(element); observed.delete(element) }
      for (const element of elements) if (!observed.has(element)) { observer.observe(element); observed.add(element) }
      const projectedObjects = previewObjects(objects, override, anchors, column.left)
      const geometry = resolveGeometry(projectedObjects, sizes, tops, anchors, column)
      // Clip against the owning slide, not the object's own box: captions, math,
      // and negative-margin Flow bodies may overhang that box inside the slide.
      const clip = (element: HTMLElement, slide: SlideGeometry, x = localLeft(element), y = localTop(element)) => {
        property(element, 'clip-path', `polygon(${-x}px ${slide.top - y}px, ${surface.clientWidth - x}px ${slide.top - y}px, ${surface.clientWidth - x}px ${slide.top + slide.height - y}px, ${-x}px ${slide.top + slide.height - y}px)`)
      }
      if (slideHeight) {
        const height = slides.reduce((sum, slide) => sum + slide.height, 0)
        property(surface, '--slides-height', `${height}px`)
        for (const block of blocks) if (!editable) clip(block.element, slides[block.slideIndex])
        for (const note of projectedObjects) {
          const element = notes.get(note.id), box = geometry[note.id]
          if (element && !editable && note.layout.placement.type !== 'flow') clip(element, slides[objectSlideIndex(doc, note)], box.x, box.y)
        }
      }
      if (!slideHeight || editable) surface.querySelectorAll<HTMLElement>('[style*="clip-path"]').forEach(element => {
        if (element.matches('.main-paragraph, [data-spacer], [data-flow], .floating-note')) element.style.removeProperty('clip-path')
      })
      // Only unused side margins may collapse in reading; retain every on-page object.
      let left = doc.page.margins.left, right = doc.page.width - doc.page.margins.right
      for (const note of projectedObjects) {
        const bounds = extentBounds(geometry[note.id])
        const start = bounds.x + surface.clientLeft, end = bounds.x + bounds.width + surface.clientLeft
        if (end > 0 && start < doc.page.width) { left = Math.min(left, start); right = Math.max(right, end) }
      }
      // Display math can extend beyond its author-sized box on either side.
      surface.querySelectorAll<HTMLElement>('.katex-html > .katex-base, .katex-html > .katex-tag').forEach(element => {
        const box = element.getBoundingClientRect()
        const start = (box.left - rect.left) / scale, end = (box.right - rect.left) / scale
        if (end > 0 && start < doc.page.width) { left = Math.min(left, start); right = Math.max(right, end) }
      })
      const sideInsets = slideHeight ? { left: 0, right: 0 } : { left: Math.max(0, left), right: Math.max(0, doc.page.width - right) }
      const values = { anchors, tops, geometry, sideInsets, slides, minHeight: slideHeight ? slides.reduce((sum, slide) => sum + slide.height, 0)
        : Math.max(0, ...projectedObjects.map(note => visualBottom(geometry[note.id]))) + doc.page.margins.bottom + surface.clientTop * 2 }
      const next = { ...values, flowMounts }
      measuredSlides.current = slides
      setLayout(previous => {
        const { flowMounts: previousMounts, ...previousValues } = previous
        return Object.keys(previousMounts).length === Object.keys(flowMounts).length
          && Object.entries(flowMounts).every(([id, mount]) => previousMounts[id] === mount)
          && JSON.stringify(previousValues) === JSON.stringify(values) ? previous : next
      })
      return next
    }
    measureRef.current = measure
    measure()
    editor.on('transaction', schedule)
    document.fonts.addEventListener('loadingdone', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      editor.off('transaction', schedule)
      document.fonts.removeEventListener('loadingdone', schedule)
    }
  }, [doc, editor, sheet, preview, editable])

  function attach(note: FloatingObject, placement: Placement): FloatingPatch {
    const { anchors, slides } = measureRef.current({ ...preview, [note.id]: placement })
    const slide = slideAtPoint(slides, placement.top)
    const self = new Set((doc.content.content ?? []).filter(block => block.type === 'flow' && block.attrs?.objectId === note.id).map(block => block.attrs!.id))
    const anchor = anchors.findLast(anchor => !self.has(anchor.id) && (!slide || anchor.slideIndex === slide.index) && anchor.top <= placement.top - (anchor.left === undefined ? gap : 0))
    return { x: placement.x - (anchor?.left ?? 0), y: Math.max(0, placement.top - (anchor?.top ?? slide?.top ?? 0)), anchorId: anchor?.id ?? slide?.id ?? null }
  }

  const objects = previewObjects(shiftSpaceObjects(doc.objects, editor ? spaceLayoutKey.getState(editor.state)?.shift : null, doc.content), preview, layout.anchors, doc.page.margins.left)
  const tops = Object.fromEntries(objects.map(note => [note.id, note.layout.placement.type === 'flow'
    ? layout.tops[note.id] ?? 0
    : preview[note.id]?.top ?? (layout.anchors.find(anchor => anchor.id === objectAnchorId(note))?.top ?? 0) + objectY(note)]))
  const geometry = resolveGeometry(objects, layout.geometry, tops, layout.anchors, { left: doc.page.margins.left, width: (sheet.current?.clientWidth ?? doc.page.width - 2) - doc.page.margins.left - doc.page.margins.right })
  return { ...layout, tops, geometry, reflow, attach }
}
