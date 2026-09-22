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

const segmentTarget = (range: { start: { index: number; offset: number }; end: { index: number; offset: number } }, blockIds: string[], objectIds: string[] = [], bookmarks = {
  start: { blockId: blockIds[0] ?? 'b', offset: 0 }, end: { blockId: blockIds.at(-1) ?? 'a', offset: 0, after: true },
}) => ({ kind: 'segment', range, blockIds, objectIds, area: { x: 0, y: 0, width: 100, height: 100 }, bookmarks })
const segmentTask = (target: ReturnType<typeof segmentTarget>, blocks: ReturnType<typeof paragraph>[], objects: FloatingObject[] = []) => ({
  id: 'segment-task', documentId: 'document', target, original: { version: 'V0', type: 'segment', content: structuredClone(blocks), floating: structuredClone(objects), palette: [], geometry: {}, anchorTops: {}, originTop: 0 },
  segmentOriginalBlocks: structuredClone(blocks), segmentOriginalObjects: structuredClone(objects), status: 'draft', submitted: false,
} as unknown as AITask)

test('empty segment anchors survive unrelated text edits but not anchor loss', () => {
  const target = segmentTarget({ start: { index: 1, offset: 0 }, end: { index: 1, offset: 0 } }, [], [], {
    start: { blockId: 'b', offset: 0 }, end: { blockId: 'a', offset: 0, after: true },
  })
  const task = segmentTask(target, [])
  assert.equal(permits([task], doc, { ...doc, content: { ...doc.content, content: [paragraph('a', 'edited'), paragraph('b'), paragraph('new')] } }), true)
  assert.equal(permits([task], doc, { ...doc, content: { ...doc.content, content: [paragraph('a')] } }), false)
})

test('partial spacer reservations lock the touched spacer without locking surrounding paragraphs', () => {
  const space = { type: 'spacer', attrs: { id: 'space', height: 100 } }
  const spaced = { ...doc, content: { ...doc.content, content: [paragraph('a'), space, paragraph('b')] } }
  const target = segmentTarget({ start: { index: 1, offset: 25 }, end: { index: 1, offset: 75 } }, ['space'], [], {
    start: { blockId: 'space', offset: 25 }, end: { blockId: 'space', offset: 75 },
  })
  const task = segmentTask(target, [space])
  assert.equal(permits([task], spaced, { ...spaced, content: { ...spaced.content, content: [paragraph('a', 'changed'), space, paragraph('b')] } }), true)
  assert.equal(permits([task], spaced, { ...spaced, content: { ...spaced.content, content: [paragraph('a'), { ...space, attrs: { ...space.attrs, height: 120 } }, paragraph('b')] } }), false)
})

test('segment reservations overlap touched blocks, owned objects, and identical empty boundaries', () => {
  const text = { kind: 'text', blockIds: ['space'] } as AITask['target']
  const partial = segmentTarget({ start: { index: 1, offset: 10 }, end: { index: 1, offset: 20 } }, ['space'])
  assert.equal(overlaps(text, partial), true)
  assert.equal(overlaps(partial, { kind: 'object', objectId: 'box' } as AITask['target']), false)
  const owned = { ...partial, objectIds: ['box'] }
  assert.equal(overlaps(owned, { kind: 'object', objectId: 'box' } as AITask['target']), true)
  const empty = segmentTarget({ start: { index: 1, offset: 0 }, end: { index: 1, offset: 0 } }, [], [], {
    start: { blockId: 'b', offset: 0 }, end: { blockId: 'a', offset: 0, after: true },
  })
  assert.equal(overlaps(empty, { ...empty }), true)
  const containing = segmentTarget({ start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, ['a', 'b'], [], {
    start: { blockId: 'a', offset: 0 }, end: { blockId: 'b', offset: 0, after: true },
  })
  assert.equal(overlaps(empty, containing, doc), true)
  assert.equal(overlaps(containing, empty, doc), true)
  assert.equal(overlaps(empty, { ...textTask.target, blockIds: ['d'] } as AITask['target'], doc), false)
})

test('segment guards preserve outside edits and reject interleaving or owned composition moves', () => {
  const base = { ...doc, floating: [], content: { ...doc.content, content: [paragraph('a'), paragraph('b'), paragraph('c')] } }
  const target = segmentTarget({ start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, ['a', 'b'], [], {
    start: { blockId: 'a', offset: 0 }, end: { blockId: 'b', offset: 0, after: true },
  })
  const task = segmentTask(target, [paragraph('a'), paragraph('b')])
  assert.equal(permits([task], base, { ...base, content: { ...base.content, content: [paragraph('a'), paragraph('b'), paragraph('outside'), paragraph('c')] } }), true)
  assert.equal(permits([task], base, { ...base, content: { ...base.content, content: [paragraph('a'), paragraph('new'), paragraph('b'), paragraph('c')] } }), false)

  const composition = { ...base, floating: [{ ...object, anchorId: 'a' }, { ...object, id: 'other', anchorId: 'a', x: 20 }] }
  const compositionTarget = { ...target, objectIds: ['box', 'other'] }
  const compositionTask = segmentTask(compositionTarget, [paragraph('a'), paragraph('b')], composition.floating)
  assert.equal(permits([compositionTask], composition, { ...composition, floating: composition.floating.map(note => note.id === 'other' ? { ...note, x: 21 } : note) }), false)

  const single = { ...base, floating: [{ ...object, anchorId: 'a' }] }
  const singleTarget = { ...target, objectIds: ['box'] }
  const singleTask = segmentTask(singleTarget, [paragraph('a'), paragraph('b')], single.floating)
  assert.equal(permits([singleTask], single, { ...single, floating: [{ ...single.floating[0], anchorId: 'c' }] }), false)
})
