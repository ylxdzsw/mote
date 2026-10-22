import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { validateDocument as validateServerDocument } from '../server/validation.mjs'

// Vite loads the model's embedded example assets and the actual editor schema.
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { defaultTheme, paragraph, captionContent, createDocument, replaceMainContent, shiftSpaceObjects } = await server.ssrLoadModule('/src/document/model.ts')
const { flowBlock, insertFlowObject, insertDocumentObjects, convertObjectPlacement, reconcileObjectDeletions, objectPagePosition } = await server.ssrLoadModule('/src/document/flow.ts')
const { validateDocument } = await server.ssrLoadModule('/src/document/validate.ts')
const { initializeDocument } = await server.ssrLoadModule('/src/document/initialize.ts')
const { paletteEntryUsed, replacePaletteEntry } = await server.ssrLoadModule('/src/theme/palette.ts')
const { copySegment, serializeSegment, parseSegment, replaceSegment, moveSegment, segmentObjectIds } = await server.ssrLoadModule('/src/document/segment.ts')
const { copyFloating, parseFloating, importFloating, pasteFloating, floatingCopyIds } = await server.ssrLoadModule('/src/document/floatingClipboard.ts')
const { resolveGeometry, horizontalBounds, boundedTranslation, constrainCaptionResize, intersects } = await server.ssrLoadModule('/src/canvas/floatingGeometry.ts')

const p = id => ({ ...paragraph(id), attrs: { id, semantic: 'body' } })
const figure = { id: 'figure', kind: 'image', placement: 'flow', anchorId: 'flow-block', x: 30, y: 0, width: 200,
  src: 'data:image/png;base64,AA==', alt: 'Figure', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption-text' }, content: [{ type: 'text', text: 'Figure caption' }] }] }, width: 230 } }
const annotation = { id: 'annotation', kind: 'code', placement: 'float', anchorId: 'flow-block', x: -20, y: -10, width: 40, source: 'x', language: 'text', scheme: 'light' }
const doc = () => ({ version: 'V0', id: 'document', width: 800, margins: { top: 20, left: 40, right: 40, bottom: 20 }, theme: structuredClone(defaultTheme),
  content: { type: 'doc', content: [p('before'), flowBlock('figure', 'flow-block'), p('after')] }, floating: structuredClone([figure, annotation]) })
const anchors = [{ id: 'before', top: 20, bottom: 50 }, { id: 'flow-block', top: 80, bottom: 200 }, { id: 'after', top: 240, bottom: 270 }]
const geometry = { figure: { x: 70, y: 80, width: 200, height: 100 }, annotation: { x: 50, y: 70, width: 40, height: 30 } }
const options = { anchors, geometry, textLeft: 40, textWidth: 720 }
const range = { start: { index: 1, offset: 0 }, end: { index: 2, offset: 0 } }

test('centered captions contribute their overhang to movement and selection bounds', () => {
  const object = { ...figure, placement: 'float', x: 100, caption: { ...figure.caption, width: 360 } }
  const boxes = resolveGeometry([object], { figure: { width: 200, height: 150 } }, { figure: 80 })
  assert.deepEqual(horizontalBounds(boxes.figure), { left: 20, right: 380 })
  assert.equal(boxes.figure.x, 100)
  assert.deepEqual(boundedTranslation([object], boxes, ['figure'], { x: -100, y: 0 }, 800), { x: -20, y: 0 })
  assert.equal(intersects(boxes.figure, { x: 25, y: 200, width: 10, height: 10 }), true)
  const resized = { ...object, width: 100, x: 400, caption: { ...object.caption, width: 600 } }
  const box = { x: 400, y: 80, width: 100, height: 150 }
  assert.equal(constrainCaptionResize(resized, { width: 560 }, box, 960).width, 520)
  assert.equal(constrainCaptionResize(resized, { x: 480, width: 20 }, box, 960).x, 480)
  const west = constrainCaptionResize(resized, { x: 0, width: 500 }, box, 960)
  assert.deepEqual(west, { x: 100, width: 400 })
})

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
    d => { d.floating[0].attachment = null },
    d => { d.floating[0].caption = null },
    d => { d.floating[1].caption = captionContent('Not supported') },
    d => { d.floating[0].caption = captionContent('Legacy bare caption') },
    d => { d.floating[0].caption.width = 0 },
    d => { d.floating[0].caption.width = -1 },
    d => { d.floating[0].caption.width = Infinity },
    d => { d.floating[0].caption.width = '230px' },
    d => { d.floating[0].caption.content.content[0].attrs.semantic = 'caption' },
    d => { d.floating[0].caption.content.content[0].attrs.listLevel = 0 },
    d => { d.floating[0].caption.content.content.push(p('extra')) },
    d => { d.floating[0].caption.content.content[0].content.push(p('nested')) },
    d => { d.content.content[1].attrs.objectId = 'missing' },
    d => { d.content.content.push(flowBlock('figure', 'second-flow')) },
    d => { d.content.content.push(p('before')) },
    d => { d.content.content[1].content = [p('nested')] },
    d => { d.floating[1].anchorId = 'missing' },
  ]
  for (const edit of edits) { const invalid = doc(); edit(invalid); assert.throws(() => validateDocument(invalid)) }
})

