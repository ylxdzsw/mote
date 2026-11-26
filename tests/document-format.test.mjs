import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { DOCUMENT_VERSION, DOCUMENT_VERSIONS, DocumentFormatError, loadDocument, migrationBreaking, validateContent, validateObject, validateDocument, publishDocument } from '../shared/document.mjs'
import { validateDocument as validateServerDocument, validateProposalCandidate } from '../server/validation.mjs'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { createBlankDocument, paragraph, captionContent, tableContent, patchObject, supportsMarkup } = await server.ssrLoadModule('/src/document/model.ts')
const { initializeDocument } = await server.ssrLoadModule('/src/document/initialize.ts')
const { currentPlacement } = await server.ssrLoadModule('/src/ai/reservations.ts')
const { encodeMote, decodeMote } = await server.ssrLoadModule('/src/document/file.ts')

function legacyDocument(document, version) {
  const value = JSON.parse(JSON.stringify(document, (key, item) => item?.type === 'box' ? { type: 'decoration', attrs: { decoration: 'box' } } : item))
  value.version = version
  delete value.theme.justifyText
  delete value.theme.firstLineIndent
  if (version < 8) delete value.theme.paragraphs.separator
  return value
}

function withoutSeparator(document) {
  delete document.theme.paragraphs.separator
  return document
}

function nativeFixture() {
  const document = createBlankDocument()
  const anchor = paragraph('Body')
  document.content.content = [anchor, { type: 'flow', attrs: { id: 'image-block', objectId: 'image' } }]
  const layout = () => ({ width: 160, placement: { type: 'float', anchorId: anchor.attrs.id, x: 8, y: 12 } })
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII='
  document.objects = [
    { id: 'image', kind: 'image', layout: { width: 160, placement: { type: 'flow', x: 'center' } }, src: png, alt: 'Image',
      caption: { width: 140, content: captionContent('Image caption') } },
    { id: 'text', kind: 'text', layout: layout(), content: { type: 'doc', content: [paragraph('Text object')] } },
    { id: 'table', kind: 'table', layout: layout(), content: tableContent([['A', 'B']]), caption: { content: captionContent('Table caption') } },
    { id: 'drawing', kind: 'drawing', layout: { ...layout(), height: 80 }, strokes: [], labels: [], background: null },
    { id: 'formula', kind: 'formula', layout: layout(), latex: 'x^2' },
    { id: 'code', kind: 'code', layout: layout(), source: 'const value = 1', language: 'javascript' },
    { id: 'html', kind: 'html', layout: { ...layout(), height: 80 }, html: '<p>Widget</p>',
      screenshot: png, alt: 'Widget', caption: { width: 140, content: captionContent('Widget caption') } },
  ]
  return document
}

test('loading migrates V1 to V9 without mutating input or changing current weights', () => {
  const current = withoutSeparator(nativeFixture()), v1 = legacyDocument(current, 1), before = structuredClone(v1)
  assert.equal(migrationBreaking(1), true)
  const loaded = loadDocument(v1)
  assert.deepEqual(v1, before)
  assert.deepEqual(loaded, current)
  validateDocument(v1)
})

test('V3 table color pairs round-trip while V2 migrates without recoloring', async () => {
  const current = withoutSeparator(nativeFixture()), v2 = legacyDocument(current, 2), before = structuredClone(v2)
  const document = loadDocument(v2), table = document.objects.find(object => object.kind === 'table')
  assert.deepEqual(document, current)
  assert.equal(migrationBreaking(2), true)
  assert.deepEqual(v2, before)
  for (const color of ['primary', 'secondary', 'red', 'amber', 'green', 'blue', 'violet', 'pink', 'gray4']) {
    const colored = { ...document, objects: document.objects.map(object => object === table ? { ...table, color } : object) }
    validateServerDocument(colored)
    assert.deepEqual(await decodeMote(new File([await encodeMote(colored)], 'table.mote')), colored)
    for (const version of [1, 2]) assert.throws(() => validateDocument(legacyDocument(colored, version)))
  }
  for (const color of ['red:soft', 'gray5', '#ff0000', null]) {
    assert.throws(() => validateDocument({ ...document, objects: document.objects.map(object => object === table ? { ...table, color } : object) }))
  }
})

