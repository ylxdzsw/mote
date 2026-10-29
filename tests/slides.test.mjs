import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { getSchema } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { loadDocument, validateDocument, validateContent, validateComposition } from '../shared/document.mjs'
import { validateCandidate } from '../server/validation.mjs'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { createBlankDocument, paragraph, px } = await server.ssrLoadModule('/src/document/model.ts')
const { setSlides, slideRanges, slideAtIndex, objectSlideIndex, insertSlideBreak, joinSlide } = await server.ssrLoadModule('/src/document/slides.ts')
const { extensions, SlideBreak } = await server.ssrLoadModule('/src/editor/extensions.ts')
const { canonicalEditorContent } = await server.ssrLoadModule('/src/editor/canonical.ts')
const { makeSegmentTarget, applySegmentCandidate } = await server.ssrLoadModule('/src/ai/segments.ts')
const { reconcileObjectDeletions, convertObjectPlacement } = await server.ssrLoadModule('/src/document/flow.ts')
const { copySegment } = await server.ssrLoadModule('/src/document/segment.ts')
const p = (id, semantic = 'body') => ({ ...paragraph(id, semantic), attrs: { id, semantic } })
const boundary = id => ({ type: 'slideBreak', attrs: { id } })
function document(blocks = [p('first')]) {
  const doc = createBlankDocument()
  doc.page.margins.top = doc.page.margins.bottom = 20
  doc.theme.paragraphs = {}
  Object.assign(doc.theme.defaults, { lineHeight: px(20), spaceBefore: px(0), spaceAfter: px(0) })
  doc.content.content = blocks
  return doc
}
const float = (id, anchorId, y = 5) => ({ id, kind: 'code', source: 'x', language: 'text',
  layout: { width: 30, placement: { type: 'float', anchorId, x: 10, y } } })

test('V2 object and whole-slide AI candidates retain unrelated slide structure', () => {
  const doc = document([p('a'), boundary('second'), p('b'), boundary('third'), p('c')])
  doc.version = 2; doc.page.slideHeight = 540
  doc.objects = [float('owned', 'second'), float('untouched', 'third')]
  const objectTarget = { kind: 'object', objectId: 'owned', isNew: false, area: { x: 10, y: 545, width: 30, height: 20 } }
  const candidate = { object: { ...doc.objects[0], source: 'changed' }, summary: 'Revision' }
  assert.equal(validateCandidate(candidate, doc, objectTarget).object.source, 'changed')
  const target = makeSegmentTarget(doc, { start: { index: 1, offset: 0 }, end: { index: 3, offset: 0 } }, { x: 0, y: 540, width: 960, height: 540 })
  const segment = { version: 1, type: 'segment', content: [p('replacement')], objects: [], geometry: {}, anchorTops: {}, originTop: 0 }
  validateCandidate({ segment, summary: 'New slide content' }, doc, target)
  const next = applySegmentCandidate(doc, target, segment, { anchors: [], geometry: {} })
  validateDocument(next)
  assert.deepEqual(next.content.content.filter(block => block.type === 'slideBreak'), [boundary('second'), boundary('third')])
  assert.deepEqual(next.objects, [doc.objects[1]])
  assert.equal(slideRanges(next).length, 3)
})

test('removing or converting the only Flow object retains its writable slide', () => {
  const doc = document([p('a'), boundary('second'), { type: 'flow', attrs: { id: 'flow', objectId: 'figure' } }])
  doc.version = 2; doc.page.slideHeight = 540
  doc.objects = [{ ...float('figure', null), layout: { width: 100, placement: { type: 'flow', x: 'center' } } }]
  for (const next of [reconcileObjectDeletions(doc, []), convertObjectPlacement(doc, 'figure', 'float')]) {
    validateDocument(next)
    assert.equal(slideRanges(next).length, 2)
    assert.equal(next.content.content.at(-1).type, 'paragraph')
  }
})

test('multi-slide candidates preserve internal boundaries and slide-top Float anchors', () => {
  const doc = document([p('a'), boundary('second'), p('b'), boundary('third'), p('c'), boundary('fourth'), p('d')])
  doc.version = 2; doc.page.slideHeight = 540
  doc.objects = [float('on-second', 'second', 15), float('on-third', 'third', 25)]
  const range = { start: { index: 1, offset: 0 }, end: { index: 5, offset: 0 } }
  const target = makeSegmentTarget(doc, range, { x: 0, y: 540, width: 960, height: 1080 })
  const payload = copySegment(doc, range, [], {}, true)
  assert.equal(payload.version, 2)
  validateCandidate({ segment: payload, summary: 'Two slides' }, doc, target)
  const next = applySegmentCandidate(doc, target, payload, { anchors: [], geometry: {} })
  validateDocument(next)
  assert.deepEqual(next.content.content.filter(block => block.type === 'slideBreak'), doc.content.content.filter(block => block.type === 'slideBreak'))
  assert.deepEqual(next.objects.map(object => object.layout.placement), doc.objects.map(object => object.layout.placement))
  const bad = { ...payload, content: payload.content.filter(block => block.type !== 'slideBreak'), objects: [] }
  bad.anchorTops = {}
  assert.throws(() => validateCandidate({ segment: bad, summary: 'Missing boundary' }, doc, target), /boundaries/)
  assert.throws(() => applySegmentCandidate(doc, target, bad, { anchors: [], geometry: {} }), /boundary/)
  const cleared = applySegmentCandidate(doc, target, null, { anchors: [], geometry: {} })
  validateDocument(cleared)
  assert.equal(slideRanges(cleared).length, 4)
  assert.equal(cleared.objects.length, 0)
})

