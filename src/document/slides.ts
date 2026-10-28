import type { JSONContent } from '@tiptap/core'
import { objectAnchorId, paragraph, patchObject, supportsCaption, type FloatingObject, type MoteDocument, type ThemeLength } from './model'
import type { Geometries } from '../canvas/floatingGeometry'

export const DEFAULT_SLIDE_HEIGHT = 540
export interface SlideRange { index: number; start: number; end: number; id: string | null }
export interface SlideContext {
  anchors: readonly { id: string; top: number; bottom?: number }[]
  geometry: Geometries
}

const blocksOf = (doc: MoteDocument) => doc.content.content ?? []
const marker = (): JSONContent => ({ type: 'slideBreak', attrs: { id: crypto.randomUUID() } })

/** Block ranges are half-open. A boundary belongs to the slide it starts. */
export function slideRanges(doc: MoteDocument): SlideRange[] {
  const blocks = blocksOf(doc)
  const ranges: SlideRange[] = [{ index: 0, start: 0, end: blocks.length, id: null }]
  if (doc.page.slideHeight === undefined) return ranges
  blocks.forEach((block, index) => {
    if (block.type !== 'slideBreak') return
    ranges.at(-1)!.end = index
    ranges.push({ index: ranges.length, start: index, end: blocks.length, id: block.attrs!.id })
  })
  return ranges
}

export function slideAtIndex(doc: MoteDocument, index: number): SlideRange {
  const ranges = slideRanges(doc)
  return ranges.findLast(range => range.start <= index) ?? ranges[0]
}

export function objectSlideIndex(doc: MoteDocument, object: FloatingObject): number {
  const anchor = objectAnchorId(object, doc.content)
  return anchor === null ? 0 : slideAtIndex(doc, blocksOf(doc).findIndex(block => block.attrs?.id === anchor)).index
}

export function filledSlides(blocks: JSONContent[]): JSONContent[] {
  const result: JSONContent[] = []
  let empty = true
  for (const block of blocks) {
    if (block.type === 'slideBreak') {
      if (empty) result.push(paragraph(''))
      empty = true
    } else empty = false
    result.push(block)
  }
  if (empty) result.push(paragraph(''))
  return result
}

interface BlockSize { height: number; before: number; after: number }
interface BlockBox extends BlockSize { top: number; bottom: number }

// Estimates are only for explicit mode conversion, never saved layout or rendering.
function sizes(doc: MoteDocument, context?: SlideContext) {
  const base = doc.theme.defaults.size
  const length = (value: ThemeLength) => value.value * (value.unit === 'em' ? base : 1)
  const textSize = (block: JSONContent, width: number, semantic = block.attrs?.semantic ?? 'body'): BlockSize => {
    const style = { ...doc.theme.defaults, ...doc.theme.paragraphs[semantic as keyof typeof doc.theme.paragraphs] }
    const size = typeof style.size === 'number' ? style.size : length(style.size)
    const line = style.lineHeight.unit === 'ratio' ? style.lineHeight.value * size : length(style.lineHeight)
    const text = (block.content ?? []).map(node => node.type === 'hardBreak' ? '\n' : node.text ?? '').join('')
    const columns = Math.max(1, width / (size * .55))
    const lines = text.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / columns)), 0)
    return { height: lines * line, before: length(style.spaceBefore), after: length(style.spaceAfter) }
  }
  const objects = new Map(doc.objects.map(object => [object.id, object]))
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  return (block: JSONContent): BlockSize => {
    if (block.type === 'spacer') return { height: block.attrs!.height, before: 0, after: 0 }
    if (block.type === 'slideBreak') return { height: 0, before: 0, after: 0 }
    if (block.type !== 'flow') return textSize(block, width)
    const object = objects.get(block.attrs!.objectId)!
    const geometry = context?.geometry[object.id]
    let height = geometry?.height ?? object.layout.height
    if (height === undefined) {
      if (object.kind === 'text') height = (object.content.content ?? []).reduce((sum, p) => {
        const size = textSize(p, object.layout.width)
        return sum + size.height + size.before + size.after
      }, 0)
      else if (object.kind === 'table') height = (object.content.content?.[0].content?.length ?? 1) * base * 2.5
      else if (object.kind === 'code') height = object.source.split('\n').length * base * 1.375 + 24
      else height = object.kind === 'image' ? object.layout.width * .6 : base * 3
    }
    if (geometry?.height === undefined && supportsCaption(object) && object.caption) {
      const caption = textSize(object.caption.content.content![0], object.caption.width ?? object.layout.width, 'caption')
      height += caption.height + caption.before + caption.after
    }
    const margins = object.layout.margins
    return { height: Math.max(0, height + (margins?.top ?? 0) + (margins?.bottom ?? 0)),
      before: length(doc.theme.flow.spaceBefore ?? { value: 0, unit: 'px' }),
      after: length(doc.theme.flow.spaceAfter ?? doc.theme.paragraphs.body?.spaceAfter ?? doc.theme.defaults.spaceAfter) }
  }
}

