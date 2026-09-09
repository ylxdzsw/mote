import type { JSONContent } from '@tiptap/core'

export const blockClasses = ['title', 'heading', 'body', 'caption'] as const
export const inlineClasses = ['emphasis', 'term'] as const
export type BlockClass = typeof blockClasses[number]
export type InlineClass = typeof inlineClasses[number]

export interface BlockStyle {
  size: number
  color: string
  family: 'sans' | 'serif'
  weight: number
  lineHeight: number
  spaceBefore: number
  spaceAfter: number
  letterSpacing: number
}

export interface PhraseStyle {
  color: string
  background: string
  weight: number
  italic: boolean
  decoration: 'none' | 'underline' | 'line-through'
}

export interface Theme {
  defaults: BlockStyle & { background: string }
  blocks: Record<BlockClass, Partial<BlockStyle>>
  inline: Record<InlineClass, Partial<PhraseStyle>>
}

export const defaultTheme: Theme = {
  defaults: { family: 'sans', size: 17, color: '#414841', background: '#fffefa', weight: 400, lineHeight: 1.7, spaceBefore: 0, spaceAfter: 18, letterSpacing: 0 },
  blocks: {
    title: { size: 48, color: '#262b27', family: 'serif', lineHeight: 1.16, letterSpacing: -1.8 },
    heading: { size: 26, color: '#262b27', family: 'serif', lineHeight: 1.3, spaceBefore: 25, spaceAfter: 12, letterSpacing: -.4 },
    body: {},
    caption: { size: 13, color: '#737b72', lineHeight: 1.65 },
  },
  inline: {
    emphasis: { color: '#355b43', background: '#e9efdf' },
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

export type FloatingObject = FloatingText | FloatingTable | FloatingImage
export type FloatingPatch = Partial<Pick<FloatingGeometry, 'anchorId' | 'x' | 'y' | 'width' | 'textFlow'>> & { content?: JSONContent; src?: string; alt?: string }

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
  return {
    version: 'V0',
    id: crypto.randomUUID(),
    width: 800,
    margins: { left: 55, right: 55 },
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
            { type: 'text', text: 'a little space', marks: [{ type: 'semanticText', attrs: { semantic: 'emphasis' } }] },
            { type: 'text', text: '. Mote brings both into the same document.' },
          ],
        },
        { type: 'spacer', attrs: { id: spaceId, height: 176 } },
        paragraph('Meaning before appearance', 'heading'),
        paragraph('Give a paragraph or a phrase a role, then let the theme take care of how it looks. Change the theme once, and every use follows.'),
        paragraph('Try it out', 'heading'),
        paragraph('Write above the floating note and watch it follow its anchor. Select a phrase to give it emphasis, or insert a spacer to leave room for something new.'),
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
      id: crypto.randomUUID(), kind: 'image', anchorId: sketchSpaceId,
      x: 55, y: 48, width: 340, textFlow: 'overlap', src: landscape,
      alt: 'A winding path between green hills beneath a golden sun.',
    }, {
      id: crypto.randomUUID(), kind: 'table', anchorId: reviewSpaceId,
      x: 55, y: 48, width: 340, textFlow: 'overlap',
      content: tableContent([['Keep', 'Explore'], ['The main thread', 'A different angle'], ['Room to think', 'One useful question']]),
    }],
  }
}

// Keep notes when their anchor is removed: prefer the nearest surviving predecessor.
export function replaceMainContent(doc: MoteDocument, content: JSONContent): MoteDocument {
  const oldIds = doc.content.content!.map(node => node.attrs!.id as string)
  const newIds = content.content!.map(node => node.attrs!.id as string)
  const floating = doc.floating.map(note => {
    const y = Math.max(0, note.y)
    if (note.anchorId === null || newIds.includes(note.anchorId)) return y === note.y ? note : { ...note, y }
    const preceding = oldIds.slice(0, oldIds.indexOf(note.anchorId)).reverse()
    return { ...note, anchorId: preceding.find(id => newIds.includes(id)) ?? null, y }
  })
  return { ...doc, content, floating }
}