test('V4 restricts typography to regular/bold and migrates sparse legacy weights', async () => {
  const document = createBlankDocument()
  assert.equal(document.version, DOCUMENT_VERSION)
  for (const name of ['title', 'heading', 'subheading']) assert.equal(document.theme.paragraphs[name].weight, 700)
  assert.equal(migrationBreaking(3), true)
  const legacy = legacyDocument(document, 3)
  legacy.theme.defaults.weight = 500
  legacy.theme.paragraphs.title.weight = 600
  delete legacy.theme.paragraphs.heading.weight
  legacy.theme.paragraphs.body.weight = 549.9
  legacy.theme.paragraphs.caption.weight = 550
  legacy.theme.objects.table.weight = 1
  legacy.theme.objects.code.weight = 1000
  const before = structuredClone(legacy)
  for (const version of [1, 2, 3]) validateServerDocument({ ...legacy, version })
  assert.throws(() => validateServerDocument({ ...legacy, version: 4 }))
  const loaded = loadDocument(legacy), expected = structuredClone(before)
  expected.version = 9
  Object.assign(expected.theme, { justifyText: false, firstLineIndent: false })
  expected.theme.defaults.weight = 400
  expected.theme.paragraphs.title.weight = 700
  expected.theme.paragraphs.body.weight = 400
  expected.theme.paragraphs.caption.weight = 700
  expected.theme.objects.table.weight = 400
  expected.theme.objects.code.weight = 700
  assert.deepEqual(loaded, expected)
  assert.deepEqual(legacy, before)
  validateServerDocument(loaded)
  assert.deepEqual(await decodeMote(new File([await encodeMote(loaded)], 'weights.mote')), loaded)
})

test('V5 markup is closed, owner-bound, preserved by patches and candidates, and non-breaking', async () => {
  const current = withoutSeparator(nativeFixture()), legacy = legacyDocument(current, 4), before = structuredClone(legacy)
  const document = loadDocument(legacy)
  assert.deepEqual(document, current)
  assert.deepEqual(legacy, before)
  const markup = { width: 300, height: 150,
    strokes: [{ points: [[0, 0], [300, 150]], color: 'red', width: 2 }],
    labels: [{ x: 10, y: 20, text: 'Review', color: 'gray2', size: 14 }] }
  for (const original of document.objects.filter(supportsMarkup)) {
    const owner = patchObject(original, { markup })
    const marked = { ...document, objects: document.objects.map(object => object.id === owner.id ? owner : object) }
    validateServerDocument(marked)
    assert.deepEqual(await decodeMote(new File([await encodeMote(marked)], 'markup.mote')), marked)
    assert.deepEqual(patchObject(owner, { width: 450, ...(owner.kind === 'image' ? { src: owner.src } : { html: '<p>Revised</p>' }) }).markup, markup)
    assert.equal('markup' in patchObject(owner, { markup: null }), false)
    assert.deepEqual(owner.markup, markup)
    const omitted = { ...owner }; delete omitted.markup
    assert.equal(validateProposalCandidate({ object: omitted, summary: 'Preserve' }).object.markup, undefined)
    assert.deepEqual(currentPlacement(omitted, owner).markup, markup)
    const empty = { ...markup, strokes: [], labels: [] }
    assert.deepEqual(validateProposalCandidate({ object: { ...owner, markup: empty }, summary: 'Clear' }).object.markup, empty)
    for (const version of [1, 2, 3, 4]) {
      assert.throws(() => validateDocument(legacyDocument(marked, version)))
    }
    for (const invalid of [null, {}, { ...markup, width: 0 }, { ...markup, height: Infinity },
      ...['id', 'layout', 'background'].map(key => ({ ...markup, [key]: null })),
      { ...markup, strokes: [{ points: [], color: 'red', width: 2 }] },
      { ...markup, labels: [{ ...markup.labels[0], color: '#ff0000' }] },
      { ...markup, labels: [{ ...markup.labels[0], text: 'x'.repeat(4097) }] }]) {
      assert.throws(() => validateServerDocument({ ...marked, objects: marked.objects.map(object => object.id === owner.id ? { ...owner, markup: invalid } : object) }))
    }
  }
  for (const original of document.objects.filter(object => !supportsMarkup(object))) {
    assert.equal('markup' in patchObject(original, { markup }), false)
    assert.throws(() => validateDocument({ ...document, objects: document.objects.map(object => object.id === original.id ? { ...object, markup } : object) }))
  }
})

