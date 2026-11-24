import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { extractCandidate } from './extract.mjs'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { createBlankDocument } = await server.ssrLoadModule('/src/document/model.ts')
const { copySegment } = await server.ssrLoadModule('/src/document/segment.ts')
const { makeSegmentTarget } = await server.ssrLoadModule('/src/ai/segments.ts')
const paragraph = id => ({ type: 'paragraph', attrs: { id, semantic: 'body' }, content: [] })
const protocol = 'mote-agent-v7'

test('copy-edit extraction preserves segment semantics, shorthand, partial spacers and empty boundaries', () => {
  const document = { ...createBlankDocument(), content: { type: 'doc', content: [
    paragraph('before'), { type: 'spacer', attrs: { id: 'space', height: 100 } },
    { type: 'flow', attrs: { id: 'flow', objectId: 'figure' } }, paragraph('after'),
  ] }, objects: [
    { id: 'note', kind: 'text', content: { type: 'doc', content: [paragraph('note-text')] }, layout: { width: 100, placement: { type: 'float', anchorId: 'space', x: 10, y: 70 } } },
    { id: 'figure', kind: 'image', src: 'data:image/svg+xml,%3Csvg%2F%3E', alt: '', layout: { width: 100, placement: { type: 'flow', x: 'center' } } },
  ] }
  const anchors = document.content.content.map((block, index) => ({ id: block.attrs.id, top: index * 100, bottom: (index + 1) * 100 }))
  const geometry = { note: { x: 10, y: 170, width: 100, height: 30 }, figure: { x: 0, y: 200, width: 100, height: 50 } }
  for (const [start, end] of [[{ index: 0, offset: 0 }, { index: 4, offset: 0 }],
    [{ index: 1, offset: 40 }, { index: 3, offset: 0 }], [{ index: 1, offset: 40 }, { index: 1, offset: 80 }],
    [{ index: 4, offset: 0 }, { index: 4, offset: 0 }]]) {
    const range = { start, end }, original = copySegment(document, range, anchors, geometry)
    const target = makeSegmentTarget(document, range, { x: 0, y: 0, width: 900, height: 400 })
    const task = { protocol, target, geometry: { geometry: original.geometry, anchorTops: original.anchorTops, originTop: original.originTop } }
    const before = structuredClone({ task, document })
    const { segment } = extractCandidate(task, { document })
    const expanded = { ...segment, objects: segment.objects.map(object => typeof object === 'string' ? document.objects.find(value => value.id === object) : object) }
    assert.deepEqual(expanded, original)
    assert.deepEqual({ task, document }, before)
    if (start.offset === 40) assert.equal(segment.objects.find(object => object.id === 'note').layout.placement.y, 30)
    const shifted = { ...document, content: { type: 'doc', content: [paragraph('inserted'), ...document.content.content] } }
    assert.deepEqual(extractCandidate(task, shifted), { summary: 'Unchanged reserved content.', segment })
  }
})

test('extraction copies individual objects and paragraphs and rejects missing targets and retired protocols', () => {
  const document = { ...createBlankDocument(), content: { type: 'doc', content: [paragraph('a'), paragraph('b')] }, objects: [{ id: 'figure', kind: 'image', src: 'bytes' }] }
  const object = extractCandidate({ protocol, target: { kind: 'object', objectId: 'figure' } }, document).object
  assert.deepEqual(object, document.objects[0]); assert.notEqual(object, document.objects[0])
  assert.deepEqual(extractCandidate({ protocol, target: { kind: 'text', blockIds: ['a', 'b'] } }, document).content, document.content.content)
  assert.throws(() => extractCandidate({ protocol, target: { kind: 'object', objectId: 'missing' } }, document), /missing/)
  assert.throws(() => extractCandidate({ protocol, target: { kind: 'text', blockIds: ['b', 'a'] } }, document), /no longer match/)
  assert.throws(() => extractCandidate({ protocol: 'mote-agent-v6' }, document), /Unsupported/)
})
