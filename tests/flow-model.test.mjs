import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { validateDocument as validateServerDocument } from '../shared/document.mjs'
import { pageColor, contrastRatio } from '../shared/palette.mjs'

// Vite loads the model's embedded example assets and the actual editor schema.
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { patchObject, objectAnchorId, objectX, objectY, px, em, defaultTheme, paragraph, captionContent, createBlankDocument, isPristineBlankDocument, createDocument, replaceMainContent, shiftSpaceObjects } = await server.ssrLoadModule('/src/document/model.ts')
const { flowBlock, insertFlowObject, insertDocumentObjects, convertObjectPlacement, reconcileObjectDeletions, objectPagePosition } = await server.ssrLoadModule('/src/document/flow.ts')
const { validateDocument } = await server.ssrLoadModule('/src/document/validate.ts')
const { initializeDocument } = await server.ssrLoadModule('/src/document/initialize.ts')
const { paletteColor, paletteEntries } = await server.ssrLoadModule('/src/theme/palette.ts')
const { copyParagraphs, parseParagraphs } = await server.ssrLoadModule('/src/document/paragraphClipboard.ts')
const { copySegment, serializeSegment, parseSegment, replaceSegment, moveSegment, segmentObjectIds } = await server.ssrLoadModule('/src/document/segment.ts')
const { copyFloating, parseFloating, importFloating, pasteFloating, floatingCopyIds } = await server.ssrLoadModule('/src/document/floatingClipboard.ts')
const { resolveGeometry, horizontalBounds, layoutBounds, extentBounds, flowX, boundedTranslation, constrainCaptionResize, intersects } = await server.ssrLoadModule('/src/canvas/floatingGeometry.ts')
const { canonicalEditorContent } = await server.ssrLoadModule('/src/editor/canonical.ts')
const { themeVariables } = await server.ssrLoadModule('/src/theme/ThemePanel.tsx')
const { extensions } = await server.ssrLoadModule('/src/editor/extensions.ts')
const { getSchema } = await import('@tiptap/core')

const p = id => ({ ...paragraph(id), attrs: { id, semantic: 'body' } })
const figure = { id: 'figure', kind: 'image', layout: { width: 200, placement: { type: 'flow', x: 30 } },
  src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Figure', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption-text' }, content: [{ type: 'text', text: 'Figure caption' }] }] }, width: 230 } }
const annotation = { id: 'annotation', kind: 'code', layout: { width: 40, placement: { type: 'float', anchorId: 'flow-block', x: -20, y: -10 } }, source: 'x', language: 'text' }
const doc = () => ({ format: 'mote', version: 1, language: 'en', id: 'document', page: { width: 800, margins: { top: 20, left: 40, right: 40, bottom: 20 } }, theme: structuredClone(defaultTheme),
  content: { type: 'doc', content: [p('before'), flowBlock('figure', 'flow-block'), p('after')] }, objects: structuredClone([figure, annotation]) })
const anchors = [{ id: 'before', top: 20, bottom: 50 }, { id: 'flow-block', top: 80, bottom: 200 }, { id: 'after', top: 240, bottom: 270 }]
const geometry = { figure: { x: 70, y: 80, width: 200, height: 100 }, annotation: { x: 50, y: 70, width: 40, height: 30 } }
const options = { anchors, geometry, textLeft: 40, textWidth: 720 }
const range = { start: { index: 1, offset: 0 }, end: { index: 2, offset: 0 } }

