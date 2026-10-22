import test from 'node:test'
import assert from 'node:assert/strict'
import { compatibleTasks, currentPlacement, inactiveTaskReason, overlaps, permits, permitsEditor, paragraphSelection, segmentReservationIntact } from '../src/ai/reservations.ts'
import { patchFloating } from '../src/canvas/patchFloating.ts'
import { Schema } from '@tiptap/pm/model'
import type { MoteDocument, FloatingDrawing, FloatingHTMLWidget, FloatingObject } from '../src/document/model.ts'
import type { AITask } from '../src/ai/types.ts'

const paragraph = (id: string, text = id) => ({ type: 'paragraph', attrs: { id, semantic: 'body' }, content: [{ type: 'text', text }] })
const captionContent = { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption-text' }, content: [{ type: 'text', text: 'Caption' }] }] }, width: 240 }
const object: FloatingHTMLWidget = { id: 'box', kind: 'html', anchorId: 'a', x: 12, y: 20, width: 320, height: 180, placement: 'float', html: 'before', screenshot: 'png', alt: 'Figure', caption: captionContent }
const doc = { id: 'document', content: { type: 'doc', content: ['a', 'b', 'c', 'd'].map(id => paragraph(id)) }, floating: [object] } as MoteDocument
const textTask = { target: { kind: 'text', blockIds: ['b', 'c'] } } as AITask
const objectTask = { target: { kind: 'object', objectId: 'box' } } as AITask

test('partial selections expand to complete paragraphs without swallowing the next boundary', () => {
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', attrs: { id: {} } }, spacer: { group: 'block' }, flow: { group: 'block', attrs: { id: {}, objectId: {} } }, text: {} } })
  const doc = schema.nodeFromJSON({ type: 'doc', content: [paragraph('a', 'first'), paragraph('b', 'second'), paragraph('c', 'third')] })
  assert.deepEqual(paragraphSelection(doc, 3, 10), { blockIds: ['a', 'b'], selection: { from: 1, to: 14 }, selectedText: 'first\nsecond' })
  assert.deepEqual(paragraphSelection(doc, 3, 8)?.blockIds, ['a'])
  assert.deepEqual(paragraphSelection(doc, 10, 10), { blockIds: ['b'], selection: { from: 8, to: 14 }, selectedText: 'second' })
  const empty = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'empty' } }] })
  assert.deepEqual(paragraphSelection(empty, 1, 1), { blockIds: ['empty'], selection: { from: 1, to: 1 }, selectedText: '' })
  const spaced = schema.nodeFromJSON({ type: 'doc', content: [paragraph('a', 'first'), { type: 'spacer' }, paragraph('b', 'second')] })
  assert.equal(paragraphSelection(spaced, 3, 11), null)
  assert.equal(paragraphSelection(spaced, 3, 8), null)
  const flowing = schema.nodeFromJSON({ type: 'doc', content: [paragraph('a', 'first'), { type: 'flow', attrs: { id: 'flow-block', objectId: 'box' } }, paragraph('b', 'second')] })
  assert.equal(paragraphSelection(flowing, 3, 11), null)
})

test('reservations allow unrelated edits and placement, but block content, size, and removal', () => {
  assert.equal(permits([objectTask], doc, { ...doc, floating: [{ ...object, x: 90, y: 160, anchorId: 'c' }] }), true)
  for (const patch of [{ width: 321 }, { html: 'after' }, { screenshot: 'other' }]) {
    assert.equal(permits([objectTask], doc, { ...doc, floating: [{ ...object, ...patch }] }), false)
  }
  assert.equal(permits([objectTask], doc, { ...doc, floating: [] }), false)
  assert.equal(permits([textTask], doc, { ...doc, content: { ...doc.content, content: [paragraph('a', 'edited'), ...doc.content.content!.slice(1)] } }), true)
})

