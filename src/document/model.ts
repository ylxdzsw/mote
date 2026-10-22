import type { JSONContent } from '@tiptap/core'
import type { SpaceMerge, SpaceShift } from '../editor/spaces'
import { objectPagePosition, placementAtPoint, reconcileFlowContent, type FlowGeometryOptions } from './flow'
import { defaultHue } from '../theme/colors'
import exampleMath from './examples/math.tex?raw'
import attentionHTML from './examples/attention.html?raw'
import attentionScreenshot from './examples/attention.png?inline'
import motionHTML from './examples/motion.html?raw'
import motionScreenshot from './examples/motion.png?inline'

export const blockClasses = ['title', 'heading', 'body', 'caption', 'list'] as const
export const themeBlockClasses = [...blockClasses, 'table', 'math', 'code'] as const
export type BlockClass = typeof blockClasses[number]
export type ThemeBlockClass = typeof themeBlockClasses[number]

export type ThemeLength = number | `${number}px` | `${number}em`

export interface BlockStyle {
  size: ThemeLength
  color: string
  family: 'sans' | 'serif' | 'mono'
  weight: number
  lineHeight: ThemeLength
  spaceBefore: ThemeLength
  spaceAfter: ThemeLength
  letterSpacing: ThemeLength
}

export interface PaletteEntry {
  id: string
  name: string
  strong: string
  soft?: string
}

export const boxDecorations = {
  info: { id: 'info', name: 'Info', strong: '#2874b8', soft: '#eaf3fc' },
  warning: { id: 'warning', name: 'Warning', strong: '#c99716', soft: '#fff5cc' },
} satisfies Record<string, PaletteEntry>
export type BoxDecoration = { kind: keyof typeof boxDecorations; color: string }

export interface Theme {
  hue: number
  autospace?: boolean
  defaults: Omit<BlockStyle, 'size'> & { size: number; background: string }
  blocks: Record<ThemeBlockClass, Partial<BlockStyle>>
  palette: PaletteEntry[]
}

export const defaultTheme: Theme = {
  hue: defaultHue,
  defaults: { family: 'sans', size: 16, color: 'ink', background: 'paper', weight: 400, lineHeight: '1.5em', spaceBefore: '0em', spaceAfter: '1em', letterSpacing: '0em' },
  blocks: {
    title: { size: '3em', color: 'ink', family: 'serif', lineHeight: '3.5em' },
    heading: { size: '1.5em', color: 'ink', lineHeight: '2em', spaceBefore: '1.5em', spaceAfter: '0.75em' },
    body: { size: '1em' },
    table: { size: '1em' },
    math: {},
    caption: { size: '0.75em', color: 'muted', lineHeight: '1.25em' },
    code: { size: '0.875em', family: 'mono', lineHeight: '1.375em' },
    list: { size: '1em', spaceAfter: '0.375em' },
  },
  palette: [
    { id: 'ink', name: 'Ink', strong: '#303830' },
    { id: 'muted', name: 'Muted', strong: '#687166' },
    { id: 'paper', name: 'Paper', strong: '#fffefa' },
    { id: 'detail', name: 'Detail', strong: '#425f87', soft: '#e8eef7' },
    { id: 'term', name: 'Term', strong: '#875a35', soft: '#f6edde' },
    { id: 'caution', name: 'Caution', strong: '#984b38', soft: '#fae9e1' },
    ...Object.values(boxDecorations),
  ],
}

interface FloatingGeometry {
  id: string
  anchorId: string | null
  x: number
  y: number
  width: number
  placement: 'flow' | 'float'
  centered?: boolean
}

export interface Caption {
  content: JSONContent
  width?: number // Native document pixels.
}

export interface FloatingText extends FloatingGeometry {
  kind?: 'text'
  content: JSONContent
  decoration?: BoxDecoration | null
  padding?: ThemeLength
  background?: string | null
  borderColor?: string | null
}

export interface FloatingTable extends FloatingGeometry {
  kind: 'table'
  content: JSONContent
  caption?: Caption
}

export interface FloatingImage extends FloatingGeometry {
  kind: 'image'
  src: string
  alt: string
  caption?: Caption
}

export interface FloatingDrawing extends FloatingGeometry {
  kind: 'drawing'
  height: number
  strokes: Array<{ points: [number, number][]; color: string; width: number }>
  labels: Array<{ x: number; y: number; text: string; color: string; size: number }>
  background: 'paper' | null
}

