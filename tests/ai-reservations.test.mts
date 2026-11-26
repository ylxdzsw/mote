import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { Schema } from '@tiptap/pm/model'
import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MoteDocument, FloatingDrawing, FloatingHTMLWidget, FloatingObject } from '../src/document/model.ts'
import type { AITask } from '../src/ai/types.ts'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { compatibleTasks, currentPlacement, inactiveTaskReason, overlaps, permits, permitsEditor, paragraphSelection, segmentReservationIntact } = await server.ssrLoadModule('/src/ai/reservations.ts')
const { makeSegmentTarget, mapReservations, resolveSegmentRange, applySegmentCandidate, expandSegmentCandidate } = await server.ssrLoadModule('/src/ai/segments.ts')
const { copySegment, replaceSegment, moveSegment, recordSpaceEdit } = await server.ssrLoadModule('/src/document/segment.ts')
const { useDocumentHistory } = await server.ssrLoadModule('/src/document/history.tsx')
const { projectSegments } = await server.ssrLoadModule('/src/ai/segmentProjection.ts')
const { validateReservations } = await import('../server/reservation-validation.mjs')
const { candidateVersions, selectedCandidateVersion, reconcileCandidateState } = await server.ssrLoadModule('/src/ai/candidates.ts')
const { candidateDocument } = await server.ssrLoadModule('/src/ai/useAssistant.ts')
const { patchFloating } = await server.ssrLoadModule('/src/canvas/patchFloating.ts')
const { createBlankDocument, patchObject } = await server.ssrLoadModule('/src/document/model.ts')