test('only a default single empty body paragraph is a pristine blank document', () => {
  const blank = initializeDocument(createBlankDocument())
  assert.equal(isPristineBlankDocument(blank), true)
  assert.equal(isPristineBlankDocument({ ...blank, language: 'en', authoring: { aiModel: ' ', notes: ['', ''] }, theme: { ...blank.theme, autospace: true } }), true)
  for (const change of [
    d => { d.content.content[0].content = [{ type: 'text', text: ' ' }] },
    d => { d.content.content.push(paragraph('')) },
    d => { d.content.content[0].attrs.semantic = 'heading' },
    d => { d.content.content[0].attrs.listLevel = 1 },
    d => { d.content.content = [{ type: 'spacer', attrs: { id: crypto.randomUUID(), height: 20 } }] },
    d => { d.objects.push({ ...annotation }) },
    d => { d.authoring = { notes: ['An internal thought'] } },
    d => { d.page.width++ },
    d => { d.page.margins.left++ },
    d => { d.theme.appearance.primaryHue++ },
    d => { d.theme.appearance.secondaryHue++ },
    d => { d.theme.appearance.mode = 'dark' },
    d => { d.theme.autospace = false },
    d => { d.language = 'zh-Hans' },
    d => { d.authoring = { notes: [], aiModel: 'custom-model' } },
  ]) {
    const document = structuredClone(blank)
    change(document)
    assert.equal(isPristineBlankDocument(document), false)
  }
  assert.equal(isPristineBlankDocument(createDocument()), false)
  const defaults = { mode: 'dark', language: 'zh-Hans' }
  const remembered = { ...blank, language: defaults.language, theme: { ...blank.theme, appearance: { ...blank.theme.appearance, mode: defaults.mode } } }
  assert.equal(isPristineBlankDocument(remembered, defaults), true)
  assert.equal(isPristineBlankDocument({ ...remembered, language: 'en' }, defaults), false)
  assert.equal(isPristineBlankDocument({ ...remembered, theme: { ...remembered.theme, appearance: { ...remembered.theme.appearance, mode: 'light' } } }, defaults), false)
  assert.equal(isPristineBlankDocument({ ...remembered, authoring: { notes: ['Keep this'] } }, defaults), false)
})

test('centered captions contribute their overhang to movement and selection bounds', () => {
  const object = patchObject(figure, { placement: 'float', x: 100, caption: { ...figure.caption, width: 360 } })
  const boxes = resolveGeometry([object], { figure: { width: 200, height: 150 } }, { figure: 80 })
  assert.deepEqual(horizontalBounds(boxes.figure), { left: 20, right: 380 })
  assert.equal(boxes.figure.x, 100)
  assert.deepEqual(boundedTranslation([object], boxes, ['figure'], { x: -100, y: 0 }, 800), { x: -20, y: 0 })
  assert.equal(intersects(boxes.figure, { x: 25, y: 200, width: 10, height: 10 }), true)
  const resized = patchObject(object, { width: 100, x: 400, caption: { ...object.caption, width: 600 } })
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
    d => { d.objects[0].layout.placement = { type: 'float', anchorId: 'before', x: 30, y: 0 } },
    d => { d.objects[0].layout.placement.anchorId = 'before' },
    d => { d.objects[0].layout.placement.y = 1 },
    d => { d.objects[0].layout.placement.x = 'yes' },
    d => { d.objects[0].textFlow = 'repel' },
    d => { d.objects[0].attachment = null },
    d => { d.objects[0].caption = null },
    d => { d.objects[1].caption = captionContent('Not supported') },
    d => { d.objects[0].caption = captionContent('Legacy bare caption') },
    d => { d.objects[0].caption.width = 0 },
    d => { d.objects[0].caption.width = -1 },
    d => { d.objects[0].caption.width = Infinity },
    d => { d.objects[0].caption.width = '230px' },
    d => { d.objects[0].caption.content.content[0].attrs.semantic = 'caption' },
    d => { d.objects[0].caption.content.content[0].attrs.listLevel = 0 },
    d => { d.objects[0].caption.content.content.push(p('extra')) },
    d => { d.objects[0].caption.content.content[0].content.push(p('nested')) },
    d => { d.content.content[1].attrs.objectId = 'missing' },
    d => { d.content.content.push(flowBlock('figure', 'second-flow')) },
    d => { d.content.content.push(p('before')) },
    d => { d.content.content[1].content = [p('nested')] },
    d => { d.objects[1].layout.placement.anchorId = 'missing' },
  ]
  for (const edit of edits) { const invalid = doc(); edit(invalid); assert.throws(() => validateDocument(invalid)) }
})