function boxes(doc: MoteDocument, context?: SlideContext, positioned = true): Map<string, BlockBox> {
  const sizeOf = sizes(doc, context)
  const anchors = new Map(context?.anchors.map(anchor => [anchor.id, anchor]))
  const result = new Map<string, BlockBox>()
  let bottom = 0, after = doc.page.margins.top
  for (const block of blocksOf(doc)) {
    const size = sizeOf(block)
    const measured = anchors.get(block.attrs!.id)
    const top = positioned && measured ? measured.top : bottom + Math.max(after, size.before)
    const end = top + (measured?.bottom === undefined ? size.height : measured.bottom - measured.top)
    result.set(block.attrs!.id, { ...size, top, bottom: end, height: Math.max(0, end - top) })
    bottom = end
    after = size.after
  }
  return result
}

function firstBlock(doc: MoteDocument, range: SlideRange) {
  return blocksOf(doc)[range.start + (range.id === null ? 0 : 1)]
}

function inset(doc: MoteDocument, box: BlockBox) { return Math.max(doc.page.margins.top, box.before) }

/** Enabling partitions once; changing the height of an existing slide document does not. */
export function setSlides(doc: MoteDocument, enabled: boolean, height = DEFAULT_SLIDE_HEIGHT, context?: SlideContext): MoteDocument {
  if (!enabled) {
    if (doc.page.slideHeight === undefined) return doc
    const ranges = slideRanges(doc)
    const { slideHeight: _height, ...page } = doc.page
    const content = { ...doc.content, content: blocksOf(doc).filter(block => block.type !== 'slideBreak') }
    const next = { ...doc, page, content }
    const continuous = boxes(next, context, false)
    const measured = new Map(context?.anchors.map(anchor => [anchor.id, anchor.top]))
    const offsets = new Map(ranges.filter(range => range.id !== null).map(range => {
      const first = firstBlock(doc, range), box = continuous.get(first.attrs!.id)!
      const firstTop = measured.get(first.attrs!.id), slideTop = measured.get(range.id!)
      const localTop = firstTop !== undefined && slideTop !== undefined ? firstTop - slideTop : inset(doc, box)
      return [range.id, box.top - localTop] as const
    }))
    return { ...next, objects: doc.objects.map(object => {
      const placement = object.layout.placement
      if (placement.type !== 'float' || placement.anchorId === null || !offsets.has(placement.anchorId)) return object
      return patchObject(object, { anchorId: null, y: Math.max(0, placement.y + offsets.get(placement.anchorId)!) })
    }) }
  }
  if (!Number.isFinite(height) || height <= 0) throw new RangeError('Slide height must be a positive finite number.')
  const next: MoteDocument = { ...doc, version: 2, page: { ...doc.page, slideHeight: height } }
  if (doc.page.slideHeight !== undefined) return next
  const measured = boxes(doc, context)
  const content: JSONContent[] = []
  const origins: { id: string | null; top: number }[] = [{ id: null, top: 0 }]
  let used = 0, after = doc.page.margins.top, previous: BlockBox | undefined, hasContent = false
  for (const block of blocksOf(doc)) {
    const box = measured.get(block.attrs!.id)!
    const gap = previous ? Math.max(0, box.top - previous.bottom) : Math.max(after, box.before)
    const heading = block.type === 'paragraph' && ['title', 'heading'].includes(block.attrs!.semantic)
    if (hasContent && (heading || used + gap + box.height + doc.page.margins.bottom > height)) {
      const boundary = marker()
      content.push(boundary)
      origins.push({ id: boundary.attrs!.id, top: box.top - inset(doc, box) })
      used = inset(doc, box)
    } else used += gap
    content.push(block)
    used += box.height
    after = box.after
    previous = box
    hasContent = block.type !== 'paragraph' || heading || !!block.content?.length || hasContent
  }
  next.content = { ...doc.content, content: filledSlides(content) }
  // Paragraph/Flow anchors already encode ownership and preserve their local
  // offsets. Only document-top Floats need associating with a newly made slide.
  next.objects = doc.objects.map(object => {
    const placement = object.layout.placement
    if (placement.type !== 'float' || placement.anchorId !== null) return object
    const y = context?.geometry[object.id]?.y ?? placement.y
    const origin = origins.findLast(origin => origin.top <= y) ?? origins[0]
    return origin.id === null ? object : patchObject(object, { anchorId: origin.id, y: Math.max(0, y - origin.top) })
  })
  return next
}

