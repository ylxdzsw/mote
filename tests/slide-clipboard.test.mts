import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { validateDocument } from '../shared/document.mjs'
import type { MoteDocument, FloatingObject } from '../src/document/model.ts'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { createBlankDocument, paragraph } = await server.ssrLoadModule('/src/document/model.ts')
const { copySlides, deleteSlides, insertSlides, parseSlides, serializeSlides, flattenSlides, promoteSlideSelection, slideObjectIds } = await server.ssrLoadModule('/src/document/slideClipboard.ts')
const { slideRanges, objectSlideIndex } = await server.ssrLoadModule('/src/document/slides.ts')
const { replaceSegment, copySegment, serializeSegment } = await server.ssrLoadModule('/src/document/segment.ts')
const p = (id: string) => ({ ...paragraph(id), attrs: { id, semantic: 'body' } })
const marker = (id: string) => ({ type: 'slideBreak', attrs: { id } })
const code = (id: string, anchorId: string | null, y = 12): FloatingObject => ({ id, kind: 'code', source: id, language: 'text', layout: { width: 100, placement: { type: 'float', anchorId, x: 7, y } } })
const range = (start: number, end: number) => ({ start: { index: start, offset: 0 }, end: { index: end, offset: 0 } })
const source = (): MoteDocument => ({ ...createBlankDocument(), version: 2, page: { ...createBlankDocument().page, slideHeight: 540 },
  content: { type: 'doc', content: [p('a'), p('b'), marker('s1'), p('c'), marker('s2'), p('d')] },
  objects: [code('first', null, 1200), code('middle', 's1', 900), code('last', 'd')] })

test('gutter promotion is partial within a slide and whole across boundaries', () => {
  const doc = source()
  assert.equal(promoteSlideSelection(doc, range(0, 1)), null)
  assert.deepEqual(promoteSlideSelection(doc, range(0, 2)), { first: 0, last: 0 })
  assert.deepEqual(promoteSlideSelection(doc, range(1, 4)), { first: 0, last: 1 })
  assert.deepEqual(promoteSlideSelection(doc, range(3, 4)), { first: 1, last: 1 })
  assert.equal(promoteSlideSelection(doc, range(2, 2)), null)
  assert.deepEqual([...slideObjectIds(doc, { first: 0, last: 1 })], ['first', 'middle'])
})

test('slide copy/paste refreshes IDs and top anchors without scaling local geometry', () => {
  const doc = source(), payload = parseSlides(serializeSlides(copySlides(doc, { first: 0, last: 1 })))
  for (const boundary of [0, 1, 3]) {
    const result = insertSlides({ ...doc, page: { ...doc.page, slideHeight: 300 } }, payload, boundary)
    validateDocument(result.doc)
    assert.equal(slideRanges(result.doc).length, 5)
    assert.equal(result.doc.page.slideHeight, 300)
    assert.deepEqual(result.slides, { first: boundary, last: boundary + 1 })
    const pasted = result.doc.objects.slice(doc.objects.length)
    assert.deepEqual(pasted.map((object: FloatingObject) => objectSlideIndex(result.doc, object)), [boundary, boundary + 1])
    assert.deepEqual(pasted.map((object: FloatingObject) => object.layout.placement.type === 'float' && [object.layout.placement.x, object.layout.placement.y]), [[7, 1200], [7, 900]])
    assert.ok(pasted.every((object: FloatingObject) => !doc.objects.some(original => original.id === object.id)))
    assert.equal(objectSlideIndex(result.doc, result.doc.objects[0]), boundary === 0 ? 2 : 0)
  }
})

test('V7 slide clipboard round-trips its native document version', () => {
  const doc = source()
  doc.version = 7
  doc.theme.justifyText = true
  doc.theme.firstLineIndent = true
  const payload = parseSlides(serializeSlides(copySlides(doc, { first: 0, last: 2 })))
  assert.equal(payload.documentVersion, 7)
  const inserted = insertSlides(doc, payload, 3).doc
  validateDocument(inserted)
  assert.equal(inserted.version, 7)
  assert.equal(inserted.theme.justifyText, true)
  assert.equal(inserted.theme.firstLineIndent, true)
})

test('slide deletion and cut/paste preserve ownership and one writable slide', () => {
  const doc = source()
  const remaining = deleteSlides(doc, { first: 0, last: 0 })
  validateDocument(remaining)
  assert.equal(remaining.objects[0].layout.placement.anchorId, null)
  assert.equal(remaining.objects[0].layout.placement.y, 900)
  const moved = insertSlides(remaining, copySlides(doc, { first: 0, last: 0 }), 2).doc
  validateDocument(moved)
  assert.equal(slideRanges(moved).length, 3)
  assert.equal(objectSlideIndex(moved, moved.objects.at(-1)), 2)
  const empty = deleteSlides(doc, { first: 0, last: 2 })
  validateDocument(empty)
  assert.equal(slideRanges(empty).length, 1)
  assert.equal(empty.content.content[0].type, 'paragraph')
  assert.deepEqual(empty.objects, [])
})

test('Flow, captions and signed Flow-anchor offsets survive slide paste', () => {
  const doc = source()
  doc.content.content!.splice(3, 1, { type: 'flow', attrs: { id: 'flow-block', objectId: 'image' } })
  doc.objects.push({ id: 'image', kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', alt: '', layout: { width: 200, placement: { type: 'flow', x: 'center' } }, caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption' }, content: [] }] }, width: 250 } })
  doc.objects.push(code('annotation', 'flow-block', -10))
  const result = insertSlides(doc, copySlides(doc, { first: 1, last: 1 }), 2).doc
  validateDocument(result)
  const image = result.objects.find((object: FloatingObject) => object.kind === 'image' && object.id !== 'image')
  assert.notEqual(image.caption.content.content[0].attrs.id, 'caption')
  assert.equal(image.caption.width, 250)
  const annotation = result.objects.find((object: FloatingObject) => object.kind === 'code' && object.source === 'annotation' && object.id !== 'annotation')
  assert.equal(annotation.layout.placement.y, -10)
  assert.notEqual(annotation.layout.placement.anchorId, 'flow-block')
  assert.equal(objectSlideIndex(result, annotation), 2)
})

test('continuous paste flattens and ordinary segment paste never creates slides', () => {
  const doc = source(), payload = flattenSlides(copySlides(doc, { first: 0, last: 2 }))
  const blank = { ...createBlankDocument(), version: 1 }
  const pasted = replaceSegment(blank, range(0, 0), payload, [], {})
  validateDocument(pasted)
  assert.equal(pasted.page.slideHeight, undefined)
  assert.ok(pasted.content.content.every((block: { type: string }) => block.type !== 'slideBreak'))
  const segment = copySegment(doc, range(1, 4), [], {})
  serializeSegment(segment)
  assert.ok(segment.content.every((block: { type: string }) => block.type !== 'slideBreak'))
  const inserted = replaceSegment(doc, range(3, 4), segment, [], {})
  validateDocument(inserted)
  assert.equal(slideRanges(inserted).length, 3)
  validateDocument(replaceSegment(doc, range(3, 4), null, [], {}))
})

test('slide clipboard rejects unknown versions, fields, invalid anchors and malformed slides', () => {
  const payload = copySlides(source(), { first: 0, last: 2 })
  for (const change of [
    { documentVersion: 1 }, { version: 2 }, { extra: true }, { slideHeight: -1 },
    { content: [marker('bad'), ...payload.content] },
    { objects: [code('bad', 'missing')] },
  ]) assert.throws(() => parseSlides(JSON.stringify({ ...payload, ...change })))
})
