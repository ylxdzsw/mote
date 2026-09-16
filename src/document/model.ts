import type { JSONContent } from '@tiptap/core'
import type { SpaceMerge, SpaceShift } from '../editor/spaces'
import exampleMath from './examples/math.tex?raw'
import attentionHTML from './examples/attention.html?raw'
import attentionScreenshot from './examples/attention.png?inline'
import motionHTML from './examples/motion.html?raw'
import motionScreenshot from './examples/motion.png?inline'

export const blockClasses = ['title', 'heading', 'body', 'caption', 'code', 'list'] as const
export const themeBlockClasses = [...blockClasses, 'table', 'label', 'math'] as const
export const inlineClasses = ['primary', 'secondary', 'bold', 'term'] as const
export type BlockClass = typeof blockClasses[number]
export type ThemeBlockClass = typeof themeBlockClasses[number]
export type InlineClass = typeof inlineClasses[number]

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

export interface PhraseStyle {
  color: string
  background: string
  weight: number
  italic: boolean
  decoration: 'none' | 'underline' | 'line-through'
}

export interface Theme {
  defaults: Omit<BlockStyle, 'size'> & { size: number; background: string }
  blocks: Record<ThemeBlockClass, Partial<BlockStyle>>
  inline: Record<InlineClass, Partial<PhraseStyle>>
}

export const defaultTheme: Theme = {
  defaults: { family: 'sans', size: 16, color: '#414841', background: '#fffefa', weight: 400, lineHeight: '1.5em', spaceBefore: '0em', spaceAfter: '1em', letterSpacing: '0em' },
  blocks: {
    title: { size: '3em', color: '#262b27', family: 'serif', lineHeight: '3.5em', letterSpacing: '-0.1em' },
    heading: { size: '1.5em', color: '#262b27', family: 'serif', lineHeight: '2em', spaceBefore: '1.5em', spaceAfter: '0.75em', letterSpacing: '-0.025em' },
    body: { size: '1em' },
    table: { size: '1em' },
    label: { size: '1em' },
    math: {},
    caption: { size: '0.75em', color: '#737b72', lineHeight: '1.25em' },
    code: { family: 'mono', size: '0.875em', lineHeight: '1.375em' },
    list: { size: '1em', spaceAfter: '0.375em' },
  },
  inline: {
    primary: { color: '#355b43', background: '#e9efdf' },
    secondary: { color: '#425f87', background: '#e8eef7' },
    bold: { weight: 700 },
    term: { color: '#875a35', background: '#f6edde' },
  },
}

interface FloatingGeometry {
  id: string
  anchorId: string | null
  x: number
  y: number
  width: number
  textFlow: 'overlap' | 'repel'
}

export interface FloatingText extends FloatingGeometry {
  kind?: 'text'
  content: JSONContent
}

export interface FloatingTable extends FloatingGeometry {
  kind: 'table'
  content: JSONContent
}

export interface FloatingImage extends FloatingGeometry {
  kind: 'image'
  src: string
  alt: string
}

export interface FloatingKaTeX extends FloatingGeometry {
  kind: 'katex'
  latex: string
}

export interface FloatingHTMLWidget extends FloatingGeometry {
  kind: 'html'
  html: string
  screenshot: string
  alt: string
  height: number
}