test('signed object margins change layout footprints without shrinking visible bounds and survive structural copying', () => {
  const margins = { top: -8, right: -20, bottom: 24, left: 40 }
  const object = patchObject(figure, { centered: true, margins })
  const box = { x: 100, y: 80, width: 200, height: 100, captionWidth: 240, margins }
  assert.deepEqual(horizontalBounds(box), { left: 80, right: 320 })
  assert.deepEqual(layoutBounds(box), { x: 40, y: 88, width: 260, height: 116 })
  assert.deepEqual(extentBounds(box), { x: 40, y: 80, width: 280, height: 124 })
  assert.equal(flowX(object, 720), 290)
  assert.deepEqual(layoutBounds({ ...box, margins: { top: -120, right: -300, bottom: 0, left: 0 } }), { x: 80, y: 200, width: 0, height: 0 })
  const source = doc()
  source.objects[0].layout.margins = margins
  source.objects[0].src = 'data:image/png;base64,iVBORw0KGgo='
  source.theme.flow = { spaceBefore: em(1.5), spaceAfter: px(32) }
  validateDocument(source); validateServerDocument(source); initializeDocument(source)
  const copied = parseFloating(JSON.stringify(copyFloating(source, new Set(['figure']), geometry)))
  assert.deepEqual(copied.objects[0].layout.margins, margins)
  assert.deepEqual(convertObjectPlacement(source, 'figure', 'float', options).objects[0].layout.margins, margins)
  for (const mutate of [d => { d.theme.flow.spaceBefore = -1 }, d => { d.objects[0].layout.margins.top = '1px' }, d => { delete d.objects[0].layout.margins.left }]) {
    const invalid = structuredClone(source); mutate(invalid)
    assert.throws(() => validateDocument(invalid)); assert.throws(() => validateServerDocument(invalid))
  }
})

test('captions use one id-only paragraph and fixed color references', () => {
  const empty = captionContent()
  assert.equal(empty.type, 'doc')
  assert.equal(empty.content.length, 1)
  assert.deepEqual(Object.keys(empty.content[0].attrs), ['id'])
  const source = doc()
  source.objects[0].caption.content.content[0].content[0].marks = [{ type: 'color', attrs: { color: 'secondary:soft' } }]
  assert.equal(source.objects[0].caption.width, 230)
  initializeDocument(source)
})

test('text-box decorations pick one color pair and keep the destination theme on paste', () => {
  const source = doc()
  source.objects[0].src = 'data:image/png;base64,iVBORw0KGgo='
  const note = { id: 'note', kind: 'text', layout: { width: 200, placement: { type: 'float', anchorId: 'before', x: 0, y: 0 } },
    content: { type: 'doc', content: [p('note-text')] }, decoration: { kind: 'left', color: 'blue' } }
  source.objects.push(note)
  for (const validate of [value => { validateDocument(value); initializeDocument(value) }, validateServerDocument]) {
    validate(source)
    for (const decoration of [{ kind: 'info', color: 'blue' }, { kind: 'box', color: 'blue:soft' }, { kind: 'box', color: 'gray6' }, 'box']) {
      const invalid = structuredClone(source); invalid.objects.at(-1).decoration = decoration
      assert.throws(() => validate(invalid))
    }
    for (const key of ['background', 'borderColor']) {
      const invalid = structuredClone(source); invalid.objects.at(-1)[key] = null
      assert.throws(() => validate(invalid))
    }
    const invalid = structuredClone(source); invalid.objects[0].decoration = note.decoration
    assert.throws(() => validate(invalid))
  }
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['note']), { note: { x: 0, y: 20, width: 200, height: 50 } })))
  assert.equal('palette' in payload, false)
  const destination = doc()
  destination.objects[0].src = source.objects[0].src
  Object.assign(destination.theme.appearance, { mode: 'dark', primaryHue: 220, secondaryHue: 300 })
  const pasted = pasteFloating(destination, payload, anchors)
  const copied = pasted.objects.at(-1)
  assert.equal(pasted.theme, destination.theme)
  assert.deepEqual(copied.decoration, note.decoration)
  initializeDocument(pasted); validateServerDocument(pasted)
})

test('fixed palette retains readable pairs across all theme hues and both modes', () => {
  for (const mode of ['light', 'dark']) for (let hue = 0; hue < 360; hue++) {
    const theme = { ...defaultTheme, appearance: { mode, primaryHue: hue, secondaryHue: hue } }
    const entries = paletteEntries(theme)
    assert.equal(entries.length, 14)
    assert.equal(entries.filter(entry => entry.soft).length, 8)
    assert.equal(paletteColor(theme, 'gray1'), mode === 'light' ? '#000000' : '#ffffff')
    assert.equal(paletteColor(theme, 'gray6'), mode === 'light' ? '#ffffff' : '#000000')
    for (const entry of entries.filter(entry => entry.soft)) {
      for (const [foreground, background] of [[entry.strong, pageColor(theme)], [entry.strong, entry.soft], [paletteColor(theme, 'gray2'), entry.soft]]) {
        assert.ok(contrastRatio(foreground, background) >= 4.5, `${mode} ${hue} ${entry.id}`)
      }
    }
  }
})

