import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { Schema } from '@tiptap/pm/model'
import type { MoteDocument, FloatingDrawing, FloatingHTMLWidget, FloatingObject } from '../src/document/model.ts'
import type { AITask } from '../src/ai/types.ts'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { compatibleTasks, currentPlacement, inactiveTaskReason, overlaps, permits, permitsEditor, paragraphSelection, segmentReservationIntact } = await server.ssrLoadModule('/src/ai/reservations.ts')
const { patchFloating } = await server.ssrLoadModule('/src/canvas/patchFloating.ts')
const { createBlankDocument, patchObject } = await server.ssrLoadModule('/src/document/model.ts')

const paragraph = (id: string, text = id) => ({ type: 'paragraph', attrs: { id, semantic: 'body' }, content: [{ type: 'text', text }] })
const captionContent = { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption-text' }, content: [{ type: 'text', text: 'Caption' }] }] }, width: 240 }
const object: FloatingHTMLWidget = { id: 'box', kind: 'html', layout: { width: 320, height: 180, placement: { type: 'float', anchorId: 'a', x: 12, y: 20 } }, html: 'before', screenshot: 'png', alt: 'Figure', caption: captionContent }
const doc = { ...createBlankDocument(), id: 'document', content: { type: 'doc', content: ['a', 'b', 'c', 'd'].map(id => paragraph(id)) }, objects: [object] } as MoteDocument
const taskVersion = { protocol: 'mote-agent-v1', documentVersion: 1, snapshotDocument: doc }
const textTask = { ...taskVersion, target: { kind: 'text', blockIds: ['b', 'c'] } } as AITask
const objectTask = { ...taskVersion, target: { kind: 'object', objectId: 'box' } } as AITask

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
  assert.equal(permits([objectTask], doc, { ...doc, objects: [patchObject(object, { x: 90, y: 160, anchorId: 'c' })] }), true)
  for (const patch of [{ width: 321 }, { html: 'after' }, { screenshot: 'other' }]) {
    assert.equal(permits([objectTask], doc, { ...doc, objects: [patchObject(object, patch)] }), false)
  }
  assert.equal(permits([objectTask], doc, { ...doc, objects: [] }), false)
  assert.equal(permits([textTask], doc, { ...doc, content: { ...doc.content, content: [paragraph('a', 'edited'), ...doc.content.content!.slice(1)] } }), true)
})

test('drawing reservations lock strokes and labels while figure projection retains placement', () => {
  const drawing: FloatingObject = { id: 'box', kind: 'drawing', layout: { width: 320, height: 180, placement: { type: 'float', anchorId: 'a', x: 12, y: 20 } }, background: null,
    strokes: [{ points: [[1, 2], [3, 4]], color: 'gray1', width: 2 }], labels: [{ x: 5, y: 6, text: 'A', color: 'gray1', size: 16 }] }
  const source = { ...doc, objects: [drawing] }
  assert.equal(permits([objectTask], source, { ...source, objects: [patchObject(drawing, { x: 50 })] }), true)
  for (const patch of [{ strokes: [] }, { labels: [] }, { width: 500 }, { background: 'gray6' as const }]) {
    assert.equal(permits([objectTask], source, { ...source, objects: [patchObject(drawing, patch)] }), false)
  }
  const projected = currentPlacement(object, drawing)
  assert.equal(projected.kind, 'html')
  assert.equal(projected.layout.width, drawing.layout.width)
  assert.equal(projected.layout.height, drawing.layout.height)
  assert.deepEqual(projected.layout.placement, drawing.layout.placement)
})

const drawing: FloatingDrawing = { id: 'box', kind: 'drawing', layout: { width: 317, height: 179, placement: { type: 'float', anchorId: 'a', x: 12, y: 20 } }, background: null,
  strokes: [{ points: [[1.1, 2.2], [151.3, 174.4]], color: 'gray1', width: 2 }], labels: [{ x: 57.1, y: 63.2, text: 'A', color: 'gray1', size: 16 }] }