/** Insert before a block; at either edge, retain a writable empty slide. */
export function insertSlideBreak(doc: MoteDocument, index: number): MoteDocument {
  const blocks = blocksOf(doc)
  index = Math.max(0, Math.min(blocks.length, Math.trunc(index)))
  const boundary = marker()
  const range = slideAtIndex(doc, index)
  const localDoc = { ...doc, content: { ...doc.content, content: blocks.slice(range.start + (range.id === null ? 0 : 1), range.end) } }
  const local = boxes(localDoc)
  const split = blocks[index]
  const splitBox = split && local.get(split.attrs!.id)
  const offset = splitBox ? Math.max(0, splitBox.top - inset(doc, splitBox)) : Infinity
  return { ...doc, version: 2, page: { ...doc.page, slideHeight: doc.page.slideHeight ?? DEFAULT_SLIDE_HEIGHT },
    content: { ...doc.content, content: filledSlides([...blocks.slice(0, index), boundary, ...blocks.slice(index)]) },
    objects: doc.objects.map(object => {
      const placement = object.layout.placement
      if (placement.type !== 'float' || placement.anchorId !== range.id || placement.y < offset) return object
      return patchObject(object, { anchorId: boundary.attrs!.id, y: placement.y - offset })
    }) }
}

/** Join a slide to its predecessor, retaining all blocks, objects and captions. */
export function joinSlide(doc: MoteDocument, slideIndex: number): MoteDocument {
  const ranges = slideRanges(doc), range = ranges[slideIndex], previous = ranges[slideIndex - 1]
  if (!range || !previous) return doc
  const blocks = blocksOf(doc)
  const joined = blocks.slice(previous.start + (previous.id === null ? 0 : 1), range.end).filter(block => block.attrs?.id !== range.id)
  const local = boxes({ ...doc, content: { ...doc.content, content: joined } })
  const box = local.get(firstBlock(doc, range).attrs!.id)!
  const offset = box.top - inset(doc, box)
  return { ...doc, content: { ...doc.content, content: blocks.filter(block => block.attrs?.id !== range.id) },
    objects: doc.objects.map(object => {
      const placement = object.layout.placement
      return placement.type === 'float' && placement.anchorId === range.id
        ? patchObject(object, { anchorId: previous.id, y: Math.max(0, placement.y + offset) }) : object
    }) }
}
