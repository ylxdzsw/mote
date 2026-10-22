import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

// Vite loads the model's embedded example assets and the actual editor schema.
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { defaultTheme, paragraph, replaceMainContent, shiftSpaceObjects } = await server.ssrLoadModule('/src/document/model.ts')
const { flowBlock, insertFlowObject, insertDocumentObjects, convertObjectPlacement, reconcileObjectDeletions, objectPagePosition } = await server.ssrLoadModule('/src/document/flow.ts')
const { validateDocument } = await server.ssrLoadModule('/src/document/validate.ts')
const { initializeDocument } = await server.ssrLoadModule('/src/document/initialize.ts')
const { copySegment, serializeSegment, parseSegment, replaceSegment, moveSegment, segmentObjectIds } = await server.ssrLoadModule('/src/document/segment.ts')
const { copyFloating, parseFloating, importFloating, pasteFloating, floatingCopyIds } = await server.ssrLoadModule('/src/document/floatingClipboard.ts')

const p = id => ({ ...paragraph(id), attrs: { id, semantic: 'body' } })
const figure = { id: 'figure', kind: 'code', placement: 'flow', anchorId: 'flow-block', x: 30, y: 0, width: 200, source: 'x', language: 'text', scheme: 'light' }
const annotation = { ...figure, id: 'annotation', placement: 'float', x: -20, y: -10, width: 40 }
const caption = { id: 'caption', placement: 'float', anchorId: 'after', x: 0, y: 0, width: 200,
  attachment: { targetId: 'figure', position: 'below' }, content: { type: 'doc', content: [p('caption-text')] } }
const doc = () => ({ version: 'V0', id: 'document', width: 800, margins: { top: 20, left: 40, right: 40, bottom: 20 }, theme: structuredClone(defaultTheme),
  content: { type: 'doc', content: [p('before'), flowBlock('figure', 'flow-block'), p('after')] }, floating: structuredClone([figure, annotation, caption]) })
const anchors = [{ id: 'before', top: 20, bottom: 50 }, { id: 'flow-block', top: 80, bottom: 200 }, { id: 'after', top: 240, bottom: 270 }]
const geometry = { figure: { x: 70, y: 80, width: 200, height: 100 }, annotation: { x: 50, y: 70, width: 40, height: 30 }, caption: { x: 70, y: 188, width: 200, height: 20 } }
const options = { anchors, geometry, textLeft: 40, textWidth: 720 }
const range = { start: { index: 1, offset: 0 }, end: { index: 2, offset: 0 } }

test('Flow validation enforces the block/object bijection and actual schema retains atoms', () => {
  const source = doc()
  initializeDocument(source)
  assert.equal(source.content.content[1].attrs.objectId, 'figure')
  const edits = [
    d => { d.floating[0].placement = 'float' },
    d => { d.floating[0].anchorId = 'before' },
    d => { d.floating[0].y = 1 },
    d => { d.floating[0].centered = 'yes' },
    d => { d.floating[0].textFlow = 'repel' },
    d => { d.content.content[1].attrs.objectId = 'missing' },
    d => { d.content.content.push(flowBlock('figure', 'second-flow')) },
    d => { d.content.content.push(p('before')) },
    d => { d.content.content[1].content = [p('nested')] },
    d => { d.floating[1].anchorId = 'missing' },
    d => { d.floating[2].placement = 'flow' },
    d => { d.floating[2].content.content.push(flowBlock('figure', 'nested-flow')) },
  ]
  for (const edit of edits) { const invalid = doc(); edit(invalid); assert.throws(() => validateDocument(invalid)) }
})

