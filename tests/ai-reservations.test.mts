import test from 'node:test'
import assert from 'node:assert/strict'
import { compatibleTasks, currentPlacement, inactiveTaskReason, overlaps, permits, permitsEditor, paragraphSelection, segmentReservationIntact } from '../src/ai/reservations.ts'
import { patchFloating } from '../src/canvas/patchFloating.ts'
import { Schema } from '@tiptap/pm/model'
import type { MoteDocument, FloatingDrawing, FloatingLine, FloatingObject } from '../src/document/model.ts'
import type { AITask } from '../src/ai/types.ts'

const paragraph = (id: string, text = id) => ({ type: 'paragraph', attrs: { id, semantic: 'body' }, content: [{ type: 'text', text }] })
const object = { id: 'box', kind: 'html', anchorId: 'a', x: 12, y: 20, width: 320, height: 180, textFlow: 'overlap', html: 'before', screenshot: 'png', alt: 'Figure' } as FloatingObject
const caption = { id: 'caption', kind: 'text', anchorId: 'd', x: 24, y: 12, width: 88, textFlow: 'overlap',
  content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption-text', semantic: 'caption' }, content: [{ type: 'text', text: 'Caption' }] }] },
  attachment: { targetId: 'box', position: 'above' } } as FloatingObject
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

test('drawing reservations lock strokes and labels while figure projection retains placement', () => {
  const drawing: FloatingObject = { id: 'box', kind: 'drawing', anchorId: 'a', x: 12, y: 20, width: 320, height: 180, textFlow: 'repel', background: null,
    strokes: [{ points: [[1, 2], [3, 4]], color: 'ink', width: 2 }], labels: [{ x: 5, y: 6, text: 'A', color: 'ink', size: 16 }] }
  const source = { ...doc, floating: [drawing] }
  assert.equal(permits([objectTask], source, { ...source, floating: [{ ...drawing, x: 50 }] }), true)
  for (const patch of [{ strokes: [] }, { labels: [] }, { width: 500 }, { background: 'paper' as const }]) {
    assert.equal(permits([objectTask], source, { ...source, floating: [{ ...drawing, ...patch }] }), false)
  }
  const projected = currentPlacement(object, drawing)
  assert.equal(projected.kind, 'html')
  assert.equal(projected.width, drawing.width)
  assert.equal('height' in projected && projected.height, drawing.height)
  assert.equal(projected.textFlow, 'repel')
  assert.equal(projected.anchorId, 'a')
})

const drawing: FloatingDrawing = { id: 'box', kind: 'drawing', anchorId: 'a', x: 12, y: 20, width: 317, height: 179, textFlow: 'repel', background: null,
  strokes: [{ points: [[1.1, 2.2], [151.3, 174.4]], color: 'ink', width: 2 }], labels: [{ x: 57.1, y: 63.2, text: 'A', color: 'ink', size: 16 }] }

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
    value => { value.strokes[0].width = 3 }, value => { value.strokes[0].color = 'muted' },
    value => { value.labels[0].x += .01 }, value => { value.labels[0].size = 17 },
    value => { value.labels[0].color = 'muted' }, value => { value.labels[0].text = 'B' },
    value => { value.labels = [] }, value => { value.background = 'paper' },
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
    strokes: [{ points: [[25, 10], [100, 50]], color: 'muted', width: 3 }], labels: [{ x: 50, y: 25, text: 'B', color: 'ink', size: 18 }] }
  const before = structuredClone(candidate)
  for (const original of [{ ...drawing, width: 200, height: 150 }, { ...object, width: 200, height: 150 }]) {
    const placed = currentPlacement(candidate, original) as FloatingDrawing
    assert.deepEqual(placed.strokes, [{ points: [[50, 30], [200, 150]], color: 'muted', width: 3 }])
    assert.deepEqual(placed.labels, [{ x: 100, y: 75, text: 'B', color: 'ink', size: 18 }])
    assert.equal(placed.x, original.x); assert.equal(placed.y, original.y)
    assert.equal(placed.width, 200); assert.equal(placed.height, 150)
    assert.deepEqual(currentPlacement(candidate, original), placed)
  }
  assert.deepEqual(candidate, before)
})