test('native themes reject legacy palette/background and drawings accept only gray6 or null', () => {
  const source = doc()
  source.objects[0].src = 'data:image/png;base64,iVBORw0KGgo='
  const drawing = { id: 'drawing', kind: 'drawing', layout: { width: 200, height: 100, placement: { type: 'float', anchorId: 'before', x: 0, y: 0 } },
    strokes: [], labels: [], background: 'gray6' }
  source.objects.push(drawing)
  for (const validate of [value => { validateDocument(value); initializeDocument(value) }, validateServerDocument]) {
    validate(source)
    for (const change of [
      value => { value.theme.palette = [] },
      value => { value.theme.defaults.background = 'gray6' },
      value => { delete value.theme.appearance.mode },
      value => { value.theme.appearance.mode = 'sepia' },
      value => { value.theme.appearance.secondaryHue = 360 },
      value => { value.theme.appearance.secondaryHue = -1 },
      value => { delete value.theme.appearance.secondaryHue },
      value => { value.objects.at(-1).background = 'paper' },
      value => { value.objects.at(-1).background = 'gray5' },
    ]) {
      const invalid = structuredClone(source); change(invalid)
      assert.throws(() => validate(invalid))
    }
    const transparent = structuredClone(source); transparent.objects.at(-1).background = null
    validate(transparent)
  }
})

test('structural insertion and conversion preserve bindings and measured annotation geometry', () => {
  const source = doc()
  const converted = convertObjectPlacement(source, 'figure', 'float', options)
  validateDocument(converted)
  assert.deepEqual(converted.content.content.map(block => block.type), ['paragraph', 'paragraph'])
  for (const id of ['figure', 'annotation']) assert.deepEqual(objectPagePosition(converted, converted.objects.find(object => object.id === id), { anchors }), { x: geometry[id].x, y: geometry[id].y })
  const restored = convertObjectPlacement(converted, 'figure', 'flow', { ...options, index: 1, centered: true })
  validateDocument(restored)
  assert.deepEqual(restored.objects[0].caption, source.objects[0].caption)
  assert.equal(objectY(restored.objects[0]), 0)
  assert.equal((restored.objects[0].layout.placement.x === 'center'), true)
  assert.deepEqual(objectPagePosition(restored, restored.objects[0], { anchors: [{ id: objectAnchorId(restored.objects[0], restored.content), top: 80 }] }), { x: 300, y: 80 })
  const inserted = insertFlowObject(source, patchObject({ ...figure, id: 'another', caption: { content: captionContent('Another figure'), width: 180 } }, { placement: 'float', anchorId: null, y: 100 }), 2)
  validateDocument(inserted)
  assert.equal(inserted.content.content[2].attrs.objectId, 'another')
})

test('main Flow block and object deletion preserve surviving annotations and remove the owner caption', () => {
  const source = doc()
  const content = { ...source.content, content: source.content.content.filter(block => block.type !== 'flow') }
  for (const result of [replaceMainContent(source, content, [], undefined, options), reconcileObjectDeletions(source, source.objects.filter(object => object.id !== 'figure'), options)]) {
    validateDocument(result)
    assert.deepEqual(result.objects.map(object => object.id), ['annotation'])
    assert.deepEqual(objectPagePosition(result, result.objects[0], { anchors }), { x: geometry.annotation.x, y: geometry.annotation.y })
  }
  const shifted = shiftSpaceObjects(source.objects, { anchors, from: 0, delta: 50 }, source.content)
  assert.equal(objectY(shifted[0]), 0)
  assert.equal(objectY(shifted[1]), -10)
})