test('captions use one id-only paragraph and participate in palette replacement', () => {
  const empty = captionContent()
  assert.equal(empty.type, 'doc')
  assert.equal(empty.content.length, 1)
  assert.deepEqual(Object.keys(empty.content[0].attrs), ['id'])
  const source = doc()
  assert.equal(source.floating[0].caption.width, 230)
  source.floating[0].caption.content.content[0].content[0].marks = [{ type: 'color', attrs: { color: 'detail' } }]
  assert.equal(paletteEntryUsed(source, 'detail'), true)
  const replaced = replacePaletteEntry(source, 'detail', 'muted')
  assert.equal(replaced.floating[0].caption.content.content[0].content[0].marks[0].attrs.color, 'muted')
  assert.equal(replaced.floating[0].caption.width, 230)
  initializeDocument(replaced)
})

test('text-box decorations validate and retain their palette through replacement and clipboard', () => {
  const source = doc()
  source.floating[0].src = 'data:image/png;base64,iVBORw0KGgo='
  const note = { id: 'note', kind: 'text', placement: 'float', anchorId: 'before', x: 0, y: 0, width: 200,
    content: { type: 'doc', content: [p('note-text')] }, background: 'paper', borderColor: 'term', decoration: { kind: 'info', color: 'info' } }
  source.floating.push(note)
  for (const validate of [value => { validateDocument(value); initializeDocument(value) }, validateServerDocument]) {
    validate(source)
    for (const decoration of [{ kind: 'unknown', color: 'info' }, { kind: 'info', color: 'missing' }, 'info']) {
      const invalid = structuredClone(source); invalid.floating.at(-1).decoration = decoration
      assert.throws(() => validate(invalid))
    }
    const invalid = structuredClone(source); invalid.floating[0].decoration = note.decoration
    assert.throws(() => validate(invalid))
  }
  assert.equal(paletteEntryUsed(source, 'info'), true)
  const replaced = replacePaletteEntry(source, 'info', 'detail')
  assert.deepEqual(replaced.floating.at(-1).decoration, { kind: 'info', color: 'detail' })
  initializeDocument(replaced); validateServerDocument(replaced)
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['note']), { note: { x: 0, y: 20, width: 200, height: 50 } })))
  assert.ok(payload.palette.some(entry => entry.id === 'info'))
  const destination = doc()
  destination.floating[0].src = source.floating[0].src
  destination.theme.palette.find(entry => entry.id === 'info').strong = '#112233'
  const pasted = pasteFloating(destination, payload, anchors)
  const copied = pasted.floating.at(-1)
  assert.notEqual(copied.decoration.color, 'info')
  assert.equal(pasted.theme.palette.find(entry => entry.id === copied.decoration.color).strong, source.theme.palette.find(entry => entry.id === 'info').strong)
  assert.equal(copied.background, 'paper'); assert.equal(copied.borderColor, 'term')
  initializeDocument(pasted); validateServerDocument(pasted)
})

test('structural insertion and conversion preserve bindings and measured annotation geometry', () => {
  const source = doc()
  const converted = convertObjectPlacement(source, 'figure', 'float', options)
  validateDocument(converted)
  assert.deepEqual(converted.content.content.map(block => block.type), ['paragraph', 'paragraph'])
  for (const id of ['figure', 'annotation']) assert.deepEqual(objectPagePosition(converted, converted.floating.find(object => object.id === id), { anchors }), { x: geometry[id].x, y: geometry[id].y })
  const restored = convertObjectPlacement(converted, 'figure', 'flow', { ...options, index: 1, centered: true })
  validateDocument(restored)
  assert.deepEqual(restored.floating[0].caption, source.floating[0].caption)
  assert.equal(restored.floating[0].y, 0)
  assert.equal(restored.floating[0].centered, true)
  assert.deepEqual(objectPagePosition(restored, restored.floating[0], { anchors: [{ id: restored.floating[0].anchorId, top: 80 }] }), { x: 300, y: 80 })
  const inserted = insertFlowObject(source, { ...figure, id: 'another', caption: { content: captionContent('Another figure'), width: 180 }, placement: 'float', anchorId: null, y: 100 }, 2)
  validateDocument(inserted)
  assert.equal(inserted.content.content[2].attrs.objectId, 'another')
})

