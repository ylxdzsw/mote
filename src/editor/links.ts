import { Mark, getMarkRange, type Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { validLinkHref } from '../../shared/links.mjs'

export interface LinkRange { from: number; to: number }

export function selectedLink(editor: Editor | null) {
  const empty = { href: null as string | null, linked: false, mixed: false, ranges: [] as LinkRange[], from: 0, to: 0 }
  if (!editor) return empty
  const { selection, schema, doc } = editor.state
  const { from, to } = selection
  if (selection.empty) {
    if (!(selection instanceof TextSelection)) return empty
    const mark = schema.marks.link.isInSet(selection.$from.marks())
    const range = mark && getMarkRange(selection.$from, schema.marks.link, mark.attrs)
    return { href: mark?.attrs.href ?? null, linked: !!mark, mixed: false, ranges: [range ?? { from, to }], from, to }
  }
  const hrefs: (string | null)[] = []
  const ranges = selection.ranges.map(({ $from, $to }) => ({ from: $from.pos, to: $to.pos }))
  for (const range of ranges) doc.nodesBetween(range.from, range.to, node => {
    if (node.isText) hrefs.push(schema.marks.link.isInSet(node.marks)?.attrs.href ?? null)
  })
  const mixed = hrefs.some(href => href !== hrefs[0])
  return { href: mixed ? null : hrefs[0] ?? null, linked: hrefs.length > 0 && hrefs.every(Boolean), mixed, ranges, from, to }
}

function urls(text: string) {
  const matches: { from: number; to: number; href: string }[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\u0000-\u001f]+/gi)) {
    if (match.index && /[\p{L}\p{N}_@]/u.test(text[match.index - 1])) continue
    let href = match[0]
    let previous: string
    do {
      previous = href
      href = href.replace(/[.,;:!?，。；：！？、]+$/, '')
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        if (href.endsWith(close) && href.split(close).length > href.split(open).length) href = href.slice(0, -1)
      }
    } while (href !== previous)
    if (validLinkHref(href)) matches.push({ from: match.index, to: match.index + href.length, href })
  }
  return matches
}

function linkify(fragment: Fragment, inheritedLinks: boolean): Fragment {
  const result: PMNode[] = []
  let run: PMNode[] = []
  const flush = () => {
    if (!run.length) return
    const matches = urls(run.map(node => node.text!).join(''))
    let offset = 0
    for (const node of run) {
      let start = 0
      for (const match of matches) {
        const from = Math.max(0, match.from - offset), to = Math.min(node.nodeSize, match.to - offset)
        if (from >= to) continue
        if (from > start) result.push(node.cut(start, from))
        result.push(node.cut(from, to).mark(node.type.schema.marks.link.create({ href: match.href }).addToSet(node.marks)))
        start = to
      }
      if (start < node.nodeSize) result.push(node.cut(start))
      offset += node.nodeSize
    }
    run = []
  }
  fragment.forEach(node => {
    if (node.isText && (inheritedLinks || !node.type.schema.marks.link.isInSet(node.marks))) run.push(node)
    else { flush(); result.push(node.isLeaf ? node : node.copy(linkify(node.content, inheritedLinks))) }
  })
  flush()
  return Fragment.from(result)
}

export const InlineLink = Mark.create({
  name: 'link',
  priority: 107,
  inclusive: false,
  addAttributes: () => ({ href: {
    default: null,
    validate: (value: unknown) => { if (!validLinkHref(value)) throw new Error('Link must use an absolute HTTP or HTTPS URL') },
  } }),
  parseHTML: () => [{ tag: 'a[href]', getAttrs: element => validLinkHref(element.getAttribute('href')) ? { href: element.getAttribute('href') } : false }],
  renderHTML: ({ HTMLAttributes }) => ['a', { ...HTMLAttributes, target: '_blank', rel: 'noopener noreferrer' }, 0],
  addProseMirrorPlugins() {
    let plain = false
    return [new Plugin({
      props: {
        // Unlike transformPasted's asText, this distinguishes the explicit
        // plain-text command from an ordinary paste with only text/plain data.
        transformPastedText: (text, asPlain) => { plain = asPlain; return text },
        transformPastedHTML: html => { plain = false; return html },
        transformPasted: (slice, _view, asText) => {
          const skip = plain
          plain = false
          return skip ? slice : new Slice(linkify(slice.content, asText), slice.openStart, slice.openEnd)
        },
      },
    })]
  },
})