test('native documents have one strict browser/server contract and initialization never strips input', () => {
  const document = nativeFixture(), before = structuredClone(document)
  assert.equal(loadDocument(document), document)
  initializeDocument(document)
  validateServerDocument(document)
  assert.deepEqual(document, before)
  for (const edit of [
    d => { d.extra = true },
    d => { d.content.content[0].attrs.future = 'must not disappear' },
    d => { d.content.content[0].attrs.semantic = 'unknown' },
    d => { Object.assign(d.content.content[0].attrs, { semantic: 'list', listLevel: .5 }) },
    d => { d.theme.defaults.lineHeight = 1.5 },
    d => { d.theme.defaults.spaceAfter = '1em' },
    d => { d.theme.objects.code.family = 'serif' },
    d => { d.objects.find(o => o.kind === 'code').scheme = 'dark' },
    d => { delete d.objects.find(o => o.kind === 'text').kind },
    d => { d.authoring = { notes: 'old single-string notes' } },
    d => { d.authoring = { notes: [], aiModel: 42 } },
    d => { d.objects[0].layout.width = 0 },
    d => { d.objects[0].layout.placement.anchorId = 'redundant' },
    d => { d.objects.find(o => o.kind === 'image').caption.content.content[0].attrs.id = d.content.content[0].attrs.id },
    d => { d.objects.find(o => o.kind === 'table').content.content[0].attrs = { columns: [{ weight: 1, align: 'left' }] } },
  ]) {
    const value = structuredClone(document); edit(value)
    const original = structuredClone(value)
    assert.throws(() => validateDocument(value), DocumentFormatError)
    assert.throws(() => initializeDocument(value))
    assert.throws(() => validateServerDocument(value))
    assert.deepEqual(value, original)
  }
})

test('Justify is version-gated, boolean, and survives native round-trip', async () => {
  const blank = createBlankDocument()
  assert.equal(blank.version, DOCUMENT_VERSION)
  assert.equal(blank.theme.justifyText, false)
  validateDocument(blank)

  for (const version of [1, 2, 3, 4, 5]) {
    const old = legacyDocument(blank, version)
    validateDocument(old)
    assert.throws(() => validateDocument({ ...old, theme: { ...old.theme, justifyText: false } }))
  }
  for (const justifyText of [false, true]) validateServerDocument({ ...blank, theme: { ...blank.theme, justifyText } })
  for (const justifyText of [null, 0, 'true']) {
    assert.throws(() => validateDocument({ ...blank, theme: { ...blank.theme, justifyText } }))
  }

  const legacy = legacyDocument(blank, 5), before = structuredClone(legacy)
  assert.deepEqual(loadDocument(legacy), withoutSeparator(blank))
  assert.deepEqual(legacy, before)

  const current = createBlankDocument()
  current.language = 'zh-Hans'
  current.theme.justifyText = true
  validateServerDocument(current)
  assert.deepEqual(await decodeMote(new File([await encodeMote(current)], 'justify.mote')), current)
})

