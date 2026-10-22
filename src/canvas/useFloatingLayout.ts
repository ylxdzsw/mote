import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { supportsCaption, shiftSpaceObjects, type FloatingObject, type FloatingPatch, type MoteDocument } from '../document/model'
import { spaceLayoutKey } from '../editor/spaces'
import { horizontalBounds, resolveGeometry, visualBottom, type Anchor, type Geometries } from './floatingGeometry'
import { nativeSize } from './measurement'

export interface Placement { x: number; top: number }
export type FloatingPreview = FloatingPatch & { top?: number }
export type FloatingPreviews = Record<string, FloatingPreview>
interface Obstacle { left: number; right: number; top: number; bottom: number }
interface Layout { anchors: Anchor[]; tops: Record<string, number>; geometry: Geometries; minHeight: number; sideInsets: { left: number; right: number }; flowMounts: Record<string, HTMLElement> }
interface VisibleBlock { element: HTMLElement; ids: string[]; paragraph: boolean }
const gap = 8
const origin: Layout = { anchors: [], tops: {}, geometry: {}, minHeight: 0, sideInsets: { left: 0, right: 0 }, flowMounts: {} }

function property(element: HTMLElement, name: string, value: string) {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value)
}

function layoutBlock(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.matches('.main-paragraph, [data-spacer], [data-flow]')
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
    const object = { ...note, ...moving } as FloatingObject
    if (moving?.x !== undefined) object.x = moving.x - (object.placement === 'flow'
      ? columnLeft : anchors.find(anchor => anchor.id === object.anchorId)?.left ?? 0)
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
    // Portals arrive after their mounts are reported; preview DOM can also be
    // replaced without changing its dimensions. Neither requires a document edit.
    const mutations = new MutationObserver(schedule)
    mutations.observe(editor.view.dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-id', 'data-object-id', 'data-ai-block', 'class'] })
    function measure(override = preview) {
      const floating = shiftSpaceObjects(doc.floating, spaceLayoutKey.getState(editor!.state)?.shift)
      const rect = surface.getBoundingClientRect()
      const scale = rect.width / nativeSize(surface).width
      const localTop = (element: Element) => (element.getBoundingClientRect().top - rect.top) / scale - surface.clientTop
      const localLeft = (element: Element) => (element.getBoundingClientRect().left - rect.left) / scale - surface.clientLeft
      const column = { left: doc.margins.left, width: surface.clientWidth - doc.margins.left - doc.margins.right }
      const elements = new Set<Element>([editor!.view.dom])
      const heights = new Map<string, number>()
      const bodyHeights = new Map<string, number>()
      const captionHeights = new Map<string, number>()
      const notes = new Map<string, HTMLElement>()
      const sizes: Record<string, { width: number; height: number }> = {}
      surface.querySelectorAll<HTMLElement>('.floating-note').forEach(element => {
        if (element.closest('.ai-original-hidden')) return
        const size = nativeSize(element)
        notes.set(element.dataset.noteId!, element)
        heights.set(element.dataset.noteId!, size.height)
        const caption = element.querySelector<HTMLElement>('.object-caption')
        if (caption) {
          bodyHeights.set(element.dataset.noteId!, nativeSize(element.querySelector<HTMLElement>('.object-body')!).height)
          captionHeights.set(element.dataset.noteId!, nativeSize(caption).height)
          elements.add(caption)
        }
        sizes[element.dataset.noteId!] = size
        elements.add(element)
      })
      const anchors: Anchor[] = []
      const tops: Record<string, number> = {}
      const flowMounts: Record<string, HTMLElement> = {}
      const obstacles: Obstacle[] = []
      const activate = (note: FloatingObject, anchorTop: number, anchorLeft = 0) => {
        if (note.placement === 'flow') return
        const moving = override[note.id]
        const top = moving?.top ?? anchorTop + note.y
        const left = moving?.x ?? anchorLeft + note.x
        const width = moving?.width ?? note.width
        tops[note.id] = top
        const height = bodyHeights.get(note.id) ?? heights.get(note.id) ?? 0
        obstacles.push({
          left: left - gap, right: left + width + gap,
          top: Math.max(anchorTop, top - gap), bottom: top + height + gap,
        })
        const caption = moving?.caption ?? (supportsCaption(note) ? note.caption : undefined)
        if (caption && captionHeights.has(note.id)) {
          const captionWidth = caption.width ?? width
          const captionLeft = left + (width - captionWidth) / 2
          obstacles.push({ left: captionLeft - gap, right: captionLeft + captionWidth + gap,
            top: top + height, bottom: top + height + 8 + captionHeights.get(note.id)! + gap })
        }
      }
      // A dragged object has a fixed document-space position until release.
      for (const note of floating) if (note.anchorId === null || override[note.id]?.top !== undefined) activate(note, 0)
      const originalIds: string[] = []
      editor!.state.doc.forEach(node => originalIds.push(node.attrs.id))
      const blocks: VisibleBlock[] = []
      let originalIndex = 0
      const addBlock = (element: HTMLElement, fallback?: string) => {
        if (element.classList.contains('ai-original-hidden')) return
        const ids = blockIds(element, fallback)
        blocks.push({ element, ids, paragraph: element.classList.contains('main-paragraph') })
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
        property(element, 'margin-top', !paragraph || index === 0 ? '0px' : 'var(--text-spaceBefore)')
        property(element, 'margin-bottom', index === blocks.length - 1 ? '0px' : paragraph ? 'var(--text-spaceAfter)' : 'var(--body-spaceAfter)')
      }
      // A spacer separates margins that would otherwise collapse to their maximum.
      const visible = new Set(blocks.map(block => block.element))
      editor!.view.dom.querySelectorAll<HTMLElement>('[data-spacer]').forEach(element => {
        if (!visible.has(element)) { element.style.removeProperty('--space-overlap'); return }
        const index = blocks.findIndex(block => block.element === element)
        const before = index > 0 ? blocks[index - 1].element : undefined
        const after = index + 1 < blocks.length ? blocks[index + 1].element : undefined
        const overlap = Math.min(before ? parseFloat(getComputedStyle(before).marginBottom) || 0 : 0, after ? parseFloat(getComputedStyle(after).marginTop) || 0 : 0)
        property(element, '--space-overlap', `${overlap}px`)
      })
      for (const { element, ids, paragraph } of blocks) {
        let top = localTop(element)
        let left: number | undefined
        if (element.hasAttribute('data-flow')) {
          const id = element.dataset.objectId!
          const mount = element.querySelector<HTMLElement>('[data-flow-mount]')!
          flowMounts[id] = mount
          elements.add(mount)
          const object = floating.find(note => note.id === id)
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
        anchors.push(...ids.toReversed().map(id => ({ id, top, ...(left === undefined ? {} : { left }) })))
        elements.add(element)
        for (const note of floating) if (note.anchorId !== null && ids.includes(note.anchorId) && override[note.id]?.top === undefined) activate(note, top, left)
        if (!paragraph) continue
        const content = element.firstElementChild as HTMLElement
        elements.add(content)
        const shape = exclusion(obstacles, top, localLeft(element), nativeSize(element).width)
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
      const objects = previewObjects(floating, override, anchors, column.left)
      const geometry = resolveGeometry(objects, sizes, tops, anchors, column)
      // Only unused side margins may collapse in reading; retain every on-page object.
      let left = doc.margins.left, right = doc.width - doc.margins.right
      for (const note of objects) {
        const bounds = horizontalBounds(geometry[note.id])
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
      const values = { anchors, tops, geometry, sideInsets, minHeight: Math.max(0, ...objects.map(note => visualBottom(geometry[note.id]))) + doc.margins.bottom + surface.clientTop * 2 }
      const next = { ...values, flowMounts }
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
  }, [doc, editor, sheet, preview])

  function attach(note: FloatingObject, placement: Placement): FloatingPatch {
    const { anchors } = measureRef.current({ ...preview, [note.id]: placement })
    const self = new Set((doc.content.content ?? []).filter(block => block.type === 'flow' && block.attrs?.objectId === note.id).map(block => block.attrs!.id))
    const anchor = anchors.findLast(anchor => !self.has(anchor.id) && anchor.top <= placement.top - (anchor.left === undefined ? gap : 0))
    return { x: placement.x - (anchor?.left ?? 0), y: Math.max(0, placement.top - (anchor?.top ?? 0)), anchorId: anchor?.id ?? null }
  }

  const objects = previewObjects(shiftSpaceObjects(doc.floating, editor ? spaceLayoutKey.getState(editor.state)?.shift : null), preview, layout.anchors, doc.margins.left)
  const tops = Object.fromEntries(objects.map(note => [note.id, note.placement === 'flow'
    ? layout.tops[note.id] ?? 0
    : preview[note.id]?.top ?? (layout.anchors.find(anchor => anchor.id === note.anchorId)?.top ?? 0) + note.y]))
  const geometry = resolveGeometry(objects, layout.geometry, tops, layout.anchors, { left: doc.margins.left, width: (sheet.current?.clientWidth ?? doc.width - 2) - doc.margins.left - doc.margins.right })
  return { ...layout, tops, geometry, reflow, attach }
}
