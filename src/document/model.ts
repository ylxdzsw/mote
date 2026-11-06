import type { JSONContent } from '@tiptap/core'
import type { SpaceMerge, SpaceShift } from '../editor/spaces'
import { objectPagePosition, placementAtPoint, reconcileFlowContent, type FlowGeometryOptions } from './flow'
import { defaultHue, defaultSecondaryHue } from '../theme/colors'
import { createExampleDocument, type ExampleOptions } from './examples'

export const blockClasses = ['title', 'heading', 'subheading', 'body', 'caption', 'list'] as const
export const themeBlockClasses = [...blockClasses, 'table', 'formula', 'code'] as const
export type BlockClass = typeof blockClasses[number]
export type ThemeBlockClass = typeof themeBlockClasses[number]

export interface ThemeLength { value: number; unit: 'px' | 'em' }
export type LineHeight = ThemeLength | { value: number; unit: 'ratio' }
export interface BlockStyle {
  size: ThemeLength
  color: string
  family: 'sans' | 'serif' | 'mono'
  weight: number
  lineHeight: LineHeight
  spaceBefore: ThemeLength
  spaceAfter: ThemeLength
  letterSpacing: ThemeLength
}
export const em = (value: number): ThemeLength => ({ value, unit: 'em' })
export const px = (value: number): ThemeLength => ({ value, unit: 'px' })
export const defaultSubheadingStyle: Partial<BlockStyle> = {
  size: em(1.125), weight: 700, lineHeight: em(1.5), spaceBefore: em(1.5),
}
export const boxDecorationKinds = ['left', 'box'] as const
export type BoxDecoration = { kind: typeof boxDecorationKinds[number]; color: string }
export interface Theme {
  appearance: { mode: 'light' | 'dark'; primaryHue: number; secondaryHue: number }
  autospace: boolean
  flow: { spaceBefore?: ThemeLength; spaceAfter?: ThemeLength }
  defaults: Omit<BlockStyle, 'size'> & { size: number }
  paragraphs: Partial<Record<BlockClass, Partial<BlockStyle>>>
  objects: { table?: Partial<BlockStyle>; code?: Partial<Pick<BlockStyle, 'size' | 'weight' | 'lineHeight' | 'letterSpacing'>>; formula?: Partial<Pick<BlockStyle, 'size' | 'color'>> }
}
export const defaultTheme: Theme = {
  appearance: { mode: 'light', primaryHue: defaultHue, secondaryHue: defaultSecondaryHue }, autospace: true,
  flow: { spaceBefore: em(1.5), spaceAfter: em(1.5) },
  defaults: { family: 'sans', size: 16, color: 'gray2', weight: 400, lineHeight: em(1.5), spaceBefore: em(1), spaceAfter: em(1), letterSpacing: px(0) },
  paragraphs: {
    title: { size: em(2.5), color: 'gray2', weight: 700, lineHeight: em(3.5), spaceBefore: em(3), spaceAfter: em(3) },
    heading: { size: em(1.5), color: 'gray2', weight: 700, lineHeight: em(2), spaceBefore: em(2), spaceAfter: em(1.5) },
    subheading: defaultSubheadingStyle,
    body: { size: em(1) }, caption: { size: em(.75), color: 'gray3', lineHeight: em(1.25) },
    list: { size: em(1), spaceBefore: em(.375), spaceAfter: em(.375) },
  },
  objects: { table: { size: em(1) }, formula: {}, code: { size: em(.875), lineHeight: em(1.375) } },
}
export type Margins = { top: number; right: number; bottom: number; left: number }
export type ObjectPlacement = { type: 'flow'; x: number | 'center' } | { type: 'float'; anchorId: string | null; x: number; y: number }
export interface ObjectLayout { width: number; height?: number; margins?: Margins; placement: ObjectPlacement }
interface FloatingGeometry<L extends ObjectLayout = ObjectLayout & { height?: never }> { id: string; layout: L }

export interface Caption {
  content: JSONContent
  width?: number // Native document pixels.
}

export interface FloatingText extends FloatingGeometry {
  kind: 'text'
  content: JSONContent
  decoration?: BoxDecoration
  padding?: ThemeLength
}

export const tableStyles = ['simple', 'academic', 'business'] as const
export type TableStyle = typeof tableStyles[number]

export interface FloatingTable extends FloatingGeometry {
  kind: 'table'
  content: JSONContent
  style?: TableStyle // Omitted means simple.
  headerRow?: boolean
  color?: string // Strong/Soft pair; omitted preserves the style's default.
  caption?: Caption
}

export interface FloatingImage extends FloatingGeometry {
  kind: 'image'
  src: string
  alt: string
  caption?: Caption
  markup?: ObjectMarkup
}

