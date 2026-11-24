// One-way V8 conversion. These are the legacy Slides-Off estimates without a
// measured canvas: no DOM, font metrics, or slide-height-dependent padding.
function blockSizes({ page, theme, objects }) {
  const base = theme.defaults.size
  const length = value => value.value * (value.unit === 'em' ? base : 1)
  const textSize = (block, width, semantic = block.attrs.semantic) => {
    const style = { ...theme.defaults, ...theme.paragraphs[semantic] }
    const size = typeof style.size === 'number' ? style.size : length(style.size)
    const line = style.lineHeight.unit === 'ratio' ? style.lineHeight.value * size : length(style.lineHeight)
    const text = (block.content ?? []).map(node => node.type === 'hardBreak' ? '\n' : node.text).join('')
    const columns = Math.max(1, width / (size * .55))
    const lines = text.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / columns)), 0)
    return { height: lines * line, before: length(style.spaceBefore), after: length(style.spaceAfter) }
  }
  const byId = new Map(objects.map(object => [object.id, object]))
  const column = page.width - page.margins.left - page.margins.right
  return block => {
    if (block.type === 'spacer') return { height: block.attrs.height, before: 0, after: 0 }
    if (block.type !== 'flow') return textSize(block, column)
    const object = byId.get(block.attrs.objectId), { width, margins } = object.layout
    let height = object.layout.height
    if (height === undefined) {
      if (object.kind === 'text') height = object.content.content.reduce((sum, p) => {
        const size = textSize(p, width)
        return sum + size.height + size.before + size.after
      }, 0)
      else if (object.kind === 'table') height = object.content.content[0].content.length * base * 2.5
      else if (object.kind === 'code') height = object.source.split('\n').length * base * 1.375 + 24
      else height = object.kind === 'image' ? width * .6 : base * 3
    }
    if (object.caption) {
      const caption = textSize(object.caption.content.content[0], object.caption.width ?? width, 'caption')
      height += caption.height + caption.before + caption.after
    }
    return { height: Math.max(0, height + (margins?.top ?? 0) + (margins?.bottom ?? 0)),
      before: theme.flow.spaceBefore ? length(theme.flow.spaceBefore) : 0,
      after: length(theme.flow.spaceAfter ?? theme.paragraphs.body?.spaceAfter ?? theme.defaults.spaceAfter) }
  }
}

function slidesOff(doc) {
  if (doc.page.slideHeight === undefined) return doc
  const { slideHeight, ...page } = doc.page
  const sizeOf = blockSizes(doc), offsets = new Map(), blocks = []
  let marker, bottom = 0, after = page.margins.top
  for (const block of doc.content.content) {
    if (block.type === 'slideBreak') { marker = block.attrs.id; continue }
    blocks.push(block)
    const size = sizeOf(block), top = bottom + Math.max(after, size.before)
    if (marker !== undefined) {
      offsets.set(marker, top - Math.max(page.margins.top, size.before))
      marker = undefined
    }
    bottom = top + size.height
    after = size.after
  }
  return { ...doc, page, content: { ...doc.content, content: blocks }, objects: doc.objects.map(object => {
    const { placement } = object.layout
    if (placement.type !== 'float' || !offsets.has(placement.anchorId)) return object
    const y = placement.y + offsets.get(placement.anchorId)
    // Finite legacy dimensions can overflow when combined. Keep the original
    // offset if the estimate is indeterminate, and never save non-finite y.
    return { ...object, layout: { ...object.layout, placement: { ...placement, anchorId: null,
      y: Number.isNaN(y) ? placement.y : Math.min(Number.MAX_VALUE, Math.max(0, y)) } } }
  }) }
}

function convertMarks(node) {
  if (node.content) return { ...node, content: node.content.map(convertMarks) }
  if (node.marks?.some(mark => mark.type === 'decoration')) return { ...node,
    marks: node.marks.map(mark => mark.type === 'decoration' ? { type: 'box' } : mark) }
  return node
}

export function migrateV8ToV9(document) {
  const doc = slidesOff(document)
  return { ...doc, version: 9,
    theme: { ...doc.theme, justifyText: doc.theme.justifyText ?? false, firstLineIndent: doc.theme.firstLineIndent ?? false },
    content: convertMarks(doc.content), objects: doc.objects.map(object => ({ ...object,
      ...(object.content && { content: convertMarks(object.content) }),
      ...(object.caption && { caption: { ...object.caption, content: convertMarks(object.caption.content) } }),
    })) }
}
