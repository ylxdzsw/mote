import test from 'node:test'
import assert from 'node:assert/strict'
import { currentPlacement, overlaps, permits, permitsEditor, paragraphSelection } from '../src/ai/reservations.ts'
import { Schema } from '@tiptap/pm/model'
import type { MoteDocument, FloatingObject } from '../src/document/model.ts'
import type { AITask } from '../src/ai/types.ts'

const paragraph = (id: string, text = id) => ({ type: 'paragraph', attrs: { id, semantic: 'body' }, content: [{ type: 'text', text }] })
const object = { id: 'box', kind: 'html', anchorId: 'a', x: 12, y: 20, width: 320, height: 180, textFlow: 'overlap', html: 'before', screenshot: 'png', alt: 'Figure' } as FloatingObject
const doc = { id: 'document', content: { type: 'doc', content: ['a', 'b', 'c', 'd'].map(id => paragraph(id)) }, floating: [object] } as MoteDocument
const textTask = { target: { kind: 'text', blockIds: ['b', 'c'] } } as AITask
const objectTask = { target: { kind: 'object', objectId: 'box' } } as AITask

test('partial selections expand to complete paragraphs without swallowing the next boundary', () => {
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', attrs: { id: {} } }, spacer: { group: 'block' }, text: {} } })
  const doc = schema.nodeFromJSON({ type: 'doc', content: [paragraph('a', 'first'), paragraph('b', 'second'), paragraph('c', 'third')] })
  assert.deepEqual(paragraphSelection(doc, 3, 10), { blockIds: ['a', 'b'], selection: { from: 1, to: 14 }, selectedText: 'first\nsecond' })
  assert.deepEqual(paragraphSelection(doc, 3, 8)?.blockIds, ['a'])
  assert.deepEqual(paragraphSelection(doc, 10, 10), { blockIds: ['b'], selection: { from: 8, to: 14 }, selectedText: 'second' })
  const empty = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'empty' } }] })
  assert.deepEqual(paragraphSelection(empty, 1, 1), { blockIds: ['empty'], selection: { from: 1, to: 1 }, selectedText: '' })
  const spaced = schema.nodeFromJSON({ type: 'doc', content: [paragraph('a', 'first'), { type: 'spacer' }, paragraph('b', 'second')] })
  assert.equal(paragraphSelection(spaced, 3, 11), null)
  assert.equal(paragraphSelection(spaced, 3, 8), null)
})

test('reservations allow unrelated edits and placement, but block content, size, and removal', () => {
  assert.equal(permits([objectTask], doc, { ...doc, floating: [{ ...object, x: 90, y: 160, anchorId: 'c' }] }), true)
  for (const patch of [{ width: 321 }, { html: 'after' }, { screenshot: 'other' }]) {
    assert.equal(permits([objectTask], doc, { ...doc, floating: [{ ...object, ...patch }] }), false)
  }
  assert.equal(permits([objectTask], doc, { ...doc, floating: [] }), false)
  assert.equal(permits([textTask], doc, { ...doc, content: { ...doc.content, content: [paragraph('a', 'edited'), ...doc.content.content!.slice(1)] } }), true)
})

test('text boundary locks reject cross-range replacement, deletion, and interleaving', () => {
  for (const blocks of [[paragraph('a'), paragraph('b', 'changed'), paragraph('c'), paragraph('d')],
    [paragraph('a'), paragraph('c'), paragraph('d')], [paragraph('a'), paragraph('b'), paragraph('new'), paragraph('c'), paragraph('d')]]) {
    assert.equal(permitsEditor([textTask], 'main', doc.content, { type: 'doc', content: blocks }), false)
  }
  assert.equal(permitsEditor([textTask], 'main', doc.content, { type: 'doc', content: [paragraph('new'), ...doc.content.content!] }), true)
})

test('unsubmitted floating reservations allow size changes, but never content edits or uncertain submitted resizes', () => {
  const draft = { ...objectTask, status: 'draft', submitted: false } as AITask
  const resized = { ...doc, floating: [{ ...object, width: 400, height: 220 }] }
  assert.equal(permits([draft], doc, resized), true)
  assert.equal(permits([draft], doc, { ...doc, floating: [{ ...object, html: 'changed' }] }), false)
  for (const patch of [{ status: 'preparing' }, { requestSent: true, status: 'error' }, { submitted: true, status: 'stopped' }]) {
    assert.equal(permits([{ ...draft, ...patch } as AITask], doc, resized), false)
  }
})

test('concurrent tasks reject overlap and accepted object preserves current geometry', () => {
  assert.equal(overlaps(textTask.target, { ...textTask.target, blockIds: ['c', 'd'] } as typeof textTask.target), true)
  assert.equal(overlaps(textTask.target, objectTask.target), false)
  const moved = { ...object, x: 70, y: 80, anchorId: 'd' }
  const candidate = { ...object, html: 'after', width: 999, x: 999 }
  const applied = currentPlacement(candidate, moved)
  assert.equal(applied.x, 70); assert.equal(applied.y, 80); assert.equal(applied.width, 320)
  assert.equal(applied.anchorId, 'd'); assert.equal('html' in applied && applied.html, 'after')
})