test('V1 stays exact; only V2 Slides accepts closed marker/page shapes', () => {
  const v1 = document(), original = structuredClone(v1)
  assert.equal(loadDocument(v1), v1)
  const v2 = insertSlideBreak(v1, 1)
  assert.equal(v2.version, 2)
  assert.equal(v2.page.slideHeight, 540)
  assert.equal(loadDocument(v2), v2)
  assert.deepEqual(v1, original)
  validateDocument(setSlides(v2, false))
  validateDocument({ ...v1, version: 2 })
  for (const change of [
    d => { d.version = 1 },
    d => { delete d.page.slideHeight },
    d => { d.page.slideHeight = 0 },
    d => { d.page.slideHeight = Infinity },
    d => { d.content.content[1].attrs.extra = true },
    d => { d.content.content[1].attrs.id = 'first' },
    d => { d.content.content.pop() },
    d => { d.content.content.unshift(boundary('leading')) },
    d => { d.content.content.splice(2, 0, boundary('adjacent')) },
  ]) {
    const invalid = structuredClone(v2); change(invalid)
    const before = structuredClone(invalid)
    assert.throws(() => loadDocument(invalid))
    assert.deepEqual(invalid, before)
  }
  assert.throws(() => loadDocument({ ...v1, page: { ...v1.page, slideHeight: 540 } }))
  assert.throws(() => validateContent(v2.content))
  validateContent(v2.content, 'main', { slides: true })
  validateComposition(v2.content.content, [], { slides: true })
  assert.throws(() => validateContent(v2.content, 'text', { slides: true }))
})

