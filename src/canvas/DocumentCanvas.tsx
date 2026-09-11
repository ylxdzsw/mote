import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Editor, JSONContent } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { labelContent, type FloatingObject, type FloatingPatch, type LabelAttachment, type LineEnd, type MoteDocument } from '../document/model'
import { useHistory } from '../document/history'
import { TextEditor } from '../editor/TextEditor'
import { themeVariables } from '../theme/ThemePanel'
import { useDocumentZoom } from './useDocumentZoom'
import { Minimap } from './Minimap'
import { SegmentBoundaries } from './SegmentBoundaries'
import { useFloatingLayout, type FloatingPreviews } from './useFloatingLayout'
import { FloatingObjectView, type DragPart } from './FloatingObjectView'
import { anchorPoint, boundary, boundedTranslation, boxLabelPositions, center, contains, distance, gridSize, labelPlacement, lineLabelPositions, objectIntersects, type Box, type Geometries, type Point } from './floatingGeometry'
import type { ViewSettings } from '../app/GlobalSettings'
import './floating.css'

export type CreationTool = 'rectangle' | 'ellipse' | 'line' | 'label' | null
export interface CanvasActions { remove: () => void; duplicate: () => void; label: () => void; detach: () => void }
const zoomPresets = [.25, .5, .75, 1, 1.25, 1.5, 2, 3]
interface Props {
  doc: MoteDocument; editable: boolean; minimap: boolean; minimapSize: ViewSettings['minimapSize']; zoomHost: HTMLDivElement | null
  selectedIds: string[]; onSelect: (ids: string[]) => void
  tool: CreationTool; onToolChange: (tool: CreationTool) => void
  onMainChange: (content: JSONContent) => void; onNoteChange: (id: string, patch: FloatingPatch) => void
  onFloatingChange: (objects: FloatingObject[]) => void; onActions: (actions: CanvasActions) => void
  onActive: (editor: Editor | null) => void; onMainReady: (editor: Editor) => void
}
interface Drag {
  part: DragPart | 'create' | 'marquee'; id: string; start: Point; ids: string[]; objects: FloatingObject[]; geometry: Geometries
  patches: FloatingPreviews; moved: boolean; additive: string[]; created?: FloatingObject
}
interface Guide { point: Point; active?: boolean; box?: Box }
const rectangle = (a: Point, b: Point): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })

