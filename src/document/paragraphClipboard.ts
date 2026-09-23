import type { JSONContent } from '@tiptap/core'
import type { MoteDocument } from './model'
import { copySegment, parseSegment } from './segment'

export const PARAGRAPH_MIME = 'application/x-mote-paragraphs+json'

export function paragraphClipboardJSON(data: DataTransfer) {
  const native = data.getData(PARAGRAPH_MIME)
  if (native) return native
  const html = data.getData('text/html')
  return html.includes('data-mote-paragraphs')
    ? new DOMParser().parseFromString(html, 'text/html').querySelector('[data-mote-paragraphs]')?.getAttribute('data-mote-paragraphs') ?? '' : ''
}

export function parseParagraphs(json: string) {
  const payload = parseSegment(json)
  if (!payload.content.length || payload.floating.length || payload.content.some(node => node.type !== 'paragraph')) throw new Error('Invalid Mote paragraphs')
  return payload
}

export function copyParagraphs(doc: MoteDocument, content: JSONContent[]) {
  return copySegment({ ...doc, content: { type: 'doc', content }, floating: [] },
    { start: { index: 0, offset: 0 }, end: { index: content.length, offset: 0 } }, [], {})
}