test('V7 first-line indent is optional, boolean, version-gated, and preserved on load and native export', async () => {
  const blank = createBlankDocument()
  assert.equal(blank.version, DOCUMENT_VERSION)
  assert.equal(blank.theme.firstLineIndent, false)
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const old = legacyDocument(blank, version), before = structuredClone(old)
    assert.deepEqual(loadDocument(old), withoutSeparator(structuredClone(blank)))
    assert.deepEqual(old, before)
    assert.throws(() => validateDocument({ ...old, theme: { ...old.theme, firstLineIndent: false } }))
  }
  for (const firstLineIndent of [null, 0, 2, 'true']) {
    assert.throws(() => validateServerDocument({ ...blank, theme: { ...blank.theme, firstLineIndent } }))
  }
  for (const firstLineIndent of [false, true]) {
    const document = createBlankDocument()
    document.language = 'zh-Hans'
    document.theme.firstLineIndent = firstLineIndent
    document.theme.justifyText = true
    validateServerDocument(document)
    assert.equal(loadDocument(document), document)
    assert.deepEqual(await decodeMote(new File([await encodeMote(document)], 'indent.mote')), document)
  }
})

test('V8 separator is version-gated, main/text-only, and has a positive theme line thickness', async () => {
  assert.deepEqual(createBlankDocument().theme.paragraphs.separator, { color: 'gray4' })
  const paragraph = (id, semantic = 'body', content = []) => ({ type: 'paragraph', attrs: { id, semantic }, content })
  const separator = paragraph('separator', 'separator', [{ type: 'text', text: 'A label', marks: [{ type: 'bold' }] }])
  const content = { type: 'doc', content: [separator] }
  validateContent(content, 'main')
  validateContent(content, 'text')
  validateContent({ type: 'doc', content: [paragraph('empty-separator', 'separator')] }, 'main')
  for (const version of DOCUMENT_VERSIONS.filter(version => version < 8)) {
    assert.throws(() => validateContent(content, 'main', { version }))
    assert.throws(() => validateContent(content, 'text', { version }))
  }
  assert.throws(() => validateContent(content, 'caption'))
  assert.throws(() => validateContent({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableCell', content: [paragraph('table-separator', 'separator')] },
  ] }] }] }, 'table'))

  const document = createBlankDocument()
  assert.equal(document.version, DOCUMENT_VERSION)
  const mainParagraph = document.content.content.find(block => block.type === 'paragraph')
  mainParagraph.attrs.semantic = 'separator'
  mainParagraph.content = structuredClone(separator.content)
  document.theme.paragraphs.separator = {}
  validateServerDocument(document)
  assert.equal(loadDocument(document), document)

  const separatorStyle = { color: 'red', lineThickness: { value: 1.5, unit: 'px' } }
  for (const lineThickness of [{ value: 1, unit: 'px' }, { value: 0.1, unit: 'em' }]) {
    document.theme.paragraphs.separator = { ...separatorStyle, lineThickness }
    validateServerDocument(document)
    assert.deepEqual(await decodeMote(new File([await encodeMote(document)], 'separator.mote')), document)
  }
  for (const lineThickness of [null, { value: 0, unit: 'px' }, { value: -1, unit: 'em' },
    { value: 1, unit: 'ratio' }, { value: 1, unit: 'px', extra: true }]) {
    assert.throws(() => validateServerDocument({ ...document, theme: { ...document.theme,
      paragraphs: { ...document.theme.paragraphs, separator: { ...separatorStyle, lineThickness } },
    } }))
  }
  for (const theme of [
    { ...document.theme, defaults: { ...document.theme.defaults, lineThickness: { value: 1, unit: 'px' } } },
    { ...document.theme, paragraphs: { ...document.theme.paragraphs, body: { lineThickness: { value: 1, unit: 'px' } } } },
  ]) assert.throws(() => validateServerDocument({ ...document, theme }))

  for (const version of DOCUMENT_VERSIONS.filter(version => version < 8)) {
    const oldMain = legacyDocument(createBlankDocument(), version)
    oldMain.content.content[0].attrs.semantic = 'separator'
    assert.throws(() => validateServerDocument(oldMain))

    const oldTheme = legacyDocument(createBlankDocument(), version)
    oldTheme.theme.paragraphs.separator = { lineThickness: { value: 1, unit: 'px' } }
    assert.throws(() => validateServerDocument(oldTheme))
  }

  const oldNested = legacyDocument(createBlankDocument(), 7)
  const beforeMigration = structuredClone(oldNested)
  assert.deepEqual(loadDocument(oldNested), { ...beforeMigration, version: 9, theme: { ...beforeMigration.theme, justifyText: false, firstLineIndent: false } })
  assert.deepEqual(oldNested, beforeMigration)
  const anchorId = oldNested.content.content[0].attrs.id
  const nested = { type: 'doc', content: [paragraph('nested-separator', 'separator')] }
  const textObject = { id: 'separator-text', kind: 'text', layout: { width: 120,
    placement: { type: 'float', anchorId, x: 0, y: 0 } }, content: nested }
  oldNested.objects.push(textObject)
  assert.throws(() => validateServerDocument(oldNested))
  assert.throws(() => validateObject(textObject, { version: 7 }))
  assert.deepEqual(validateProposalCandidate({ object: textObject, summary: 'Separator text' }).object, textObject)
  assert.deepEqual(validateProposalCandidate({ content: [separator], summary: 'Separator paragraph' }).content, [separator])
  const segment = { type: 'segment', version: 1, content: [separator], objects: [], geometry: {},
    anchorTops: { separator: 0 }, originTop: 0 }
  assert.deepEqual(validateProposalCandidate({ segment, summary: 'Separator segment' }).segment, segment)
})