export function DocumentCanvas({ doc, editable, minimap, minimapSize, zoomHost, selectedIds, onSelect, tool, onToolChange, onMainChange, onNoteChange, onFloatingChange, onActions, onActive, onMainReady }: Props) {
  const history = useHistory()
  const canvasId = useId()
  const stage = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null)
  const [mainEditor, setMainEditor] = useState<Editor | null>(null)
  const { scale, minScale, zoomTo, zoomBy, reset } = useDocumentZoom(stage, sheet, doc.width, editable)
  const [previews, setPreviews] = useState<FloatingPreviews>({})
  const [creating, setCreating] = useState<FloatingObject | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const drag = useRef<Drag | null>(null)
  const captured = useRef<{ element: Element; pointerId: number } | null>(null)
  const layoutDoc = useMemo(() => creating ? { ...doc, floating: [...doc.floating, creating] } : doc, [doc, creating])
  const { geometry, anchors, minHeight, reflow, attach } = useFloatingLayout(layoutDoc, mainEditor, sheet, scale, previews)
  const active = !!creating || !!marquee || Object.keys(previews).length > 0

  function select(ids: string[]) {
    onSelect(ids)
    if (!ids.includes(editingLabel ?? '')) setEditingLabel(null)
  }
  function focusObject(id: string) {
    requestAnimationFrame(() => sheet.current?.querySelector<HTMLElement>(`[data-note-id="${id}"]`)?.focus({ preventScroll: true }))
  }
  function cancel() {
    drag.current = null; setPreviews({}); setCreating(null); setMarquee(null); setGuides([])
    const pointer = captured.current
    captured.current = null
    if (pointer?.element.hasPointerCapture(pointer.pointerId)) pointer.element.releasePointerCapture(pointer.pointerId)
  }
  useLayoutEffect(() => { cancel(); setEditingLabel(null); onToolChange(null) }, [editable, scale, history.revision])
  useLayoutEffect(() => {
    const ids = selectedIds.filter(id => doc.floating.some(note => note.id === id))
    if (ids.length !== selectedIds.length) select(ids)
  }, [doc.floating])
  useLayoutEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (drag.current) { event.preventDefault(); cancel() }
      onToolChange(null)
      if (editingLabel) { const id = editingLabel; setEditingLabel(null); focusObject(id) }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  })

  function point(event: { clientX: number; clientY: number }): Point {
    const rect = sheet.current!.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / scale - sheet.current!.clientLeft, y: (event.clientY - rect.top) / scale - sheet.current!.clientTop }
  }
  function spaceAt(p: Point) {
    const rect = sheet.current!.getBoundingClientRect()
    return [...sheet.current!.querySelectorAll<HTMLElement>('.main-text [data-spacer]')].map(element => ({ element,
      x: 0, y: (element.getBoundingClientRect().top - rect.top) / scale - sheet.current!.clientTop, width: doc.width, height: element.getBoundingClientRect().height / scale,
    })).find(space => contains(space, p))
  }
  function snap(p: Point, alt: boolean): Point {
    const space = !alt && spaceAt(p)
    return space ? { x: Math.round(p.x / gridSize) * gridSize, y: space.y + Math.round((p.y - space.y) / gridSize) * gridSize } : p
  }
  function pageWidth() {
    const style = getComputedStyle(sheet.current!)
    return doc.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
  }
  function boundedPoint(p: Point, width = 0, inset = 0): Point {
    return { x: Math.max(inset, Math.min(pageWidth() - width - inset, p.x)), y: Math.max(0, p.y) }
  }
  function boundedWidth(x: number, width: number, minimum: number, inset = 0) {
    return Math.max(0, Math.min(pageWidth() - x - inset, Math.max(minimum, width)))
  }
  function snapEndpoint(p: Point, alt: boolean, excluded: string[] = []): LineEnd {
    if (!alt) {
      const tolerance = 14 / scale
      const target = [...doc.floating].reverse().find(object => {
        if (excluded.includes(object.id) || object.kind === 'line' || object.kind === 'label') return false
        const box = geometry[object.id]
        return box && contains({ x: box.x - tolerance, y: box.y - tolerance, width: box.width + tolerance * 2, height: box.height + tolerance * 2 }, p)
      })
      if (target) {
        const box = geometry[target.id]
        const ports = (['top', 'bottom', 'left', 'right'] as const).map(side => ({ side, point: boundary(box, side, p) }))
        const pinned = ports.find(port => distance(port.point, p) < tolerance)
        const activePoint = pinned?.point ?? boundary(box, 'auto', p, target.kind === 'ellipse')
        setGuides([...ports.map(port => ({ point: port.point, active: port === pinned })), ...(!pinned ? [{ point: activePoint, active: true }] : [])])
        return { ...anchorPoint(activePoint, anchors), connection: { targetId: target.id, side: pinned?.side ?? 'auto' } }
      }
    }
    setGuides([])
    return anchorPoint(boundedPoint(snap(p, alt), 0, 16), anchors)
  }
  function snapLabel(p: Point, size: Box, id: string, alt: boolean): { point: Point; attachment: LabelAttachment | null } {
    if (!alt) {
      const candidates = doc.floating.filter(object => object.id !== id && object.kind !== 'label').flatMap(object => {
        const target = geometry[object.id]
        return target ? (object.kind === 'line' ? lineLabelPositions : boxLabelPositions).map(position => {
          const placed = labelPlacement(target, size, position)
          return { point: placed, attachment: { targetId: object.id, position }, distance: distance(p, placed) }
        }).filter(candidate => candidate.point.x >= 0 && candidate.point.x + size.width <= pageWidth()) : []
      }).sort((a, b) => a.distance - b.distance)
      const nearest = candidates[0]
      if (nearest && nearest.distance < 60 / scale) {
        setGuides(candidates.filter(candidate => candidate.attachment.targetId === nearest.attachment.targetId).map(candidate => ({
          point: center({ ...candidate.point, width: size.width, height: size.height }), active: candidate === nearest && nearest.distance < 16 / scale,
          box: candidate === nearest && nearest.distance < 16 / scale ? { ...candidate.point, width: size.width, height: size.height } : undefined,
        })))
        if (nearest.distance < 16 / scale) return nearest
        return { point: boundedPoint(snap(p, alt), size.width), attachment: null }
      }
    }
    setGuides([])
    return { point: boundedPoint(snap(p, alt), size.width), attachment: null }
  }
  function capture(event: PointerEvent) {
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    captured.current = { element: event.currentTarget, pointerId: event.pointerId }
  }
  function begin(id: string, part: DragPart, event: PointerEvent) {
    if (event.button !== 0) return
    capture(event)
    if (event.shiftKey && part === 'move') { const ids = selectedIds.includes(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id]; select(ids); onActive(null); if (ids.length) focusObject(ids.at(-1)!); return }
    const ids = selectedIds.includes(id) && part === 'move' ? selectedIds : [id]
    select(ids); setEditingLabel(null); onActive(null)
    focusObject(id)
    history.boundary()
    drag.current = { part, id, ids, start: point(event), objects: doc.floating, geometry, patches: {}, moved: false, additive: [] }
  }
  function blankDown(event: PointerEvent) {
    if (!editable || event.button !== 0) return
    const target = event.target as Element
    if (tool) {
      if (target.closest('.object-handle, .segment-boundary, .floating-border-right, .table-column-divider')) return
      capture(event); select([]); onActive(null); setEditingLabel(null); history.boundary()
      const start = boundedPoint(snap(point(event), event.altKey), 16, .5)
      const base = { id: crypto.randomUUID(), ...anchorPoint(start, anchors), width: boundedWidth(start.x, 128, 16, .5), textFlow: 'overlap' as const }
      const note: FloatingObject = tool === 'label' ? { ...base, kind: 'label', content: labelContent(), attachment: null }
        : tool === 'line' ? { ...base, kind: 'line', stroke: null, strokeWidth: 1, dashed: false, start: snapEndpoint(start, event.altKey), end: anchorPoint(start, anchors), route: 'straight', bend: 0, arrowStart: false, arrowEnd: true }
        : { ...base, kind: tool, height: 80, fill: null, rounded: false, stroke: null, strokeWidth: 1, dashed: false }
      drag.current = { part: 'create', id: note.id, ids: [note.id], start, objects: doc.floating, geometry, patches: {}, moved: false, additive: [], created: note }
      setCreating(note)
      return
    }
    const floating = target.closest<HTMLElement>('.floating-note')
    if (floating && event.shiftKey) {
      capture(event)
      const id = floating.dataset.noteId!
      const ids = selectedIds.includes(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id]
      select(ids); onActive(null); if (ids.length) focusObject(ids.at(-1)!)
      return
    }
    if (floating || target.closest('.segment-boundary')) return
    const start = point(event), space = spaceAt(start)
    if (space) {
      capture(event); setEditingLabel(null)
      drag.current = { part: 'marquee', id: '', ids: [], start, objects: doc.floating, geometry, patches: {}, moved: false, additive: event.shiftKey ? selectedIds : [] }
      if (mainEditor && !drag.current.additive.length) {
        select([])
        mainEditor.view.dispatch(mainEditor.state.tr.setSelection(NodeSelection.create(mainEditor.state.doc, mainEditor.view.posAtDOM(space.element, 0))))
        mainEditor.view.focus(); onActive(mainEditor)
      } else onActive(null)
    } else select([])
  }
  function shifted(objects: FloatingObject[], boxes: Geometries, ids: string[], dx: number, dy: number): FloatingPreviews {
    const delta = boundedTranslation(objects, boxes, ids, { x: dx, y: dy }, pageWidth())
    dx = delta.x; dy = delta.y
    const patches: FloatingPreviews = {}
    for (const object of objects) {
      if (!ids.includes(object.id)) continue
      const box = boxes[object.id]
      if (object.kind === 'label' && object.attachment && ids.includes(object.attachment.targetId)) continue
      if (object.kind === 'line') {
        const endpoint = (end: LineEnd, p: Point) => end.connection && ids.includes(end.connection.targetId) ? end : anchorPoint({ x: p.x + dx, y: p.y + dy }, anchors)
        patches[object.id] = { start: endpoint(object.start, box.path![0]), end: endpoint(object.end, box.path!.at(-1)!) }
      } else patches[object.id] = { x: box.x + dx, top: box.y + dy, ...(object.kind === 'label' ? { attachment: null } : {}) }
    }
    return patches
  }
  function move(event: PointerEvent) {
    const d = drag.current
    if (!d) return
    const p = point(event)
    if (!d.moved && distance(p, d.start) * scale < 3) return
    if (!d.moved && d.part === 'marquee') onActive(null)
    d.moved = true
    if (d.part === 'marquee') {
      const box = rectangle(d.start, p)
      setMarquee(box)
      select([...new Set([...d.additive, ...d.objects.filter(object => d.geometry[object.id] && objectIntersects(object, d.geometry[object.id], box)).map(object => object.id)])])
      return
    }
    const object = d.created ?? d.objects.find(object => object.id === d.id)!
    const box = d.geometry[d.id]
    let patch: FloatingPatch & { top?: number } = {}
    if (d.part === 'create') {
      if (object.kind === 'line') patch = { end: snapEndpoint(p, event.altKey) }
      else if (object.kind === 'label') {
        const placement = snapLabel(p, geometry[object.id] ?? { ...p, width: 12, height: 24 }, object.id, event.altKey)
        patch = { x: placement.point.x, top: placement.point.y, attachment: placement.attachment }
      } else {
        let end = boundedPoint(snap(p, event.altKey), 0, .5)
        if (event.shiftKey) { const size = Math.min(Math.max(Math.abs(end.x - d.start.x), Math.abs(end.y - d.start.y)), end.x >= d.start.x ? pageWidth() - .5 - d.start.x : d.start.x - .5); end = { x: d.start.x + Math.sign(end.x - d.start.x || 1) * size, y: d.start.y + Math.sign(end.y - d.start.y || 1) * size } }
        const rect = rectangle(d.start, end)
        patch = { x: rect.x, top: Math.max(0, rect.y), width: boundedWidth(rect.x, rect.width, 16, .5), height: Math.max(16, rect.height) }
      }
    } else if (d.part === 'move') {
      let placement = snap({ x: box.x + p.x - d.start.x, y: box.y + p.y - d.start.y }, event.altKey)
      const dx = Math.max(-Math.min(...d.ids.map(id => d.geometry[id].x)), placement.x - box.x)
      const dy = Math.max(-Math.min(...d.ids.map(id => d.geometry[id].y)), placement.y - box.y)
      d.patches = shifted(d.objects, d.geometry, d.ids, dx, dy)
      if (object.kind === 'label' && d.ids.length === 1) {
        const attached = snapLabel({ x: box.x + p.x - d.start.x, y: box.y + p.y - d.start.y }, box, object.id, event.altKey)
        placement = attached.point
        d.patches[object.id] = { x: placement.x, top: placement.y, attachment: attached.attachment }
      }
      setPreviews(d.patches); return
    } else if (d.part === 'width') {
      const edge = snap({ x: box.x + box.width + p.x - d.start.x, y: box.y }, event.altKey)
      patch = { width: boundedWidth(box.x, edge.x - box.x, 120) }
    } else if (d.part === 'start' || d.part === 'end') patch = { [d.part]: snapEndpoint(p, event.altKey, [object.id]) }
    else if (d.part === 'bend') {
      const start = box.path![0], end = box.path!.at(-1)!
      patch = { bend: boundedPoint(snap(p, event.altKey), 0, 'strokeWidth' in object ? object.strokeWidth / 2 : 0).x - (start.x + end.x) / 2 }
    } else {
      const west = d.part.includes('w'), north = d.part.includes('n')
      const fixed = { x: west ? box.x + box.width : box.x, y: north ? box.y + box.height : box.y }
      const inset = 'strokeWidth' in object ? object.strokeWidth / 2 : 0
      const end = boundedPoint(snap(p, event.altKey), 0, inset)
      let width = Math.max(16, west ? fixed.x - end.x : end.x - fixed.x), height = Math.max(16, north ? fixed.y - end.y : end.y - fixed.y)
      if (event.shiftKey) width = height = Math.max(width, height)
      width = Math.min(width, west ? Math.max(0, fixed.x - inset) : Math.max(0, pageWidth() - inset - fixed.x))
      if (event.shiftKey) height = width
      patch = { x: west ? fixed.x - width : fixed.x, top: Math.max(0, north ? fixed.y - height : fixed.y), width, height }
    }
    d.patches = { [object.id]: patch }; setPreviews(d.patches)
  }
  function applyPatches(objects: FloatingObject[], patches: FloatingPreviews) {
    return objects.map(object => {
      const patch = patches[object.id]
      if (!patch) return object
      const { top, ...saved } = patch
      return { ...object, ...saved, ...(top !== undefined ? attach(object, { x: patch.x ?? object.x, top }) : {}) } as FloatingObject
    })
  }
  function finish(event: PointerEvent) {
    const d = drag.current
    if (!d) return
    if (d.part === 'marquee') {
      if (d.moved && selectedIds.length) focusObject(selectedIds[0])
    } else if (d.created) {
      let object = d.created
      if (!d.moved && object.kind === 'line') object = { ...object, end: anchorPoint(boundedPoint({ x: d.start.x + 160, y: d.start.y }, 0, 16), anchors) }
      onFloatingChange(applyPatches([...doc.floating, object], d.patches))
      select([object.id]); onToolChange(null)
      if (object.kind === 'label') setEditingLabel(object.id); else focusObject(object.id)
    } else if (d.moved) onFloatingChange(applyPatches(doc.floating, d.patches))
    cancel()
    if (sheet.current?.hasPointerCapture(event.pointerId)) sheet.current.releasePointerCapture(event.pointerId)
  }
  function remove() {
    if (!editable || !selectedIds.length || !window.confirm(`Delete ${selectedIds.length === 1 ? 'this floating object' : `${selectedIds.length} floating objects`}?`)) return
    const next = doc.floating.filter(object => !selectedIds.includes(object.id)).map(object => {
      const box = geometry[object.id]
      if (object.kind === 'label' && object.attachment && selectedIds.includes(object.attachment.targetId)) return { ...object, ...anchorPoint(box, anchors), attachment: null }
      if (object.kind === 'line') {
        const detached = (end: LineEnd, p: Point) => end.connection && selectedIds.includes(end.connection.targetId) ? anchorPoint(p, anchors) : end
        return { ...object, start: detached(object.start, box.path![0]), end: detached(object.end, box.path!.at(-1)!) }
      }
      return object
    })
    history.boundary(); onFloatingChange(next); select([]); onActive(null)
  }
  function duplicate() {
    if (!editable || !selectedIds.length) return
    const originals = doc.floating.filter(object => selectedIds.includes(object.id) || (object.kind === 'label' && object.attachment && selectedIds.includes(object.attachment.targetId)))
    const mapping = new Map(originals.map(object => [object.id, crypto.randomUUID()]))
    const patches = shifted(doc.floating, geometry, originals.map(object => object.id), 16, 16)
    const copies = applyPatches(originals, patches).map(original => {
      const object = structuredClone(original)
      object.id = mapping.get(original.id)!
      if (object.kind === 'label' && object.attachment) object.attachment.targetId = mapping.get(object.attachment.targetId) ?? object.attachment.targetId
      if (object.kind === 'line') for (const end of [object.start, object.end]) if (end.connection) end.connection.targetId = mapping.get(end.connection.targetId) ?? end.connection.targetId
      return object
    })
    history.boundary(); onFloatingChange([...doc.floating, ...copies]); select(copies.map(object => object.id)); onActive(null)
  }
  function label(id = selectedIds[0]) {
    const target = doc.floating.find(object => object.id === id)
    if (!editable || !target) return
    if (target.kind === 'label') { select([id]); setEditingLabel(id); return }
    const existing = doc.floating.filter(object => object.kind === 'label' && object.attachment?.targetId === id).sort((a, b) => (geometry[a.id]?.y ?? 0) - (geometry[b.id]?.y ?? 0) || a.id.localeCompare(b.id))[0]
    if (existing) { select([existing.id]); onActive(null); focusObject(existing.id); return }
    const box = geometry[id]
    const newLabel: FloatingObject = { id: crypto.randomUUID(), kind: 'label', ...anchorPoint(box, anchors), width: 12, textFlow: 'overlap', content: labelContent(), attachment: {
      targetId: id, position: target.kind === 'image' ? 'bottom-outside' : target.kind === 'line' ? 'above' : 'center',
    } }
    history.boundary(); onFloatingChange([...doc.floating, newLabel]); select([newLabel.id]); setEditingLabel(newLabel.id)
  }
  function detach() {
    const object = doc.floating.find(object => object.id === selectedIds[0])
    if (object?.kind !== 'label' || !object.attachment) return
    onNoteChange(object.id, { ...anchorPoint(geometry[object.id], anchors), attachment: null })
  }
  useLayoutEffect(() => { onActions({ remove, duplicate, label, detach }) })
  function key(id: string, event: React.KeyboardEvent) {
    if (!editable) return
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); return }
    if (event.key === 'Enter') { event.preventDefault(); label(id); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return }
    const directions: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
    const direction = directions[event.key]
    if (!direction) return
    event.preventDefault()
    const step = event.shiftKey ? 1 : event.altKey ? 8 : gridSize
    const part = (event.target as HTMLElement).dataset.floatingControl
    const object = doc.floating.find(object => object.id === id)!
    if (part === 'width') { onNoteChange(id, { width: boundedWidth(object.x, object.width + direction.x * step, 120) }); return }
    if ((part === 'start' || part === 'end') && object.kind === 'line') {
      const p = part === 'start' ? geometry[id].path![0] : geometry[id].path!.at(-1)!
      onNoteChange(id, { [part]: snapEndpoint({ x: p.x + direction.x * step, y: p.y + direction.y * step }, event.altKey, [id]) }); setGuides([]); return
    }
    if (part === 'bend' && object.kind === 'line') {
      const path = geometry[id].path!, middle = (path[0].x + path.at(-1)!.x) / 2
      onNoteChange(id, { bend: boundedPoint({ x: middle + object.bend + direction.x * step, y: 0 }, 0, object.strokeWidth / 2).x - middle }); return
    }
    if (part && (object.kind === 'rectangle' || object.kind === 'ellipse')) {
      onNoteChange(id, { width: boundedWidth(object.x, object.width + direction.x * step, 16, object.strokeWidth / 2), height: Math.max(16, object.height + direction.y * step) }); return
    }
    const ids = selectedIds.includes(id) ? selectedIds : [id]
    const patches = shifted(doc.floating, geometry, ids, direction.x * step, direction.y * step)
    onFloatingChange(applyPatches(doc.floating, patches))
  }

  return <div className={`canvas-pane ${minimap ? 'has-minimap' : ''}`}>
    <div className="stage" ref={stage} id={canvasId} aria-label="Document canvas" onPointerDown={event => {
      if (!(event.target as Element).closest('.sheet')) select([])
    }}>
      <div className={`sheet ${editable ? 'is-editing' : 'is-reading'} ${selectedIds.length ? 'has-selected-note' : ''} ${editable && Object.keys(previews).length > 0 ? 'show-floating-grid' : ''} ${tool ? 'has-creation-tool' : ''} ${active ? 'is-floating-dragging' : ''}`}
        ref={sheet} data-floating-preview={active ? '' : undefined} onPointerDownCapture={blankDown}
        onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}
        style={{ ...themeVariables(doc.theme), '--margin-left': `${doc.margins.left}px`, '--margin-right': `${doc.margins.right}px`, width: doc.width, zoom: scale, minHeight } as React.CSSProperties}>
        <div className="main-text">
          <TextEditor content={doc.content} editable={editable} spatial label="Main text" historyId="main" onChange={onMainChange}
            onReady={editor => { setMainEditor(editor); onMainReady(editor) }} onActive={editor => { if (!drag.current) select([]); onActive(editor) }} />
        </div>
        {mainEditor && <SegmentBoundaries editor={mainEditor} sheet={sheet} editable={editable} scale={scale} reflow={reflow} floatingPreview={active}
          onActive={() => { select([]); onActive(mainEditor) }} />}
        {layoutDoc.floating.map(original => {
          const note = { ...original, ...previews[original.id] } as FloatingObject
          const box = geometry[note.id] ?? { x: note.x, y: previews[note.id]?.top ?? note.y, width: note.width, height: 'height' in note ? note.height : 24 }
          return <FloatingObjectView key={note.id} note={note} geometry={box} editable={editable} selected={selectedIds.includes(note.id) || creating?.id === note.id}
            editingLabel={editingLabel === note.id} defaultColor={doc.theme.defaults.color}
            onBegin={(part, event) => begin(note.id, part, event)} onActive={editor => { if (!drag.current) { if (!selectedIds.includes(note.id) || editor) select([note.id]); onActive(editor) } }}
            onChange={patch => onNoteChange(note.id, patch)} onLabel={() => label(note.id)} onFinishLabel={() => { setEditingLabel(null); focusObject(note.id) }} onKey={event => key(note.id, event)} />
        })}
        {editable && marquee && <div className="marquee-selection" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
        {editable && guides.length > 0 && <svg className="attachment-guides" width="100%" height="100%" aria-hidden="true">{guides.map((guide, i) => <g key={i}>
          {guide.box && <rect x={guide.box.x} y={guide.box.y} width={guide.box.width} height={guide.box.height} />}
          <circle className={guide.active ? 'active' : ''} cx={guide.point.x} cy={guide.point.y} r={4 / scale} />
        </g>)}</svg>}
      </div>
    </div>
    {minimap && <Minimap stage={stage} sheet={sheet} canvasId={canvasId} sizing={minimapSize} />}
    {zoomHost && createPortal(<div className="zoom-controls" aria-label="Document zoom" onPointerDown={event => { if ((event.target as Element).closest('button')) event.preventDefault() }}>
      <button aria-label="Zoom out" disabled={scale <= minScale} onClick={() => zoomBy(1 / 1.1)}>−</button>
      <select aria-label="Document zoom level" value={String(scale)} onChange={event => event.target.value === 'fit' ? reset() : zoomTo(Number(event.target.value))}>
        {!zoomPresets.includes(scale) && <option value={String(scale)} hidden>{Math.round(scale * 100)}%</option>}
        {!editable && <option value="fit">Fit</option>}
        {zoomPresets.map(value => <option key={value} value={String(value)}>{value * 100}%</option>)}
      </select>
      <button aria-label="Zoom in" disabled={scale >= 3} onClick={() => zoomBy(1.1)}>+</button>
    </div>, zoomHost)}
  </div>
}