test('Flow segments include owner captions and annotations, paste remaps paragraph IDs, reorder preserves IDs', () => {
  const source = doc()
  assert.deepEqual([...segmentObjectIds(source, range)].sort(), ['annotation', 'figure'])
  const payload = parseSegment(serializeSegment(copySegment(source, range, anchors, geometry)))
  const target = { start: { index: 3, offset: 0 }, end: { index: 3, offset: 0 } }
  const pasted = replaceSegment(source, target, payload, anchors, geometry)
  validateDocument(pasted)
  const added = pasted.objects.slice(2), block = pasted.content.content.at(-1)
  assert.equal(block.type, 'flow')
  assert.equal(block.attrs.objectId, added[0].id)
  assert.notEqual(block.attrs.id, 'flow-block')
  assert.equal(objectAnchorId(added[0], pasted.content), block.attrs.id)
  assert.equal(objectAnchorId(added[1]), block.attrs.id)
  assert.deepEqual([objectX(added[1]), objectY(added[1])], [-20, -10])
  assert.equal(added[0].caption.content.content[0].content[0].text, 'Figure caption')
  assert.notEqual(added[0].caption.content.content[0].attrs.id, 'caption-text')
  assert.equal(added[0].caption.width, 230)
  const moved = moveSegment(source, range, { index: 3, offset: 0 }, anchors, geometry).doc
  validateDocument(moved)
  assert.deepEqual(moved.content.content.map(block => block.attrs.id), ['before', 'after', 'flow-block'])
  assert.deepEqual(moved.objects.slice(0, 2), source.objects.slice(0, 2))
  const deleted = replaceSegment(source, range, null, anchors, geometry)
  validateDocument(deleted)
  assert.equal(deleted.objects.length, 0)
})

test('object clipboard recreates Flow blocks and preserves offsets while standalone annotations detach', () => {
  const source = doc()
  assert.deepEqual([...floatingCopyIds(source.objects, ['figure'], source.content)].sort(), ['annotation', 'figure'])
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['figure']), geometry)))
  const imported = importFloating(source, payload, anchors)
  const pasted = insertDocumentObjects(source, imported.objects, 1, imported.content)
  validateDocument(pasted)
  assert.equal(pasted.content.content[1].attrs.objectId, imported.objects[0].id)
  assert.deepEqual([objectX(imported.objects[0]), objectY(imported.objects[0])], [30, 0])
  assert.deepEqual([objectX(imported.objects[1]), objectY(imported.objects[1])], [-20, -10])
  assert.equal(objectAnchorId(imported.objects[1]), objectAnchorId(imported.objects[0], { type: 'doc', content: imported.content }))
  validateDocument(pasteFloating(source, payload, anchors))
  const alone = parseFloating(JSON.stringify(copyFloating(source, new Set(['annotation']), geometry)))
  assert.equal(alone.content.length, 0)
  assert.equal(objectAnchorId(alone.objects[0]), null)
  assert.deepEqual([objectX(alone.objects[0]), objectY(alone.objects[0])], [50, 70])
})

test('imported groups recreate missing Flow blocks and deletion can reanchor to another Flow', () => {
  const source = doc()
  const empty = { ...source, content: { type: 'doc', content: [p('start')] }, objects: [] }
  const inserted = insertDocumentObjects(empty, [figure, annotation], 1, [flowBlock('figure', 'flow-block')])
  validateDocument(inserted)
  assert.equal(objectAnchorId(inserted.objects[0], inserted.content), objectAnchorId(inserted.objects[1]))
  assert.equal(objectAnchorId(inserted.objects[0], inserted.content), 'flow-block')
  source.content.content.splice(1, 0, flowBlock('previous', 'previous-flow'))
  source.objects.push(patchObject({ ...figure, id: 'previous', caption: { content: captionContent('Previous figure'), width: 245 } }, { x: 260 }))
  const measured = { ...options, anchors: [{ id: 'before', top: 20 }, { id: 'previous-flow', top: 45 }, ...anchors.slice(1)],
    geometry: { ...geometry, previous: { x: 300, y: 45, width: 200, height: 20 } } }
  const removed = reconcileObjectDeletions(source, source.objects.filter(object => object.id !== 'figure'), measured)
  validateDocument(removed)
  const note = removed.objects.find(object => object.id === 'annotation')
  assert.equal(objectAnchorId(note), 'previous-flow')
  assert.deepEqual([objectX(note), objectY(note)], [-250, 25])
  const converted = convertObjectPlacement(source, 'figure', 'float', measured)
  validateDocument(converted)
  assert.deepEqual([objectX(converted.objects[0]), objectY(converted.objects[0])], [-230, 35])
})