test('ranges and ownership use flat block indices including leading markers', () => {
  const doc = document([p('a'), boundary('second'), p('b'), boundary('third'), { type: 'flow', attrs: { id: 'flow', objectId: 'figure' } }])
  doc.version = 2; doc.page.slideHeight = 100
  doc.objects = [float('top', null), float('second-top', 'second'), float('on-b', 'b'), float('on-flow', 'flow', -10),
    { id: 'figure', kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', alt: '', layout: { width: 50, placement: { type: 'flow', x: 'center' } },
      caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption' } }] } } }]
  validateDocument(doc)
  assert.deepEqual(slideRanges(doc), [
    { index: 0, start: 0, end: 1, id: null }, { index: 1, start: 1, end: 3, id: 'second' }, { index: 2, start: 3, end: 5, id: 'third' },
  ])
  assert.equal(slideAtIndex(doc, 1).index, 1)
  assert.equal(slideAtIndex(doc, 5).index, 2)
  assert.deepEqual(doc.objects.map(object => objectSlideIndex(doc, object)), [0, 1, 1, 2, 2])
  const joined = joinSlide(doc, 2)
  validateDocument(joined)
  assert.deepEqual(joined.objects, doc.objects)
  assert.deepEqual(joined.objects.at(-1).caption, doc.objects.at(-1).caption)
  assert.equal(objectSlideIndex(joined, joined.objects.at(-1)), 1)
  const continuous = setSlides(doc, false)
  validateDocument(continuous)
  assert.equal(continuous.version, 2)
  assert.equal(continuous.page.slideHeight, undefined)
  assert.deepEqual(continuous.content.content.map(block => block.attrs.id), ['a', 'b', 'flow'])
  assert.deepEqual(continuous.objects[3], doc.objects[3])
})

test('enabling partitions headings and measured height, never repartitions a height edit', () => {
  const source = document([p('title', 'title'), p('body'), p('sub', 'subheading'), p('overflow'), p('heading', 'heading')])
  const before = structuredClone(source)
  const enabled = setSlides(source, true, 100)
  validateDocument(enabled)
  assert.deepEqual(slideRanges(enabled).map(range => enabled.content.content.slice(range.start, range.end).filter(block => block.type !== 'slideBreak').map(block => block.attrs.id)),
    [['title', 'body', 'sub'], ['overflow'], ['heading']])
  const resized = setSlides(enabled, true, .5)
  assert.equal(resized.content, enabled.content)
  assert.equal(resized.objects, enabled.objects)
  assert.deepEqual(source, before)
  for (const height of [0, -1, NaN, Infinity]) assert.throws(() => setSlides(source, true, height), RangeError)
  const measured = setSlides(document([p('a'), p('b')]), true, 100, {
    anchors: [{ id: 'a', top: 20, bottom: 75 }, { id: 'b', top: 75, bottom: 95 }], geometry: {},
  })
  assert.equal(slideRanges(measured).length, 2)
  const leadingEmpty = document([paragraph(''), p('title', 'title')])
  assert.equal(slideRanges(setSlides(leadingEmpty, true)).length, 1)
})

test('packing keeps oversized Flow/caption compositions and signed Float offsets intact', () => {
  const source = document([p('a'), { type: 'flow', attrs: { id: 'flow', objectId: 'figure' } }, p('b')])
  source.theme.flow = { spaceBefore: px(0), spaceAfter: px(0) }
  source.objects = [
    { id: 'figure', kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', alt: '', layout: { width: 200, placement: { type: 'flow', x: 'center' } },
      caption: { width: 260, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption' }, content: [{ type: 'text', text: 'Caption' }] }] } } },
    float('note', 'flow', -15), float('unanchored', null, 100),
  ]
  const enabled = setSlides(source, true, 100, { anchors: [{ id: 'a', top: 20, bottom: 40 }, { id: 'flow', top: 40, bottom: 240 }, { id: 'b', top: 240, bottom: 260 }],
    geometry: { figure: { x: 200, y: 40, width: 200, height: 200 }, unanchored: { x: 10, y: 100, width: 30, height: 20 } } })
  validateDocument(enabled)
  assert.equal(slideRanges(enabled).length, 3)
  assert.equal(enabled.objects[0], source.objects[0])
  assert.equal(enabled.objects[1], source.objects[1])
  assert.equal(objectSlideIndex(enabled, enabled.objects[2]), 1)
  assert.equal(enabled.objects[2].layout.placement.y, 80)
})

test('boundary insert/join/disable translates slide-top Floats without losing content', () => {
  const source = document([p('a'), p('b'), p('c')])
  source.objects = [float('top', null, 30), float('at-c', 'c', 3)]
  const split = insertSlideBreak(source, 1)
  validateDocument(split)
  assert.equal(objectSlideIndex(split, split.objects[0]), 1)
  assert.equal(split.objects[0].layout.placement.y, 10)
  const joined = joinSlide(split, 1)
  validateDocument(joined)
  assert.deepEqual(joined.objects, source.objects)
  assert.deepEqual(joined.content, source.content)
  assert.deepEqual(setSlides(split, false).objects, source.objects)
  const id = slideRanges(split)[1].id
  const measured = setSlides(split, false, 540, { anchors: [{ id, top: 540 }, { id: 'b', top: 570 }], geometry: {} })
  assert.equal(measured.objects[0].layout.placement.y, 20)
  for (const index of [0, source.content.content.length]) {
    const inserted = insertSlideBreak(source, index)
    validateDocument(inserted)
    assert.equal(inserted.content.content[index === 0 ? 0 : inserted.content.content.length - 1].type, 'paragraph')
    assert.equal(slideRanges(inserted).length, 2)
  }
})

test('main editor keeps the marker atom and ordinary writable blank-slide paragraphs', () => {
  const schema = getSchema(extensions(true))
  assert.equal(schema.topNodeType.contentMatch.defaultType.name, 'paragraph')
  const source = insertSlideBreak(document(), 1)
  const editorDoc = schema.nodeFromJSON(source.content)
  editorDoc.check()
  validateDocument({ ...source, content: canonicalEditorContent(editorDoc.toJSON()) })
  assert.equal(schema.nodes.slideBreak.isAtom, true)
  assert.equal(schema.nodes.slideBreak.spec.toDOM(editorDoc.child(1))[1]['data-slide-break'], '')
  assert.equal(schema.nodes.slideBreak.spec.toDOM(editorDoc.child(1))[1]['data-id'], source.content.content[1].attrs.id)
  const plugins = SlideBreak.config.addProseMirrorPlugins.call({})
  let state = EditorState.create({ schema, doc: editorDoc, plugins })
  const end = state.doc.content.size
  state = state.applyTransaction(state.tr.delete(end - 2, end)).state
  assert.equal(state.doc.lastChild.type.name, 'paragraph')
  state = state.applyTransaction(state.tr.insertText('Typed into the new slide', state.doc.content.size - 1)).state
  assert.equal(state.doc.lastChild.textContent, 'Typed into the new slide')
  validateDocument({ ...source, content: canonicalEditorContent(state.doc.toJSON()) })
})