export interface FloatingDrawing extends FloatingGeometry<ObjectLayout & { height: number }> {
  kind: 'drawing'
  layout: ObjectLayout & { height: number }
  strokes: Array<{ points: [number, number][]; color: string; width: number }>
  labels: Array<{ x: number; y: number; text: string; color: string; size: number }>
  background: 'gray6' | null
}

export interface ObjectMarkup {
  width: number
  height: number
  strokes: FloatingDrawing['strokes']
  labels: FloatingDrawing['labels']
}

export interface FloatingFormula extends FloatingGeometry {
  kind: 'formula'
  latex: string
}

export interface FloatingCode extends FloatingGeometry {
  kind: 'code'
  source: string
  language: string
}

export interface FloatingHTMLWidget extends FloatingGeometry<ObjectLayout & { height: number }> {
  kind: 'html'
  html: string
  screenshot: string
  alt: string
  layout: ObjectLayout & { height: number }
  caption?: Caption
  markup?: ObjectMarkup
}
export type FloatingObject = FloatingText | FloatingTable | FloatingImage | FloatingDrawing | FloatingFormula | FloatingHTMLWidget | FloatingCode
export const isText = (object: FloatingObject): object is FloatingText => object.kind === 'text'
export const supportsCaption = (object: FloatingObject): object is FloatingImage | FloatingHTMLWidget | FloatingTable =>
  object.kind === 'image' || object.kind === 'html' || object.kind === 'table'
export const supportsMarkup = (object: FloatingObject): object is FloatingImage | FloatingHTMLWidget =>
  object.kind === 'image' || object.kind === 'html'
export type FloatingPatch = Partial<{ anchorId: string | null; x: number; y: number; width: number; placement: 'flow' | 'float'; centered: boolean; margins: Margins }> & {
  content?: JSONContent; src?: string; alt?: string; height?: number
  caption?: Caption | null
  markup?: ObjectMarkup | null
  latex?: string; html?: string; screenshot?: string
  source?: string; language?: string
  style?: TableStyle; headerRow?: boolean; color?: string
  strokes?: FloatingDrawing['strokes']; labels?: FloatingDrawing['labels']
  background?: string | null; padding?: ThemeLength; decoration?: BoxDecoration | null
}

export function captionContent(text = ''): JSONContent {
  const block = paragraph(text)
  return { type: 'doc', content: [{ ...block, attrs: { id: block.attrs!.id } }] }
}

export type DocumentLanguage = 'en' | 'zh-Hans'

export interface MoteDocument {
  format: 'mote'
  version: 1 | 2 | 3 | 4 | 5
  id: string
  language: DocumentLanguage
  page: { width: number; margins: Margins; slideHeight?: number }
  theme: Theme
  content: JSONContent
  objects: FloatingObject[]
  authoring?: { notes: string[]; aiModel?: string }
}

// Geometry commands are transient; native objects store only layout.
export function objectX(object: FloatingObject): number { return object.layout.placement.x === 'center' ? 0 : object.layout.placement.x }
export function objectY(object: FloatingObject): number { return object.layout.placement.type === 'float' ? object.layout.placement.y : 0 }
export function objectAnchorId(object: FloatingObject, content?: JSONContent): string | null {
  return object.layout.placement.type === 'float' ? object.layout.placement.anchorId
    : content?.content?.find(block => block.type === 'flow' && block.attrs?.objectId === object.id)?.attrs?.id ?? null
}
export function patchObject<T extends FloatingObject>(object: T, patch: FloatingPatch): T {
  const { width, height, margins, placement, centered, anchorId, x, y, caption, markup, decoration, ...body } = patch
  const old = object.layout.placement
  const type = placement ?? old.type
  const position: ObjectPlacement = type === 'flow'
    ? { type, x: centered === true ? 'center' : centered === false ? x ?? objectX(object) : x ?? old.x }
    : { type, anchorId: anchorId === undefined ? objectAnchorId(object) : anchorId, x: x ?? objectX(object), y: y ?? objectY(object) }
  const next = { ...object, ...body, layout: { ...object.layout, placement: position,
    ...(width !== undefined && { width }), ...(height !== undefined && { height }), ...(margins !== undefined && { margins }) } } as T
  if (caption !== undefined && supportsCaption(next)) { if (caption === null) delete next.caption; else next.caption = caption }
  if (markup !== undefined && supportsMarkup(next)) { if (markup === null) delete next.markup; else next.markup = markup }
  if (decoration !== undefined && isText(next)) { if (decoration === null) delete next.decoration; else next.decoration = decoration }
  return next
}

export function paragraph(text: string, semantic: BlockClass = 'body'): JSONContent {
  return {
    type: 'paragraph',
    attrs: { id: crypto.randomUUID(), semantic, ...(semantic === 'list' && { listLevel: 0 }) },
    content: text ? [{ type: 'text', text }] : [],
  }
}

