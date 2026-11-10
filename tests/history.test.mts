import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import type { Reservation } from '../src/ai/types.ts'
import type { useDocumentHistory as HistoryHook } from '../src/document/history.tsx'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
after(() => server.close())
const { useDocumentHistory } = await server.ssrLoadModule('/src/document/history.tsx')
const { createBlankDocument } = await server.ssrLoadModule('/src/document/model.ts')
const initial = createBlankDocument()
const reserved: Reservation[] = [{ id: 'task', documentId: initial.id, original: [], workspaceRead: false,
  target: { kind: 'text', blockIds: [], selection: { from: 1, to: 1 }, insert: false, area: { x: 0, y: 0, width: 100, height: 40 } } }]
const released = reserved.map(task => ({ ...task, released: true }))
const changed = { ...initial, authoring: { notes: ['Accepted with prior notes'] } }
type History = ReturnType<typeof HistoryHook>

// Render-phase state updates exercise the real hook without a DOM dependency.
function run(reservations: Reservation[], steps: ((history: History) => void)[]) {
  function Harness() {
    const history = useDocumentHistory(initial, reservations), [step, next] = useState(0)
    if (step < steps.length) { steps[step](history); next(step + 1) }
    return null
  }
  renderToStaticMarkup(createElement(Harness))
}

test('acceptance is one atomic history entry, restores selections, and bypasses only the content guard', () => {
  let selection = { type: 'text', anchor: 1, head: 2 }
  run(reserved, [
    h => {
      h.register('body', { selection: () => selection, composing: () => false })
      h.guard.current = () => false
      h.setState(changed, released)
      assert.equal(h.currentReservations(), released)
    },
    h => {
      assert.equal(h.doc, changed)
      assert.equal(h.reservations, released)
      assert.equal(h.canUndo, true)
      selection = { type: 'text', anchor: 3, head: 4 }
      h.undo()
    },
    h => {
      assert.equal(h.doc, initial)
      assert.equal(h.reservations, reserved)
      assert.deepEqual(h.restoredSelection('body'), { type: 'text', anchor: 1, head: 2 })
      assert.equal(h.canUndo, false)
      h.redo()
    },
    h => {
      assert.equal(h.doc, changed)
      assert.equal(h.reservations, released)
      assert.deepEqual(h.restoredSelection('body'), selection)
      assert.equal(h.canRedo, false)
    },
  ])
})

test('reservation edits undo independently and ordinary grouped edits preserve their array reference', () => {
  const empty: Reservation[] = []
  const second = { ...changed, authoring: { notes: ['Second grouped edit'] } }
  run(empty, [
    h => h.setReservations(reserved),
    h => {
      assert.equal(h.doc, initial)
      assert.equal(h.reservations, reserved)
      h.begin('notes')
      h.setDoc(changed)
      h.setDoc(second)
    },
    h => {
      assert.equal(h.doc, second)
      assert.equal(h.reservations, reserved)
      h.guard.current = () => false
      h.undo()
    },
    h => {
      assert.equal(h.doc, second, 'content-only travel still uses the ordinary guard')
      h.guard.current = () => true
      h.undo()
    },
    h => {
      assert.equal(h.doc, initial)
      assert.equal(h.reservations, reserved)
      h.undo()
    },
    h => {
      assert.equal(h.reservations, empty)
      assert.equal(h.canUndo, false)
      h.redo()
    },
    h => assert.equal(h.reservations, reserved),
  ])
})

test('combined-state guard protects other reservations on explicit edits and undo/redo', () => {
  run(reserved, [
    h => {
      h.guardState.current = () => false
      h.setState(changed, released)
    },
    h => {
      assert.equal(h.doc, initial)
      assert.equal(h.reservations, reserved)
      assert.equal(h.canUndo, false)
      h.guardState.current = () => true
      h.setState(changed, released)
    },
    h => { h.guardState.current = () => false; h.undo() },
    h => {
      assert.equal(h.doc, changed)
      assert.equal(h.reservations, released)
      h.guardState.current = () => true
      h.undo()
    },
    h => { h.guardState.current = () => false; h.redo() },
    h => {
      assert.equal(h.doc, initial)
      assert.equal(h.reservations, reserved)
      assert.equal(h.canRedo, true)
    },
  ])
})