test('drawing-to-line conversion fits path and bend to the moved target without external connections', () => {
  const candidate: FloatingLine = { id: 'box', kind: 'line', anchorId: 'old', x: 20, y: 20, width: 100, textFlow: 'overlap',
    start: { x: 100, y: 20, anchorId: 'outside-a', connection: { targetId: 'other', side: 'auto' } },
    end: { x: 20, y: 80, anchorId: 'outside-b', connection: { targetId: 'other-2', side: 'auto' } },
    route: 'elbow', bend: 60, stroke: 'ink', strokeWidth: 2, dashed: false, arrowStart: false, arrowEnd: true }
  const moved = { ...drawing, x: 10, y: 40, width: 320, height: 180, anchorId: 'c' }
  const placed = currentPlacement(candidate, moved) as FloatingLine
  assert.deepEqual(placed.start, { x: 266, y: 40, anchorId: 'c' })
  assert.deepEqual(placed.end, { x: 10, y: 220, anchorId: 'c' })
  assert.equal(placed.bend, 192)
  assert.equal((placed.start.x + placed.end.x) / 2 + placed.bend, moved.x + moved.width)
  assert.equal(placed.arrowEnd, true); assert.equal(placed.strokeWidth, 2)
  for (const [start, end, expectedStart, expectedEnd] of [
    [[100, 20], [20, 20], [330, 130], [10, 130]],
    [[20, 80], [20, 20], [170, 220], [170, 40]],
    [[20, 20], [20, 20], [170, 130], [170, 130]],
  ]) {
    const straight = { ...candidate, route: 'straight' as const, start: { x: start[0], y: start[1], anchorId: null }, end: { x: end[0], y: end[1], anchorId: null } }
    const bound = currentPlacement(straight, moved) as FloatingLine
    assert.deepEqual([bound.start.x, bound.start.y], expectedStart)
    assert.deepEqual([bound.end.x, bound.end.y], expectedEnd)
    assert.equal(bound.bend, 0)
  }
  const originalLine = { ...candidate, start: { x: 5, y: 6, anchorId: 'd' }, bend: 17 }
  const unchanged = currentPlacement(candidate, originalLine) as FloatingLine
  assert.deepEqual(unchanged.start, originalLine.start)
  assert.deepEqual(unchanged.end, originalLine.end)
  assert.equal(unchanged.bend, 17)
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

test('attached text binding is placement for reservations and survives candidate acceptance', () => {
  const captionDoc = { ...doc, floating: [object, caption] }
  const task = { ...objectTask, target: { kind: 'object', objectId: 'caption' }, original: caption } as AITask
  const below = { ...caption, attachment: { targetId: 'box', position: 'below' } } as FloatingObject
  assert.equal(permits([task], captionDoc, { ...captionDoc, floating: [object, below] }), true)

  const moved = { ...caption, x: 50, y: 80, attachment: { targetId: 'box', position: 'above' } } as FloatingObject
  const candidate = { ...caption, x: 400, attachment: { targetId: 'other', position: 'below' } } as FloatingObject
  const applied = currentPlacement(candidate, moved)
  assert.equal(applied.x, 50); assert.equal(applied.y, 80)
  assert.deepEqual(applied.attachment, moved.attachment)
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

test('attached captions follow targets for segment ownership and reservation', () => {
  const floating = [{ ...object, anchorId: 'a' }, caption]
  const target = segmentTarget({ start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, ['a', 'b'], ['box', 'caption'])
  const task = segmentTask(target, [paragraph('a'), paragraph('b')], floating)
  const source = { ...doc, floating }
  assert.equal(segmentReservationIntact(task, source), true)
  assert.equal(segmentReservationIntact(task, { ...source, floating: [floating[0], { ...caption, attachment: null } as FloatingObject] }), false)
})
