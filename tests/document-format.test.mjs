import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { DOCUMENT_VERSION, DOCUMENT_VERSIONS, DocumentFormatError, loadDocument, migrationBreaking, validateContent, validateObject, validateDocument, publishDocument } from '../shared/document.mjs'
import { validateDocument as validateServerDocument, validateProposalCandidate } from '../server/validation.mjs'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { createBlankDocument, createDocument, patchObject, supportsMarkup } = await server.ssrLoadModule('/src/document/model.ts')
const { initializeDocument } = await server.ssrLoadModule('/src/document/initialize.ts')
const { currentPlacement } = await server.ssrLoadModule('/src/ai/reservations.ts')
const { encodeMote, decodeMote } = await server.ssrLoadModule('/src/document/file.ts')

function legacyDocument(document, version) {
  const value = structuredClone(document)
  value.version = version
  delete value.theme.paragraphs.separator
  return value
}

test('loading migrates V1 to V8 without mutating input or changing current weights', () => {
  const v1 = legacyDocument(createDocument(), 1), before = structuredClone(v1)
  assert.equal(migrationBreaking(1), true)
  const loaded = loadDocument(v1)
  assert.deepEqual(v1, before)
  assert.deepEqual(loaded, { ...before, version: 8 })
  validateDocument(v1)
})

test('V3 table color pairs round-trip while V2 migrates without recoloring', async () => {
  const v2 = legacyDocument(createDocument(), 2), before = structuredClone(v2)
  const document = loadDocument(v2), table = document.objects.find(object => object.kind === 'table')
  assert.deepEqual(document, { ...before, version: 8 })
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
  assert.equal(migrationBreaking(4), false)
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
  expected.version = 8
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
  const legacy = legacyDocument(createDocument(), 4), before = structuredClone(legacy)
  const document = loadDocument(legacy)
  assert.equal(migrationBreaking(4), false)
  assert.equal(migrationBreaking(5), false)
  assert.deepEqual(document, { ...before, version: 8 })
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

test('V1 has one strict browser/server contract and initialization never strips input', () => {
  const document = createDocument(), before = structuredClone(document)
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
    d => { d.objects[0].caption.content.content[0].attrs.id = d.content.content[0].attrs.id },
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

test('V6 Justify is optional, boolean, version-gated, and survives native Slides round-trip', async () => {
  const blank = createBlankDocument()
  assert.equal(blank.version, DOCUMENT_VERSION)
  assert.equal('justifyText' in blank.theme, false)
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
  assert.equal(migrationBreaking(5), false)
  assert.deepEqual(loadDocument(legacy), { ...before, version: 8 })
  assert.deepEqual(legacy, before)

  const slides = createDocument({ slideHeight: 540 })
  slides.theme.justifyText = true
  validateServerDocument(slides)
  assert.deepEqual(await decodeMote(new File([await encodeMote(slides)], 'justify-slides.mote')), slides)
})

test('V7 first-line indent is optional, boolean, version-gated, and preserved on load and native export', async () => {
  const blank = createBlankDocument()
  assert.equal(blank.version, DOCUMENT_VERSION)
  assert.equal('firstLineIndent' in blank.theme, false)
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const old = legacyDocument(blank, version), before = structuredClone(old)
    assert.deepEqual(loadDocument(old), { ...before, version: DOCUMENT_VERSION })
    assert.deepEqual(old, before)
    assert.throws(() => validateDocument({ ...old, theme: { ...old.theme, firstLineIndent: false } }))
  }
  assert.equal(migrationBreaking(6), false)
  for (const firstLineIndent of [null, 0, 2, 'true']) {
    assert.throws(() => validateServerDocument({ ...blank, theme: { ...blank.theme, firstLineIndent } }))
  }
  for (const firstLineIndent of [false, true]) for (const slideHeight of [undefined, 540]) {
    const document = createDocument({ language: 'zh-Hans', slideHeight })
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
  for (const version of DOCUMENT_VERSIONS.slice(0, -1)) {
    assert.throws(() => validateContent(content, 'main', { version }))
    assert.throws(() => validateContent(content, 'text', { version }))
  }
  assert.throws(() => validateContent(content, 'caption'))
  assert.throws(() => validateContent({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableCell', content: [paragraph('table-separator', 'separator')] },
  ] }] }] }, 'table'))

  const document = createDocument()
  assert.equal(document.version, 8)
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

  for (const version of DOCUMENT_VERSIONS.slice(0, -1)) {
    const oldMain = legacyDocument(createBlankDocument(), version)
    oldMain.content.content[0].attrs.semantic = 'separator'
    assert.throws(() => validateServerDocument(oldMain))

    const oldTheme = legacyDocument(createBlankDocument(), version)
    oldTheme.theme.paragraphs.separator = { lineThickness: { value: 1, unit: 'px' } }
    assert.throws(() => validateServerDocument(oldTheme))
  }

  const oldNested = legacyDocument(createBlankDocument(), 7)
  const beforeMigration = structuredClone(oldNested)
  assert.equal(migrationBreaking(7), false)
  assert.deepEqual(loadDocument(oldNested), { ...beforeMigration, version: 8 })
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

test('unsupported versions are rejected without conversion or mutation', () => {
  for (const version of ['V0', 0, 9, 'V1', undefined]) {
    const value = { ...createBlankDocument(), version }, before = structuredClone(value)
    assert.throws(() => loadDocument(value), error => error instanceof DocumentFormatError && error.code === 'unsupported' && /has not been changed/.test(error.message))
    assert.deepEqual(value, before)
  }
})

test('native V8 round-trips every example kind and publication omits all authoring data', async () => {
  const document = createDocument()
  document.authoring = { notes: ['Unpublished plan', ''], aiModel: 'private-provider/model' }
  const file = new File([await encodeMote(document)], 'document.mote')
  assert.deepEqual(await decodeMote(file), document)
  const published = publishDocument(document)
  assert.equal('authoring' in published, false)
  validateDocument(published)
  assert.deepEqual({ ...published, authoring: document.authoring }, document)
  published.content.content[0].content[0].text = 'Separate publication copy'
  assert.notEqual(published.content.content[0].content[0].text, document.content.content[0].content[0].text)
})
