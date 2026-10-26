import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { DocumentFormatError, loadDocument, validateDocument, publishDocument } from '../shared/document.mjs'
import { validateDocument as validateServerDocument } from '../server/validation.mjs'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { createBlankDocument, createDocument } = await server.ssrLoadModule('/src/document/model.ts')
const { initializeDocument } = await server.ssrLoadModule('/src/document/initialize.ts')
const { encodeMote, decodeMote } = await server.ssrLoadModule('/src/document/file.ts')

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
  for (const version of ['V0', 0, 2, 'V1', undefined]) {
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
