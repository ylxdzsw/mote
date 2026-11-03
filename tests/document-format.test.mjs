import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { DocumentFormatError, loadDocument, migrationBreaking, validateDocument, publishDocument } from '../shared/document.mjs'
import { validateDocument as validateServerDocument } from '../server/validation.mjs'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { createBlankDocument, createDocument } = await server.ssrLoadModule('/src/document/model.ts')
const { initializeDocument } = await server.ssrLoadModule('/src/document/initialize.ts')
const { encodeMote, decodeMote } = await server.ssrLoadModule('/src/document/file.ts')

test('loading migrates V1 to V4 without mutating input or changing current weights', () => {
  const v1 = { ...createDocument(), version: 1 }, before = structuredClone(v1)
  assert.equal(migrationBreaking(1), true)
  const loaded = loadDocument(v1)
  assert.deepEqual(v1, before)
  assert.deepEqual(loaded, { ...before, version: 4 })
  validateDocument(v1)
})

test('V3 table color pairs round-trip while V2 migrates without recoloring', async () => {
  const v2 = { ...createDocument(), version: 2 }, before = structuredClone(v2)
  const document = loadDocument(v2), table = document.objects.find(object => object.kind === 'table')
  assert.deepEqual(document, { ...before, version: 4 })
  assert.equal(migrationBreaking(2), true)
  assert.deepEqual(v2, before)
  for (const color of ['primary', 'secondary', 'red', 'amber', 'green', 'blue', 'violet', 'pink', 'gray4']) {
    const colored = { ...document, objects: document.objects.map(object => object === table ? { ...table, color } : object) }
    validateServerDocument(colored)
    assert.deepEqual(await decodeMote(new File([await encodeMote(colored)], 'table.mote')), colored)
    for (const version of [1, 2]) assert.throws(() => validateDocument({ ...colored, version }))
  }
  for (const color of ['red:soft', 'gray5', '#ff0000', null]) {
    assert.throws(() => validateDocument({ ...document, objects: document.objects.map(object => object === table ? { ...table, color } : object) }))
  }
})

test('V4 restricts typography to regular/bold and migrates sparse legacy weights', async () => {
  const document = createBlankDocument()
  assert.equal(document.version, 4)
  for (const name of ['title', 'heading', 'subheading']) assert.equal(document.theme.paragraphs[name].weight, 700)
  assert.equal(migrationBreaking(3), true)
  assert.equal(migrationBreaking(4), false)
  const legacy = { ...document, version: 3 }
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
  expected.version = 4
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

test('unsupported versions are rejected without conversion or mutation', () => {
  for (const version of ['V0', 0, 5, 'V1', undefined]) {
    const value = { ...createBlankDocument(), version }, before = structuredClone(value)
    assert.throws(() => loadDocument(value), error => error instanceof DocumentFormatError && error.code === 'unsupported' && /has not been changed/.test(error.message))
    assert.deepEqual(value, before)
  }
})

test('native V1 round-trips every example kind and publication omits all authoring data', async () => {
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
