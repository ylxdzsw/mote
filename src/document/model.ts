import type { JSONContent } from '@tiptap/core'

export const blockClasses = ['title', 'heading', 'body', 'caption'] as const
export const inlineClasses = ['emphasis', 'term'] as const
export type BlockClass = typeof blockClasses[number]
export type InlineClass = typeof inlineClasses[number]

export interface BlockStyle {
  size: number
  color: string
  family: 'sans' | 'serif'
}

export interface Theme {
  blocks: Record<BlockClass, BlockStyle>
  inline: Record<InlineClass, { color: string; background: string }>
}

export interface FloatingText {
  id: string
  anchorId: string
  x: number
  y: number
  width: number
  content: JSONContent
}

export interface MoteDocument {
  version: 'V0'
  id: string
  width: number
  theme: Theme
  content: JSONContent
  floating: FloatingText[]
}

export function paragraph(text: string, semantic: BlockClass = 'body'): JSONContent {
  return {
    type: 'paragraph',
    attrs: { id: crypto.randomUUID(), semantic },
    content: text ? [{ type: 'text', text }] : [],
  }
}

export function createDocument(): MoteDocument {
  const spaceId = crypto.randomUUID()
  const sketchSpaceId = crypto.randomUUID()
  const reviewSpaceId = crypto.randomUUID()
  return {
    version: 'V0',
    id: crypto.randomUUID(),
    width: 800,
    theme: {
      blocks: {
        title: { size: 48, color: '#262b27', family: 'serif' },
        heading: { size: 26, color: '#262b27', family: 'serif' },
        body: { size: 17, color: '#414841', family: 'sans' },
        caption: { size: 13, color: '#737b72', family: 'sans' },
      },
      inline: {
        emphasis: { color: '#355b43', background: '#e9efdf' },
        term: { color: '#875a35', background: '#f6edde' },
      },
    },
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
      x: 306,
      y: 22,
      width: 300,
      content: { type: 'doc', content: [paragraph('A thought in the margin', 'heading'), paragraph('I move with the space I’m anchored to.', 'caption')] },
    }, {
      id: crypto.randomUUID(),
      anchorId: sketchSpaceId,
      x: 64,
      y: 56,
      width: 300,
      content: { type: 'doc', content: [paragraph('A question to keep', 'heading'), paragraph('What belongs in the main thread, and what deserves its own small place?', 'caption')] },
    }, {
      id: crypto.randomUUID(),
      anchorId: reviewSpaceId,
      x: 280,
      y: 64,
      width: 300,
      content: { type: 'doc', content: [paragraph('A note for next time', 'heading'), paragraph('Leave one useful question for the person who returns to this page. That person may be you.', 'caption')] },
    }],
  }
}

// Keep notes when their anchor is removed: prefer the nearest surviving predecessor.
export function replaceMainContent(doc: MoteDocument, content: JSONContent): MoteDocument {
  const oldIds = doc.content.content!.map(node => node.attrs!.id as string)
  const newIds = content.content!.map(node => node.attrs!.id as string)
  const floating = doc.floating.map(note => {
    if (newIds.includes(note.anchorId)) return note
    const preceding = oldIds.slice(0, oldIds.indexOf(note.anchorId)).reverse()
    return { ...note, anchorId: preceding.find(id => newIds.includes(id)) ?? newIds[0] }
  })
  return { ...doc, content, floating }
}