export type AttachmentSide = 'auto' | 'top' | 'bottom' | 'left' | 'right'
export interface ObjectConnection { targetId: string; side: AttachmentSide }
export interface LineEnd { x: number; y: number; anchorId: string | null; connection?: ObjectConnection }
export type LabelPosition = 'center' | 'top-inside' | 'top-outside' | 'bottom-inside' | 'bottom-outside' | 'left' | 'right' | 'above' | 'below'
export interface LabelAttachment { targetId: string; position: LabelPosition }
export interface Stroke { stroke: string | null; strokeWidth: number; dashed: boolean }
export interface FloatingShape extends FloatingGeometry, Stroke {
  kind: 'rectangle' | 'ellipse'
  height: number
  fill: string | null
  rounded: boolean
}
export interface FloatingLine extends FloatingGeometry, Stroke {
  kind: 'line'
  start: LineEnd
  end: LineEnd
  route: 'straight' | 'elbow'
  // Horizontal offset from the endpoints' midpoint, in document pixels.
  bend: number
  arrowStart: boolean
  arrowEnd: boolean
}
export interface FloatingLabel extends FloatingGeometry {
  kind: 'label'
  content: JSONContent
  attachment: LabelAttachment | null
}
export type FloatingObject = FloatingText | FloatingTable | FloatingImage | FloatingShape | FloatingLine | FloatingLabel | FloatingKaTeX | FloatingHTMLWidget
export type FloatingKind = NonNullable<FloatingObject['kind']>
export type FloatingPatch = Partial<Omit<FloatingGeometry, 'id'>> & Partial<Stroke> & {
  content?: JSONContent; src?: string; alt?: string; height?: number; fill?: string | null; rounded?: boolean
  start?: LineEnd; end?: LineEnd; route?: 'straight' | 'elbow'; bend?: number; arrowStart?: boolean; arrowEnd?: boolean
  attachment?: LabelAttachment | null
  latex?: string; html?: string; screenshot?: string
}

export function labelContent(text = ''): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] }
}

export interface MoteDocument {
  version: 'V0'
  id: string
  width: number
  margins: { left: number; right: number }
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

export function tableContent(rows = [['Idea', 'Next step'], ['A little space', 'Try something new'], ['', '']]): JSONContent {
  return { type: 'doc', content: [{ type: 'table', content: rows.map(row => ({
    type: 'tableRow', content: row.map(text => ({ type: 'tableCell', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] })),
  })) }] }
}

const landscape = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360"><rect width="600" height="360" fill="#e8ecdf"/><circle cx="450" cy="86" r="40" fill="#d9b678"/><path d="M0 238Q145 76 320 224T600 164V360H0Z" fill="#9aaa89"/><path d="M0 292Q156 196 340 278T600 228V360H0Z" fill="#54725b"/><path d="M240 360Q410 290 330 238" fill="none" stroke="#eee5c9" stroke-width="20"/><path d="M95 285V150m0 70q-65-8-53-54 53 7 53 54m0-26q59-4 49-49-49 6-49 49" fill="#35543e" stroke="#35543e" stroke-width="5"/></svg>')}`

