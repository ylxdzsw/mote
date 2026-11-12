// Standalone helper: copy the current reserved scope, not a reservation snapshot.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function extractCandidate(task, envelope) {
  if (task.protocol !== 'mote-agent-v6') throw new Error('Unsupported task protocol; request a current task.')
  const document = envelope.document ?? envelope
  const { target } = task, blocks = document.content.content
  const objects = new Map(document.objects.map(object => [object.id, object]))
  const findObject = id => {
    const object = objects.get(id)
    if (!object) throw new Error(`Reserved object is missing: ${id}`)
    return structuredClone(object)
  }
  const summary = 'Unchanged reserved content.'
  if (target.kind === 'object') return { summary, object: findObject(target.objectId) }
  if (target.kind === 'text') {
    const first = blocks.findIndex(block => block.attrs.id === target.blockIds[0])
    const content = blocks.slice(first, first + target.blockIds.length)
    if (content.length !== target.blockIds.length || content.some((block, index) => block.type !== 'paragraph' || block.attrs.id !== target.blockIds[index])) {
      throw new Error('Reserved paragraphs no longer match the document.')
    }
    return { summary, content: structuredClone(content) }
  }
  if (target.kind !== 'segment') throw new Error('Unsupported target kind.')
  const resolve = bookmark => {
    if (bookmark.blockId === null) return { index: bookmark.after ? blocks.length : 0, offset: 0 }
    const index = blocks.findIndex(block => block.attrs.id === bookmark.blockId)
    if (index < 0) throw new Error(`Segment boundary is missing: ${bookmark.blockId}`)
    return { index: index + (bookmark.after ? 1 : 0), offset: bookmark.after ? 0 : bookmark.offset }
  }
  const canonical = point => {
    const { index, offset } = point, block = blocks[index]
    if (!Number.isInteger(index) || index < 0 || index > blocks.length || !Number.isFinite(offset) || offset < 0
      || (block?.type === 'spacer' ? offset > block.attrs.height : offset !== 0)) throw new Error('Invalid segment boundary.')
    return block?.type === 'spacer' && offset === block.attrs.height ? { index: index + 1, offset: 0 } : point
  }
  const empty = target.range.start.index === target.range.end.index && target.range.start.offset === target.range.end.offset
  const start = canonical(target.bookmarks ? empty && target.bookmarks.start.after
    ? { index: blocks.length, offset: 0 } : resolve(target.bookmarks.start) : target.range.start)
  const end = empty ? start : canonical(target.bookmarks ? resolve(target.bookmarks.end) : target.range.end)
  if (start.index > end.index || start.index === end.index && start.offset > end.offset) throw new Error('Segment boundaries are reversed.')
  const content = [], slices = new Map()
  for (let index = start.index; index <= end.index && index < blocks.length; index++) {
    const block = blocks[index]
    if (block.type === 'spacer') {
      const from = index === start.index ? start.offset : 0
      const to = index === end.index ? end.offset : block.attrs.height
      if (to <= from) continue
      slices.set(block.attrs.id, from)
      content.push({ ...structuredClone(block), attrs: { ...block.attrs, height: to - from } })
    } else if (index < end.index) content.push(structuredClone(block))
  }
  if (content.length !== target.blockIds.length || content.some((block, index) => block.attrs.id !== target.blockIds[index])) {
    throw new Error('Reserved segment blocks no longer match the document.')
  }
  // Cropped spacers need explicit adjusted objects. Bare IDs always mean literal copies.
  const selected = new Set(target.objectIds)
  for (const id of selected) findObject(id)
  const copiedObjects = document.objects.filter(object => selected.has(object.id)).map(object => {
    const placement = object.layout.placement
    const offset = placement.type === 'float' ? slices.get(placement.anchorId) : 0
    if (!offset) return object.id
    const copy = structuredClone(object)
    copy.layout.placement.y = Math.max(0, placement.y - offset)
    return copy
  })
  const { geometry, anchorTops, originTop } = task.geometry
  return { summary, segment: {
    version: document.page.slideHeight === undefined ? 1 : 2, type: 'segment', content, objects: copiedObjects,
    geometry: structuredClone(geometry), anchorTops: structuredClone(anchorTops), originTop,
  } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [taskPath, documentPath, outputPath] = process.argv.slice(2)
  if (!taskPath || !documentPath || !outputPath) throw new Error('Usage: node extract.mjs TASK.json DOCUMENT.json RESULT.json')
  const task = JSON.parse(await readFile(taskPath, 'utf8'))
  const document = JSON.parse(await readFile(documentPath, 'utf8'))
  await writeFile(outputPath, JSON.stringify(extractCandidate(task, document), null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
