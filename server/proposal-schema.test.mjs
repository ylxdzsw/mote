import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { AGENT_PROTOCOL, PROPOSAL_SCHEMA_URL, validateProposalDelivery } from './agent-protocol.mjs'
import { DOCUMENT_VERSION } from '../shared/document.mjs'

const paragraph = (id = 'paragraph') => ({ type: 'paragraph', attrs: { id, semantic: 'body' }, content: [{ type: 'text', text: 'Proposal' }] })
const doc = content => ({ type: 'doc', content })
const layout = { width: 120, placement: { type: 'float', anchorId: 'external-anchor', x: 20, y: 10 } }
const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}`
function png(width, height) {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString('base64')}`
}
function objects() {
  return [
    { kind: 'text', content: doc([paragraph('text-paragraph')]) },
    { kind: 'table', color: 'primary', content: doc([{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', attrs: { id: 'cell' } }] }] }] }]) },
    { kind: 'image', src: svg, alt: 'Image', markup: { width: 120, height: 80, strokes: [], labels: [] } },
    { kind: 'drawing', strokes: [], labels: [], background: null, layout: { ...layout, height: 80 } },
    { kind: 'formula', latex: 'x^2' },
    { kind: 'code', source: 'console.log(1)', language: 'js' },
    { kind: 'html', html: '<p>Widget</p>', alt: 'Widget', screenshot: png(120, 80), layout: { ...layout, height: 80 } },
  ].map(value => ({ id: `new-${value.kind}`, layout: structuredClone(layout), ...value }))
}
function segment(version = 1) {
  return { type: 'segment', version, content: [paragraph()], objects: [], geometry: {}, anchorTops: { paragraph: 0 }, originTop: 0 }
}
function invalid(candidate, assets) {
  assert.throws(() => validateProposalDelivery(candidate, assets), error => {
    assert.equal(error.status, 400)
    assert.equal(error.schemaUrl, PROPOSAL_SCHEMA_URL)
    assert.ok(error.message.includes(PROPOSAL_SCHEMA_URL))
    return true
  })
}

test('all object kinds, text and V1/V2 segment proposals validate without any document context', () => {
  const forbidden = new Proxy({}, { get() { throw new Error('Document context was accessed') } })
  const slides = segment(2)
  slides.content.push({ type: 'slideBreak', attrs: { id: 'slide' } }, paragraph('second'))
  for (const payload of [...objects().map(object => ({ object })), { content: [paragraph()] }, { segment: segment() }, { segment: slides }]) {
    const raw = { ...payload, summary: 'Current-schema proposal', sources: [{ title: 'Source', url: 'https://example.com/' }] }
    const before = structuredClone(raw)
    const result = validateProposalDelivery(raw, {}, forbidden, forbidden)
    assert.deepEqual(result, raw)
    assert.notEqual(result, raw)
    assert.deepEqual(raw, before)
  }
  assert.equal(AGENT_PROTOCOL, 'mote-agent-v5')
  assert.deepEqual(validateProposalDelivery({ segment: { ...segment(), content: [], anchorTops: {} }, summary: 'Delete section' }).segment.content, [])
})

test('proposal validation preserves supplied dimensions, captions, margins and markup without snapshot defaults', () => {
  const object = objects().find(object => object.kind === 'image')
  object.layout.margins = { top: 1, right: 2, bottom: 3, left: 4 }
  object.caption = { width: 37, content: doc([{ type: 'paragraph', attrs: { id: 'caption' } }]) }
  assert.deepEqual(validateProposalDelivery({ object, summary: 'Keep proposal geometry' }).object, object)
  delete object.caption; delete object.layout.margins; delete object.markup
  assert.deepEqual(validateProposalDelivery({ object, summary: 'No inherited defaults' }).object, object)
})

test('closed candidate grammar rejects wrappers, native-document envelopes, metadata and invalid native payloads', () => {
  const candidate = { content: [paragraph()], summary: 'Text' }
  for (const value of [null, [], {}, { candidate }, { ...candidate, object: objects()[0] },
    ...['documentFormat', 'documentFormatVersion', 'protocol', 'executorRevision', 'documentVersion', 'target', 'origin'].map(key => ({ ...candidate, [key]: 5 })),
    { ...candidate, sources: [{ title: 'Source', url: 'https://example.com/', extra: true }] },
    { ...candidate, content: [{ type: 'paragraph', attrs: { id: 'old' } }] },
    { ...candidate, content: [paragraph(), paragraph()] },
    { object: { ...objects()[0], layout: { ...layout, height: 80 } }, summary: 'Invalid auto-height object' },
    { object: { ...objects()[0], content: doc([{ ...paragraph(), attrs: { id: 'p', semantic: 'code' } }]) }, summary: 'Code is an object' },
    { object: { ...objects()[2], markup: { width: 120, height: 80, strokes: [], labels: [], extra: true } }, summary: 'Closed markup' },
    { ...candidate, summary: ' ' },
  ]) invalid(value)
  assert.throws(() => validateProposalDelivery({ ...candidate, extra: true }), { path: 'candidate.extra' })
  assert.throws(() => validateProposalDelivery({ object: { ...objects()[0], layout: { ...layout, extra: true } }, summary: 'Invalid layout' }), { path: 'object.layout.extra' })
})

test('segments validate their own composition, geometry and anchors, not an external reservation', () => {
  const value = segment()
  value.objects = [{ ...objects()[0], layout: { width: 120, placement: { type: 'flow', x: 'center' } } }]
  value.content.push({ type: 'flow', attrs: { id: 'flow', objectId: value.objects[0].id } })
  value.geometry[value.objects[0].id] = { x: 0, y: 10, width: 120, height: 80 }
  assert.deepEqual(validateProposalDelivery({ segment: value, summary: 'Self-contained composition' }).segment, value)
  for (const change of [
    payload => payload.content.pop(),
    payload => { payload.geometry.unknown = { x: 0, y: 0, width: 1, height: 1 } },
    payload => { payload.geometry[payload.objects[0].id].extra = true },
    payload => { payload.anchorTops.unknown = 0 },
    payload => { payload.objects[0].layout.placement = { type: 'float', anchorId: 'external', x: 0, y: 0 } },
    payload => { payload.objects = [null] },
    payload => { payload.extra = true },
    payload => payload.content.push({ type: 'slideBreak', attrs: { id: 'slide' } }),
  ]) {
    const payload = structuredClone(value); change(payload)
    invalid({ segment: payload, summary: 'Invalid composition' })
  }
})

test('HTML screenshots use supplied object dimensions and resolve transport assets without retained paths', () => {
  const object = objects().at(-1)
  delete object.screenshot
  const candidate = { object, summary: 'Widget', screenshotPath: 'screens/widget.png' }
  const result = validateProposalDelivery(candidate, { 'screens/widget.png': png(120, 80) })
  assert.equal(result.object.screenshot, png(120, 80))
  assert.equal('screenshotPath' in result, false)
  assert.equal('screenshot' in object, false)
  invalid(candidate, { 'screens/widget.png': png(240, 160) })
  invalid(candidate, {})
  invalid(candidate, { 'screens/widget.png': png(120, 80), 'unused.png': png(120, 80) })
  invalid({ ...candidate, screenshotPath: '../widget.png' }, { '../widget.png': png(120, 80) })
  invalid({ object: { ...object, screenshot: svg }, summary: 'PNG required' })
  const value = segment()
  value.objects.push({ ...object, layout: { ...object.layout, placement: { ...layout.placement, anchorId: 'paragraph' } } })
  const transport = { segment: value, summary: 'Widget section', screenshotPaths: { [object.id]: 'shot.png' } }
  const resolved = validateProposalDelivery(transport, { 'shot.png': png(120, 80) })
  assert.equal(resolved.segment.objects[0].screenshot, png(120, 80))
  assert.equal('screenshotPaths' in resolved, false)
  invalid({ ...transport, screenshotPaths: { unknown: 'shot.png' } }, { 'shot.png': png(120, 80) })
  invalid({ ...transport, segment: { ...value, objects: [null] } }, { 'shot.png': png(120, 80) })
})

test('published schema identifies the current native grammar and all references resolve locally', async () => {
  const schema = JSON.parse(await readFile(new URL('../public/skills/proposal-schema.json', import.meta.url)))
  assert.equal(schema.$id, PROPOSAL_SCHEMA_URL)
  assert.equal(schema.documentFormat, 'mote')
  assert.equal(schema.documentFormatVersion, DOCUMENT_VERSION)
  assert.equal(schema.additionalProperties, false)
  assert.equal('documentFormatVersion' in schema.properties, false)
  for (const object of objects()) assert.ok(schema.$defs[`${object.kind}Object`])
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/$defs/'))
      assert.ok(schema.$defs[value.$ref.slice('#/$defs/'.length)], value.$ref)
    }
    Object.values(value).forEach(visit)
  }
  visit(schema)
})