export function createDocument(): MoteDocument {
  const spaceId = crypto.randomUUID()
  const sketchSpaceId = crypto.randomUUID()
  const reviewSpaceId = crypto.randomUUID()
  const mathSpaceId = crypto.randomUUID()
  const attentionSpaceId = crypto.randomUUID()
  const motionSpaceId = crypto.randomUUID()
  const rectangleId = crypto.randomUUID(), ellipseId = crypto.randomUUID()
  const imageId = crypto.randomUUID()
  return {
    version: 'V0',
    id: crypto.randomUUID(),
    width: 800,
    margins: { left: 48, right: 48 },
    theme: structuredClone(defaultTheme),
    content: {
      type: 'doc',
      content: [
        paragraph('A little room to think.', 'title'),
        paragraph('A note in text and space', 'caption'),
        {
          ...paragraph(''),
          content: [
            { type: 'text', text: 'Some thoughts want a line. Others need ' },
            { type: 'text', text: 'a little space', marks: [{ type: 'semanticText', attrs: { semantic: 'primary' } }] },
            { type: 'text', text: '. Mote brings both into the same document.' },
          ],
        },
        { type: 'spacer', attrs: { id: spaceId, height: 176 } },
        paragraph('Meaning before appearance', 'heading'),
        paragraph('Give a paragraph or a phrase a role, then let the theme take care of how it looks. Change the theme once, and every use follows.'),
        paragraph('Try it out', 'heading'),
        paragraph('Write above the floating note and watch it follow its anchor. Select a phrase to highlight a key idea, or insert a spacer to leave room for something new.'),
        paragraph('This draft lives in this browser. No account, no cloud.', 'caption'),
        paragraph('Ideas need different shapes', 'heading'),
        paragraph('A small field guide to arranging a note', 'caption'),
        paragraph('Start with the thought, not the layout. A paragraph can carry an argument, while a nearby box holds a question that deserves to stay open. Both belong to the same page.'),
        { type: 'spacer', attrs: { id: sketchSpaceId, height: 410 } },
        paragraph('Keep the thread', 'heading'),
        paragraph('Use the main text for the path you want to follow. Put a definition, a reminder, or an alternative in a floating box, close to the passage that gives it meaning.'),
        paragraph('Leave room for later', 'heading'),
        paragraph('An empty area can be an invitation rather than a gap to fill. Insert a space, place a thought inside it, and return when the connection becomes clearer. Nothing needs a final position yet.'),
        paragraph('Space is part of the composition, just as a pause is part of a sentence.', 'caption'),
        paragraph('Returning with fresh eyes', 'heading'),
        paragraph('A second pass through the same landscape', 'caption'),
        paragraph('A longer note should still feel easy to explore. Its headings are landmarks; its open spaces give the eye a rest. The minimap keeps the shape of the whole nearby as you move.'),
        { type: 'spacer', attrs: { id: reviewSpaceId, height: 410 } },
        paragraph('Read for the shape', 'heading'),
        paragraph('Switch to reading mode and look at the page as a composition. Zoom out to see the relationships, then move closer to a passage. Text and floating thoughts keep their places together.'),
        paragraph('A little mathematical language', 'heading'),
        paragraph('One KaTeX object, many ways to express an idea: fractions and roots, Greek letters and sums, integrals and derivatives, matrices, cases, and vectors. Select the formula to explore its LaTeX source.'),
        { type: 'spacer', attrs: { id: mathSpaceId, height: 360 } },
        paragraph('Let the reader explore', 'heading'),
        paragraph('This ECharts widget lives inside an <attention-chart> custom element with its own shadow DOM. Change the measure, filter a series with its legend, or click a bar: the chart and the detail below it respond together.'),
        paragraph('In editing mode, select a chart and choose Interact. In reading mode, use it directly. Both charts load ECharts from a CDN and need an internet connection.', 'caption'),
        { type: 'spacer', attrs: { id: attentionSpaceId, height: 432 } },
        paragraph('Make change visible', 'heading'),
        paragraph('Watch five ideas trade places as new votes arrive. ECharts animates the bar lengths, rankings, and value labels between passes. Pause to look closer, or use Next pass to move at your own pace.'),
        { type: 'spacer', attrs: { id: motionSpaceId, height: 432 } },
        paragraph('The animation repeats with illustrative data; reduced-motion preferences start it paused. PNG exports and the minimap use saved chart screenshots, not live animation.', 'caption'),
        paragraph('Make it your own', 'heading'),
        paragraph('Replace a paragraph, rename a heading, or move a box to a better spot. Try a different theme and watch the whole note respond. The structure is a starting point, not a template to obey.'),
        paragraph('Keep what helps you think. Leave a little room for what comes next.', 'caption'),
      ],
    },
    floating: [{
      id: crypto.randomUUID(),
      anchorId: spaceId,
      x: 361,
      y: 22,
      width: 300,
      textFlow: 'overlap',
      content: { type: 'doc', content: [paragraph('A thought in the margin', 'heading'), paragraph('I move with the space I’m anchored to.', 'caption')] },
    }, {
      id: crypto.randomUUID(),
      anchorId: sketchSpaceId,
      x: 415,
      y: 72,
      width: 300,
      textFlow: 'overlap',
      content: { type: 'doc', content: [paragraph('A question to keep', 'heading'), paragraph('What belongs in the main thread, and what deserves its own small place?', 'caption')] },
    }, {
      id: crypto.randomUUID(),
      anchorId: reviewSpaceId,
      x: 415,
      y: 80,
      width: 300,
      textFlow: 'overlap',
      content: { type: 'doc', content: [paragraph('A note for next time', 'heading'), paragraph('Leave one useful question for the person who returns to this page. That person may be you.', 'caption')] },
    }, {
      id: imageId, kind: 'image', anchorId: sketchSpaceId,
      x: 55, y: 48, width: 340, textFlow: 'overlap', src: landscape,
      alt: 'A winding path between green hills beneath a golden sun.',
    }, {
      id: crypto.randomUUID(), kind: 'table', anchorId: reviewSpaceId,
      x: 55, y: 48, width: 340, textFlow: 'overlap',
      content: tableContent([['Keep', 'Explore'], ['The main thread', 'A different angle'], ['Room to think', 'One useful question']]),
    }, {
      id: rectangleId, kind: 'rectangle', anchorId: spaceId, x: 55, y: 48, width: 112, height: 80,
      textFlow: 'overlap', fill: null, stroke: null, strokeWidth: 1, dashed: false, rounded: true,
    }, {
      id: ellipseId, kind: 'ellipse', anchorId: spaceId, x: 224, y: 48, width: 96, height: 80,
      textFlow: 'overlap', fill: '#e9efdf', stroke: null, strokeWidth: 1, dashed: false, rounded: false,
    }, {
      id: crypto.randomUUID(), kind: 'line', anchorId: spaceId, x: 167, y: 88, width: 57,
      textFlow: 'overlap', stroke: null, strokeWidth: 1, dashed: true, route: 'straight', bend: 0, arrowStart: false, arrowEnd: true,
      start: { x: 167, y: 88, anchorId: spaceId, connection: { targetId: rectangleId, side: 'right' } },
      end: { x: 224, y: 88, anchorId: spaceId, connection: { targetId: ellipseId, side: 'left' } },
    }, {
      id: crypto.randomUUID(), kind: 'label', anchorId: spaceId, x: 55, y: 48, width: 12, textFlow: 'overlap',
      content: labelContent('Idea'), attachment: { targetId: rectangleId, position: 'center' },
    }, {
      id: crypto.randomUUID(), kind: 'label', anchorId: spaceId, x: 224, y: 48, width: 12, textFlow: 'overlap',
      content: labelContent('Explore'), attachment: { targetId: ellipseId, position: 'center' },
    }, {
      id: crypto.randomUUID(), kind: 'label', anchorId: sketchSpaceId, x: 55, y: 270, width: 12, textFlow: 'overlap',
      content: labelContent('A different path'), attachment: { targetId: imageId, position: 'bottom-outside' },
    }, {
      id: crypto.randomUUID(), kind: 'katex', anchorId: mathSpaceId,
      x: 55, y: 16, width: 690, textFlow: 'overlap', latex: exampleMath.trim(),
    }, {
      id: crypto.randomUUID(), kind: 'html', anchorId: attentionSpaceId,
      x: 55, y: 16, width: 690, height: 400, textFlow: 'overlap',
      html: attentionHTML, screenshot: attentionScreenshot,
      alt: 'A week of attention: interactive reading, writing, and exploring chart with a measure selector.',
    }, {
      id: crypto.randomUUID(), kind: 'html', anchorId: motionSpaceId,
      x: 55, y: 16, width: 690, height: 400, textFlow: 'overlap',
      html: motionHTML, screenshot: motionScreenshot,
      alt: 'Ideas in motion: animated ranking of five ideas by reader votes, with play, pause, and next-pass controls.',
    }],
  }
}