test('structural insertion and conversion preserve bindings and measured annotation geometry', () => {
  const source = doc()
  const converted = convertObjectPlacement(source, 'figure', 'float', options)
  validateDocument(converted)
  assert.deepEqual(converted.content.content.map(block => block.type), ['paragraph', 'paragraph'])
  for (const id of ['figure', 'annotation']) assert.deepEqual(objectPagePosition(converted, converted.floating.find(object => object.id === id), { anchors }), { x: geometry[id].x, y: geometry[id].y })
  const restored = convertObjectPlacement(converted, 'figure', 'flow', { ...options, index: 1, centered: true })
  validateDocument(restored)
  assert.equal(restored.floating[0].y, 0)
  assert.equal(restored.floating[0].centered, true)
  assert.deepEqual(objectPagePosition(restored, restored.floating[0], { anchors: [{ id: restored.floating[0].anchorId, top: 80 }] }), { x: 300, y: 80 })
  const inserted = insertFlowObject(source, { ...figure, id: 'another', placement: 'float', anchorId: null, y: 100 }, 2)
  validateDocument(inserted)
  assert.equal(inserted.content.content[2].attrs.objectId, 'another')
  assert.throws(() => convertObjectPlacement(source, 'caption', 'flow', options), /caption/)
})

test('main Flow block and object deletion preserve surviving annotations and detach captions', () => {
  const source = doc()
  const content = { ...source.content, content: source.content.content.filter(block => block.type !== 'flow') }
  for (const result of [replaceMainContent(source, content, [], undefined, options), reconcileObjectDeletions(source, source.floating.filter(object => object.id !== 'figure'), options)]) {
    validateDocument(result)
    assert.deepEqual(result.floating.map(object => object.id), ['annotation', 'caption'])
    assert.equal(result.floating[1].attachment, null)
    for (const object of result.floating) assert.deepEqual(objectPagePosition(result, object, { anchors }), { x: geometry[object.id].x, y: geometry[object.id].y })
  }
  const shifted = shiftSpaceObjects(source.floating, { anchors, from: 0, delta: 50 })
  assert.equal(shifted[0].y, 0)
  assert.equal(shifted[1].y, -10)
})

test('Flow segments include annotations and captions, paste remaps both namespaces, reorder preserves IDs', () => {
  const source = doc()
  assert.deepEqual([...segmentObjectIds(source, range)].sort(), ['annotation', 'caption', 'figure'])
  const payload = parseSegment(serializeSegment(copySegment(source, range, anchors, geometry)))
  const target = { start: { index: 3, offset: 0 }, end: { index: 3, offset: 0 } }
  const pasted = replaceSegment(source, target, payload, anchors, geometry)
  validateDocument(pasted)
  const added = pasted.floating.slice(3), block = pasted.content.content.at(-1)
  assert.equal(block.type, 'flow')
  assert.equal(block.attrs.objectId, added[0].id)
  assert.notEqual(block.attrs.id, 'flow-block')
  assert.equal(added[0].anchorId, block.attrs.id)
  assert.equal(added[1].anchorId, block.attrs.id)
  assert.deepEqual([added[1].x, added[1].y], [-20, -10])
  assert.equal(added[2].attachment.targetId, added[0].id)
  const moved = moveSegment(source, range, { index: 3, offset: 0 }, anchors, geometry).doc
  validateDocument(moved)
  assert.deepEqual(moved.content.content.map(block => block.attrs.id), ['before', 'after', 'flow-block'])
  assert.deepEqual(moved.floating.slice(0, 2), source.floating.slice(0, 2))
  const deleted = replaceSegment(source, range, null, anchors, geometry)
  validateDocument(deleted)
  assert.equal(deleted.floating.length, 0)
})