test('draft drawing reservations accept scaled positions without unlocking drawing content', () => {
  const task = { ...objectTask, documentId: doc.id, original: drawing, status: 'draft', submitted: false } as AITask
  const source = { ...doc, objects: [drawing] }
  let previous = source
  for (const [width, height] of [[431, 257], [703, 311], [317, 179]]) {
    const resized = patchFloating(previous.objects[0], { width, height }) as FloatingDrawing
    const next = { ...source, objects: [resized] }
    assert.equal(permits([task], previous, next), true)
    assert.equal(inactiveTaskReason(task, next), null)
    previous = next
  }
  const resized = patchFloating(drawing, { width: 431, height: 257 }) as FloatingDrawing
  resized.strokes[0].points[0][0] += 1e-10
  const next = { ...source, objects: [resized] }
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
    const after = { ...source, objects: [changed] }
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
  const candidate: FloatingDrawing = { ...drawing, layout: { width: 100, height: 50, placement: { type: 'float', anchorId: 'a', x: 999, y: 999 } },
    strokes: [{ points: [[25, 10], [100, 50]], color: 'gray3', width: 3 }], labels: [{ x: 50, y: 25, text: 'B', color: 'gray1', size: 18 }] }
  const before = structuredClone(candidate)
  for (const original of [patchObject(drawing, { width: 200, height: 150 }), patchObject(object, { width: 200, height: 150 })]) {
    const placed = currentPlacement(candidate, original) as FloatingDrawing
    assert.deepEqual(placed.strokes, [{ points: [[50, 30], [200, 150]], color: 'gray3', width: 3 }])
    assert.deepEqual(placed.labels, [{ x: 100, y: 75, text: 'B', color: 'gray1', size: 18 }])
    assert.deepEqual(placed.layout.placement, original.layout.placement)
    assert.equal(placed.layout.width, 200); assert.equal(placed.layout.height, 150)
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

test('unsubmitted object reservations allow size changes, but never content edits or uncertain submitted resizes', () => {
  const draft = { ...objectTask, status: 'draft', submitted: false } as AITask
  const resized = { ...doc, objects: [patchObject(object, { width: 400, height: 220 })] }
  assert.equal(permits([draft], doc, resized), true)
  assert.equal(permits([draft], doc, { ...doc, objects: [{ ...object, html: 'changed' }] }), false)
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

test('unsupported task versions retain original recovery data without reserving V1 content', () => {
  const task = { ...objectTask, protocol: 'mote-agent-v0', documentVersion: 0, documentId: doc.id,
    original: object, candidate: { object, summary: 'Retained result' } } as AITask
  const before = structuredClone(task)
  assert.match(inactiveTaskReason(task, doc), /Unsupported task/)
  assert.deepEqual(compatibleTasks([task], doc), [])
  assert.deepEqual(task, before)
})

test('concurrent tasks reject overlap and accepted object preserves current geometry', () => {
  assert.equal(overlaps(textTask.target, { ...textTask.target, blockIds: ['c', 'd'] } as typeof textTask.target), true)
  assert.equal(overlaps(textTask.target, objectTask.target), false)
  const moved = patchObject(object, { x: 70, y: 80, anchorId: 'd' })
  const candidate = patchObject(object, { html: 'after', width: 999, x: 999 })
  const applied = currentPlacement(candidate, moved)
  assert.deepEqual(applied.layout.placement, { type: 'float', x: 70, y: 80, anchorId: 'd' }); assert.equal(applied.layout.width, 320)
  assert.equal('html' in applied && applied.html, 'after')
})

test('object reservations protect embedded captions and candidates preserve or explicitly remove them', () => {
  const changedCaption = { ...object, caption: structuredClone(captionContent) }
  changedCaption.caption!.content.content![0].content![0].text = 'Changed'
  assert.equal(permits([objectTask], doc, { ...doc, objects: [changedCaption] }), false)
  assert.equal(permits([objectTask], doc, { ...doc, objects: [{ ...object, caption: { ...object.caption!, width: 420 } }] }), true)
  const { caption: _removedCaption, ...withoutCaption } = object
  assert.equal(permits([objectTask], doc, { ...doc, objects: [withoutCaption] as FloatingObject[] }), false)
  assert.equal(permitsEditor([objectTask], 'box:caption:caption-text', captionContent.content, changedCaption.caption?.content), false)
  assert.equal(permitsEditor([objectTask], 'box:caption:caption-text', captionContent.content, captionContent.content), true)

  const moved = patchObject(object, { x: 50, y: 80, anchorId: 'd' })
  const { caption: _omitted, ...candidateWithoutCaption } = object
  const candidate = patchObject(candidateWithoutCaption, { html: 'after', x: 400 }) as FloatingObject
  const applied = currentPlacement(candidate, moved)
  assert.deepEqual(applied.layout.placement, { type: 'float', x: 50, y: 80, anchorId: 'd' })
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
  const original = patchObject(object, { placement: 'flow', centered: true }) as FloatingObject
  const source = { ...doc, content: { type: 'doc', content: [paragraph('a'), flow, paragraph('b')] }, objects: [original] }
  const candidate = object
  const applied = currentPlacement(candidate, original)
  assert.deepEqual(applied.layout.placement, { type: 'flow', x: 'center' })
  assert.equal('anchorId' in applied.layout.placement, false)
  assert.equal('y' in applied.layout.placement, false)
  assert.deepEqual(currentPlacement(original, object).layout.placement, object.layout.placement)
  assert.equal(permits([objectTask], source, { ...source, objects: [patchObject(original, { centered: false, x: 24 })] }), true)
  assert.equal(permitsEditor([objectTask], 'main', source.content, { type: 'doc', content: [paragraph('a'), paragraph('b')] }), false)
  assert.equal(permitsEditor([objectTask], 'main', source.content, { type: 'doc', content: [flow, paragraph('a'), paragraph('b')] }), true)
})

const segmentTarget = (range: { start: { index: number; offset: number }; end: { index: number; offset: number } }, blockIds: string[], objectIds: string[] = [], bookmarks = {
  start: { blockId: blockIds[0] ?? 'b', offset: 0 }, end: { blockId: blockIds.at(-1) ?? 'a', offset: 0, after: true },
}) => ({ kind: 'segment', range, blockIds, objectIds, area: { x: 0, y: 0, width: 100, height: 100 }, bookmarks })
const segmentTask = (target: ReturnType<typeof segmentTarget>, blocks: ReturnType<typeof paragraph>[], objects: FloatingObject[] = []) => ({
  ...taskVersion, id: 'segment-task', documentId: 'document', target, original: { version: 1, type: 'segment', content: structuredClone(blocks), objects: structuredClone(objects), geometry: {}, anchorTops: {}, originTop: 0 },
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
  const base = { ...doc, objects: [], content: { ...doc.content, content: [paragraph('a'), paragraph('b'), paragraph('c')] } }
  const target = segmentTarget({ start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, ['a', 'b'], [], {
    start: { blockId: 'a', offset: 0 }, end: { blockId: 'b', offset: 0, after: true },
  })
  const task = segmentTask(target, [paragraph('a'), paragraph('b')])
  assert.equal(permits([task], base, { ...base, content: { ...base.content, content: [paragraph('a'), paragraph('b'), paragraph('outside'), paragraph('c')] } }), true)
  assert.equal(permits([task], base, { ...base, content: { ...base.content, content: [paragraph('a'), paragraph('new'), paragraph('b'), paragraph('c')] } }), false)

  const editorContent = { ...base.content, content: base.content.content.map(block => ({ ...block, attrs: { ...block.attrs, listLevel: 0 } })) }
  const outsideEdit = structuredClone(editorContent)
  outsideEdit.content[2].content[0].text = 'An unrelated editor change'
  assert.equal(permitsEditor([task], 'main', editorContent, outsideEdit), true)
  outsideEdit.content[0].content[0].text = 'Reserved content'
  assert.equal(permitsEditor([task], 'main', editorContent, outsideEdit), false)

  const composition = { ...base, objects: [patchObject(object, { anchorId: 'a' }), { ...patchObject(object, { anchorId: 'a', x: 20 }), id: 'other' }] }
  const compositionTarget = { ...target, objectIds: ['box', 'other'] }
  const compositionTask = segmentTask(compositionTarget, [paragraph('a'), paragraph('b')], composition.objects)
  assert.equal(permits([compositionTask], composition, { ...composition, objects: composition.objects.map(note => note.id === 'other' ? patchObject(note, { x: 21 }) : note) }), false)

  const single = { ...base, objects: [patchObject(object, { anchorId: 'a' })] }
  const singleTarget = { ...target, objectIds: ['box'] }
  const singleTask = segmentTask(singleTarget, [paragraph('a'), paragraph('b')], single.objects)
  assert.equal(permits([singleTask], single, { ...single, objects: [patchObject(single.objects[0], { anchorId: 'c' })] }), false)
})

test('segment ownership and reservation include the object caption automatically', () => {
  const objects = [patchObject(object, { anchorId: 'a' })]
  const target = segmentTarget({ start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, ['a', 'b'], ['box'])
  const task = segmentTask(target, [paragraph('a'), paragraph('b')], objects)
  const source = { ...doc, objects }
  assert.equal(segmentReservationIntact(task, source), true)
  const changed = structuredClone(objects[0])
  changed.caption!.content.content![0].content![0].text = 'Changed'
  assert.equal(segmentReservationIntact(task, { ...source, objects: [changed] }), false)
  const resizedCaption = { ...source, objects: [{ ...objects[0], caption: { ...objects[0].caption!, width: 400 } }] }
  assert.equal(segmentReservationIntact(task, resizedCaption), false)
  assert.equal(permits([task], source, resizedCaption), false)
  assert.equal(permitsEditor([task], 'box:caption:caption-text', captionContent.content, changed.caption?.content), false)
})

test('a Flow segment reserves its block, object, anchored Floats, and captions together', () => {
  const flow = { type: 'flow', attrs: { id: 'flow-block', objectId: 'box' } }
  const primary = patchObject(object, { placement: 'flow', centered: true }) as FloatingObject
  const objects = [primary, { ...patchObject(object, { anchorId: 'flow-block', x: 10, y: 20 }), id: 'detail' }]
  const source = { ...doc, content: { type: 'doc', content: [paragraph('a'), flow, paragraph('d')] }, objects }
  const target = segmentTarget({ start: { index: 1, offset: 0 }, end: { index: 2, offset: 0 } }, ['flow-block'], ['box', 'detail'])
  const task = segmentTask(target, [flow], objects)
  assert.equal(segmentReservationIntact(task, source), true)
  assert.equal(overlaps(target, objectTask.target, source), true)
  const changedOwner = structuredClone(objects[0])
  if ('caption' in changedOwner && changedOwner.caption) changedOwner.caption.content.content![0].content![0].text = 'Changed'
  assert.equal(permits([task], source, { ...source, objects: [changedOwner, objects[1]] }), false)
  assert.equal(permits([task], source, { ...source, objects: objects.map(item => item.id === 'box' ? patchObject(item, { centered: false }) : item) }), false)
  assert.equal(permits([task], source, { ...source, objects: objects.map(item => item.id === 'detail' ? patchObject(item, { anchorId: 'd' }) : item) }), false)
  assert.equal(permitsEditor([task], 'main', source.content, { ...source.content, content: [paragraph('a'), paragraph('d')] }), false)
})