export interface FloatingKaTeX extends FloatingGeometry {
  kind: 'katex'
  latex: string
}

export interface FloatingCode extends FloatingGeometry {
  kind: 'code'
  source: string
  language: string
  scheme: 'light' | 'dark'
}

export interface FloatingHTMLWidget extends FloatingGeometry {
  kind: 'html'
  html: string
  screenshot: string
  alt: string
  height: number
  caption?: Caption
}
export type FloatingObject = FloatingText | FloatingTable | FloatingImage | FloatingDrawing | FloatingKaTeX | FloatingHTMLWidget | FloatingCode
export type FloatingKind = NonNullable<FloatingObject['kind']>
export const isText = (object: FloatingObject): object is FloatingText => !object.kind || object.kind === 'text'
export const supportsCaption = (object: FloatingObject): object is FloatingImage | FloatingHTMLWidget | FloatingTable =>
  object.kind === 'image' || object.kind === 'html' || object.kind === 'table'
export type FloatingPatch = Partial<Omit<FloatingGeometry, 'id'>> & {
  content?: JSONContent; src?: string; alt?: string; height?: number
  caption?: Caption | null
  latex?: string; html?: string; screenshot?: string
  source?: string; language?: string; scheme?: 'light' | 'dark'
  strokes?: FloatingDrawing['strokes']; labels?: FloatingDrawing['labels']
  background?: string | null; borderColor?: string | null; padding?: ThemeLength; decoration?: BoxDecoration | null
}

export function captionContent(text = ''): JSONContent {
  const block = paragraph(text)
  return { type: 'doc', content: [{ ...block, attrs: { id: block.attrs!.id } }] }
}

export type DocumentLanguage = 'en' | 'zh-Hans'

export interface MoteDocument {
  version: 'V0'
  id: string
  language?: DocumentLanguage
  aiModel?: string
  notes?: string | string[]
  width: number
  margins: { top: number; right: number; bottom: number; left: number }
  theme: Theme
  content: JSONContent
  floating: FloatingObject[]
}

export function paragraph(text: string, semantic: BlockClass = 'body'): JSONContent {
  return {
    type: 'paragraph',
    attrs: { id: crypto.randomUUID(), semantic },
    content: text ? [{ type: 'text', text }] : [],
  }
}

export function tableContent(rows = [['', ''], ['', '']]): JSONContent {
  return { type: 'doc', content: [{ type: 'table', content: rows.map(row => ({
    type: 'tableRow', content: row.map(text => ({ type: 'tableCell', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] })),
  })) }] }
}

const landscape = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360"><rect width="600" height="360" fill="#e8ecdf"/><circle cx="450" cy="86" r="40" fill="#d9b678"/><path d="M0 238Q145 76 320 224T600 164V360H0Z" fill="#9aaa89"/><path d="M0 292Q156 196 340 278T600 228V360H0Z" fill="#54725b"/><path d="M240 360Q410 290 330 238" fill="none" stroke="#eee5c9" stroke-width="20"/><path d="M95 285V150m0 70q-65-8-53-54 53 7 53 54m0-26q59-4 49-49-49 6-49 49" fill="#35543e" stroke="#35543e" stroke-width="5"/></svg>')}`