const paragraph = (id: string, text = id) => ({ type: 'paragraph', attrs: { id, semantic: 'body' }, content: [{ type: 'text', text }] })
const captionContent = { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'caption-text' }, content: [{ type: 'text', text: 'Caption' }] }] }, width: 240 }
const object: FloatingHTMLWidget = { id: 'box', kind: 'html', layout: { width: 320, height: 180, placement: { type: 'float', anchorId: 'a', x: 12, y: 20 } }, html: 'before', screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII=', alt: 'Figure', caption: captionContent }
const doc = { ...createBlankDocument(), id: 'document', content: { type: 'doc', content: ['a', 'b', 'c', 'd'].map(id => paragraph(id)) }, objects: [object] } as MoteDocument
const taskVersion = { protocol: 'mote-agent-v7', documentVersion: doc.version, snapshotDocument: doc }
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

test('on-page Drawing resize scales the entire sketch', () => {
  const resized = patchFloating(drawing, { width: drawing.layout.width / 2 }) as FloatingDrawing
  assert.equal(resized.layout.height, drawing.layout.height / 2)
  assert.deepEqual(resized.strokes, [{ points: [[0.55, 1.1], [75.65, 87.2]], color: 'gray1', width: 1 }])
  assert.deepEqual(resized.labels, [{ x: 28.55, y: 31.6, text: 'A', color: 'gray1', size: 8 }])
  assert.deepEqual(patchFloating(resized, { width: drawing.layout.width }), drawing)
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

test('reservation locks are independent of agent execution and browser tab state', () => {
  const resized = { ...doc, objects: [patchObject(object, { width: 400, height: 220 })] }
  for (const status of ['draft', 'waiting', 'running', 'ready', 'stopped', 'error']) {
    for (const executor of ['builtin', 'external']) {
      const task = { ...objectTask, status, executor, submitted: false } as AITask
      assert.equal(permits([task], doc, resized), false)
      assert.equal(permits([task], doc, { ...doc, objects: [patchObject(object, { x: 80 })] }), true)
    }
  }
})

const version = (id: string) => ({ id, candidate: { object, summary: id } })

test('released executor reservations retain their result without locking document content', () => {
  const task = { ...objectTask, documentId: doc.id, original: object, released: true, versions: [version('V1')] } as AITask
  assert.deepEqual(compatibleTasks([task], doc), [])
  assert.equal(task.versions?.[0].candidate.summary, 'V1')
})

test('unsupported task protocols retain raw recovery data without reservations or previews', () => {
  for (const protocol of [undefined, 'mote-agent-v0', 'mote-agent-v1', 'mote-agent-v2', 'mote-agent-v3', 'mote-agent-v4', 'mote-agent-v5']) {
    const task = { ...objectTask, protocol, documentId: doc.id, original: object,
      candidate: { object, summary: 'Retained result' }, candidates: [{ id: 'C1', revision: 1 }],
      versions: [version('V1')], selectedVersion: 'V1', preview: true }
    const before = structuredClone(task)
    assert.match(inactiveTaskReason(task, doc), /Unsupported task/)
    assert.deepEqual(compatibleTasks([task], doc), [])
    assert.deepEqual(candidateVersions(task), [])
    assert.equal(selectedCandidateVersion(task), undefined)
    assert.throws(() => candidateDocument(doc, task, task.candidate), /Unsupported task/)
    assert.deepEqual(reconcileCandidateState(task, { protocol: 'mote-agent-v7', versions: [version('V2')] }), {})
    assert.deepEqual(reconcileCandidateState(objectTask, { protocol, versions: [version('V2')] }), {})
    assert.deepEqual(task, before)
  }
})

test('new versions preserve the exact review selection and never replace an unavailable selection', () => {
  const first = version('V1'), second = version('V2'), third = version('V3')
  const task = { ...objectTask, versions: [first, second], selectedVersion: first.id, preview: false } as AITask
  const patch = reconcileCandidateState(task, { protocol: 'mote-agent-v7', versions: [first, second, third], selectedVersion: third.id })
  const updated = { ...task, ...patch }
  assert.equal(selectedCandidateVersion(updated), first)
  assert.equal(updated.preview, false)
  const missing = { ...task, ...reconcileCandidateState(task, { protocol: 'mote-agent-v7', versions: [second, third] }) }
  assert.equal(missing.selectedVersion, first.id)
  assert.equal(selectedCandidateVersion(missing), undefined)
  assert.equal(missing.preview, false)
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

test('segment object IDs expand to the exact current object before ordinary candidate application', () => {
  const source = { ...doc, objects: [object] }
  const target = makeSegmentTarget(source, { start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, { x: 0, y: 0, width: 600, height: 100 })
  const blocks = structuredClone(source.content.content!.slice(0, 2))
  const segment = { version: 1, type: 'segment', content: blocks, objects: ['box'], geometry: {}, anchorTops: { a: 0, b: 0 }, originTop: 0 }
  const fullSegment = { ...segment, objects: [structuredClone(object)] }
  const beforeDoc = structuredClone(source), beforeSegment = structuredClone(segment)
  assert.deepEqual(expandSegmentCandidate(source, target, segment), fullSegment)
  const task = segmentTask(target, blocks, [object])
  const context = { anchors: [], geometry: {} }
  const shorthandResult = candidateDocument(source, task, { summary: 'Reuse', segment }, context)
  const fullResult = candidateDocument(source, task, { summary: 'Reuse', segment: fullSegment }, context)
  assert.equal(shorthandResult.objects[0].id === 'box', false)
  assert.equal(shorthandResult.objects[0].kind, fullResult.objects[0].kind)
  assert.equal(shorthandResult.objects[0].html, fullResult.objects[0].html)
  assert.equal(shorthandResult.objects[0].caption?.content.content![0].content![0].text, fullResult.objects[0].caption?.content.content![0].content![0].text)
  assert.equal(shorthandResult.objects[0].layout.placement.anchorId, shorthandResult.content.content![0].attrs!.id)
  assert.equal(fullResult.objects[0].layout.placement.anchorId, fullResult.content.content![0].attrs!.id)
  assert.deepEqual(source, beforeDoc)
  assert.deepEqual(segment, beforeSegment)
})

test('segment object ID expansion rejects missing and out-of-scope objects', () => {
  const source = { ...doc, objects: [object] }
  const target = makeSegmentTarget(source, { start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, { x: 0, y: 0, width: 600, height: 100 })
  const payload = { version: 1, type: 'segment', content: [paragraph('a')], objects: ['missing'], geometry: {}, anchorTops: { a: 0 }, originTop: 0 }
  assert.throws(() => expandSegmentCandidate(source, { ...target, objectIds: ['missing'] }, payload), /missing from the current working document/)
  const outside = { ...object, id: 'outside', layout: { ...object.layout, placement: { type: 'float', anchorId: 'd', x: 12, y: 20 } } } as FloatingObject
  assert.throws(() => expandSegmentCandidate({ ...source, objects: [object, outside] }, target, { ...payload, objects: ['outside'] }), /outside this reserved segment/)
})

test('invalid expanded segment candidates fail validation instead of becoming deletions', () => {
  const source = { ...doc, objects: [object] }
  const target = makeSegmentTarget(source, { start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, { x: 0, y: 0, width: 600, height: 100 })
  const task = segmentTask(target, source.content.content!.slice(0, 2), [object])
  const candidate = { summary: 'Invalid', segment: { version: 1, type: 'segment', content: [{ type: 'unknown' }], objects: ['box'], geometry: {}, anchorTops: {}, originTop: 0 } }
  const before = structuredClone(source)
  assert.throws(() => candidateDocument(source, task, candidate, { anchors: [], geometry: {} }), /Invalid Mote segment/)
  assert.deepEqual(source, before)
  const duplicate = { ...candidate.segment, content: [paragraph('a')], objects: ['box', 'box'], anchorTops: { a: 0 } }
  assert.throws(() => expandSegmentCandidate(source, target, duplicate), /duplicate ID/)
})

test('empty reservations stay zero-width when preceding paragraphs are inserted or replaced', () => {
  const source = { ...doc, objects: [] }
  const range = { start: { index: 1, offset: 0 }, end: { index: 1, offset: 0 } }
  const legacy = segmentTarget(range, [], [], {
    start: { blockId: 'b', offset: 0 }, end: { blockId: 'a', offset: 0, after: true },
  })
  for (const target of [legacy, makeSegmentTarget(source, range, legacy.area)]) {
    const task = segmentTask(target, [])
    const inserted = { ...source, content: { ...source.content, content: [paragraph('a'), paragraph('new'), ...source.content.content!.slice(1)] } }
    assert.equal(permits([task], source, inserted), true)
    assert.equal(permitsEditor([task], 'main', source.content, inserted.content), true)
    assert.deepEqual(resolveSegmentRange(inserted, target), { start: { index: 2, offset: 0 }, end: { index: 2, offset: 0 } })
    assert.equal(permits([task], inserted, source), true)
    const preceding = makeSegmentTarget(source, { start: { index: 0, offset: 0 }, end: range.start }, legacy.area)
    assert.equal(overlaps(target, preceding, source), false)
    assert.equal(overlaps(preceding, target, source), false)
    assert.equal(overlaps(target, { ...textTask.target, blockIds: ['a'] }, source), false)
    const replacement = { version: 1, type: 'segment', content: [paragraph('replacement')], objects: [], geometry: {}, anchorTops: {}, originTop: 0 }
    const accepted = applySegmentCandidate(source, preceding, replacement, { anchors: [], geometry: {} })
    assert.equal(permits([task], source, accepted), true)
    assert.deepEqual(resolveSegmentRange(accepted, target), range)
    const withCandidate = applySegmentCandidate(inserted, target, replacement, { anchors: [], geometry: {} })
    assert.deepEqual(withCandidate.content.content.map((node: { content?: { text: string }[] }) => node.content?.[0]?.text), ['a', 'new', 'replacement', 'b', 'c', 'd'])
    assert.equal(permits([task], source, { ...source, content: { ...source.content, content: [paragraph('a')] } }), false)
    assert.equal(overlaps(target, { ...textTask.target, blockIds: ['b'] }, source), true)
  }
  const tailRange = { start: { index: 4, offset: 0 }, end: { index: 4, offset: 0 } }
  const tail = segmentTarget(tailRange, [], [], {
    start: { blockId: 'd', offset: 0, after: true }, end: { blockId: 'd', offset: 0, after: true },
  })
  for (const target of [tail, makeSegmentTarget(source, tailRange, tail.area)]) {
    const inserted = { ...source, content: { ...source.content, content: [...source.content.content!, paragraph('new')] } }
    assert.equal(permits([segmentTask(target, [])], source, inserted), true)
    assert.deepEqual(resolveSegmentRange(inserted, target), { start: { index: 5, offset: 0 }, end: { index: 5, offset: 0 } })
  }
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
  assert.equal(segmentReservationIntact(task, { ...source, objects: [changed] }), true)
  const resizedCaption = { ...source, objects: [{ ...objects[0], caption: { ...objects[0].caption!, width: 400 } }] }
  assert.equal(segmentReservationIntact(task, resizedCaption), true)
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


test('the same proposal applies after a content-only target refresh without replacing unrelated work', () => {
  const task = { ...objectTask, id: 'task', documentId: doc.id, original: object, versions: [version('V1')], selectedVersion: 'V1' } as AITask
  const refreshed = { ...doc, authoring: { notes: ['Keep local notes'] }, objects: [{ ...object, html: 'Cloud content changed', layout: { ...object.layout, width: 420 } }] }
  assert.equal(inactiveTaskReason(task, refreshed), null)
  const next = candidateDocument(refreshed, task)
  assert.equal(next.objects[0].html, object.html)
  assert.equal(next.objects[0].layout.width, 420)
  assert.deepEqual(next.authoring, refreshed.authoring)
  assert.equal(task.selectedVersion, 'V1')
  assert.equal(task.versions!.length, 1)
  assert.throws(() => candidateDocument({ ...refreshed, objects: [] }, task), /missing/)
  assert.throws(() => candidateDocument({ ...refreshed, objects: [drawing] }, task), /kind/)

  const text = { ...textTask, id: 'text-task', documentId: doc.id, original: doc.content.content!.slice(1, 3),
    versions: [{ id: 'V1', candidate: { summary: 'Rewrite', content: [paragraph('proposal', 'Proposal text')] } }] } as AITask
  const content = { ...doc.content, content: [paragraph('a', 'Keep this edit'), paragraph('b', 'Refreshed'), paragraph('c', 'Also refreshed'), paragraph('d')] }
  const textRefresh = { ...doc, content }
  assert.equal(inactiveTaskReason(text, textRefresh), null)
  const accepted = candidateDocument(textRefresh, text)
  assert.equal(accepted.content.content![0].content![0].text, 'Keep this edit')
  assert.equal(accepted.content.content![1].content![0].text, 'Proposal text')
  assert.throws(() => candidateDocument({ ...doc, content: { type: 'doc', content: [paragraph('a'), paragraph('b'), paragraph('new'), paragraph('c'), paragraph('d')] } }, text), /scope/)
})

test('refreshed segment content stays compatible while local locks compare before and after', () => {
  const source = { ...doc, objects: [object] }
  const target = makeSegmentTarget(source, { start: { index: 0, offset: 0 }, end: { index: 2, offset: 0 } }, { x: 0, y: 0, width: 600, height: 100 })
  const task = segmentTask(target, source.content.content!.slice(0, 2), source.objects)
  const refreshed = { ...source, content: { ...source.content, content: [paragraph('a', 'Refreshed'), ...source.content.content!.slice(1)] }, objects: [{ ...object, html: 'Refreshed object' }] }
  assert.equal(segmentReservationIntact(task, refreshed), true)
  task.versions = [{ id: 'V1', candidate: { summary: 'Replace this section', segment: {
    version: 1, type: 'segment', content: [paragraph('replacement', 'Same section proposal')], objects: [], geometry: {}, anchorTops: {}, originTop: 0,
  } } }]
  const accepted = candidateDocument(refreshed, task, undefined, { anchors: [], geometry: {} })
  assert.equal(accepted.content.content![0].content![0].text, 'Same section proposal')
  assert.equal(accepted.content.content!.at(-1)!.attrs!.id, 'd')
  assert.equal(task.versions.length, 1)
  const unrelated = { ...refreshed, content: { ...refreshed.content, content: [...refreshed.content.content!.slice(0, 3), paragraph('d', 'Outside edit')] } }
  assert.equal(permits([task], refreshed, unrelated), true)
  assert.equal(permitsEditor([task], 'main', refreshed.content, unrelated.content), true)
  assert.equal(permits([task], refreshed, source), false)
  assert.equal(permitsEditor([task], 'main', refreshed.content, source.content), false)
  for (const changed of [
    { ...refreshed, objects: [] },
    { ...refreshed, objects: [...refreshed.objects, { ...object, id: 'new-owner' }] },
    { ...refreshed, objects: [{ ...drawing }] },
    { ...refreshed, content: { ...refreshed.content, content: [paragraph('a'), paragraph('expanded'), ...refreshed.content.content!.slice(1)] } },
  ]) assert.equal(segmentReservationIntact(task, changed), false)
})

const intervalDoc = { ...doc, content: { type: 'doc', content: [paragraph('a'), { type: 'spacer', attrs: { id: 'space', height: 100 } }, paragraph('b')] },
  objects: [{ ...patchObject(object, { anchorId: 'space', y: 65 }), id: 'inside', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'inside-caption' }, content: [{ type: 'text', text: 'Inside caption' }] }] } } }, { ...patchObject(object, { anchorId: 'space', y: 95 }), id: 'outside' }] } as MoteDocument
function intervalTask(from: number, to: number, source = intervalDoc) {
  const target = makeSegmentTarget(source, { start: { index: 1, offset: from }, end: { index: 1, offset: to } }, { x: 0, y: from, width: 600, height: to - from })
  return { ...segmentTask(target, source.content.content!.filter(block => target.blockIds.includes(block.attrs?.id)), source.objects.filter(object => target.objectIds.includes(object.id))),
    id: crypto.randomUUID(), original: copySegment(source, target.range, [], {}) } as AITask
}
const intervalCandidate = (text: string) => ({ summary: text, segment: { version: 1, type: 'segment', content: [paragraph(`candidate-${text}`, text)], objects: [], geometry: {}, anchorTops: {}, originTop: 0 } })

test('independent slices in one spacer survive acceptance in either order without snapshot replacement', () => {
  for (const reverse of [false, true]) {
    const left = intervalTask(20, 40), right = intervalTask(60, 80)
    assert.equal(overlaps(left.target, right.target, intervalDoc), false)
    assert.equal(compatibleTasks([left, right], intervalDoc).length, 2)
    let source = intervalDoc, tasks = reverse ? [right, left] : [left, right]
    for (const label of reverse ? ['right', 'left'] : ['left', 'right']) {
      const task = tasks[0], next = candidateDocument(source, task, intervalCandidate(label), { anchors: [], geometry: {} })
      assert.equal(permits(tasks.slice(1), source, next), true)
      const mapped = mapReservations(source, next, tasks.slice(1))
      assert.ok(mapped)
      if (mapped.length) {
        assert.equal(mapped[0].id, tasks[1].id)
        assert.equal(mapped[0].original, tasks[1].original)
        assert.equal(segmentReservationIntact(mapped[0], next), true)
        const changed = { ...next, objects: next.objects.map(object => object.id === 'inside' ? { ...object, html: 'mutated' } : object) }
        if (label === 'left') assert.equal(permits(mapped, next, changed), false)
      }
      source = next; tasks = mapped
    }
    assert.deepEqual(source.content.content!.filter(block => block.type === 'paragraph').map(block => block.content?.[0]?.text), ['a', 'left', 'right', 'b'])
    assert.equal(source.content.content!.filter(block => block.type === 'spacer').reduce((sum, block) => sum + block.attrs!.height, 0), 60)
    assert.deepEqual(source.objects.map(object => object.id), ['outside'])
    assert.equal((source.objects[0] as FloatingHTMLWidget).html, object.html)
    assert.deepEqual((source.objects[0] as FloatingHTMLWidget).caption, object.caption)
  }
})

test('interval points own nothing, conflict only strictly inside slices, and survive either endpoint replacement', () => {
  const slice = intervalTask(20, 40)
  for (const at of [20, 30, 40, 65]) {
    const point = intervalTask(at, at)
    assert.deepEqual(point.target.kind === 'segment' && point.target.objectIds, [])
    assert.equal(overlaps(slice.target, point.target, intervalDoc), at === 30)
    assert.equal(overlaps(point.target, slice.target, intervalDoc), at === 30)
    const records = [slice, point].map(({ id, documentId, target, original, segmentOriginalBlocks, segmentOriginalObjects }) =>
      ({ id, documentId, target, original, segmentOriginalBlocks, segmentOriginalObjects }))
    if (at === 30) assert.throws(() => validateReservations(records, intervalDoc), /overlap/)
    else {
      assert.doesNotThrow(() => validateReservations(records, intervalDoc))
      const next = candidateDocument(intervalDoc, slice, intervalCandidate('slice'), { anchors: [], geometry: {} })
      assert.equal(permits([point], intervalDoc, next), true)
      const [mapped] = mapReservations(intervalDoc, next, [point])
      const range = resolveSegmentRange(next, mapped.target)
      assert.deepEqual(range.start, range.end)
    }
  }
  const legacy = { ...slice.target }; delete legacy.version
  assert.equal(overlaps(legacy, intervalTask(60, 80).target, intervalDoc), true)
  const endpoint = intervalTask(100, 100)
  const equivalent = { ...endpoint, id: crypto.randomUUID(), target: { ...endpoint.target,
    bookmarks: undefined, range: { start: { index: 1, offset: 100 }, end: { index: 2, offset: 0 } } } }
  assert.throws(() => validateReservations([endpoint, equivalent].map(({ id, documentId, target, original }) =>
    ({ id, documentId, target, original })), intervalDoc), /overlap/)
})

test('explicit outside splices and merges map slices and owned objects while rejecting edits through them', () => {
  const task = intervalTask(60, 80)
  const at = (offset: number) => ({ index: 1, offset })
  for (const offset of [20, 60, 80, 90]) {
    const next = replaceSegment(intervalDoc, { start: at(offset), end: at(offset) }, intervalCandidate('insert').segment, [], {})
    assert.equal(permits([task], intervalDoc, next), true)
    assert.ok(mapReservations(intervalDoc, next, [task]))
  }
  const middle = replaceSegment(intervalDoc, { start: at(70), end: at(70) }, intervalCandidate('insert').segment, [], {})
  assert.equal(permits([task], intervalDoc, middle), false)
  assert.equal(mapReservations(intervalDoc, middle, [task]), null)
  const split = replaceSegment(intervalDoc, { start: at(20), end: at(20) }, intervalCandidate('split').segment, [], {})
  const [mapped] = mapReservations(intervalDoc, split, [task])
  const merged = replaceSegment(split, { start: { index: 2, offset: 0 }, end: { index: 3, offset: 0 } }, null, [], {})
  assert.equal(permits([mapped], split, merged), true)
  const [restored] = mapReservations(split, merged, [mapped])
  assert.deepEqual(resolveSegmentRange(merged, restored.target), resolveSegmentRange(intervalDoc, task.target))
  const moved = moveSegment(intervalDoc, { start: at(10), end: at(30) }, { index: 3, offset: 0 }, [], {}).doc
  assert.equal(permits([task], intervalDoc, moved), true)
  const grown = { ...intervalDoc, content: { ...intervalDoc.content, content: intervalDoc.content.content!.map(block => block.type === 'spacer' ? { ...block, attrs: { ...block.attrs, height: 120 } } : block) },
    objects: intervalDoc.objects.map(object => patchObject(object, { y: object.layout.placement.type === 'float' ? object.layout.placement.y + 20 : 0 })) }
  const shift = { anchors: [{ id: 'space', top: 100 }], from: 120, delta: 20 }
  recordSpaceEdit(intervalDoc, grown, [], shift)
  assert.equal(permits([task], intervalDoc, grown), true)
  assert.equal(permitsEditor([task], 'main', intervalDoc.content, grown.content, [], shift), true)
  assert.equal(permitsEditor([task], 'main', intervalDoc.content, grown.content, [], { ...shift, from: 170 }), false)
  const shrunk = { ...intervalDoc.content, content: intervalDoc.content.content!.map(block => block.type === 'spacer' ? { ...block, attrs: { ...block.attrs, height: 80 } } : block) }
  assert.equal(permitsEditor([intervalTask(0, 5)], 'main', intervalDoc.content, shrunk, [], { ...shift, from: 105, delta: -20 }), true)
  assert.equal(permitsEditor([intervalTask(0, 10), intervalTask(25, 35)], 'main', intervalDoc.content, shrunk, [], { ...shift, from: 120, delta: -20 }), false)
})

test('acceptance maps surviving interval identities atomically with undo and redo', () => {
  const left = intervalTask(20, 40), right = intervalTask(60, 80), initial = [left, right]
  const accepted = candidateDocument(intervalDoc, left, intervalCandidate('left'), { anchors: [], geometry: {} })
  let acceptedReservations: AITask[]
  function Harness() {
    const history = useDocumentHistory(intervalDoc, initial), [step, advance] = useState(0)
    history.guardState.current = (before: MoteDocument, previous: AITask[], after: MoteDocument, next: AITask[]) =>
      permits(previous.filter(task => next.some(item => item.id === task.id)), before, after, next)
    if (step === 0) history.setState(accepted, [right])
    if (step === 1) {
      assert.equal(history.doc, accepted)
      acceptedReservations = history.reservations
      assert.equal(acceptedReservations.length, 1)
      assert.equal(acceptedReservations[0].id, right.id)
      assert.equal(acceptedReservations[0].original, right.original)
      assert.notDeepEqual(acceptedReservations[0].target, right.target)
      history.undo()
    }
    if (step === 2) {
      assert.equal(history.doc, intervalDoc)
      assert.equal(history.reservations, initial)
      history.redo()
    }
    if (step === 3) {
      assert.equal(history.doc, accepted)
      assert.equal(history.reservations, acceptedReservations)
    }
    if (step < 3) advance(step + 1)
    return null
  }
  renderToStaticMarkup(createElement(Harness))
})

test('same-spacer previews compose and leave retained space fragments unowned', () => {
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', attrs: { id: { default: null }, semantic: { default: 'body' } } },
    spacer: { group: 'block', attrs: { id: {}, height: {} } }, text: {} } })
  const tasks = [intervalTask(20, 40), intervalTask(60, 80)].map((task, i) => ({ ...task, preview: true,
    versions: [{ id: `V${i}`, candidate: intervalCandidate(i ? 'right' : 'left') }] }))
  const result = projectSegments(intervalDoc, tasks, { schema }, { anchors: [], geometry: {} })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.document.content.content.filter((block: { type: string }) => block.type === 'paragraph').map((block: { content: { text: string }[] }) => block.content[0].text), ['a', 'left', 'right', 'b'])
  for (const preview of result.previews) {
    for (const block of preview.content) {
      if (block.type === 'spacer') assert.equal(preview.blockOwners[block.attrs.id] || '', '')
      if (block.content?.[0]?.text === 'left') assert.equal(preview.blockOwners[block.attrs.id], tasks[0].id)
      if (block.content?.[0]?.text === 'right') assert.equal(preview.blockOwners[block.attrs.id], tasks[1].id)
    }
  }
})
