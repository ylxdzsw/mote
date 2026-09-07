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
      ],
    },
    floating: [{
      id: crypto.randomUUID(),
      anchorId: spaceId,
      x: 306,
      y: 22,
      width: 300,
      content: { type: 'doc', content: [paragraph('A thought in the margin', 'heading'), paragraph('I move with the space I’m anchored to.', 'caption')] },
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