test('V9 closes retired layout and mark shapes and requires both typography switches', () => {
  const doc = createBlankDocument(), legacy = legacyDocument(doc, 8)
  for (const version of DOCUMENT_VERSIONS) assert.equal(migrationBreaking(version), version < 9)
  for (const key of ['justifyText', 'firstLineIndent']) {
    const theme = { ...doc.theme }; delete theme[key]
    assert.throws(() => validateDocument({ ...doc, theme }), new RegExp(key))
  }
  const marked = marks => ({ ...doc.content, content: [{ ...doc.content.content[0], content: [{ type: 'hardBreak', marks }] }] })
  for (const mark of [{ type: 'decoration', attrs: { decoration: 'box' } }, { type: 'box', attrs: {} }]) {
    assert.throws(() => loadDocument({ ...doc, content: marked([mark]) }), DocumentFormatError)
  }
  assert.throws(() => validateDocument({ ...doc, content: marked([{ type: 'box' }, { type: 'box' }]) }), /duplicate/)
  assert.throws(() => loadDocument({ ...legacy, content: marked([{ type: 'box' }]) }), DocumentFormatError)
  assert.throws(() => validateDocument({ ...doc, page: { ...doc.page, slideHeight: 540 } }), /slideHeight/)
  const content = { ...doc.content, content: [...doc.content.content, { type: 'slideBreak', attrs: { id: 'break' } }] }
  assert.throws(() => validateDocument({ ...doc, content }), DocumentFormatError)
  assert.throws(() => validateContent(content, 'main', { slides: true, version: 9 }), DocumentFormatError)
  for (const justifyText of [false, true]) for (const firstLineIndent of [false, true]) {
    const theme = { ...legacy.theme, justifyText, firstLineIndent }
    assert.deepEqual(loadDocument({ ...legacy, theme }).theme, theme)
  }
})