test('object clipboard recreates Flow blocks and preserves offsets while standalone annotations detach', () => {
  const source = doc()
  assert.deepEqual([...floatingCopyIds(source.floating, ['figure'])].sort(), ['annotation', 'caption', 'figure'])
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['figure']), geometry)))
  const imported = importFloating(source, payload, anchors)
  const pasted = insertDocumentObjects(source, imported.floating, 1, imported.content)
  validateDocument(pasted)
  assert.equal(pasted.content.content[1].attrs.objectId, imported.floating[0].id)
  assert.deepEqual([imported.floating[0].x, imported.floating[0].y], [30, 0])
  assert.deepEqual([imported.floating[1].x, imported.floating[1].y], [-20, -10])
  assert.equal(imported.floating[1].anchorId, imported.floating[0].anchorId)
  validateDocument(pasteFloating(source, payload, anchors))
  const alone = parseFloating(JSON.stringify(copyFloating(source, new Set(['annotation']), geometry)))
  assert.equal(alone.content.length, 0)
  assert.equal(alone.floating[0].anchorId, null)
  assert.deepEqual([alone.floating[0].x, alone.floating[0].y], [50, 70])
})

test('imported groups recreate missing Flow blocks and deletion can reanchor to another Flow', () => {
  const source = doc()
  const empty = { ...source, content: { type: 'doc', content: [p('start')] }, floating: [] }
  const inserted = insertDocumentObjects(empty, [figure, annotation])
  validateDocument(inserted)
  assert.equal(inserted.floating[0].anchorId, inserted.floating[1].anchorId)
  assert.notEqual(inserted.floating[0].anchorId, figure.anchorId)
  source.content.content.splice(1, 0, flowBlock('previous', 'previous-flow'))
  source.floating.push({ ...figure, id: 'previous', anchorId: 'previous-flow', x: 260 })
  const measured = { ...options, anchors: [{ id: 'before', top: 20 }, { id: 'previous-flow', top: 45 }, ...anchors.slice(1)],
    geometry: { ...geometry, previous: { x: 300, y: 45, width: 200, height: 20 } } }
  const removed = reconcileObjectDeletions(source, source.floating.filter(object => object.id !== 'figure'), measured)
  validateDocument(removed)
  const note = removed.floating.find(object => object.id === 'annotation')
  assert.equal(note.anchorId, 'previous-flow')
  assert.deepEqual([note.x, note.y], [-250, 25])
  const converted = convertObjectPlacement(source, 'figure', 'float', measured)
  validateDocument(converted)
  assert.deepEqual([converted.floating[0].x, converted.floating[0].y], [-230, 35])
})

test('captions with stale Flow anchors only follow their target in object copying', () => {
  const source = doc()
  source.floating.push({ ...figure, id: 'other', placement: 'float', anchorId: 'before', x: 400, y: 50 })
  source.floating[2].anchorId = 'flow-block'
  source.floating[2].attachment.targetId = 'other'
  assert.deepEqual([...floatingCopyIds(source.floating, ['figure'])].sort(), ['annotation', 'figure'])
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['figure', 'caption']), geometry)))
  const detached = payload.floating.find(object => object.id === 'caption')
  assert.equal(detached.attachment, null)
  assert.deepEqual([detached.x, detached.y], [0, 108])
})

test('deleting an ordinary anchor converts page coordinates when its predecessor is Flow', () => {
  const source = doc()
  source.floating.push({ ...figure, id: 'tail', placement: 'float', anchorId: 'after', x: 450, y: 10 })
  const result = replaceMainContent(source, { ...source.content, content: source.content.content.slice(0, 2) }, [], undefined,
    { ...options, geometry: { ...geometry, tail: { x: 450, y: 250, width: 200, height: 20 } } })
  validateDocument(result)
  const tail = result.floating.find(object => object.id === 'tail')
  assert.equal(tail.anchorId, 'flow-block')
  assert.deepEqual([tail.x, tail.y], [380, 170])
})

test('editing main text preserves signed offsets on surviving Flow anchors', () => {
  const source = doc(), content = structuredClone(source.content)
  content.content[0].content = [{ type: 'text', text: 'An edited introduction' }]
  const result = replaceMainContent(source, content, [], undefined, options)
  validateDocument(result)
  assert.deepEqual(result.floating.find(object => object.id === 'annotation'), source.floating.find(object => object.id === 'annotation'))
})