test('drawing reservations lock strokes and labels while figure projection retains placement', () => {
  const drawing: FloatingObject = { id: 'box', kind: 'drawing', anchorId: 'a', x: 12, y: 20, width: 320, height: 180, placement: 'float', background: null,
    strokes: [{ points: [[1, 2], [3, 4]], color: 'gray1', width: 2 }], labels: [{ x: 5, y: 6, text: 'A', color: 'gray1', size: 16 }] }
  const source = { ...doc, floating: [drawing] }
  assert.equal(permits([objectTask], source, { ...source, floating: [{ ...drawing, x: 50 }] }), true)
  for (const patch of [{ strokes: [] }, { labels: [] }, { width: 500 }, { background: 'gray6' as const }]) {
    assert.equal(permits([objectTask], source, { ...source, floating: [{ ...drawing, ...patch }] }), false)
  }
  const projected = currentPlacement(object, drawing)
  assert.equal(projected.kind, 'html')
  assert.equal(projected.width, drawing.width)
  assert.equal('height' in projected && projected.height, drawing.height)
  assert.equal(projected.placement, 'float')
  assert.equal(projected.anchorId, 'a')
})

const drawing: FloatingDrawing = { id: 'box', kind: 'drawing', anchorId: 'a', x: 12, y: 20, width: 317, height: 179, placement: 'float', background: null,
  strokes: [{ points: [[1.1, 2.2], [151.3, 174.4]], color: 'gray1', width: 2 }], labels: [{ x: 57.1, y: 63.2, text: 'A', color: 'gray1', size: 16 }] }

test('draft drawing reservations accept scaled positions without unlocking drawing content', () => {
  const task = { ...objectTask, documentId: doc.id, original: drawing, status: 'draft', submitted: false } as AITask
  const source = { ...doc, floating: [drawing] }
  let previous = source
  for (const [width, height] of [[431, 257], [703, 311], [317, 179]]) {
    const resized = patchFloating(previous.floating[0], { width, height }) as FloatingDrawing
    const next = { ...source, floating: [resized] }
    assert.equal(permits([task], previous, next), true)
    assert.equal(inactiveTaskReason(task, next), null)
    previous = next
  }
  const resized = patchFloating(drawing, { width: 431, height: 257 }) as FloatingDrawing
  resized.strokes[0].points[0][0] += 1e-10
  const next = { ...source, floating: [resized] }
  assert.equal(permits([task], source, next), true)
  assert.equal(inactiveTaskReason(task, next), null)
  const edits: Array<(value: FloatingDrawing) => void> = [
    value => { value.strokes[0].points[0][0] += .01 }, value => { value.strokes[0].points.reverse() },
    value => { value.strokes[0].points.push([10, 10]) }, value => { value.strokes.push(structuredClone(value.strokes[0])) },
    value => { value.strokes[0].width = 3 }, value => { value.strokes[0].color = 'gray3' },
    value => { value.labels[0].x += .01 }, value => { value.labels[0].size = 17 },
    value => { value.labels[0].color = 'gray3' }, value => { value.labels[0].text = 'B' },
    value => { value.labels = [] }, value => { value.background = 'gray6' },
  ]
  for (const edit of edits) {
    const changed = structuredClone(resized); edit(changed)
    const after = { ...source, floating: [changed] }
    assert.equal(permits([task], source, after), false)
    assert.notEqual(inactiveTaskReason(task, after), null)
  }
  for (const patch of [{ status: 'preparing' }, { requestSent: true }, { submitted: true }, { pendingExecutor: { executor: 'external', operationId: 'switch' } }]) {
    const frozen = { ...task, ...patch } as AITask
    assert.equal(permits([frozen], source, next), false)
    assert.notEqual(inactiveTaskReason(frozen, next), null)
  }
})

