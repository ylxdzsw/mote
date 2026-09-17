import type { MoteDocument, Theme } from '../document/model'
import type { JSONContent } from '@tiptap/core'

export const neutralIds = ['ink', 'muted', 'subtle', 'paper'] as const
export function paletteColor(theme: Theme, reference: string): string {
  const [id, tone] = reference.split(':')
  const entry = theme.palette.find(entry => entry.id === id)!
  return tone === 'soft' ? entry.soft! : entry.strong
}
export function paletteCSS(reference: string): string {
  return `var(--palette-${reference.replace(':', '-')})`
}
export function paletteSwatches(theme: Theme) {
  return theme.palette.flatMap(entry => [
    { value: entry.id, label: entry.name, color: entry.strong },
    ...(entry.soft ? [{ value: `${entry.id}:soft`, label: `${entry.name} · Soft`, color: entry.soft }] : []),
  ])
}
export function softReference(theme: Theme, reference: string) {
  const id = reference.split(':')[0]
  return theme.palette.find(entry => entry.id === id)?.soft ? `${id}:soft` : 'subtle'
}

export function replacePaletteEntry(doc: MoteDocument, id: string, replacement: string): MoteDocument {
  const replace = (value: string | null | undefined) => value?.split(':')[0] !== id ? value
    : value.endsWith(':soft') ? softReference(doc.theme, replacement) : replacement
  const content = (node: JSONContent): JSONContent => ({ ...node,
    ...(node.marks && { marks: node.marks.map(mark => mark.type === 'color' ? { ...mark, attrs: { color: replace(mark.attrs?.color) } } : mark) }),
    ...(node.content && { content: node.content.map(content) }),
  })
  return { ...doc, theme: { ...doc.theme,
    palette: doc.theme.palette.filter(entry => entry.id !== id),
    defaults: { ...doc.theme.defaults, color: replace(doc.theme.defaults.color)!, background: replace(doc.theme.defaults.background)! },
    blocks: Object.fromEntries(Object.entries(doc.theme.blocks).map(([name, style]) => [name, { ...style, ...(style.color && { color: replace(style.color) }) }])) as Theme['blocks'],
  }, content: content(doc.content), floating: doc.floating.map(object => ({ ...object,
    ...('content' in object && { content: content(object.content) }),
    ...('fill' in object && { fill: replace(object.fill) }),
    ...('stroke' in object && { stroke: replace(object.stroke) }),
    ...('background' in object && { background: replace(object.background) }),
    ...('borderColor' in object && { borderColor: replace(object.borderColor) }),
  })) as MoteDocument['floating'] }
}

export function validatePaletteReferences(doc: MoteDocument) {
  const fail = (message: string): never => { throw new Error(`Invalid palette: ${message}`) }
  if (!Array.isArray(doc.theme.palette)) fail('missing document palette')
  const entries = new Map<string, Theme['palette'][number]>()
  const variables = new Set<string>()
  for (const entry of doc.theme.palette) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(entry.id)
      || ['__proto__', 'constructor', 'prototype', 'mixed'].includes(entry.id) || entries.has(entry.id)) fail('invalid or duplicate entry ID')
    if (typeof entry.name !== 'string' || !entry.name.trim()) fail('entries need a name')
    const neutral = (neutralIds as readonly string[]).includes(entry.id)
    if (neutral ? entry.soft !== undefined : typeof entry.soft !== 'string') fail('families need Strong and Soft tones; neutrals use one color')
    for (const value of [entry.strong, ...(!neutral ? [entry.soft] : [])]) {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail('colors must be opaque six-digit hex values')
    }
    for (const variable of [entry.id, `${entry.id}-soft`, `${entry.id}-surface`]) {
      if (variables.has(variable)) fail('entry IDs overlap color tones')
      variables.add(variable)
    }
    entries.set(entry.id, entry)
  }
  for (const id of neutralIds) if (!entries.has(id)) fail(`missing ${id}`)
  const reference = (value: unknown) => {
    if (typeof value !== 'string') fail('color must reference a palette entry')
    const parts = (value as string).split(':')
    const entry = entries.get(parts[0])
    if (!entry || parts.length > 2 || (parts.length === 2 && (parts[1] !== 'soft' || !entry.soft))) fail(`unknown color ${value}`)
  }
  reference(doc.theme.defaults.color)
  reference(doc.theme.defaults.background)
  for (const style of Object.values(doc.theme.blocks)) if (style.color !== undefined) reference(style.color)
  const content = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type === 'color') reference(mark.attrs?.color)
      else if (mark.type === 'decoration') {
        if (!['box', 'underline'].includes(mark.attrs?.decoration)) fail('unsupported inline decoration')
      } else if (mark.type !== 'bold') fail('unsupported inline mark')
    }
    node.content?.forEach(content)
  }
  content(doc.content)
  for (const object of doc.floating) {
    if ('content' in object) content(object.content)
    for (const key of ['fill', 'stroke', 'background', 'borderColor'] as const) {
      if (key in object) {
        const value = (object as unknown as Record<string, unknown>)[key]
        if (value !== undefined && value !== null) reference(value)
      }
    }
  }
}