test('main Flow block and object deletion preserve surviving annotations and remove the owner caption', () => {
  const source = doc()
  const content = { ...source.content, content: source.content.content.filter(block => block.type !== 'flow') }
  for (const result of [replaceMainContent(source, content, [], undefined, options), reconcileObjectDeletions(source, source.floating.filter(object => object.id !== 'figure'), options)]) {
    validateDocument(result)
    assert.deepEqual(result.floating.map(object => object.id), ['annotation'])
    assert.deepEqual(objectPagePosition(result, result.floating[0], { anchors }), { x: geometry.annotation.x, y: geometry.annotation.y })
  }
  const shifted = shiftSpaceObjects(source.floating, { anchors, from: 0, delta: 50 })
  assert.equal(shifted[0].y, 0)
  assert.equal(shifted[1].y, -10)
})

test('Flow segments include owner captions and annotations, paste remaps paragraph IDs, reorder preserves IDs', () => {
  const source = doc()
  assert.deepEqual([...segmentObjectIds(source, range)].sort(), ['annotation', 'figure'])
  const payload = parseSegment(serializeSegment(copySegment(source, range, anchors, geometry)))
  const target = { start: { index: 3, offset: 0 }, end: { index: 3, offset: 0 } }
  const pasted = replaceSegment(source, target, payload, anchors, geometry)
  validateDocument(pasted)
  const added = pasted.floating.slice(2), block = pasted.content.content.at(-1)
  assert.equal(block.type, 'flow')
  assert.equal(block.attrs.objectId, added[0].id)
  assert.notEqual(block.attrs.id, 'flow-block')
  assert.equal(added[0].anchorId, block.attrs.id)
  assert.equal(added[1].anchorId, block.attrs.id)
  assert.deepEqual([added[1].x, added[1].y], [-20, -10])
  assert.equal(added[0].caption.content.content[0].content[0].text, 'Figure caption')
  assert.notEqual(added[0].caption.content.content[0].attrs.id, 'caption-text')
  assert.equal(added[0].caption.width, 230)
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
  assert.deepEqual([...floatingCopyIds(source.floating, ['figure'])].sort(), ['annotation', 'figure'])
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
  source.floating.push({ ...figure, id: 'previous', caption: { content: captionContent('Previous figure'), width: 245 }, anchorId: 'previous-flow', x: 260 })
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

test('object copying owns captions and gives their paragraph IDs fresh values', () => {
  const source = doc()
  assert.deepEqual([...floatingCopyIds(source.floating, ['figure'])].sort(), ['annotation', 'figure'])
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['figure']), geometry)))
  const imported = importFloating(source, payload, anchors)
  const copied = imported.floating.find(object => object.kind === 'image')
  assert.equal(copied.caption.content.content[0].content[0].text, 'Figure caption')
  assert.notEqual(copied.caption.content.content[0].attrs.id, source.floating[0].caption.content.content[0].attrs.id)
  assert.equal(source.floating[0].caption.content.content[0].attrs.id, 'caption-text')
  assert.equal(copied.caption.width, 230)
})

test('floating clipboard remaps palette references from embedded captions', () => {
  const source = doc(), destination = doc()
  const entry = { id: 'caption-shade', name: 'Caption shade', strong: '#123456', soft: '#abcdef' }
  source.theme.palette.push(entry)
  destination.theme.palette.push({ ...entry, name: 'Different shade', strong: '#654321', soft: '#fedcba' })
  source.floating[0].caption.content.content[0].content[0].marks = [{ type: 'color', attrs: { color: entry.id } }]
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['figure']), geometry)))
  const pasted = pasteFloating(destination, payload, anchors)
  validateDocument(pasted)
  const copied = pasted.floating.at(-2)
  const reference = copied.caption.content.content[0].content[0].marks[0].attrs.color
  assert.notEqual(reference, entry.id)
  assert.ok(pasted.theme.palette.some(value => value.id === reference))
  assert.equal(copied.caption.width, 230)
})

test('the example embeds image, table, and widget captions but no drawing caption', () => {
  const example = createDocument()
  const objects = example.floating
  assert.equal(objects.filter(object => object.kind === 'image').every(object => !!object.caption), true)
  assert.equal(objects.filter(object => object.kind === 'table').every(object => !!object.caption), true)
  assert.equal(objects.filter(object => object.kind === 'html').every(object => !!object.caption), true)
  assert.equal(objects.filter(object => object.caption).every(object => object.caption.content.type === 'doc'), true)
  assert.equal(objects.filter(object => object.kind === 'drawing').every(object => !object.caption), true)
  initializeDocument(example)
})

test('deleting an ordinary anchor converts page coordinates when its predecessor is Flow', () => {
  const source = doc()
  source.floating.push({ ...annotation, id: 'tail', anchorId: 'after', x: 450, y: 10 })
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