export function shiftSpaceObjects(objects: FloatingObject[], shift?: SpaceShift | null): FloatingObject[] {
  if (!shift) return objects
  // Later anchors already move with the text flow; only earlier anchors need offsets.
  function move<T extends { anchorId: string | null; y: number }>(point: T): T {
    const anchor = shift!.anchors.find(anchor => anchor.id === point.anchorId)
    const y = anchor && anchor.top + point.y >= shift!.from ? Math.max(0, point.y + shift!.delta) : point.y
    const removed = shift!.removed
    if (removed && point.anchorId === removed.id) return { ...point, anchorId: removed.anchorId, y: y + removed.offset }
    return y === point.y ? point : { ...point, y }
  }
  return objects.map(note => note.kind === 'line' ? { ...move(note), start: move(note.start), end: move(note.end) } : move(note))
}

// Keep notes when their anchor is removed: prefer the nearest surviving predecessor.
export function replaceMainContent(doc: MoteDocument, content: JSONContent, merges: SpaceMerge[] = [], shift?: SpaceShift): MoteDocument {
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
  const floating = shiftSpaceObjects(doc.floating, shift).map(note => {
    const { anchorId, y } = remap(note)
    if (note.kind === 'line') return { ...note, anchorId, y,
      start: { ...note.start, ...remap(note.start) }, end: { ...note.end, ...remap(note.end) } }
    return anchorId === note.anchorId && y === note.y ? note : { ...note, anchorId, y }
  })
  return { ...doc, content, floating }
}