export function createDocument(): MoteDocument {
  const floating: FloatingObject[] = []
  const flow = (object: FloatingObject): JSONContent => {
    const id = crypto.randomUUID()
    floating.push({ ...object, placement: 'flow', anchorId: id, y: 0 })
    return { type: 'flow', attrs: { id, objectId: object.id } }
  }
  const base = (width: number) => ({ id: crypto.randomUUID(), anchorId: null, x: 0, y: 0, width, placement: 'flow' as const, centered: true })
  const image = flow({ ...base(600), kind: 'image', src: landscape, alt: 'A winding path between green hills beneath a golden sun.' })
  const imageObject = floating.find(object => object.id === image.attrs!.objectId)!
  if (supportsCaption(imageObject)) imageObject.caption = { content: captionContent('A path worth following. This caption stays with the image, and the next paragraph follows both.') }
  floating.push({ ...base(210), placement: 'float', kind: 'text', anchorId: image.attrs!.id, x: 400, y: 36,
    padding: '0.75em', background: 'paper', borderColor: 'primary',
    content: { type: 'doc', content: [paragraph('A thought on the landscape', 'caption'), paragraph('Move the image: this note follows in both directions.', 'caption')] } })
  const alongside = paragraph('Some thoughts belong beside the main thread. A Float can sit anywhere on the page while the main text uses the space to its left. It can also overlap a figure or another Float. The figure itself keeps its own place in the document.')
  floating.push({ ...base(260), placement: 'float', centered: false, anchorId: alongside.attrs!.id, x: 628, y: 8,
    padding: '1em', background: 'primary:soft', borderColor: null,
    content: { type: 'doc', content: [paragraph('A different angle', 'heading'), paragraph('Keep a question close to the passage that inspired it. 灵感随行。', 'caption')] } })
  const table = flow({ ...base(894), kind: 'table', content: tableContent([
    ['Content', 'Placement', 'What moves with it'],
    ['Figure, table, code, widget', 'Flow — its own vertical space', 'Owner caption (when supported) and anchored notes'],
    ['Side note or annotation', 'Float — positioned on the page', 'Its own text content'],
    ['A composed section', 'Select it in the left gutter', 'Text, spaces, and owned objects'],
  ]), caption: { content: captionContent('A compact comparison of Flow, Float, and the objects that travel together.') } })
  const drawing = flow({ ...base(640), kind: 'drawing', height: 220, background: null,
    strokes: [
      { color: 'primary', width: 3, points: [[44, 155], [63, 126], [89, 145], [119, 98], [147, 116], [177, 65], [207, 92], [242, 48], [270, 74]] },
      { color: 'detail', width: 3, points: [[340, 125], [366, 102], [396, 108], [424, 72], [457, 86], [485, 52], [521, 63], [557, 36]] },
      { color: 'muted', width: 2, points: [[295, 102], [324, 102], [316, 94], [324, 102], [316, 110]] },
    ], labels: [{ x: 48, y: 190, text: 'Sketch the thought', color: 'ink', size: 18 }, { x: 356, y: 190, text: 'Refine it with Assistant', color: 'ink', size: 18 }] })
  const formula = flow({ ...base(800), kind: 'katex', latex: exampleMath.trim() })
  const code = flow({ ...base(760), kind: 'code', language: 'javascript', scheme: 'light',
    source: '// Give each thought a place.\nconst workspace = {\n  write: "Follow the thread",\n  flow: "Make room for a figure",\n  float: "Keep a question nearby",\n}\nconsole.log(workspace.flow)' })
  const attention = flow({ ...base(780), kind: 'html', height: 400, html: attentionHTML, screenshot: attentionScreenshot,
    alt: 'A week of attention: interactive reading, writing, and exploring chart with a measure selector.',
    caption: { content: captionContent('A week of attention, with a measure selector for exploring the chart.') } })
  const motion = flow({ ...base(780), kind: 'html', height: 400, html: motionHTML, screenshot: motionScreenshot,
    alt: 'Ideas in motion: animated ranking of five ideas by reader votes, with play, pause, and next-pass controls.',
    caption: { content: captionContent('Five ideas trade places as votes arrive.') } })
  return {
    version: 'V0', id: crypto.randomUUID(), width: 960,
    margins: { top: 48, right: 32, bottom: 48, left: 32 }, theme: structuredClone(defaultTheme),
    content: { type: 'doc', content: [
      paragraph('A little room to think.', 'title'),
      paragraph('One continuous page, two ways to place an idea.', 'caption'),
      { ...paragraph(''), content: [
        { type: 'text', text: 'Write naturally. Give a figure its own place in the ' },
        { type: 'text', text: 'Flow', marks: [{ type: 'bold' }, { type: 'color', attrs: { color: 'primary' } }] },
        { type: 'text', text: ', or let a thought ' },
        { type: 'text', text: 'Float', marks: [{ type: 'color', attrs: { color: 'detail' } }, { type: 'decoration', attrs: { decoration: 'underline' } }] },
        { type: 'text', text: ' beside it. Leave ' },
        { type: 'text', text: 'a little space — 一点留白', marks: [{ type: 'color', attrs: { color: 'primary' } }, { type: 'decoration', attrs: { decoration: 'box' } }] },
        { type: 'text', text: ' for what comes next.' },
      ] },
      paragraph('A figure in the flow', 'heading'),
      paragraph('This image takes its own vertical space. Add text above it and everything below follows. Drag it sideways to position it, snap it to the center, or drag it between paragraphs to change its place.'),
      image,
      paragraph('The small note overlaps the image and is anchored to it. The caption belongs to the figure; both travel with it when you move or copy its segment.'),
      paragraph('A thought alongside the text', 'heading'), alongside,
      paragraph('Placement is separate from content. Select an object and switch between Flow and Float in Context. Tables, drawings, formulas, code, and widgets share the same choice.'),
      paragraph('Structure you can move', 'heading'),
      paragraph('Drag in the left gutter to select a section, then move, copy, or cut it as a unit. A Flow object is a whole block; its caption, when supported, and anchored notes come along.'), table,
      paragraph('Start with a sketch', 'heading'),
      paragraph('Open the drawing to add strokes, erase, or leave labels. Ask Assistant to turn a rough sketch into a finished figure, then review the candidate on the page.'), drawing,
      paragraph('A little mathematical language', 'heading'),
      paragraph('Formulas keep their LaTeX source and use the document’s Math style. Their measured height makes room for the next block.'), formula,
      paragraph('Keep the source nearby', 'heading'),
      paragraph('Code has line numbers, syntax colors, and an exact-source Copy action. Its height follows the source; long lines scroll horizontally.'), code,
      paragraph('Let the reader explore', 'heading'),
      paragraph('Change the measure, filter a series, or click a bar. This HTML widget combines an interactive chart with a small detail view.'), attention,
      paragraph('Select a widget to interact in editing mode, or use it directly in reading mode. These charts load ECharts from a CDN. Saved screenshots appear in the minimap and PNG export.'),
      paragraph('Make change visible', 'heading'),
      paragraph('Watch five ideas trade places as votes arrive. Pause to look closer, or use Next pass to move at your own pace.'), motion,
      paragraph('Leave room for the next thought', 'heading'),
      paragraph('This is explicit vertical space. Hold Alt near a boundary to add or resize a pause; Flow objects already make room for themselves.'),
      { type: 'spacer', attrs: { id: crypto.randomUUID(), height: 96 } },
      paragraph('Your workspace, your document', 'heading'),
      paragraph('The title opens Files. Changes save locally and sync to the cloud; click the sync indicator or press Ctrl/⌘S to sync now. Settings brings document typography, workspace preferences, and browser settings together.'),
      paragraph('Use Share to create a reading link or export .mote, standalone HTML, or a high-resolution PNG. A Private document still allows local export. Assistant is available in its own tab beside Context.'),
      paragraph('Keep what helps you think. Leave a little room for what comes next.', 'caption'),
    ] }, floating,
  }
}