test('a legacy deck flattens deterministically; only marker anchors move and all rich-text contexts convert', async () => {
  const old = legacyDocument(createBlankDocument(), 8), box = { type: 'decoration', attrs: { decoration: 'box' } }
  const px = value => ({ value, unit: 'px' }), marker = id => ({ type: 'slideBreak', attrs: { id } })
  const paragraph = (id, semantic) => ({ type: 'paragraph', attrs: { id, ...(semantic && { semantic }) },
    content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, box] }] })
  const rich = (...content) => ({ type: 'doc', content })
  const note = (id, anchorId, x, y) => ({ id, kind: 'text', content: rich(paragraph(`${id}-p`, 'body')),
    layout: { width: 80, placement: { type: 'float', anchorId, x, y } }, decoration: { kind: 'box', color: 'red' } })
  old.page.slideHeight = 200
  old.page.margins.top = 20
  Object.assign(old.theme.defaults, { size: 10, lineHeight: { value: 1.2, unit: 'ratio' }, spaceBefore: px(2), spaceAfter: px(6) })
  old.theme.paragraphs.caption = { lineHeight: px(10), spaceAfter: px(3) }
  old.theme.flow = { spaceBefore: px(12), spaceAfter: px(7) }
  old.theme.justifyText = true
  const first = paragraph('first', 'body'); first.content.push({ type: 'hardBreak', marks: [box] })
  old.content = rich(first, { type: 'spacer', attrs: { id: 'space', height: 30 } },
    { type: 'flow', attrs: { id: 'table-block', objectId: 'table' } }, marker('mid'), paragraph('middle', 'body'), marker('last'), paragraph('end', 'body'))
  old.objects = [{ id: 'table', kind: 'table', layout: { width: 250, placement: { type: 'flow', x: 'center' },
    margins: { top: 4, right: 0, bottom: -1, left: 0 } }, caption: { width: 120, content: rich(paragraph('caption')) },
    content: rich({ type: 'table', content: ['one', 'two'].map(id => ({ type: 'tableRow', content: [
      { type: 'tableCell', content: [paragraph(id)] },
    ] })) }) }, note('mid-note', 'mid', 45, 9), note('last-note', 'last', 26, 3),
  note('flow-note', 'table-block', -2, -8), note('space-note', 'space', 42, 2), note('page-note', null, 0, 4)]
  old.authoring = { notes: ['Keep this'] }
  const before = structuredClone(old)
  assert.equal(validateDocument(old), old)
  const got = loadDocument(old)
  const expected = JSON.parse(JSON.stringify(before, (key, item) => item?.type === 'decoration' ? { type: 'box' } : item))
  expected.version = 9; expected.theme.firstLineIndent = false
  delete expected.page.slideHeight
  expected.content.content = expected.content.content.filter(block => block.type !== 'slideBreak')
  // First paragraph ends at 44, space at 80, table + caption/margins at 160.
  // The next paragraph starts at 167, then the last starts at 185. Slide-local top was 20.
  Object.assign(expected.objects[1].layout.placement, { anchorId: null, y: 156 })
  Object.assign(expected.objects[2].layout.placement, { anchorId: null, y: 168 })
  assert.deepEqual(got, expected)
  assert.deepEqual(await decodeMote(new File([await encodeMote(old)], 'legacy-deck.mote')), expected)
  assert.deepEqual(old, before)
})

test('unsupported versions are rejected without conversion or mutation', () => {
  for (const version of ['V0', 0, 10, 'V1', undefined]) {
    const value = { ...createBlankDocument(), version }, before = structuredClone(value)
    assert.throws(() => loadDocument(value), error => error instanceof DocumentFormatError && error.code === 'unsupported' && /has not been changed/.test(error.message))
    assert.deepEqual(value, before)
  }
})

test('native V9 round-trips every object kind and publication omits all authoring data', async () => {
  const document = nativeFixture()
  document.authoring = { notes: ['Unpublished plan', ''], aiModel: 'private-provider/model' }
  assert.deepEqual([...new Set(document.objects.map(object => object.kind))].sort(), ['code', 'drawing', 'formula', 'html', 'image', 'table', 'text'])
  validateServerDocument(document)
  const file = new File([await encodeMote(document)], 'document.mote')
  assert.deepEqual(await decodeMote(file), document)
  const published = publishDocument(document)
  assert.equal('authoring' in published, false)
  validateDocument(published)
  assert.deepEqual({ ...published, authoring: document.authoring }, document)
  published.content.content[0].content[0].text = 'Separate publication copy'
  assert.notEqual(published.content.content[0].content[0].text, document.content.content[0].content[0].text)
})