test('object copying owns captions and gives their paragraph IDs fresh values', () => {
  const source = doc()
  assert.deepEqual([...floatingCopyIds(source.objects, ['figure'], source.content)].sort(), ['annotation', 'figure'])
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['figure']), geometry)))
  const imported = importFloating(source, payload, anchors)
  const copied = imported.objects.find(object => object.kind === 'image')
  assert.equal(copied.caption.content.content[0].content[0].text, 'Figure caption')
  assert.notEqual(copied.caption.content.content[0].attrs.id, source.objects[0].caption.content.content[0].attrs.id)
  assert.equal(source.objects[0].caption.content.content[0].attrs.id, 'caption-text')
  assert.equal(copied.caption.width, 230)
})

const fixedReferences = ['primary', 'secondary', 'red', 'amber', 'green', 'blue', 'violet', 'pink']
  .flatMap(id => [id, `${id}:soft`]).concat(['gray1', 'gray2', 'gray3', 'gray4', 'gray5', 'gray6'])
const coloredText = () => fixedReferences.map(color => ({ type: 'text', text: color, marks: [{ type: 'color', attrs: { color } }] }))
const references = paragraph => paragraph.content.map(node => node.marks[0].attrs.color)

test('floating captions retain fixed slots and resolve with destination hues and mode', () => {
  const source = doc(), destination = doc()
  Object.assign(source.theme.appearance, { mode: 'light', primaryHue: 20, secondaryHue: 80 })
  Object.assign(destination.theme.appearance, { mode: 'dark', primaryHue: 220, secondaryHue: 300 })
  source.objects[0].caption.content.content[0].content = coloredText()
  const payload = parseFloating(JSON.stringify(copyFloating(source, new Set(['figure']), geometry)))
  assert.equal('palette' in payload, false)
  const pasted = pasteFloating(destination, payload, anchors)
  initializeDocument(pasted)
  const copied = pasted.objects.at(-2)
  assert.deepEqual(references(copied.caption.content.content[0]), fixedReferences)
  assert.equal(copied.caption.width, 230)
  assert.equal(pasted.theme, destination.theme)
  const entries = new Map(paletteEntries(destination.theme).map(entry => [entry.id, entry]))
  for (const reference of fixedReferences) {
    const [id, tone] = reference.split(':')
    assert.equal(paletteColor(pasted.theme, reference), entries.get(id)[tone === 'soft' ? 'soft' : 'strong'])
  }
  for (const reference of ['primary', 'secondary', 'gray1', 'gray6']) {
    assert.notEqual(paletteColor(pasted.theme, reference), paletteColor(source.theme, reference))
  }
})

test('segment and paragraph clipboards retain target slots without transferring a theme', () => {
  const source = doc(), destination = doc()
  Object.assign(source.theme.appearance, { mode: 'light', primaryHue: 20, secondaryHue: 80 })
  Object.assign(destination.theme.appearance, { mode: 'dark', primaryHue: 220, secondaryHue: 300 })
  source.content.content[0].content = coloredText()
  const range = { start: { index: 0, offset: 0 }, end: { index: 1, offset: 0 } }
  const target = { start: { index: 3, offset: 0 }, end: { index: 3, offset: 0 } }
  const payloads = [copySegment(source, range, anchors, geometry), copyParagraphs(source, [source.content.content[0]])]
  for (const original of payloads) {
    const json = serializeSegment(original)
    const payload = parseParagraphs(json)
    assert.equal('palette' in payload, false)
    const pasted = replaceSegment(destination, target, payload, anchors, geometry)
    initializeDocument(pasted)
    assert.deepEqual(references(pasted.content.content.at(-1)), fixedReferences)
    assert.equal(pasted.theme, destination.theme)
    assert.notEqual(pasted.content.content.at(-1).attrs.id, source.content.content[0].attrs.id)
    for (const legacy of [[], [{ id: 'custom', name: 'Custom', strong: '#123456', soft: '#abcdef' }]]) {
      const legacyJSON = JSON.stringify({ ...original, palette: legacy })
      assert.throws(() => parseSegment(legacyJSON))
      assert.throws(() => parseParagraphs(legacyJSON))
      assert.throws(() => serializeSegment({ ...original, palette: legacy }))
    }
  }
  const floating = copyFloating(source, new Set(['figure']), geometry)
  for (const legacy of [[], [{ id: 'custom', name: 'Custom', strong: '#123456', soft: '#abcdef' }]]) {
    assert.throws(() => parseFloating(JSON.stringify({ ...objects, palette: legacy })))
  }
})