export function shiftSpaceObjects(objects: FloatingObject[], shift?: SpaceShift | null): FloatingObject[] {
  if (!shift) return objects
  const flowAnchors = new Set(objects.filter(object => object.placement === 'flow').map(object => object.anchorId))
  // Later anchors already move with the text flow; only earlier anchors need offsets.
  function move<T extends { anchorId: string | null; y: number }>(point: T): T {
    const anchor = shift!.anchors.find(anchor => anchor.id === point.anchorId)
    const y = anchor && anchor.top + point.y >= shift!.from ? Math.max(0, point.y + shift!.delta) : point.y
    const removed = shift!.removed
    if (removed && point.anchorId === removed.id) return { ...point, anchorId: removed.anchorId, y: y + removed.offset }
    return y === point.y ? point : { ...point, y }
  }
  return objects.map(object => object.placement === 'flow' || flowAnchors.has(object.anchorId) ? object : move(object))
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
  const floating = shiftSpaceObjects(reconciled.floating, shift).map(note => {
    if (note.placement === 'flow') return note
    if (reconciled.floating.some(object => object.placement === 'flow' && object.anchorId === note.anchorId)) return note
    const { anchorId, y } = remap(note)
    if (anchorId !== note.anchorId && reconciled.floating.some(object => object.placement === 'flow' && object.anchorId === anchorId)) {
      return { ...note, ...placementAtPoint(reconciled, objectPagePosition(doc, note, geometry), anchorId, geometry) }
    }
    return anchorId === note.anchorId && y === note.y ? note : { ...note, anchorId, y }
  })
  return { ...doc, content, floating }
}