export function tableContent(rows = [['', ''], ['', '']]): JSONContent {
  return { type: 'doc', content: [{ type: 'table', content: rows.map(row => ({
    type: 'tableRow', content: row.map(text => ({ type: 'tableCell', content: [{ type: 'paragraph', attrs: { id: crypto.randomUUID() }, content: text ? [{ type: 'text', text }] : [] }] })),
  })) }] }
}

export function createBlankDocument(): MoteDocument {
  return { format: 'mote', version: 5, id: crypto.randomUUID(), language: 'en', page: { width: 960,
    margins: { top: 48, right: 32, bottom: 48, left: 32 } }, theme: structuredClone(defaultTheme),
    content: { type: 'doc', content: [paragraph('')] }, objects: [] }
}

export function isPristineBlankDocument(document: MoteDocument, defaults = { mode: defaultTheme.appearance.mode, language: 'en' as DocumentLanguage }) {
  const block = document.content.content?.[0]
  return document.objects.length === 0 && document.content.content?.length === 1 && block?.type === 'paragraph'
    && !block.content?.length && (!block.attrs?.semantic || block.attrs.semantic === 'body') && !block.attrs?.listLevel
    && !document.authoring?.notes.some(note => note.length)
    && (document.language ?? 'en') === defaults.language && !document.authoring?.aiModel?.trim()
    && document.page.slideHeight === undefined && document.page.width === 960 && document.page.margins.top === 48 && document.page.margins.bottom === 48
    && document.page.margins.left === 32 && document.page.margins.right === 32
    && document.theme.autospace !== false
    && JSON.stringify(document.theme) === JSON.stringify({ ...defaultTheme, appearance: { ...defaultTheme.appearance, mode: defaults.mode } })
}

export function createDocument(options: ExampleOptions = {}): MoteDocument {
  return createExampleDocument(options)
}

export function shiftSpaceObjects(objects: FloatingObject[], shift?: SpaceShift | null, content?: JSONContent): FloatingObject[] {
  if (!shift) return objects
  const flowAnchors = new Set(objects.filter(object => object.layout.placement.type === 'flow').map(object => objectAnchorId(object, content)))
  const anchors = new Map<SpaceShift['anchors'][number]['id'], SpaceShift['anchors'][number]>()
  for (const anchor of shift.anchors) if (!anchors.has(anchor.id)) anchors.set(anchor.id, anchor)
  // Later anchors already move with the text flow; only earlier anchors need offsets.
  function move<T extends { anchorId: string | null; y: number }>(point: T): T {
    const anchor = anchors.get(point.anchorId)
    const y = anchor && anchor.top + point.y >= shift!.from ? Math.max(0, point.y + shift!.delta) : point.y
    const removed = shift!.removed
    if (removed && point.anchorId === removed.id) return { ...point, anchorId: removed.anchorId, y: y + removed.offset }
    return y === point.y ? point : { ...point, y }
  }
  return objects.map(object => object.layout.placement.type === 'flow' || flowAnchors.has(objectAnchorId(object)) ? object : patchObject(object, move({ anchorId: objectAnchorId(object), y: objectY(object) })))
}

// Keep notes when their anchor is removed: prefer the nearest surviving predecessor.
export function replaceMainContent(doc: MoteDocument, content: JSONContent, merges: SpaceMerge[] = [], shift?: SpaceShift, geometry?: FlowGeometryOptions): MoteDocument {
  const oldIds = doc.content.content!.map(node => node.attrs!.id as string)
  const newIds = content.content!.map(node => node.attrs!.id as string)
  function survivingAnchor(anchorId: string | null) {
    if (anchorId === null || newIds.includes(anchorId)) return anchorId
    return oldIds.slice(0, oldIds.indexOf(anchorId)).reverse().find(id => newIds.includes(id)) ?? null
  }
  function remap(point: { anchorId: string | null; y: number }) {
    const merge = point.anchorId === null ? undefined : merges.find(merge => merge.id === point.anchorId)
    return { anchorId: merge?.anchorId ?? survivingAnchor(point.anchorId), y: Math.max(0, point.y + (merge?.offset ?? 0)) }
  }
  const reconciled = reconcileFlowContent(doc, content, geometry)
  const objects = shiftSpaceObjects(reconciled.objects, shift, content).map(note => {
    if (note.layout.placement.type === 'flow') return note
    if (reconciled.objects.some(object => object.layout.placement.type === 'flow' && objectAnchorId(object, content) === objectAnchorId(note))) return note
    const { anchorId, y } = remap({ anchorId: objectAnchorId(note), y: objectY(note) })
    if (anchorId !== objectAnchorId(note) && reconciled.objects.some(object => object.layout.placement.type === 'flow' && objectAnchorId(object, content) === anchorId)) {
      return patchObject(note, placementAtPoint(reconciled, objectPagePosition(doc, note, geometry), anchorId, geometry))
    }
    return anchorId === objectAnchorId(note) && y === objectY(note) ? note : patchObject(note, { anchorId, y })
  })
  return { ...doc, content, objects }
}
