import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Editor, JSONContent } from '@tiptap/core'
import { labelContent, paragraph, type FloatingObject, type FloatingPatch, type LabelAttachment, type LineEnd, type MoteDocument } from '../document/model'
import { useHistory } from '../document/history'
import { copyFloating, floatingClipboardJSON, floatingCopyIds, floatingText, importFloating, parseFloating, FLOATING_MIME } from '../document/floatingClipboard'
import { TextEditor } from '../editor/TextEditor'
import { isComposingKey } from '../editor/composition'
import { themeVariables } from '../theme/ThemePanel'
import { paletteColor } from '../theme/palette'
import { useDocumentZoom } from './useDocumentZoom'
import { Minimap } from './Minimap'
import { useSpaceGesture } from './useSpaceGesture'
import { useSegmentSelection } from './useSegmentSelection'
import { spaceRemovalThreshold, type SpaceMerge, type SpaceShift } from '../editor/spaces'
import { useFloatingLayout, type FloatingPreviews } from './useFloatingLayout'
import { FloatingObjectView, type DragPart } from './FloatingObjectView'
import { anchorPoint, boundary, boundedTranslation, boxLabelPositions, center, contains, distance, fullyOverlaps, gridSize, horizontalBounds, insertionPosition, labelOutsideGap, labelPlacement, lineLabelPositions, objectIntersects, resolveGeometry, type Box, type Geometries, type Point } from './floatingGeometry'
import type { ViewSettings } from '../app/GlobalSettings'
import './floating.css'
import { aiPlaceholder } from '../ai/placeholder'
import type { Area } from '../ai/types'
import { canResizeReservation, currentPlacement } from '../ai/reservations'
import type { AIReview } from '../ai/ReviewControls'

export type CreationTool = 'text' | 'rectangle' | 'ellipse' | 'line' | 'label' | 'ai' | null
export interface CanvasActions { remove: () => void; duplicate: () => void; label: () => void; detach: () => void; insert: (objects: FloatingObject[]) => void; without: (ids: string[]) => FloatingObject[] }
const zoomPresets = [.25, .5, .75, 1, 1.25, 1.5, 2, 3]
interface Props {
  doc: MoteDocument; editable: boolean; minimap: boolean; minimapSize: ViewSettings['minimapSize']; zoomHost: HTMLDivElement | null
  selectedIds: string[]; onSelect: (ids: string[]) => void
  tool: CreationTool; onToolChange: (tool: CreationTool) => void
  onMainChange: (content: JSONContent, merges?: SpaceMerge[], shift?: SpaceShift) => void; onNoteChange: (id: string, patch: FloatingPatch) => void
  onFloatingChange: (objects: FloatingObject[]) => void; onActions: (actions: CanvasActions) => void
  onActive: (editor: Editor | null) => void; onMainReady: (editor: Editor) => void
  widgetRuns?: Record<string, number>; staticWidgets?: boolean
  initialScale?: number
  onDropImages?: (files: File[], position: LineEnd) => void
  lockedIds?: Set<string>; onAICreate?: (object: FloatingObject, area: Area) => void
  aiWidgetIds?: Set<string>
  aiReview?: AIReview
}
interface Drag {
  part: DragPart | 'create' | 'marquee'; id: string; start: Point; ids: string[]; objects: FloatingObject[]; geometry: Geometries
  patches: FloatingPreviews; moved: boolean; additive: string[]; created?: FloatingObject
}
interface Guide { point: Point; active?: boolean; box?: Box }
const rectangle = (a: Point, b: Point): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
const contentText = (content: JSONContent): string => (content.text ?? '') + (content.content?.map(contentText).join('') ?? '')
const emptyContent = (object: FloatingObject) => ('content' in object && object.kind !== 'table' && !contentText(object.content).replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, ''))
  || (object.kind === 'katex' && !object.latex.trim())