test('drawing candidate placement scales positions into target bounds while retaining pen and font sizes', () => {
  const candidate: FloatingDrawing = { ...drawing, x: 999, y: 999, width: 100, height: 50,
    strokes: [{ points: [[25, 10], [100, 50]], color: 'gray3', width: 3 }], labels: [{ x: 50, y: 25, text: 'B', color: 'gray1', size: 18 }] }
  const before = structuredClone(candidate)
  for (const original of [{ ...drawing, width: 200, height: 150 }, { ...object, width: 200, height: 150 }]) {
    const placed = currentPlacement(candidate, original) as FloatingDrawing
    assert.deepEqual(placed.strokes, [{ points: [[50, 30], [200, 150]], color: 'gray3', width: 3 }])
    assert.deepEqual(placed.labels, [{ x: 100, y: 75, text: 'B', color: 'gray1', size: 18 }])
    assert.equal(placed.x, original.x); assert.equal(placed.y, original.y)
    assert.equal(placed.width, 200); assert.equal(placed.height, 150)
    assert.deepEqual(currentPlacement(candidate, original), placed)
  }
  assert.deepEqual(candidate, before)
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
  for (const patch of [{ status: 'preparing' }, { requestSent: true, status: 'error' }, { submitted: true, status: 'stopped' },
    { pendingExecutor: { executor: 'external', operationId: 'switch' } }]) {
    assert.equal(permits([{ ...draft, ...patch } as AITask], doc, resized), false)
  }
})

test('released executor reservations retain their result without locking document content', () => {
  const task = { ...objectTask, documentId: doc.id, original: object, released: true, candidate: { object, summary: 'Retained' } } as AITask
  assert.deepEqual(compatibleTasks([task], doc), [])
  assert.equal(task.candidate?.summary, 'Retained')
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

test('object reservations protect embedded captions and candidates preserve or explicitly remove them', () => {
  const changedCaption = { ...object, caption: structuredClone(captionContent) }
  changedCaption.caption!.content.content![0].content![0].text = 'Changed'
  assert.equal(permits([objectTask], doc, { ...doc, floating: [changedCaption] }), false)
  assert.equal(permits([objectTask], doc, { ...doc, floating: [{ ...object, caption: { ...object.caption!, width: 420 } }] }), true)
  const { caption: _removedCaption, ...withoutCaption } = object
  assert.equal(permits([objectTask], doc, { ...doc, floating: [withoutCaption] as FloatingObject[] }), false)
  assert.equal(permitsEditor([objectTask], 'box:caption:caption-text', captionContent.content, changedCaption.caption?.content), false)
  assert.equal(permitsEditor([objectTask], 'box:caption:caption-text', captionContent.content, captionContent.content), true)

  const moved = { ...object, x: 50, y: 80, anchorId: 'd' }
  const { caption: _omitted, ...candidateWithoutCaption } = object
  const candidate = { ...candidateWithoutCaption, html: 'after', x: 400 } as FloatingObject
  const applied = currentPlacement(candidate, moved)
  assert.equal(applied.x, 50); assert.equal(applied.y, 80)
  assert.deepEqual('caption' in applied && applied.caption, moved.caption)

  const candidateWithResizedCaption = { ...object, html: 'after', caption: { ...object.caption!, width: 600 } }
  const sizedOriginal = { ...object, caption: { ...object.caption!, width: 310 } }
  const restoredWidth = currentPlacement(candidateWithResizedCaption, sizedOriginal)
  assert.equal('caption' in restoredWidth && restoredWidth.caption?.width, 310)
  const originalWithoutWidth = { ...object, caption: { content: object.caption!.content } }
  const clearedCandidateWidth = currentPlacement(candidateWithResizedCaption, originalWithoutWidth)
  assert.equal('caption' in clearedCandidateWidth && clearedCandidateWidth.caption?.width, undefined)
  const converted = currentPlacement({ ...object, caption: { ...object.caption!, width: 330 } }, drawing)
  assert.equal('caption' in converted && converted.caption?.width, 330)

  const emptyCaption = { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'candidate-empty' } }] }, width: 600 }
  const removed = currentPlacement({ ...object, caption: emptyCaption }, moved)
  assert.equal('caption' in removed, false)
})