test('the example embeds image, table, and widget captions but no drawing caption', () => {
  const example = createDocument()
  const objects = example.objects
  assert.equal(objects.filter(object => object.kind === 'image').every(object => !!object.caption), true)
  assert.equal(objects.filter(object => object.kind === 'table').every(object => !!object.caption), true)
  assert.equal(objects.filter(object => object.kind === 'html').every(object => !!object.caption), true)
  assert.equal(objects.filter(object => object.caption).every(object => object.caption.content.type === 'doc'), true)
  assert.equal(objects.filter(object => object.kind === 'drawing').every(object => !object.caption), true)
  initializeDocument(example)
})

test('deleting an ordinary anchor converts page coordinates when its predecessor is Flow', () => {
  const source = doc()
  source.objects.push(patchObject({ ...annotation, id: 'tail' }, { anchorId: 'after', x: 450, y: 10 }))
  const result = replaceMainContent(source, { ...source.content, content: source.content.content.slice(0, 2) }, [], undefined,
    { ...options, geometry: { ...geometry, tail: { x: 450, y: 250, width: 200, height: 20 } } })
  validateDocument(result)
  const tail = result.objects.find(object => object.id === 'tail')
  assert.equal(objectAnchorId(tail), 'flow-block')
  assert.deepEqual([objectX(tail), objectY(tail)], [380, 170])
})

test('editing main text preserves signed offsets on surviving Flow anchors', () => {
  const source = doc(), content = structuredClone(source.content)
  content.content[0].content = [{ type: 'text', text: 'An edited introduction' }]
  const result = replaceMainContent(source, content, [], undefined, options)
  validateDocument(result)
  assert.deepEqual(result.objects.find(object => object.id === 'annotation'), source.objects.find(object => object.id === 'annotation'))
})

test('V1 loading validates without rewriting input; unknown versions and fields stay unchanged', () => {
  const source = createDocument(), before = JSON.stringify(source)
  assert.equal(initializeDocument(source), source)
  assert.equal(JSON.stringify(source), before)
  for (const invalid of [{ ...source, version: 'V0' }, { ...source, version: 2 }, { ...source, extra: true }]) {
    const raw = JSON.stringify(invalid)
    assert.throws(() => initializeDocument(invalid))
    assert.equal(JSON.stringify(invalid), raw)
  }
})

test('editor output removes only schema defaults and retains stable paragraph IDs', () => {
  const source = createDocument()
  const serialized = getSchema(extensions(true)).nodeFromJSON(source.content).toJSON()
  assert.throws(() => validateDocument({ ...source, content: serialized }))
  const canonical = canonicalEditorContent(serialized)
  assert.deepEqual(canonical.content.map(node => node.attrs), source.content.content.map(node => node.attrs))
  validateDocument({ ...source, content: canonical })
  const table = source.objects.find(object => object.kind === 'table')
  const tableJSON = getSchema(extensions(false, true)).nodeFromJSON(table.content).toJSON()
  const native = canonicalEditorContent(tableJSON)
  assert.deepEqual(JSON.parse(JSON.stringify(native)), table.content)
  validateDocument({ ...source, objects: source.objects.map(object => object === table ? { ...table, content: native } : object) })
})

test('sparse styles inherit saved defaults and ratio line height uses resolved font size', () => {
  const theme = { ...structuredClone(defaultTheme), paragraphs: { body: { size: em(2), spaceAfter: px(25) } }, objects: {}, flow: {},
    defaults: { ...defaultTheme.defaults, size: 20, lineHeight: { value: 1.7, unit: 'ratio' } } }
  const variables = themeVariables(theme, 'en')
  assert.equal(variables['--body-size'], '40px')
  assert.equal(variables['--body-lineHeight'], '68px')
  assert.equal(variables['--subheading-size'], '20px')
  assert.equal(variables['--subheading-lineHeight'], '34px')
  assert.equal(variables['--math-size'], '20px')
  assert.equal(variables['--flow-spaceBefore'], '0px')
  assert.equal(variables['--flow-spaceAfter'], '25px')
})