export function DocumentCanvas({ doc, editable, minimap, minimapSize, zoomHost, selectedIds, onSelect, tool, onToolChange, onMainChange, onNoteChange, onFloatingChange, onActions, onActive, onMainReady, widgetRuns = {}, staticWidgets = false, initialScale, onDropImages, lockedIds = new Set(), onAICreate, aiWidgetIds, aiReview }: Props) {
  const history = useHistory()
  const canvasId = useId()
  const stage = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null)
  const footprint = useRef<HTMLDivElement>(null)
  const [mainEditor, setMainEditor] = useState<Editor | null>(null)
  const { scale, minScale, automatic, zoomTo, zoomBy, reset, fit } = useDocumentZoom(stage, sheet, doc.width, editable, initialScale)
  const [previews, setPreviews] = useState<FloatingPreviews>({})
  const [creating, setCreating] = useState<FloatingObject | null>(null)
  const [inserting, setInserting] = useState<FloatingObject[]>([])
  const pasteGroup = useRef<{ doc: MoteDocument; palette: MoteDocument['theme']['palette']; top?: number } | null>(null)
  const [clipboardNotice, setClipboardNotice] = useState('')
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [manipulating, setManipulating] = useState(false)
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const newLabels = useRef(new Set<string>())
  const drag = useRef<Drag | null>(null)
  const captured = useRef<{ element: Element; pointerId: number } | null>(null)
  const layoutDoc = useMemo(() => ({ ...doc, theme: pasteGroup.current ? { ...doc.theme, palette: pasteGroup.current.palette } : doc.theme, floating: [...doc.floating.map(object => {
    const task = editable && aiReview?.tasks.find(task => task.target.kind === 'object' && task.target.objectId === object.id)
    return task && task.preview && task.candidate?.object ? currentPlacement(task.candidate.object, object) : object
  }), ...inserting, ...(creating ? [creating] : [])] }), [doc, creating, inserting, editable, aiReview?.tasks])
  const { geometry, anchors, minHeight, sideInsets, reflow, attach } = useFloatingLayout(layoutDoc, mainEditor, sheet, previews)
  const sideSpace = sideInsets.left + sideInsets.right
  const active = !!creating || !!marquee || Object.keys(previews).length > 0
  const spaces = useSpaceGesture(mainEditor, sheet, editable, scale, reflow, () => { select([]); onActive(mainEditor) })
  const segments = useSegmentSelection({ doc, editable, editor: mainEditor, stage, sheet, scale, anchors, geometry, lockedIds,
    onStart: () => { cancel(); select([]); onActive(null); onToolChange(null) } })

  function sizeFootprint() {
    const wrapper = footprint.current!, height = getComputedStyle(sheet.current!).height
    if (wrapper.style.getPropertyValue('--page-height') !== height) wrapper.style.setProperty('--page-height', height)
  }
  // Update alongside edits, not one observer delivery after selection scrolling.
  useLayoutEffect(sizeFootprint)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(sizeFootprint)
    observer.observe(sheet.current!)
    return () => observer.disconnect()
  }, [])

  // Measure new content before committing its geometry and creation as one undo step.
  useLayoutEffect(() => {
    if (!inserting.length) return
    const group = pasteGroup.current
    if (!editable || group && group.doc !== doc) { pasteGroup.current = null; setInserting([]); return }
    if (inserting.some(object => object.kind === 'image' && !sheet.current!.querySelector<HTMLImageElement>(`[data-note-id="${object.id}"] img`)?.complete)) return
    const measured = reflow()
    if (group) {
      const ids = inserting.map(object => object.id), boxes = measured.geometry
      const roots = inserting.filter(object => !(object.kind === 'label' && object.attachment))
      const top = Math.min(...inserting.map(object => boxes[object.id].y))
      const right = Math.max(...inserting.map(object => horizontalBounds(object, boxes[object.id]).right))
      let delta = boundedTranslation(inserting, boxes, ids, { x: Math.min(0, pageWidth() - right), y: group.top === undefined ? 0 : group.top - top }, pageWidth())
      while ((roots.length ? roots : inserting).some(object => doc.floating.some(other => fullyOverlaps({ ...boxes[object.id], x: boxes[object.id].x + delta.x, y: boxes[object.id].y + delta.y }, boxes[other.id])))) delta = { ...delta, y: delta.y + 24 }
      const placed = applyPatches(inserting, shifted(inserting, boxes, ids, delta.x, delta.y))
      const next = { ...doc, theme: { ...doc.theme, palette: group.palette }, floating: [...doc.floating, ...placed] }
      pasteGroup.current = null; setInserting([])
      if (!history.guard.current(doc, next)) { setClipboardNotice('Accept or discard the affected AI task before pasting.'); return }
      history.boundary(); history.setDoc(next); history.boundary()
      segments.clear(); select(ids); onActive(null); onToolChange(null); focusObject(ids[0])
      return
    }
    const occupied = doc.floating.map(object => measured.geometry[object.id])
    const placed = inserting.map(object => {
      const box = measured.geometry[object.id]
      const position = insertionPosition(box, occupied, pageWidth())
      occupied.push({ ...box, ...position })
      if (object.kind === 'line') {
        const offset = (p: Point) => anchorPoint({ x: p.x + position.x - box.x, y: p.y + position.y - box.y }, measured.anchors)
        return { ...object, start: offset(box.path![0]), end: offset(box.path!.at(-1)!) }
      }
      return { ...object, ...anchorPoint(position, measured.anchors) }
    })
    history.boundary(); onFloatingChange([...doc.floating, ...placed]); setInserting([])
    select(placed.map(object => object.id)); onActive(null); onToolChange(null); focusObject(placed[0].id, placed[0].kind === 'text')
  }, [inserting, doc])

  const previousEdit = useRef({ ids: selectedIds, label: editingLabel, editable, revision: history.revision })
  const cleanedDraft = useRef(false)
  useLayoutEffect(() => {
    if (cleanedDraft.current || !editable || !anchors.length) return
    cleanedDraft.current = true
    const empty = doc.floating.filter(object => !lockedIds.has(object.id) && (emptyContent(object) || collapsedLine(object, doc.floating))).map(object => object.id)
    if (empty.length) history.edit({ normalize: true }, () => onFloatingChange(withoutObjects(empty)))
  }, [editable, anchors])
  useLayoutEffect(() => {
    const previous = previousEdit.current
    previousEdit.current = { ids: selectedIds, label: editingLabel, editable, revision: history.revision }
    if (previous.revision !== history.revision) { newLabels.current.clear(); return }
    if (!previous.editable) return
    const finished = previous.ids.filter(id => !editable || !selectedIds.includes(id))
    if (previous.label && previous.label !== editingLabel) finished.push(previous.label)
    const empty = doc.floating.filter(object => !lockedIds.has(object.id) && finished.includes(object.id) && (emptyContent(object) || collapsedLine(object, doc.floating))).map(object => object.id)
    let changed = empty.length > 0
    const next = withoutObjects(empty).map(object => {
      if (!finished.includes(object.id) || !newLabels.current.delete(object.id) || object.kind !== 'label' || object.attachment) return object
      const position = insertionPosition(geometry[object.id], doc.floating.filter(other => other.id !== object.id && !empty.includes(other.id)).map(other => geometry[other.id]), pageWidth())
      changed = true
      return { ...object, ...anchorPoint(position, anchors) }
    })
    for (const id of empty) newLabels.current.delete(id)
    if (changed) history.edit({ normalize: true }, () => onFloatingChange(next))
  }, [selectedIds, editingLabel, editable, history.revision])

  function select(ids: string[]) {
    onSelect(ids)
    setClipboardNotice('')
    if (ids.length !== 1 || !ids.includes(editingLabel ?? '')) setEditingLabel(null)
  }
  function focusObject(id: string, text = false) {
    requestAnimationFrame(() => sheet.current?.querySelector<HTMLElement>(`[data-note-id="${id}"]${text ? ' .tiptap' : ''}`)?.focus({ preventScroll: true }))
  }
  function cancel() {
    drag.current = null; setManipulating(false); setPreviews(previous => Object.keys(previous).length ? {} : previous); setCreating(null); setMarquee(null); setGuides([])
    const pointer = captured.current
    captured.current = null
    if (pointer?.element.hasPointerCapture(pointer.pointerId)) pointer.element.releasePointerCapture(pointer.pointerId)
  }
  useLayoutEffect(() => { cancel(); pasteGroup.current = null; setInserting([]); setEditingLabel(null); setClipboardNotice(''); onToolChange(null) }, [editable, scale, history.revision])
  useLayoutEffect(() => {
    const ids = selectedIds.filter(id => doc.floating.some(note => note.id === id))
    if (ids.length !== selectedIds.length) select(ids)
  }, [doc.floating])
  useLayoutEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || isComposingKey(event)) return
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
    return alt ? p : { x: Math.round(p.x / gridSize) * gridSize, y: Math.round(p.y / gridSize) * gridSize }
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
          const placed = labelPlacement(target, size, position, labelOutsideGap(doc.theme))
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
    setManipulating(true)
  }
  function begin(id: string, part: DragPart, event: PointerEvent) {
    if (event.button !== 0) return
    if (sizeLocked(id) && part !== 'move') { event.preventDefault(); event.stopPropagation(); return }
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
    if (segments.begin(event)) return
    segments.clear()
    const target = event.target as Element
    if (target.closest('[data-ai-controls], [data-ai-preview]')) return
    const inside = !!target.closest('.sheet')
    if (inside && spaces.begin(event)) return
    if (tool && inside) {
      if (target.closest('.object-handle, .floating-border-right, .table-column-divider')) return
      capture(event); select([]); onActive(null); setEditingLabel(null); history.boundary()
      const start = boundedPoint(snap(point(event), event.altKey), 16, .5)
      const base = { id: crypto.randomUUID(), ...anchorPoint(start, anchors), width: boundedWidth(start.x, 128, 16, .5), textFlow: 'overlap' as const }
      const note: FloatingObject = tool === 'ai' ? aiPlaceholder({ ...base, width: boundedWidth(start.x, 340, 120) })
        : tool === 'label' ? { ...base, kind: 'label', content: labelContent(), attachment: null }
        : tool === 'text' ? { ...base, kind: 'text', width: boundedWidth(start.x, 340, 120), background: null, borderColor: null, content: { type: 'doc', content: [paragraph('')] } }
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
    if (floating) return
    const start = point(event), space = spaceAt(start)
    const gutter = !inside && (start.x < 0 || start.x > pageWidth())
    const padding = target.matches('.main-text, .sheet')
    if (space || gutter || padding) {
      capture(event); setEditingLabel(null)
      stage.current!.focus({ preventScroll: true })
      drag.current = { part: 'marquee', id: '', ids: [], start, objects: doc.floating, geometry, patches: {}, moved: false, additive: event.shiftKey ? selectedIds : [] }
      if (!drag.current.additive.length) select([])
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
      } else if (object.kind === 'text') {
        const end = boundedPoint(snap(p, event.altKey))
        const x = Math.min(d.start.x, end.x)
        patch = { x, top: d.start.y, width: boundedWidth(x, Math.abs(end.x - d.start.x), 120) }
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
      patch = { width: boundedWidth(box.x, edge.x - box.x, object.kind === 'html' ? 16 : 120) }
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
      if (!d.moved && object.kind === 'line') object = { ...object, end: anchorPoint(boundedPoint({ x: d.start.x + (d.start.x + 160 <= pageWidth() - 16 ? 160 : -160), y: d.start.y }, 0, 16), anchors) }
      const next = applyPatches([object], d.patches)[0]
      if (tool === 'ai') {
        const top = (anchors.find(anchor => anchor.id === next.anchorId)?.top ?? 0) + next.y
        onAICreate?.(next, { x: next.x, y: top, width: next.width, height: 'height' in next ? next.height : 220 })
        select([next.id]); onToolChange(null); cancel(); return
      }
      if (collapsedLine(next, [...doc.floating, next])) { cancel(); onToolChange(null); return }
      if (!d.moved && next.kind !== 'label' && !(next.kind === 'line' && next.start.connection)) {
        setInserting([next]); onToolChange(null); cancel(); return
      }
      onFloatingChange([...doc.floating, next])
      select([object.id]); onToolChange(null)
      if (object.kind === 'label') { newLabels.current.add(object.id); setEditingLabel(object.id) } else focusObject(object.id, object.kind === 'text')
    } else if (d.moved) {
      const next = applyPatches(doc.floating, d.patches)
      const object = next.find(object => object.id === d.id)!
      if (collapsedLine(object, next)) { onFloatingChange(withoutObjects([object.id])); select([]); onActive(null) }
      else onFloatingChange(next)
    }
    cancel()
    if (sheet.current?.hasPointerCapture(event.pointerId)) sheet.current.releasePointerCapture(event.pointerId)
  }
  function collapsedLine(object: FloatingObject, objects: FloatingObject[]) {
    if (object.kind !== 'line') return false
    const tops = Object.fromEntries(objects.map(note => [note.id, (anchors.find(anchor => anchor.id === note.anchorId)?.top ?? 0) + note.y]))
    const path = resolveGeometry(objects, anchors, geometry, tops, labelOutsideGap(doc.theme))[object.id].path!
    return path.every(point => distance(point, path[0]) < 1)
  }
  function withoutObjects(ids: string[]) {
    return doc.floating.filter(object => !ids.includes(object.id)).map(object => {
      const box = geometry[object.id]
      if (object.kind === 'label' && object.attachment && ids.includes(object.attachment.targetId)) return { ...object, ...anchorPoint(box, anchors), attachment: null }
      if (object.kind === 'line') {
        const detached = (end: LineEnd, p: Point) => end.connection && ids.includes(end.connection.targetId) ? anchorPoint(p, anchors) : end
        return { ...object, start: detached(object.start, box.path![0]), end: detached(object.end, box.path!.at(-1)!) }
      }
      return object
    })
  }
  function remove() {
    if (!editable || !selectedIds.length) return
    if (selectedIds.some(id => lockedIds.has(id))) return
    history.boundary(); onFloatingChange(withoutObjects(selectedIds)); select([]); onActive(null)
  }
  useLayoutEffect(() => {
    if (!editable) return
    function ownsClipboard() {
      const element = document.activeElement as HTMLElement | null
      return !!element && stage.current!.contains(element) && !element.closest('input, textarea, select') && element.tagName !== 'IFRAME'
    }
    function copy(event: ClipboardEvent) {
      if (!selectedIds.length || !ownsClipboard() || (document.activeElement as HTMLElement).isContentEditable || !event.clipboardData) return
      event.preventDefault(); event.stopImmediatePropagation(); setClipboardNotice('')
      try {
        const ids = floatingCopyIds(doc.floating, selectedIds)
        if ([...ids].some(id => lockedIds.has(id))) throw new Error('Accept or discard the selected AI task before copying or cutting these elements.')
        const payload = copyFloating(doc, ids, geometry), json = JSON.stringify(payload)
        parseFloating(json)
        const next = event.type === 'cut' ? { ...doc, floating: withoutObjects([...ids]) } : null
        if (next && !history.guard.current(doc, next)) throw new Error('Accept or discard the affected AI task before cutting these elements.')
        const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
        const text = floatingText(payload)
        event.clipboardData.setData(FLOATING_MIME, json)
        event.clipboardData.setData('text/plain', text || '\n')
        event.clipboardData.setData('text/html', `<div data-mote-floating="${escape(json)}"><pre>${escape(text)}</pre></div>`)
        if (next) {
          history.boundary(); history.setDoc(next); history.boundary()
          select([]); onActive(null); stage.current!.focus({ preventScroll: true })
        }
      } catch (error) { setClipboardNotice(error instanceof Error ? error.message : 'These elements could not be copied.') }
    }
    function paste(event: ClipboardEvent) {
      if (!ownsClipboard() || !event.clipboardData) return
      // Rich-text editors and widget frames keep their own content clipboard.
      const element = document.activeElement as HTMLElement
      if (element.isContentEditable && !mainEditor?.isFocused) return
      const json = floatingClipboardJSON(event.clipboardData)
      if (!json) return
      event.preventDefault(); event.stopImmediatePropagation(); setClipboardNotice('')
      try {
        const payload = parseFloating(json)
        const imported = importFloating(doc, payload, anchors)
        const caret = mainEditor?.isFocused ? mainEditor.view.coordsAtPos(mainEditor.state.selection.from) : null
        const top = caret ? point({ clientX: caret.left, clientY: caret.top }).y : undefined
        cancel(); segments.clear(); onToolChange(null)
        pasteGroup.current = { doc, palette: imported.palette, top }
        setInserting(imported.floating)
      } catch (error) { setClipboardNotice(error instanceof Error ? error.message : 'The clipboard does not contain valid Mote elements.') }
    }
    window.addEventListener('copy', copy, true)
    window.addEventListener('cut', copy, true)
    window.addEventListener('paste', paste, true)
    return () => {
      window.removeEventListener('copy', copy, true)
      window.removeEventListener('cut', copy, true)
      window.removeEventListener('paste', paste, true)
    }
  })
  function duplicate() {
    if (!editable || !selectedIds.length) return
    if (selectedIds.some(id => lockedIds.has(id))) return
    const originals = doc.floating.filter(object => !emptyContent(object) && (selectedIds.includes(object.id) || (object.kind === 'label' && object.attachment && selectedIds.includes(object.attachment.targetId))))
    if (!originals.length) return
    const mapping = new Map(originals.map(object => [object.id, crypto.randomUUID()]))
    const ids = originals.map(object => object.id)
    let delta = boundedTranslation(doc.floating, geometry, ids, { x: 16, y: 16 }, pageWidth())
    const roots = originals.filter(object => !(object.kind === 'label' && object.attachment && ids.includes(object.attachment.targetId)))
    while (roots.some(object => doc.floating.some(other => fullyOverlaps({ ...geometry[object.id], x: geometry[object.id].x + delta.x, y: geometry[object.id].y + delta.y }, geometry[other.id])))) delta = { ...delta, y: delta.y + 24 }
    const patches = shifted(doc.floating, geometry, ids, delta.x, delta.y)
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
    if (lockedIds.has(id)) return
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
  useLayoutEffect(() => { onActions({ remove, duplicate, label, detach, without: withoutObjects, insert: objects => { if (editable) setInserting(current => [...current, ...objects]) } }) })
  function key(id: string, event: React.KeyboardEvent) {
    if (!editable || isComposingKey(event.nativeEvent)) return
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); return }
    if (event.key === 'Enter') { event.preventDefault(); label(id); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return }
    const directions: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
    const direction = directions[event.key]
    if (!direction) return
    event.preventDefault()
    const step = event.shiftKey ? 1 : event.altKey ? 8 : gridSize
    const part = (event.target as HTMLElement).dataset.floatingControl
    if (sizeLocked(id) && part) return
    const object = doc.floating.find(object => object.id === id)!
    if (part === 'width') { onNoteChange(id, { width: boundedWidth(object.x, object.width + direction.x * step, object.kind === 'html' ? 16 : 120) }); return }
    if ((part === 'start' || part === 'end') && object.kind === 'line') {
      const p = part === 'start' ? geometry[id].path![0] : geometry[id].path!.at(-1)!
      onNoteChange(id, { [part]: snapEndpoint({ x: p.x + direction.x * step, y: p.y + direction.y * step }, event.altKey, [id]) }); setGuides([]); return
    }
    if (part === 'bend' && object.kind === 'line') {
      const path = geometry[id].path!, middle = (path[0].x + path.at(-1)!.x) / 2
      onNoteChange(id, { bend: boundedPoint({ x: middle + object.bend + direction.x * step, y: 0 }, 0, object.strokeWidth / 2).x - middle }); return
    }
    if (part && (object.kind === 'rectangle' || object.kind === 'ellipse' || object.kind === 'html')) {
      onNoteChange(id, { width: boundedWidth(object.x, object.width + direction.x * step, 16, 'strokeWidth' in object ? object.strokeWidth / 2 : 0), height: Math.max(16, object.height + direction.y * step) }); return
    }
    const ids = selectedIds.includes(id) ? selectedIds : [id]
    const patches = shifted(doc.floating, geometry, ids, direction.x * step, direction.y * step)
    onFloatingChange(applyPatches(doc.floating, patches))
  }

  function sizeLocked(id: string) {
    return lockedIds.has(id) && !aiReview?.tasks.some(task => task.target.kind === 'object' && task.target.objectId === id && canResizeReservation(task))
  }

  return <div className={`canvas-pane ${minimap ? 'has-minimap' : ''} ${editable ? '' : 'reading-canvas'}`}
    style={{ '--page-background': paletteColor(doc.theme, doc.theme.defaults.background) } as React.CSSProperties}>
    <div className="stage" ref={stage} id={canvasId} tabIndex={-1} aria-label="Document canvas" onPointerDownCapture={blankDown}
      onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <div className="sheet-footprint" ref={footprint} style={{
        width: editable ? doc.width * scale : `clamp(${(doc.width - sideSpace) * scale}px, 100%, ${doc.width * scale}px)`,
        '--scaled-page-width': `${doc.width * scale}px`, '--crop-left': sideSpace ? sideInsets.left / sideSpace : 0,
        height: `calc(var(--page-height, 0px) * ${scale})`,
      } as React.CSSProperties}>
      <div className={`sheet ${editable ? 'is-editing' : 'is-reading'} ${selectedIds.length ? 'has-selected-note' : ''} ${editable && (tool || creating || Object.keys(previews).length > 0) ? 'show-floating-grid' : ''} ${tool ? 'has-creation-tool' : ''} ${active ? 'is-floating-dragging' : ''} ${spaces.hint ? 'can-resize-space' : ''} ${spaces.hint?.dragging ? 'is-space-dragging' : ''}`}
        ref={sheet} lang={doc.language ?? 'en'} data-floating-preview={active ? '' : undefined}
        onLoadCapture={event => { if (inserting.some(object => object.id === (event.target as Element).closest<HTMLElement>('[data-note-id]')?.dataset.noteId)) setInserting(current => [...current]) }}
        onDragOverCapture={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = editable ? 'copy' : 'none' } }}
        onDropCapture={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault(); event.stopPropagation()
          if (editable) onDropImages?.([...event.dataTransfer.files], anchorPoint(boundedPoint(point(event)), anchors))
        }}
        style={{ ...themeVariables(layoutDoc.theme, doc.language ?? 'en'), '--ai-page-width': `${doc.width - 2}px`, '--margin-top': `${doc.margins.top}px`, '--margin-right': `${doc.margins.right}px`, '--margin-bottom': `${doc.margins.bottom}px`, '--margin-left': `${doc.margins.left}px`, width: doc.width, transform: `scale(${scale})`, minHeight } as React.CSSProperties}>
        <div className="main-text">
          <TextEditor content={doc.content} editable={editable} spatial label="Main text" historyId="main" onChange={onMainChange} aiReview={aiReview}
            onReady={editor => { setMainEditor(editor); onMainReady(editor) }} onActive={editor => { if (!drag.current) select([]); onActive(editor) }} />
        </div>
        {editable && spaces.hint && <div className={`space-hint ${spaces.hint.dragging ? 'is-dragging' : ''}`} aria-hidden="true"
          style={{ top: spaces.hint.top + (spaces.hint.dragging ? spaces.hint.height : 0) }}>
          {spaces.hint.dragging ? spaces.hint.height < spaceRemovalThreshold ? 'Release to remove' : `${Math.round(spaces.hint.height)}px` : !spaces.hint.existing ? '↕' : null}
        </div>}
        {/* Stable DOM order keeps iframe browsing contexts alive when stacking changes. */}
        {layoutDoc.floating.toSorted((a, b) => a.id.localeCompare(b.id)).map(original => {
          const note = { ...original, ...previews[original.id] } as FloatingObject
          const box = geometry[note.id] ?? { x: note.x, y: previews[note.id]?.top ?? note.y, width: note.width, height: 'height' in note ? note.height : 24 }
          return <FloatingObjectView key={note.id} note={note} geometry={box} editable={editable} locked={lockedIds.has(note.id)} sizeLocked={sizeLocked(note.id)} selected={selectedIds.includes(note.id) || creating?.id === note.id}
            contentActive={selectedIds.length === 1 && selectedIds[0] === note.id && !manipulating}
            aiReview={aiReview} aiTask={editable ? aiReview?.tasks.find(task => task.target.kind === 'object' && task.target.objectId === note.id) : undefined}
            restoreWidgetRevision={aiWidgetIds?.has(note.id) ? history.revision : undefined}
            editingLabel={editingLabel === note.id} defaultColor={paletteColor(doc.theme, doc.theme.defaults.color)} defaultFontSize={doc.theme.defaults.size} widgetRun={widgetRuns[note.id] ?? 0} staticWidgets={staticWidgets} order={layoutDoc.floating.indexOf(original)}
            onBegin={(part, event) => begin(note.id, part, event)} onActive={editor => { if (!drag.current) { if (!selectedIds.includes(note.id) || editor) select([note.id]); onActive(editor) } }}
            onChange={patch => onNoteChange(note.id, patch)} onLabel={() => label(note.id)} onFinishLabel={() => { setEditingLabel(null); focusObject(note.id) }} onKey={event => key(note.id, event)} />
        })}
        {editable && marquee && <div className="marquee-selection" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
        {editable && guides.length > 0 && <svg className="attachment-guides" width="100%" height="100%" aria-hidden="true">{guides.map((guide, i) => <g key={i}>
          {guide.box && <rect x={guide.box.x} y={guide.box.y} width={guide.box.width} height={guide.box.height} />}
          <circle className={guide.active ? 'active' : ''} cx={guide.point.x} cy={guide.point.y} r={4 / scale} />
        </g>)}</svg>}
      </div>
      {segments.overlay}
      </div>
    </div>
    {(clipboardNotice || segments.notice) && <p className="segment-notice" role="status">{clipboardNotice || segments.notice}</p>}
    {minimap && <Minimap stage={stage} sheet={sheet} canvasId={canvasId} sizing={minimapSize} />}
    {zoomHost && createPortal(<div className="zoom-controls" aria-label="Document zoom" onPointerDown={event => { if ((event.target as Element).closest('button')) event.preventDefault() }}>
      <button aria-label="Zoom out" disabled={scale <= minScale} onClick={() => zoomBy(1 / 1.1)}>−</button>
      <select aria-label="Document zoom level" title={automatic ? 'Auto zoom' : 'Zoom'} value={String(scale)} onChange={event => event.target.value === 'auto' ? reset() : event.target.value === 'fit' ? fit() : zoomTo(Number(event.target.value))}>
        <option value="auto">Auto</option>
        {!zoomPresets.includes(scale) && <option value={String(scale)} hidden>{Math.round(scale * 100)}%</option>}
        {!editable && <option value="fit">Fit</option>}
        {zoomPresets.map(value => <option key={value} value={String(value)}>{value * 100}%</option>)}
      </select>
      <button aria-label="Zoom in" disabled={scale >= 3} onClick={() => zoomBy(1.1)}>+</button>
    </div>, zoomHost)}
  </div>
}