test('Flow revisions retain current placement and centering and protect the structural block', () => {
  const flow = { type: 'flow', attrs: { id: 'flow-block', objectId: 'box' } }
  const original = { ...object, placement: 'flow', centered: true, anchorId: 'flow-block', x: 0, y: 0 } as FloatingObject
  const source = { ...doc, content: { type: 'doc', content: [paragraph('a'), flow, paragraph('b')] }, floating: [original] }
  const candidate = { ...object, centered: false }
  const applied = currentPlacement(candidate, original)
  assert.equal(applied.placement, 'flow'); assert.equal(applied.centered, true)
  assert.equal(applied.anchorId, 'flow-block'); assert.equal(applied.y, 0)
  assert.equal(currentPlacement({ ...candidate, centered: true }, object).centered, undefined)
  assert.equal('centered' in currentPlacement({ ...candidate, centered: true }, object), false)
  assert.equal(permits([objectTask], source, { ...source, floating: [{ ...original, centered: false, x: 24 }] }), true)
  assert.equal(permitsEditor([objectTask], 'main', source.content, { type: 'doc', content: [paragraph('a'), paragraph('b')] }), false)
  assert.equal(permitsEditor([objectTask], 'main', source.content, { type: 'doc', content: [flow, paragraph('a'), paragraph('b')] }), true)
})

const segmentTarget = (range: { start: { index: number; offset: number }; end: { index: number; offset: number } }, blockIds: string[], objectIds: string[] = [], bookmarks = {
  start: { blockId: blockIds[0] ?? 'b', offset: 0 }, end: { blockId: blockIds.at(-1) ?? 'a', offset: 0, after: true },
}) => ({ kind: 'segment', range, blockIds, objectIds, area: { x: 0, y: 0, width: 100, height: 100 }, bookmarks })
const segmentTask = (target: ReturnType<typeof segmentTarget>, blocks: ReturnType<typeof paragraph>[], objects: FloatingObject[] = []) => ({
  id: 'segment-task', documentId: 'document', target, original: { version: 'V0', type: 'segment', content: structuredClone(blocks), floating: structuredClone(objects), geometry: {}, anchorTops: {}, originTop: 0 },
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

test('segment ownership and reservation include the object caption automatically', () => {
  const floating = [{ ...object, anchorId: 'a' }]
  const target = segmentTarget({ start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, ['a', 'b'], ['box'])
  const task = segmentTask(target, [paragraph('a'), paragraph('b')], floating)
  const source = { ...doc, floating }
  assert.equal(segmentReservationIntact(task, source), true)
  const changed = structuredClone(floating[0])
  changed.caption!.content.content![0].content![0].text = 'Changed'
  assert.equal(segmentReservationIntact(task, { ...source, floating: [changed] }), false)
  const resizedCaption = { ...source, floating: [{ ...floating[0], caption: { ...floating[0].caption!, width: 400 } }] }
  assert.equal(segmentReservationIntact(task, resizedCaption), false)
  assert.equal(permits([task], source, resizedCaption), false)
  assert.equal(permitsEditor([task], 'box:caption:caption-text', captionContent.content, changed.caption?.content), false)
})

test('a Flow segment reserves its block, object, anchored Floats, and captions together', () => {
  const flow = { type: 'flow', attrs: { id: 'flow-block', objectId: 'box' } }
  const primary = { ...object, placement: 'flow', anchorId: 'flow-block', y: 0, centered: true } as FloatingObject
  const floating = [primary, { ...object, id: 'detail', anchorId: 'flow-block', x: 10, y: 20 }]
  const source = { ...doc, content: { type: 'doc', content: [paragraph('a'), flow, paragraph('d')] }, floating }
  const target = segmentTarget({ start: { index: 1, offset: 0 }, end: { index: 2, offset: 0 } }, ['flow-block'], ['box', 'detail'])
  const task = segmentTask(target, [flow], floating)
  assert.equal(segmentReservationIntact(task, source), true)
  assert.equal(overlaps(target, objectTask.target, source), true)
  const changedOwner = structuredClone(floating[0])
  if ('caption' in changedOwner && changedOwner.caption) changedOwner.caption.content.content![0].content![0].text = 'Changed'
  assert.equal(permits([task], source, { ...source, floating: [changedOwner, floating[1]] }), false)
  assert.equal(permits([task], source, { ...source, floating: floating.map(item => item.id === 'box' ? { ...item, centered: false } : item) }), false)
  assert.equal(permits([task], source, { ...source, floating: floating.map(item => item.id === 'detail' ? { ...item, anchorId: 'd' } : item) }), false)
  assert.equal(permitsEditor([task], 'main', source.content, { ...source.content, content: [paragraph('a'), paragraph('d')] }), false)
})
