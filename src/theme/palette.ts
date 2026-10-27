import { isText, supportsCaption, type MoteDocument, type Theme } from '../document/model'
import type { JSONContent } from '@tiptap/core'
import { paletteEntries, validPaletteReference } from '../../shared/palette.mjs'
import { validLinkHref } from '../../shared/links.mjs'
export { paletteEntries, pageColor, neutralIds, boxColorIds, hueTones } from '../../shared/palette.mjs'

export function paletteColor(theme: Theme, reference: string): string {
  const [id, tone] = reference.split(':')
  const entry = paletteEntries(theme).find(entry => entry.id === id)!
  return tone === 'soft' ? entry.soft! : entry.strong
}
export function paletteCSS(reference: string): string {
  return `var(--palette-${reference.replace(':', '-')})`
}
export function paletteSwatches(theme: Theme) {
  return paletteEntries(theme).flatMap(entry => [
    { value: entry.id, label: entry.soft ? `${entry.name} · Strong` : entry.name, color: entry.strong },
    ...(entry.soft ? [{ value: `${entry.id}:soft`, label: `${entry.name} · Soft`, color: entry.soft }] : []),
  ])
}
export function softReference(theme: Theme, reference: string) {
  const id = reference.split(':')[0]
  return paletteEntries(theme).find(entry => entry.id === id)?.soft ? `${id}:soft` : 'gray5'
}

export function validatePaletteReferences(doc: MoteDocument) {
  const fail = (message: string): never => { throw new Error(`Invalid palette: ${message}`) }
  const reference = (value: unknown) => {
    if (!validPaletteReference(value)) fail(`unknown color ${value}`)
  }
  reference(doc.theme.defaults.color)
  for (const style of Object.values({ ...doc.theme.paragraphs, ...doc.theme.objects })) if ('color' in style && style.color !== undefined) reference(style.color)
  const content = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type === 'color') reference(mark.attrs?.color)
      else if (mark.type === 'decoration') {
        if (mark.attrs?.decoration !== 'box') fail('unsupported inline decoration')
      } else if (mark.type === 'link') {
        if (!validLinkHref(mark.attrs?.href)) fail('unsupported link destination')
      } else if (mark.type !== 'bold') fail('unsupported inline mark')
    }
    node.content?.forEach(content)
  }
  content(doc.content)
  for (const object of doc.objects) {
    if (isText(object) && object.decoration) reference(object.decoration.color)
    if (object.kind === 'drawing') for (const item of [...object.strokes, ...object.labels]) reference(item.color)
    if ('content' in object) content(object.content)
    if (supportsCaption(object) && object.caption) content(object.caption.content)
  }
}
