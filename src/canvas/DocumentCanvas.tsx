import { patchObject, objectX, objectY, objectAnchorId } from '../document/model'
import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Editor, JSONContent } from '@tiptap/core'
import { captionContent, supportsCaption, isText, paragraph, tableContent, type FloatingImage, type FloatingObject, type FloatingPatch, type MoteDocument } from '../document/model'
import { useHistory } from '../document/history'
import { convertObjectPlacement, insertDocumentObjects, reconcileObjectDeletions } from '../document/flow'
import { copyFloating, floatingClipboardJSON, floatingCopyIds, floatingText, importFloating, parseFloating, FLOATING_MIME } from '../document/floatingClipboard'
import { copyParagraphs, PARAGRAPH_MIME } from '../document/paragraphClipboard'
import { TextEditor } from '../editor/TextEditor'
import { isComposingKey } from '../editor/composition'
import { themeVariables } from '../theme/ThemePanel'
import { pageColor } from '../../shared/palette.mjs'
import { validLinkHref } from '../../shared/links.mjs'
import { useDocumentZoom } from './useDocumentZoom'
import { Minimap } from './Minimap'
import { useSpaceGesture } from './useSpaceGesture'
import { useScrollFloor } from './useScrollFloor'
import { useParagraphInsertion } from './useParagraphInsertion'
import { useDocumentTail } from './useDocumentTail'
import { useImagePlacement } from './useImagePlacement'
import { DEFAULT_WIDGET_HTML, WIDGET_SCREENSHOT_PLACEHOLDER } from '../document/widget'
import { useSegmentSelection } from './useSegmentSelection'
import { spaceRemovalThreshold, type SpaceMerge, type SpaceShift } from '../editor/spaces'
import { useFloatingLayout, type FloatingPreviews } from './useFloatingLayout'
import { FloatingObjectView, type DragPart } from './FloatingObjectView'
import { patchFloating } from './patchFloating'
import { anchorPoint, boundedTranslation, constrainCaptionResize, contains, distance, extentBounds, flowX, fullyOverlaps, gridSize, insertionPosition, intersects, layoutBounds, type Box, type Geometries, type Point } from './floatingGeometry'
import type { ViewSettings } from '../app/GlobalSettings'
import { PanelIcon } from '../app/PanelIcon'
import './floating.css'
import { aiPlaceholder } from '../ai/placeholder'
import type { Area } from '../ai/types'
import { freshNode, moveSegment, type SegmentPoint, type SegmentRange } from '../document/segment'
import { resolveSegmentRange, type SegmentContext } from '../ai/segments'
import { projectSegments } from '../ai/segmentProjection'
import { OriginalGeometry } from '../ai/OriginalGeometry'
import { SegmentPreviewBorders } from '../ai/SegmentPreviewBorders'
import { canResizeReservation, currentPlacement } from '../ai/reservations'
import { ReviewControls, type AIReview } from '../ai/ReviewControls'

export type CreationTool = 'paragraph' | 'text' | 'code' | 'drawing' | 'ai' | 'table' | 'formula' | 'html' | { image: FloatingImage; ratio: number } | null
export interface CanvasActions {
  clearSelection: () => void
  remove: () => void; duplicate: () => void; caption: (id?: string) => void
  insert: (objects: FloatingObject[]) => void; without: (ids: string[]) => FloatingObject[]
  selectOwner: () => void; captionWidth: (width: number | null) => void
  placement: (placement: 'flow' | 'float') => void
  segmentSelection: () => { range: SegmentRange; area: Area } | null
  segmentContext: () => SegmentContext | undefined; locateSegment: (id: string) => void
}
const zoomPresets = [.25, .5, .75, 1, 1.25, 1.5, 2, 3]
interface Props {
  doc: MoteDocument; editable: boolean; minimap: boolean; minimapSize: ViewSettings['minimapSize']; zoomHost: HTMLDivElement | null
  selectedIds: string[]; onSelect: (ids: string[]) => void
  onCaptionSelection?: (id: string | null) => void
  onSegmentSelection?: (range: SegmentRange | null, taskId: string | null) => void
  onInteraction?: (event: React.SyntheticEvent) => void
  tool: CreationTool; onToolChange: (tool: CreationTool) => void
  onMainChange: (content: JSONContent, merges?: SpaceMerge[], shift?: SpaceShift) => void; onNoteChange: (id: string, patch: FloatingPatch) => void
  onFloatingChange: (objects: FloatingObject[]) => void; onActions: (actions: CanvasActions) => void
  onActive: (editor: Editor | null) => void; onMainReady: (editor: Editor) => void
  widgetRuns?: Record<string, number>; staticWidgets?: boolean
  initialScale?: number
  onDropImages?: (files: File[], position: ReturnType<typeof anchorPoint>) => void
  lockedIds?: Set<string>; onAICreate?: (object: FloatingObject, area: Area) => void
  onAISegmentCreate?: (range: SegmentRange, area: Area) => string | undefined
  aiWidgetIds?: Set<string>
  aiReview?: AIReview
  onDeleteObjects?: (objects: FloatingObject[]) => boolean
  onContextMenu?: (point: { x: number; y: number }) => void
  onDrawingEdit?: (id: string) => void
}
interface Drag {
  part: DragPart | 'create' | 'marquee'; id: string; start: Point; origin?: Point; ids: string[]; objects: FloatingObject[]; geometry: Geometries
  patches: FloatingPreviews; moved: boolean; additive: string[]; created?: FloatingObject
  destination?: SegmentPoint
}
const rectangle = (a: Point, b: Point): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
const contentText = (content: JSONContent): string => (content.text ?? '') + (content.content?.map(contentText).join('') ?? '')
const emptyContent = (object: FloatingObject) => ('content' in object && object.kind !== 'table' && !contentText(object.content))
  || (object.kind === 'formula' && !object.latex.length)
  || (object.kind === 'code' && !object.source.length)

export function DocumentCanvas({ doc, editable, minimap, minimapSize, zoomHost, selectedIds, onSelect, onCaptionSelection, onSegmentSelection, onInteraction, tool, onToolChange, onMainChange, onNoteChange, onFloatingChange, onActions, onActive, onMainReady, widgetRuns = {}, staticWidgets = false, initialScale, onDropImages, lockedIds = new Set(), onAICreate, onAISegmentCreate, aiWidgetIds, aiReview, onDeleteObjects, onContextMenu, onDrawingEdit }: Props) {
  const history = useHistory()
  const canvasId = useId()
  const stage = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null)
  const footprint = useRef<HTMLDivElement>(null)
  const scrollFloor = useScrollFloor(stage, footprint, editable)
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null)
  const [mainEditor, setMainEditor] = useState<Editor | null>(null)
  const { scale, automatic, zoomTo, reset, fit } = useDocumentZoom(stage, sheet, doc.page.width, editable, initialScale)
  const [previews, setPreviews] = useState<FloatingPreviews>({})
  const [creating, setCreating] = useState<FloatingObject | null>(null)
  const [insertionHint, setInsertionHint] = useState<{ position: Point; boundary?: { point: SegmentPoint; top: number } } | null>(null)
  const insertionPointer = useRef<Pick<globalThis.PointerEvent, 'clientX' | 'clientY' | 'altKey'> | null>(null)
  const creationObject = useMemo<FloatingObject | null>(() => {
    if (!tool || tool === 'paragraph') return null
    if (typeof tool === 'object') return tool.image
    const base = { id: crypto.randomUUID(), layout: { width: 340, placement: { type: 'float' as const, anchorId: null, x: 0, y: 0 } } }
    return tool === 'ai' ? aiPlaceholder(base)
      : tool === 'text' ? { ...base, kind: 'text', content: { type: 'doc', content: [paragraph('')] } }
      : tool === 'code' ? { ...base, kind: 'code', layout: { ...base.layout, width: 420 }, source: '', language: 'plaintext' }
      : tool === 'table' ? { ...base, kind: 'table', layout: { ...base.layout, width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 2 }, content: tableContent([['', ''], ['', '']]) }
      : tool === 'formula' ? { ...base, kind: 'formula', latex: 'E = mc^2' }
      : tool === 'html' ? { ...base, kind: 'html', layout: { ...base.layout, height: 220 }, html: DEFAULT_WIDGET_HTML, screenshot: WIDGET_SCREENSHOT_PLACEHOLDER, alt: '' }
      : { ...base, kind: 'drawing', layout: { ...base.layout, width: 480, height: 320 }, strokes: [], labels: [], background: null }
  }, [tool])
  const [inserting, setInserting] = useState<FloatingObject[]>([])
  const pasteGroup = useRef<{ doc: MoteDocument; top?: number } | null>(null)
  const [clipboardNotice, setClipboardNotice] = useState('')
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [manipulating, setManipulating] = useState(false)
  const [flowDrop, setFlowDrop] = useState<{ top?: number; centered: boolean } | null>(null)
  const dragPointer = useRef<{ clientX: number; clientY: number; altKey: boolean; pointerId: number } | null>(null)
  const drag = useRef<Drag | null>(null)
  const captured = useRef<{ element: Element; pointerId: number } | null>(null)
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null)
  const [contextReady, setContextReady] = useState(false)
  const sourceContext = useRef<SegmentContext>({ anchors: [], geometry: {} })
  const [measuredSource, setMeasuredSource] = useState<{ doc: MoteDocument; context: SegmentContext; signature: string } | null>(null)
  const originalContext = measuredSource?.doc === doc ? measuredSource.context : sourceContext.current
  const projected = useRef<{ doc: MoteDocument; editor: Editor | null; context: SegmentContext; tasks: { id: string; candidate: unknown }[]; value: ReturnType<typeof projectSegments> } | null>(null)
  const candidates = editable && contextReady ? aiReview?.tasks.filter(task => task.target.kind === 'segment' && task.preview && task.candidate?.segment) ?? [] : []
  if (!projected.current || projected.current.doc !== doc || projected.current.editor !== mainEditor || projected.current.context !== originalContext
    || projected.current.tasks.length !== candidates.length || candidates.some((task, i) => projected.current!.tasks[i].id !== task.id || projected.current!.tasks[i].candidate !== task.candidate)) {
    projected.current = { doc, editor: mainEditor, context: originalContext, tasks: candidates.map(task => ({ id: task.id, candidate: task.candidate })), value: projectSegments(doc, candidates, mainEditor, originalContext) }
  }
  const projection = projected.current.value
  useLayoutEffect(() => {
    for (const failure of projection.failures) aiReview?.previewFailed(failure.taskId, failure.error)
  }, [projection])
  const layoutDoc = useMemo(() => ({ ...projection.document, objects: [...projection.document.objects.map(object => {
    const task = editable && aiReview?.tasks.find(task => task.target.kind === 'object' && task.target.objectId === object.id)
    return task && task.preview && task.candidate?.object ? currentPlacement(task.candidate.object, object) : object
  }), ...inserting, ...(creating ? [creating] : [])] }), [projection, creating, inserting, editable, aiReview?.tasks])
  const { geometry, anchors, minHeight, sideInsets, flowMounts, reflow, attach } = useFloatingLayout(layoutDoc, mainEditor, sheet, previews)
  const sideSpace = sideInsets.left + sideInsets.right
  const active = !!creating || !!marquee || Object.keys(previews).length > 0
  const spaces = useSpaceGesture(mainEditor, sheet, editable, scale, doc.page.margins.left, reflow, () => { select([]); onActive(mainEditor) }, scrollFloor)
  useLayoutEffect(scrollFloor.reset, [doc.id, editable, scale, scrollFloor.reset])
  const segments = useSegmentSelection({ doc, editable, editor: mainEditor, stage, sheet, scale, anchors, geometry, lockedIds,
    onStart: () => { cancel(); select([]); onActive(null); onToolChange(null) } })
  useLayoutEffect(() => { onSegmentSelection?.(segments.range, activeSegmentId) }, [segments.range, activeSegmentId])
  const paragraphs = useParagraphInsertion(mainEditor, sheet, editable && tool === 'paragraph', scale, segments.target, () => { onToolChange(null); onActive(mainEditor) })
  const tail = useDocumentTail(mainEditor, sheet, editable && !tool && !active, scale, doc.page.margins.left, doc.theme, () => { select([]); onActive(mainEditor) })
  const imagePlacement = useImagePlacement({ doc, editable, scale, tool, stage,
    onStart: () => { cancel(); segments.clear(); setActiveSegmentId(null); select([]); onActive(null); onToolChange(null) },
    onReady: (image, ratio) => onToolChange({ image, ratio }),
  })
  useLayoutEffect(() => { if (tool) { segments.clear(); setActiveSegmentId(null) } }, [tool])
  useLayoutEffect(() => {
    if (!projection.previews.length) {
      sourceContext.current = segments.context()
      if (!contextReady && anchors.length) setContextReady(true)
    }
  })
  function selectAISegment(id: string) {
    segments.clear(); select([]); onActive(null); setActiveSegmentId(id)
  }
  function segmentTask(id: string) {
    const owner = projection.owners.get(id)
    return aiReview?.tasks.find(task => task.target.kind === 'segment' && (task.id === owner || task.target.objectIds.includes(id)))
  }
  const segmentRanges = useMemo(() => {
    if (!mainEditor || !editable) return []
    const positions = [0]
    mainEditor.schema.nodeFromJSON(doc.content).forEach(node => positions.push(positions.at(-1)! + node.nodeSize))
    return (aiReview?.tasks ?? []).flatMap(task => {
      if (task.target.kind !== 'segment') return []
      const range = resolveSegmentRange(doc, task.target)
      if (!range) return []
      const empty = range.start.index === range.end.index && range.start.offset === range.end.offset
      return [{ taskId: task.id, from: positions[range.start.index], to: positions[range.end.index + (range.end.offset && !empty ? 1 : 0)],
        startOffset: range.start.offset, endOffset: range.end.offset || undefined }]
    })
  }, [doc, aiReview?.tasks, mainEditor, editable])
  const canvasReview = aiReview && { ...aiReview, activeSegmentId, selectSegment: selectAISegment, segmentPreviews: projection.previews, segmentRanges }

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
      const roots = inserting
      const bounds = inserting.map(object => extentBounds(boxes[object.id]))
      const top = Math.min(...bounds.map(box => box.y))
      const right = Math.max(...bounds.map(box => box.x + box.width))
      let delta = boundedTranslation(inserting, boxes, ids, { x: Math.min(0, pageWidth() - right), y: group.top === undefined ? 0 : group.top - top }, pageWidth())
      while ((roots.length ? roots : inserting).some(object => doc.objects.some(other => fullyOverlaps({ ...boxes[object.id], x: boxes[object.id].x + delta.x, y: boxes[object.id].y + delta.y }, boxes[other.id])))) delta = { ...delta, y: delta.y + 24 }
      const placed = applyPatches(inserting, shifted(inserting, boxes, ids, delta.x, delta.y))
      const next = { ...doc, objects: [...doc.objects, ...placed] }
      pasteGroup.current = null; setInserting([])
      if (!history.guard.current(doc, next)) { setClipboardNotice('Accept or discard the affected AI task before pasting.'); return }
      history.boundary(); history.setDoc(next); history.boundary()
      segments.clear(); select(ids); onActive(null); onToolChange(null); focusObject(ids[0])
      return
    }
    const occupied = doc.objects.map(object => measured.geometry[object.id])
    const placed = inserting.map(object => {
      const box = measured.geometry[object.id]
      const position = insertionPosition(box, occupied, pageWidth())
      occupied.push({ ...box, ...position })
      return patchObject(object, anchorPoint(position, measured.anchors))
    })
    history.boundary(); onFloatingChange([...doc.objects, ...placed]); setInserting([])
    select(placed.map(object => object.id)); onActive(null); onToolChange(null); focusObject(placed[0].id, placed[0].kind === 'text' || placed[0].kind === 'code')
    if (placed.length === 1 && placed[0].kind === 'drawing') onDrawingEdit?.(placed[0].id)
  }, [inserting, doc])

  const previousEdit = useRef({ ids: selectedIds, editable, revision: history.revision })
  useLayoutEffect(() => {
    const previous = previousEdit.current
    previousEdit.current = { ids: selectedIds, editable, revision: history.revision }
    if (previous.revision !== history.revision || !previous.editable) return
    const finished = previous.ids.filter(id => !editable || !selectedIds.includes(id))
    const empty = doc.objects.filter(object => !lockedIds.has(object.id) && finished.includes(object.id) && emptyContent(object)).map(object => object.id)
    if (empty.length) history.edit({ normalize: true }, () => onFloatingChange(withoutObjects(empty)))
  }, [selectedIds, editable, history.revision])

  const previousCaption = useRef<{ id: string | null; revision: number }>({ id: null, revision: history.revision })
  useLayoutEffect(() => {
    const previous = previousCaption.current
    previousCaption.current = { id: editable ? selectedCaptionId : null, revision: history.revision }
    if (previous.revision !== history.revision || !previous.id || editable && previous.id === selectedCaptionId) return
    const object = doc.objects.find(object => object.id === previous.id)
    if (object && supportsCaption(object) && object.caption && !lockedIds.has(object.id) && !contentText(object.caption.content)) {
      history.edit({ normalize: true }, () => onNoteChange(object.id, { caption: null }))
    }
  }, [selectedCaptionId, editable, history.revision])
  useLayoutEffect(() => {
    const object = doc.objects.find(object => object.id === selectedCaptionId)
    if (selectedCaptionId && (selectedIds.length !== 1 || selectedIds[0] !== selectedCaptionId || !object || !supportsCaption(object) || !object.caption)) {
      setSelectedCaptionId(null); onCaptionSelection?.(null)
    }
  }, [selectedIds, selectedCaptionId, doc.objects])

  function select(ids: string[], captionId: string | null = null) {
    setActiveSegmentId(null)
    setSelectedCaptionId(captionId); onCaptionSelection?.(captionId)
    onSelect(ids)
    setClipboardNotice('')
  }
  function insertionIndex() {
    const selected = segments.selection()
    if (selected) return selected.range.start.index
    if (!mainEditor) return doc.content.content?.length ?? 0
    const { $from } = mainEditor.state.selection
    return Math.min(mainEditor.state.doc.childCount, $from.index(0) + ($from.depth && $from.parent.content.size ? 1 : 0))
  }
  function commitDocument(next: MoteDocument) {
    if (!history.guard.current(doc, next)) { setClipboardNotice('Accept or discard the affected AI task before changing these objects.'); return false }
    history.boundary(); history.setDoc(next); history.boundary()
    return true
  }
  function insertObjects(objects: FloatingObject[]) {
    if (!editable) return
    if (!objects.some(object => object.layout.placement.type === 'flow')) { setInserting(current => [...current, ...objects]); return }
    if (commitDocument(insertDocumentObjects(doc, objects, insertionIndex()))) {
      select(objects.map(object => object.id)); onActive(null); onToolChange(null); focusObject(objects[0].id)
    }
  }
  function placement(mode: 'flow' | 'float') {
    const object = doc.objects.find(object => object.id === selectedIds[0])
    if (!editable || !object || lockedIds.has(object.id) || object.layout.placement.type === mode) return
    const target = segments.target(geometry[object.id].y)
    const next = convertObjectPlacement(doc, object.id, mode, { anchors, geometry, index: target.point.index,
      textLeft: doc.page.margins.left, textWidth: pageWidth() - doc.page.margins.left - doc.page.margins.right })
    onActive(null)
    if (commitDocument(next)) segments.clear()
  }
  function focusCaption(id: string, text = false) {
    requestAnimationFrame(() => sheet.current?.querySelector<HTMLElement>(`[data-note-id="${id}"] .object-caption${text ? ' .tiptap' : ''}`)?.focus({ preventScroll: true }))
  }
  function focusObject(id: string, text = false) {
    requestAnimationFrame(() => sheet.current?.querySelector<HTMLElement>(`[data-note-id="${id}"]${text ? ' :is(.tiptap, [data-code-source])' : ''}`)?.focus({ preventScroll: true }))
  }
  function cancel() {
    dragPointer.current = null; setFlowDrop(null)
    drag.current = null; setManipulating(false); setPreviews(previous => Object.keys(previous).length ? {} : previous); setCreating(null); setMarquee(null)
    const pointer = captured.current
    captured.current = null
    if (pointer?.element.hasPointerCapture(pointer.pointerId)) pointer.element.releasePointerCapture(pointer.pointerId)
  }
  useLayoutEffect(() => { cancel(); pasteGroup.current = null; setInserting([]); setClipboardNotice(''); onToolChange(null) }, [editable, scale, history.revision])
  useLayoutEffect(() => {
    const ids = selectedIds.filter(id => doc.objects.some(note => note.id === id))
    if (ids.length !== selectedIds.length) select(ids)
  }, [doc.objects])
  useLayoutEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || isComposingKey(event)) return
      if (drag.current) { event.preventDefault(); cancel() }
      onToolChange(null)
      if (stage.current?.contains(event.target as Node) && !drag.current && !event.defaultPrevented) {
        segments.clear(); select([]); onActive(null)
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      }
    }
    window.addEventListener('keydown', escape)
    window.addEventListener('blur', cancel)
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancel) }
  }, [onToolChange])

  function point(event: { clientX: number; clientY: number }): Point {
    const rect = sheet.current!.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / scale - sheet.current!.clientLeft, y: (event.clientY - rect.top) / scale - sheet.current!.clientTop }
  }
  function spaceAt(p: Point) {
    const rect = sheet.current!.getBoundingClientRect()
    return [...sheet.current!.querySelectorAll<HTMLElement>('.main-text [data-spacer]')].map(element => ({ element,
      x: 0, y: (element.getBoundingClientRect().top - rect.top) / scale - sheet.current!.clientTop, width: doc.page.width, height: element.getBoundingClientRect().height / scale,
    })).find(space => contains(space, p))
  }
  function snap(p: Point, alt: boolean): Point {
    return alt ? p : { x: Math.round(p.x / gridSize) * gridSize, y: Math.round(p.y / gridSize) * gridSize }
  }
  function pageWidth() {
    const style = getComputedStyle(sheet.current!)
    return doc.page.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
  }
  function boundedPoint(p: Point, width = 0, inset = 0): Point {
    return { x: Math.max(inset, Math.min(pageWidth() - width - inset, p.x)), y: Math.max(0, p.y) }
  }
  function boundedWidth(x: number, width: number, minimum: number, inset = 0) {
    return Math.max(0, Math.min(pageWidth() - x - inset, Math.max(minimum, width)))
  }
  function boundedObjectWidth(object: FloatingObject, box: Box, width: number) {
    const margins = object.layout.margins
    const left = margins?.left ?? 0, right = margins?.right ?? 0
    const minimum = object.layout.placement.type === 'flow' || object.kind === 'html' || object.kind === 'drawing' ? 16 : 120
    const maximum = object.layout.placement.type === 'flow'
      ? pageWidth() - doc.page.margins.left - doc.page.margins.right - ((object.layout.placement.x === 'center') ? left + right : Math.max(0, objectX(object)) + right)
      : pageWidth() - box.x - right
    return Math.max(Math.min(minimum, object.layout.width), Math.min(maximum, Math.max(minimum, width)))
  }
  function boundedResizePoint(position: Point, object: FloatingObject, north: boolean): Point {
    const margins = object.layout.margins
    const left = object.layout.placement.type === 'flow' ? doc.page.margins.left + (margins?.left ?? 0) : Math.max(0, margins?.left ?? 0)
    const right = object.layout.placement.type === 'flow' ? pageWidth() - doc.page.margins.right - (margins?.right ?? 0) : pageWidth() - Math.max(0, margins?.right ?? 0)
    const top = object.layout.placement.type === 'flow' || !north ? 0 : Math.max(0, margins?.top ?? 0)
    return { x: Math.max(left, Math.min(right, position.x)), y: Math.max(top, position.y) }
  }
  function capture(event: PointerEvent) {
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    captured.current = { element: event.currentTarget, pointerId: event.pointerId }
    setManipulating(true)
  }
  function insertionTarget(event: Pick<globalThis.PointerEvent, 'clientX' | 'clientY' | 'altKey'>) {
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    if (!hit || !stage.current?.contains(hit)) return null
    if ((tool === 'ai' && hit.closest('[data-segment-control]')) || (tool !== 'ai' && !event.altKey && (sheet.current?.contains(hit) || hit.closest('[data-segment-control]')))) {
      const boundary = segments.target(point(event).y, tool === 'ai' && event.altKey)
      return { position: { x: doc.page.margins.left, y: boundary.top }, boundary }
    }
    if (!sheet.current?.contains(hit)) return null
    return { position: boundedPoint(snap(point(event), tool === 'ai' && event.altKey), creationObject?.kind === 'image' ? 36 : 16, .5) }
  }
  function objectAt(position: Point, flow = false): FloatingObject {
    const width = Math.min(creationObject!.layout.width, flow ? pageWidth() - doc.page.margins.left - doc.page.margins.right : pageWidth() - position.x - .5)
    return patchObject(creationObject!, { placement: 'float', ...anchorPoint(position, anchors), width,
      ...(flow && { placement: 'flow', centered: true, anchorId: null, x: 0, y: 0 }) })
  }
  const refreshInsertion = useRef(() => {})
  refreshInsertion.current = () => {
    if (!editable || !creationObject || drag.current) return
    setInsertionHint(insertionPointer.current ? insertionTarget(insertionPointer.current) : null)
  }
  useLayoutEffect(() => {
    setInsertionHint(null)
    if (!editable || !creationObject) return
    insertionPointer.current = null
    refreshInsertion.current()
    const move = (event: globalThis.PointerEvent) => { insertionPointer.current = event; refreshInsertion.current() }
    const refresh = () => refreshInsertion.current()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Alt' && insertionPointer.current) { insertionPointer.current = { ...insertionPointer.current, clientX: insertionPointer.current.clientX, clientY: insertionPointer.current.clientY, altKey: event.altKey }; refresh() }
    }
    const blur = () => { insertionPointer.current = null; onToolChange(null) }
    window.addEventListener('pointermove', move)
    window.addEventListener('scroll', refresh, true)
    window.addEventListener('keydown', key); window.addEventListener('keyup', key)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('scroll', refresh, true)
      window.removeEventListener('keydown', key); window.removeEventListener('keyup', key)
      window.removeEventListener('blur', blur)
    }
  }, [editable, creationObject, scale, onToolChange])
  function insertAtBoundary(boundary: { point: SegmentPoint; top: number }) {
    if (tool === 'ai') {
      const id = onAISegmentCreate?.({ start: boundary.point, end: boundary.point }, { x: 0, y: boundary.top, width: pageWidth(), height: 0 })
      if (id) { select([]); onActive(null); setActiveSegmentId(id); onToolChange(null) }
      return
    }
    const object = objectAt({ x: doc.page.margins.left, y: boundary.top }, true)
    if (!commitDocument(insertDocumentObjects(doc, [object], boundary.point.index))) return
    segments.clear(); select([object.id]); onActive(null); onToolChange(null)
    focusObject(object.id, isText(object) || object.kind === 'code')
    if (object.kind === 'drawing') onDrawingEdit?.(object.id)
  }
  function begin(id: string, part: DragPart, event: PointerEvent, caption = false) {
    if (event.button !== 0) return
    const task = segmentTask(id)
    if (task) { event.preventDefault(); event.stopPropagation(); selectAISegment(task.id); return }
    const object = doc.objects.find(object => object.id === id)!
    if (sizeLocked(id) && part !== 'move' && part !== 'caption-width') { event.preventDefault(); event.stopPropagation(); return }
    capture(event)
    if (event.shiftKey && part === 'move') { const ids = selectedIds.includes(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id]; select(ids); onActive(null); if (ids.length) focusObject(ids.at(-1)!); return }
    const ids = caption || object.layout.placement.type === 'flow' || selectedIds.some(id => doc.objects.find(object => object.id === id)?.layout.placement.type === 'flow') ? [id]
      : selectedIds.includes(id) && part === 'move' ? selectedIds : [id]
    select(ids, caption ? id : null); onActive(null)
    if (caption) focusCaption(id); else focusObject(id)
    history.boundary()
    drag.current = { part, id, ids, start: point(event), objects: doc.objects, geometry, patches: {}, moved: false, additive: [] }
  }
  function blankDown(event: PointerEvent) {
    if (!editable || event.button !== 0) return
    if ((event.ctrlKey || event.metaKey) && (event.target as Element).closest('.text-content a[href]')) {
      event.stopPropagation()
      return
    }
    if (!tool && !imagePlacement.active && segments.begin(event)) return
    if (tail.begin(event)) { segments.clear(); setActiveSegmentId(null); return }
    if (tool === 'paragraph') { paragraphs.insert(event); return }
    if (creationObject) {
      event.preventDefault(); event.stopPropagation()
      const target = insertionTarget(event)
      if (!target || !event.isPrimary) return
      if (target.boundary) { insertAtBoundary(target.boundary); return }
      capture(event); segments.clear(); select([]); onActive(null); history.boundary()
      const start = target.position, note = objectAt(start)
      drag.current = { part: 'create', id: note.id, ids: [note.id], start, origin: point(event), objects: doc.objects, geometry, patches: {}, moved: false, additive: [], created: note }
      if (tool === 'ai') setCreating(note)
      return
    }
    segments.clear()
    const target = event.target as Element
    if (target.closest('[data-ai-controls], [data-ai-preview]')) return
    const reservedObject = target.closest<HTMLElement>('[data-note-id]')
    if (reservedObject && segmentTask(reservedObject.dataset.noteId!)) return
    if (target.closest('[data-ai-segment]')) return
    setActiveSegmentId(null)
    const inside = !!target.closest('.sheet')
    if (inside && spaces.begin(event)) return
    const objects = target.closest<HTMLElement>('.floating-note')
    if (objects && event.shiftKey) {
      capture(event)
      const id = objects.dataset.noteId!
      const ids = selectedIds.includes(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id]
      select(ids); onActive(null); if (ids.length) focusObject(ids.at(-1)!)
      return
    }
    if (objects) return
    const start = point(event), space = spaceAt(start)
    const gutter = !inside && (start.x < 0 || start.x > pageWidth())
    const padding = target.matches('.main-text, .sheet')
    if (space || gutter || padding) {
      capture(event)
      stage.current!.focus({ preventScroll: true })
      drag.current = { part: 'marquee', id: '', ids: [], start, objects: doc.objects, geometry, patches: {}, moved: false, additive: event.shiftKey ? selectedIds : [] }
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
      patches[object.id] = { x: box.x + dx, top: box.y + dy }
    }
    return patches
  }
  function move(event: PointerEvent) {
    const d = drag.current
    if (!d || captured.current?.pointerId !== event.pointerId) return
    dragPointer.current = { clientX: event.clientX, clientY: event.clientY, altKey: event.altKey, pointerId: event.pointerId }
    const p = point(event)
    if (!d.moved && distance(p, d.origin ?? d.start) * scale < 3) return
    if (!d.moved && d.part === 'marquee') onActive(null)
    d.moved = true
    if (d.part === 'marquee') {
      const box = rectangle(d.start, p)
      setMarquee(box)
      select([...new Set([...d.additive, ...d.objects.filter(object => d.geometry[object.id] && intersects(d.geometry[object.id], box)).map(object => object.id)])])
      return
    }
    const object = d.created ?? d.objects.find(object => object.id === d.id)!
    const box = d.geometry[d.id]
    let patch: FloatingPatch & { top?: number } = {}
    if (d.part === 'create') {
      if (['text', 'code', 'table', 'formula'].includes(object.kind)) {
        const end = boundedPoint(snap(p, false))
        const x = Math.min(d.start.x, end.x)
        patch = { x, top: d.start.y, width: boundedWidth(x, Math.abs(end.x - d.start.x), 120) }
      } else if (object.kind === 'image' && typeof tool === 'object' && tool) {
        const end = snap(p, false), west = end.x < d.start.x, north = end.y < d.start.y
        const inset = 18, ratio = tool.ratio
        const available = west ? d.start.x : pageWidth() - d.start.x
        const vertical = north ? Math.max(0, d.start.y - inset) * ratio + inset : Infinity
        const width = Math.min(available, vertical, Math.max(36, Math.abs(end.x - d.start.x), Math.max(0, Math.abs(end.y - d.start.y) - inset) * ratio + inset))
        const height = Math.max(0, width - inset) / ratio + inset
        patch = { x: west ? d.start.x - width : d.start.x, top: north ? d.start.y - height : d.start.y, width }
      } else {
        let end = boundedPoint(snap(p, tool === 'ai' && event.altKey), 0, .5)
        if (event.shiftKey) { const size = Math.min(Math.max(Math.abs(end.x - d.start.x), Math.abs(end.y - d.start.y)), end.x >= d.start.x ? pageWidth() - .5 - d.start.x : d.start.x - .5); end = { x: d.start.x + Math.sign(end.x - d.start.x || 1) * size, y: d.start.y + Math.sign(end.y - d.start.y || 1) * size } }
        const rect = rectangle(d.start, end)
        patch = { x: rect.x, top: Math.max(0, rect.y), width: boundedWidth(rect.x, rect.width, 16, .5), height: Math.max(16, rect.height) }
      }
    } else if (d.part === 'move') {
      if (object.layout.placement.type === 'flow') {
        const target = segments.target(p.y, event.altKey)
        const index = doc.content.content!.findIndex(node => node.attrs?.objectId === object.id)
        const reordering = target.point.index < index || target.point.index > index + 1
          || target.point.index === index + 1 && target.point.offset > 0
        d.destination = reordering ? target.point : undefined
        if (reordering) {
          d.patches = {}
          setPreviews(d.patches); setFlowDrop({ top: target.top, centered: false }); return
        }
        const left = doc.page.margins.left, available = pageWidth() - left - doc.page.margins.right
        const center = left + flowX(patchObject(object, { centered: true }), available)
        const minimum = left + (object.layout.margins?.left ?? 0)
        const maximum = left + available - object.layout.width - (object.layout.margins?.right ?? 0)
        let x = Math.max(minimum, Math.min(Math.max(minimum, maximum), box.x + p.x - d.start.x))
        x = box.x + boundedTranslation(d.objects, d.geometry, [object.id], { x: x - box.x, y: 0 }, pageWidth()).x
        const centered = !event.altKey && Math.abs(x - center) * scale <= 8
        if (centered) x = center
        d.patches = { [object.id]: { x, centered } }
        setPreviews(d.patches); setFlowDrop({ centered }); return
      }
      const footprint = layoutBounds(box)
      const placement = snap({ x: footprint.x + p.x - d.start.x, y: footprint.y + p.y - d.start.y }, event.altKey)
      const dx = Math.max(-Math.min(...d.ids.map(id => d.geometry[id].x)), placement.x - footprint.x)
      const dy = Math.max(-Math.min(...d.ids.map(id => d.geometry[id].y)), placement.y - footprint.y)
      d.patches = shifted(d.objects, d.geometry, d.ids, dx, dy)
      setPreviews(d.patches); return
    } else if (d.part === 'caption-width' && supportsCaption(object) && object.caption) {
      const width = object.caption.width ?? object.layout.width
      const edge = snap({ x: box.x + box.width / 2 + width / 2 + p.x - d.start.x, y: box.y }, event.altKey || object.layout.placement.type === 'flow')
      patch = { caption: { ...object.caption, width: boundedCaptionWidth(object, box, 2 * (edge.x - box.x - box.width / 2)) } }
    } else if (d.part === 'width') {
      const edge = snap({ x: box.x + box.width + p.x - d.start.x, y: box.y }, event.altKey || object.layout.placement.type === 'flow')
      patch = { width: boundedObjectWidth(object, box, edge.x - box.x) }
      if (object.kind === 'drawing') patch.height = object.layout.height * patch.width! / object.layout.width
    } else {
      const west = d.part.includes('w'), north = d.part.includes('n')
      const fixed = { x: west ? box.x + box.width : box.x, y: north ? box.y + (object.layout.height !== undefined ? object.layout.height : box.height) : box.y }
      const end = boundedResizePoint(snap(p, event.altKey || object.layout.placement.type === 'flow'), object, north)
      let width = Math.max(16, west ? fixed.x - end.x : end.x - fixed.x), height = Math.max(16, north ? fixed.y - end.y : end.y - fixed.y)
      const ratio = object.kind === 'drawing' ? object.layout.height / object.layout.width : 0
      if (ratio) width = Math.max(width, height / ratio)
      else if (event.shiftKey) width = height = Math.max(width, height)
      const marginLeft = object.layout.margins?.left ?? 0, marginRight = object.layout.margins?.right ?? 0
      width = Math.min(width, west ? Math.max(0, fixed.x - marginLeft) : Math.max(0, pageWidth() - fixed.x - marginRight))
      if (object.layout.placement.type === 'flow') width = Math.min(width, (object.layout.placement.x === 'center') ? pageWidth() - doc.page.margins.left - doc.page.margins.right - marginLeft - marginRight
        : west ? Math.max(16, fixed.x - doc.page.margins.left - marginLeft) : Math.max(16, pageWidth() - doc.page.margins.right - fixed.x - marginRight))
      width = Math.max(Math.min(16, object.layout.width), width)
      if (ratio) height = width * ratio
      else if (event.shiftKey) height = width
      patch = { x: west ? fixed.x - width : fixed.x, top: Math.max(0, north ? fixed.y - height : fixed.y), width, height }
      if (object.layout.placement.type === 'flow') { delete patch.top; if ((object.layout.placement.x === 'center')) delete patch.x }
    }
    if (d.part === 'create') setCreating(object)
    patch = constrainCaptionResize(object, patch, box, pageWidth())
    d.patches = { [object.id]: patch }; setPreviews(d.patches)
  }
  function applyPatches(objects: FloatingObject[], patches: FloatingPreviews) {
    return objects.map(object => {
      const patch = patches[object.id]
      if (!patch) return object
      const { top, ...saved } = patch
      if (object.layout.placement.type === 'flow') return patchFloating(object, { ...saved, ...(patch.x !== undefined && { x: patch.x - doc.page.margins.left }) })
      return patchFloating(object, { ...saved, ...(top !== undefined || patch.x !== undefined ? attach(object, { x: patch.x ?? geometry[object.id]?.x ?? objectX(object), top: top ?? geometry[object.id]?.y ?? objectY(object) }) : {}) })
    })
  }
  const movePointer = useRef(move)
  movePointer.current = move
  useLayoutEffect(() => {
    if (!manipulating) return
    let frame = 0
    const scroll = () => {
      const d = drag.current, pointer = dragPointer.current, viewport = stage.current
      if (d?.part === 'move' && d.objects.find(object => object.id === d.id)?.layout.placement.type === 'flow' && pointer && viewport) {
        const rect = viewport.getBoundingClientRect(), edge = 48
        const delta = pointer.clientY < rect.top + edge ? -Math.min(20, (rect.top + edge - pointer.clientY) / 3)
          : pointer.clientY > rect.bottom - edge ? Math.min(20, (pointer.clientY - rect.bottom + edge) / 3) : 0
        if (delta) { viewport.scrollTop += delta; movePointer.current(pointer as PointerEvent) }
      }
      frame = requestAnimationFrame(scroll)
    }
    frame = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(frame)
  }, [manipulating])
  function finish(event: PointerEvent) {
    const d = drag.current
    if (!d || captured.current?.pointerId !== event.pointerId) return
    if (d.part === 'marquee') {
      if (d.moved && selectedIds.length) focusObject(selectedIds[0])
    } else if (d.created) {
      if (!d.moved && tool !== 'ai') { cancel(); refreshInsertion.current(); return }
      const object = d.created
      const next = applyPatches([object], d.patches)[0]
      if (tool === 'ai') {
        const anchor = anchors.find(anchor => anchor.id === objectAnchorId(next))
        onAICreate?.(next, { x: (anchor?.left ?? 0) + objectX(next), y: (anchor?.top ?? 0) + objectY(next), width: next.layout.width, height: next.layout.height !== undefined ? next.layout.height : 220 })
        select([next.id]); onToolChange(null); cancel(); return
      }
      if (!commitDocument({ ...doc, objects: [...doc.objects, next] })) { cancel(); return }
      select([object.id]); onToolChange(null)
      focusObject(object.id, isText(object) || object.kind === 'code')
      if (next.kind === 'drawing') onDrawingEdit?.(next.id)
    } else if (d.moved) {
      const object = doc.objects.find(object => object.id === d.id)!
      if (object.layout.placement.type === 'flow' && d.part === 'move') {
        const index = doc.content.content!.findIndex(node => node.attrs?.objectId === object.id)
        const next = d.destination ? moveSegment(doc, { start: { index, offset: 0 }, end: { index: index + 1, offset: 0 } }, d.destination, segments.context().anchors, geometry).doc : doc
        commitDocument({ ...next, objects: applyPatches(next.objects, d.patches) })
      } else onFloatingChange(applyPatches(doc.objects, d.patches))
    }
    cancel()
    if (sheet.current?.hasPointerCapture(event.pointerId)) sheet.current.releasePointerCapture(event.pointerId)
  }
  function withoutObjects(ids: string[]) {
    return reconcileObjectDeletions(doc, doc.objects.filter(object => !ids.includes(object.id)), { anchors, geometry }).objects
  }
  function remove() {
    if (!editable || !selectedIds.length) return
    const next = withoutObjects(selectedIds)
    if (onDeleteObjects) { if (!onDeleteObjects(next)) return }
    else { if (selectedIds.some(id => lockedIds.has(id))) return; history.boundary(); onFloatingChange(next) }
    select([]); onActive(null)
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
        if (selectedCaptionId) {
          const object = doc.objects.find(object => object.id === selectedCaptionId)!
          if (lockedIds.has(object.id)) throw new Error('Accept or discard the AI task before copying this caption.')
          if (!supportsCaption(object) || !object.caption) return
          const node = object.caption.content.content![0]
          const payload = copyParagraphs(doc, [{ ...node, attrs: { ...node.attrs, semantic: 'caption' } }])
          const carrier = document.createElement('div')
          carrier.dataset.moteParagraphs = JSON.stringify(payload)
          carrier.innerHTML = sheet.current!.querySelector(`[data-note-id="${object.id}"] .object-caption .tiptap`)!.innerHTML
          event.clipboardData.setData(PARAGRAPH_MIME, JSON.stringify(payload))
          event.clipboardData.setData('text/html', carrier.outerHTML)
          event.clipboardData.setData('text/plain', (node.content ?? []).map(node => node.type === 'hardBreak' ? '\n' : node.text ?? '').join(''))
          if (event.type === 'cut') removeCaption(object.id)
          return
        }
        const ids = floatingCopyIds(doc.objects, selectedIds, doc.content)
        if ([...ids].some(id => lockedIds.has(id))) throw new Error('Accept or discard the selected AI task before copying or cutting these elements.')
        const payload = copyFloating(doc, ids, geometry), json = JSON.stringify(payload)
        parseFloating(json)
        const next = event.type === 'cut' ? reconcileObjectDeletions(doc, withoutObjects([...ids]), { anchors, geometry }) : null
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
        if (imported.content.length) {
          const next = insertDocumentObjects(doc, imported.objects, insertionIndex(), imported.content)
          if (commitDocument(next)) { cancel(); segments.clear(); select(imported.objects.map(object => object.id)); onActive(null); onToolChange(null); focusObject(imported.objects[0].id) }
          return
        }
        const caret = mainEditor?.isFocused ? mainEditor.view.coordsAtPos(mainEditor.state.selection.from) : null
        const top = caret ? point({ clientX: caret.left, clientY: caret.top }).y : undefined
        cancel(); segments.clear(); onToolChange(null)
        pasteGroup.current = { doc, top }
        setInserting(imported.objects)
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
    if (doc.objects.some(object => selectedIds.includes(object.id) && object.layout.placement.type === 'flow')) {
      const ids = floatingCopyIds(doc.objects, selectedIds, doc.content)
      const imported = importFloating(doc, copyFloating(doc, ids, geometry), anchors)
      const index = Math.max(...doc.content.content!.map((node, index) => ids.has(node.attrs?.objectId) ? index + 1 : 0))
      const next = insertDocumentObjects(doc, imported.objects, index, imported.content)
      if (commitDocument(next)) { select(imported.objects.map(object => object.id)); onActive(null); focusObject(imported.objects[0].id) }
      return
    }
    const originals = doc.objects.filter(object => !emptyContent(object) && selectedIds.includes(object.id))
    if (!originals.length) return
    const mapping = new Map(originals.map(object => [object.id, crypto.randomUUID()]))
    const ids = originals.map(object => object.id)
    let delta = boundedTranslation(doc.objects, geometry, ids, { x: 16, y: 16 }, pageWidth())
    const roots = originals
    while (roots.some(object => doc.objects.some(other => fullyOverlaps({ ...geometry[object.id], x: geometry[object.id].x + delta.x, y: geometry[object.id].y + delta.y }, geometry[other.id])))) delta = { ...delta, y: delta.y + 24 }
    const patches = shifted(doc.objects, geometry, ids, delta.x, delta.y)
    const copies = applyPatches(originals, patches).map(original => {
      const object = structuredClone(original)
      if ('content' in object) object.content = freshNode(object.content, new Set())
      object.id = mapping.get(original.id)!
      if (supportsCaption(object) && object.caption) object.caption.content = freshNode(object.caption.content, new Set())
      return object
    })
    history.boundary(); onFloatingChange([...doc.objects, ...copies]); select(copies.map(object => object.id)); onActive(null)
  }
  function boundedCaptionWidth(object: FloatingObject, box: Box, width: number) {
    const center = box.x + object.layout.width / 2
    const left = center - (object.layout.margins?.left ?? 0), right = pageWidth() - center - (object.layout.margins?.right ?? 0)
    return Math.max(1, Math.min(Math.max(16, width), 2 * Math.max(0, Math.min(left, right))))
  }
  function captionWidth(width: number | null) {
    const object = doc.objects.find(object => object.id === selectedIds[0])
    if (!editable || !object || !supportsCaption(object) || !object.caption || segmentTask(object.id)) return
    const caption = { ...object.caption }
    if (width === null) delete caption.width
    else caption.width = boundedCaptionWidth(object, geometry[object.id], width)
    onNoteChange(object.id, { caption })
  }
  function removeCaption(id: string) {
    if (lockedIds.has(id)) return
    history.boundary(); onNoteChange(id, { caption: null }); history.boundary()
    select([id]); onActive(null); focusObject(id)
  }
  function caption(id = selectedIds[0]) {
    const target = doc.objects.find(object => object.id === id)
    if (!editable || !target || !supportsCaption(target) || lockedIds.has(id)) return
    if (!target.caption) { history.boundary(); onNoteChange(id, { caption: { content: captionContent() } }); history.boundary() }
    select([id], id); onActive(null)
    focusCaption(id, true)
  }
  useLayoutEffect(() => { onActions({ remove, duplicate, caption, captionWidth, selectOwner: () => { const id = selectedIds[0]; select(selectedIds); onActive(null); if (id) focusObject(id) }, placement, without: withoutObjects, insert: insertObjects,
    clearSelection: () => {
      cancel(); segments.clear(); setActiveSegmentId(null); select([])
      const focused = document.activeElement
      if (focused instanceof HTMLElement && stage.current?.contains(focused)) focused.blur()
      const selection = window.getSelection()
      if (selection?.anchorNode && stage.current?.contains(selection.anchorNode)) selection.removeAllRanges()
    },
    segmentSelection: segments.selection,
    segmentContext: () => candidates.length ? measuredSource?.doc === doc ? measuredSource.context : undefined : segments.context(),
    locateSegment: id => {
      selectAISegment(id)
      requestAnimationFrame(() => {
        const element = sheet.current?.querySelector<HTMLElement>(`[data-ai-segment-owner="${id}"], [data-ai-segment-tasks~="${id}"], [data-ai-segment="${id}"]`)
        const target = element?.firstElementChild instanceof HTMLElement ? element.firstElementChild : element
        target?.scrollIntoView({ block: 'center', inline: 'nearest' }); target?.focus({ preventScroll: true })
      })
    },
  }) })
  function key(id: string, event: React.KeyboardEvent, captionSelected = false) {
    if (!editable || isComposingKey(event.nativeEvent)) return
    const task = segmentTask(id)
    if (task) {
      if (captionSelected) return
      if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); aiReview?.deleteTarget?.(task.id) }
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (captionSelected) removeCaption(id); else remove(); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (captionSelected) { if (!lockedIds.has(id)) focusCaption(id, true); return }
      if (doc.objects.find(object => object.id === id)?.kind === 'drawing' && !lockedIds.has(id)) { onDrawingEdit?.(id); return }
      if ((isText(doc.objects.find(object => object.id === id)!) || doc.objects.find(object => object.id === id)?.kind === 'code') && !lockedIds.has(id)) { select([id]); focusObject(id, true) }
      else caption(id)
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return }
    const directions: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
    const direction = directions[event.key]
    if (!direction) return
    event.preventDefault()
    const step = event.shiftKey ? 1 : event.altKey ? 8 : gridSize
    const part = (event.target as HTMLElement).dataset.floatingControl
    if ((event.target as HTMLElement).hasAttribute('data-caption-control')) {
      if (direction.x && !segmentTask(id)) {
        const object = doc.objects.find(object => object.id === id)!
        if (supportsCaption(object) && object.caption) onNoteChange(id, { caption: { ...object.caption, width: boundedCaptionWidth(object, geometry[id], (object.caption.width ?? object.layout.width) + direction.x * step * 2) } })
      }
      return
    }
    if (sizeLocked(id) && part) return
    const object = doc.objects.find(object => object.id === id)!
    const width = (next: number) => boundedObjectWidth(object, geometry[id], next)
    if (part === 'width' || part && object.kind === 'drawing') {
      onNoteChange(id, constrainCaptionResize(object, { width: width(object.layout.width + (direction.x || direction.y) * step) }, geometry[id], pageWidth())); return
    }
    if (part && object.kind === 'html') {
      onNoteChange(id, constrainCaptionResize(object, { width: width(object.layout.width + direction.x * step), height: Math.max(16, object.layout.height + direction.y * step) }, geometry[id], pageWidth())); return
    }
    if (object.layout.placement.type === 'flow') {
      if (direction.x) {
        const available = pageWidth() - doc.page.margins.left - doc.page.margins.right
        const box = geometry[id]
        const minimum = doc.page.margins.left + (object.layout.margins?.left ?? 0)
        const maximum = doc.page.margins.left + available - object.layout.width - (object.layout.margins?.right ?? 0)
        const desired = Math.max(minimum, Math.min(Math.max(minimum, maximum), box.x + direction.x * (event.shiftKey ? 10 : 1)))
        onNoteChange(id, { x: box.x - doc.page.margins.left + boundedTranslation(doc.objects, geometry, [id], { x: desired - box.x, y: 0 }, pageWidth()).x, centered: false })
      } else {
        const index = doc.content.content!.findIndex(node => node.attrs?.objectId === id)
        const destination = Math.max(0, Math.min(doc.content.content!.length, index + (direction.y < 0 ? -1 : 2)))
        commitDocument(moveSegment(doc, { start: { index, offset: 0 }, end: { index: index + 1, offset: 0 } }, { index: destination, offset: 0 }, segments.context().anchors, geometry).doc)
      }
      return
    }
    const ids = selectedIds.includes(id) ? selectedIds : [id]
    const patches = shifted(doc.objects, geometry, ids, direction.x * step, direction.y * step)
    onFloatingChange(applyPatches(doc.objects, patches))
  }

  function sizeLocked(id: string) {
    return lockedIds.has(id) && !aiReview?.tasks.some(task => task.target.kind === 'object' && task.target.objectId === id && canResizeReservation(task))
  }

  function interact(event: React.SyntheticEvent) {
    // Zoom controls are portaled into the header, outside the document surface.
    if (!editable || !event.currentTarget.contains(event.target as Node)) return
    onInteraction?.(event)
  }

  function handleContextMenu(event: React.MouseEvent) {
    if (!editable || !onContextMenu) return
    if (event.shiftKey) return // native bypass
    const target = event.target as Element
    // Protect native contexts
    if (target.closest('input,textarea,select,button,a[href],.code-view,iframe')) return
    // Only a context-click on highlighted text belongs to the native Copy menu.
    const sel = window.getSelection()
    const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null
    if (range && sheet.current?.contains(range.commonAncestorContainer) && range.intersectsNode(target) &&
      [...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) return
    event.preventDefault()
    onContextMenu({ x: event.clientX, y: event.clientY })
  }

  function renderObject(original: FloatingObject, inFlow = false) {
          const { top: _top, ...preview } = previews[original.id] ?? {}
          const note = patchFloating(original, preview)
          const box = geometry[note.id] ?? { x: objectX(note), y: previews[note.id]?.top ?? objectY(note), width: note.layout.width, height: note.layout.height !== undefined ? note.layout.height : 24,
            ...(note.layout.margins && { margins: note.layout.margins }) }
          const segment = segmentTask(note.id)
          return <FloatingObjectView key={note.id} note={note} inFlow={inFlow} geometry={inFlow ? { ...box, x: box.x - doc.page.margins.left } : box} editable={editable} locked={lockedIds.has(note.id) || !!segment} sizeLocked={sizeLocked(note.id) || !!segment} selected={segment ? activeSegmentId === segment.id : selectedIds.includes(note.id) || creating?.id === note.id}
            captionSelected={selectedIds.length === 1 && selectedCaptionId === note.id} captionResizable={!segment}
            contentActive={segment ? activeSegmentId === segment.id && note.kind === 'html' : selectedIds.length === 1 && selectedIds[0] === note.id && !manipulating}
            aiTask={editable ? segment ?? aiReview?.tasks.find(task => task.target.kind === 'object' && task.target.objectId === note.id) : undefined}
            restoreWidgetRevision={aiWidgetIds?.has(note.id) ? history.revision : undefined}
            defaultFontSize={doc.theme.defaults.size} widgetRun={widgetRuns[note.id] ?? 0} staticWidgets={staticWidgets || original.id === creating?.id} order={layoutDoc.objects.indexOf(original)}
            onBegin={(part, event, caption) => begin(note.id, part, event, caption)} onActive={(editor, caption = false) => {
              if (segment) { selectAISegment(segment.id); return }
              if (drag.current) return
              if (editor || caption || selectedIds.length <= 1 || !selectedIds.includes(note.id)) select([note.id], caption ? note.id : null)
              onActive(editor)
            }}
            onChange={patch => onNoteChange(note.id, patch)} onCaption={() => caption(note.id)} onDrawingEdit={() => onDrawingEdit?.(note.id)} onKey={(event, caption) => key(note.id, event, caption)} />
  }

  const zoomControl = <div className="zoom-level">
    <select aria-label="Document zoom level" title={editable ? automatic ? 'Auto zoom' : 'Zoom' : 'Zoom document · You can also pinch to zoom'} value={String(scale)} onChange={event => event.target.value === 'auto' ? reset() : event.target.value === 'fit' ? fit() : zoomTo(Number(event.target.value))}>
      <option value="auto">Auto</option>
      {!zoomPresets.includes(scale) && <option value={String(scale)} hidden>{Math.round(scale * 100)}%</option>}
      {!editable && <option value="fit">Fit</option>}
      {zoomPresets.map(value => <option key={value} value={String(value)}>{value * 100}%</option>)}
    </select>
    <PanelIcon name="chevron" />
  </div>

  return <div className={`canvas-pane ${minimap ? 'has-minimap' : ''} ${editable ? '' : 'reading-canvas'}`}
    onPointerDownCapture={interact} onFocusCapture={interact} onKeyDownCapture={interact}
    onClickCapture={event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('.text-content a[href]')
      if (!editable || !link) return
      event.preventDefault()
      if ((event.ctrlKey || event.metaKey) && validLinkHref(link.getAttribute('href'))) {
        event.stopPropagation()
        window.open(link.href, '_blank', 'noopener,noreferrer')
      }
    }}
    onDropCapture={interact}
    style={{ '--page-background': pageColor(doc.theme) } as React.CSSProperties}>
    <div className={`stage${segments.marginHover ? ' has-segment-margin-hover' : ''}`} ref={stage} id={canvasId} tabIndex={-1} aria-label="Document canvas" onContextMenu={handleContextMenu} onPointerDownCapture={blankDown}
      onPointerMoveCapture={event => segments.hover(!tool && !imagePlacement.active ? event : null)} onPointerLeave={() => segments.hover(null)}
      onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <div className="canvas-scroll-floor" ref={scrollFloor.container}>
      <div className="sheet-footprint" ref={footprint} style={{
        width: editable ? doc.page.width * scale : `clamp(${(doc.page.width - sideSpace) * scale}px, 100%, ${doc.page.width * scale}px)`,
        '--scaled-page-width': `${doc.page.width * scale}px`, '--crop-left': sideSpace ? sideInsets.left / sideSpace : 0,
        height: `calc(var(--page-height, 0px) * ${scale})`,
      } as React.CSSProperties}>
      <div className={`sheet ${editable ? 'is-editing' : 'is-reading'} ${selectedIds.length ? 'has-selected-note' : ''} ${editable && ((creationObject && insertionHint && !insertionHint.boundary) || creating || Object.keys(previews).some(id => doc.objects.find(object => object.id === id)?.layout.placement.type !== 'flow')) ? 'show-floating-grid' : ''} ${tool || imagePlacement.active ? 'has-creation-tool' : ''} ${active ? 'is-floating-dragging' : ''} ${spaces.hint ? 'can-resize-space' : ''} ${spaces.hint?.dragging ? 'is-space-dragging' : ''}`}
        ref={sheet} lang={doc.language ?? 'en'} data-mode={doc.theme.appearance.mode} data-floating-preview={active ? '' : undefined}
        onLoadCapture={event => { if (inserting.some(object => object.id === (event.target as Element).closest<HTMLElement>('[data-note-id]')?.dataset.noteId)) setInserting(current => [...current]) }}
        onDragOverCapture={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = editable ? 'copy' : 'none' } }}
        onDropCapture={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault(); event.stopPropagation()
          if (editable) onDropImages?.([...event.dataTransfer.files], anchorPoint(boundedPoint(point(event)), anchors))
        }}
        style={{ ...themeVariables(layoutDoc.theme, doc.language ?? 'en'), '--canvas-ui-layer': layoutDoc.objects.length + 1, '--margin-top': `${doc.page.margins.top}px`, '--margin-right': `${doc.page.margins.right}px`, '--margin-bottom': `${doc.page.margins.bottom}px`, '--margin-left': `${doc.page.margins.left}px`, width: doc.page.width, transform: `scale(${scale})`, minHeight } as React.CSSProperties}>
        <div className="main-text">
          <TextEditor content={doc.content} editable={editable} spatial label="Main text" historyId="main" onChange={onMainChange} aiReview={canvasReview}
            onReady={editor => { setMainEditor(editor); onMainReady(editor) }} onActive={editor => { if (!drag.current) select([]); onActive(editor) }} />
        </div>
        {tail.hint !== null && <div className="document-tail-hint" aria-hidden="true" style={{ top: tail.hint, left: doc.page.margins.left }}>Continue writing…</div>}
        {editable && spaces.hint && <div className={`space-hint ${spaces.hint.dragging ? 'is-dragging' : ''}`} aria-hidden="true"
          style={{ top: spaces.hint.top + (spaces.hint.dragging ? spaces.hint.height : 0) }}>
          {spaces.hint.dragging ? spaces.hint.height < spaceRemovalThreshold ? 'Release to remove' : `${Math.round(spaces.hint.height)}px` : !spaces.hint.existing ? '↕' : null}
        </div>}
        {/* Stable DOM order keeps iframe browsing contexts alive when stacking changes. */}
        {layoutDoc.objects.toSorted((a, b) => a.id.localeCompare(b.id)).map(original => {
          if (original.layout.placement.type === 'flow') {
            const mount = flowMounts[original.id]
            if (!mount) return null
            return createPortal(renderObject(original, true), mount, original.id)
          }
          return renderObject(original)
        })}
        {editable && canvasReview?.tasks.map(task => {
          if (task.target.kind !== 'object' || !selectedIds.includes(task.target.objectId)) return null
          const box = geometry[task.target.objectId]
          if (!box) return null
          return <ReviewControls key={task.id} task={task} review={canvasReview}
            style={{ left: Math.max(0, Math.min(box.x, pageWidth() - 300)), top: box.y + box.height, maxWidth: pageWidth() }} />
        })}
        {editable && projection.previews.length > 0 && <SegmentPreviewBorders sheet={sheet} previews={projection.previews}
          owners={projection.owners} geometry={geometry} activeId={activeSegmentId} />}
        {editable && marquee && <div className="marquee-selection" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
      </div>
      {/* Outside the sheet so layout measurement, minimaps, and exports never see it. */}
      {editable && creationObject && insertionHint && !creating && (tool === 'ai' ? !insertionHint.boundary : !!insertionHint.boundary) && <div className="object-insertion-preview is-editing" aria-hidden="true" inert data-mode={doc.theme.appearance.mode}
        style={{ ...themeVariables(doc.theme, doc.language ?? 'en'), width: doc.page.width, transform: `scale(${scale})` } as React.CSSProperties}>
        {(() => {
          const flow = !!insertionHint.boundary, object = objectAt(insertionHint.position, flow)
          const x = flow ? doc.page.margins.left + flowX(patchObject(object, { centered: true }), pageWidth() - doc.page.margins.left - doc.page.margins.right) : insertionHint.position.x
          return <FloatingObjectView note={object} geometry={{ x, y: insertionHint.position.y, width: object.layout.width, height: object.layout.height !== undefined ? object.layout.height : 24,
            ...(object.layout.margins && { margins: object.layout.margins }) }}
            editable staticWidgets selected={false} contentActive={false} defaultFontSize={doc.theme.defaults.size} widgetRun={0} order={0}
            onBegin={() => {}} onActive={() => {}} onChange={() => {}} onCaption={() => {}} onKey={() => {}} />
        })()}
      </div>}
      {segments.overlay}
      {editable && creationObject && insertionHint?.boundary && !creating && <div className="segment-layer creation-guides" aria-hidden="true"><div className="segment-drop" style={{ top: (insertionHint.boundary.top + (sheet.current?.clientTop ?? 0)) * scale }}><span>{tool === 'ai' ? 'Reserve AI section' : 'Insert Flow'}</span></div></div>}
      {flowDrop && <div className="segment-layer flow-drag-guides" aria-hidden="true">
        {flowDrop.top !== undefined && <div className="segment-drop" style={{ top: (flowDrop.top + (sheet.current?.clientTop ?? 0)) * scale }}><span>Move Flow here</span></div>}
        {flowDrop.centered && <div className="flow-center-guide" style={{ left: (doc.page.margins.left + (pageWidth() - doc.page.margins.left - doc.page.margins.right) / 2 + 1) * scale }} />}
      </div>}
      {paragraphs.hint && <div className="segment-layer" aria-hidden="true"><div className="segment-drop" style={{ top: (paragraphs.hint.top + (sheet.current?.clientTop ?? 0)) * scale }}><span>Insert paragraph</span></div></div>}
      </div>
      </div>
    </div>
    {editable && aiReview?.tasks.some(task => task.target.kind === 'segment') && <OriginalGeometry doc={doc} onMeasure={(source, context) => {
      const signature = JSON.stringify(context)
      setMeasuredSource(previous => previous?.doc === source && previous.signature === signature ? previous : { doc: source, context, signature })
    }} />}
    {(clipboardNotice || segments.notice) && <p className="segment-notice" role="status">{clipboardNotice || segments.notice}</p>}
    {imagePlacement.notice && <p className="segment-notice" role="status">{imagePlacement.notice}</p>}
    {editable && creationObject && !clipboardNotice && !segments.notice && !imagePlacement.notice && <p className="segment-notice" role="status">{tool === 'ai' ? 'Click or drag to reserve an AI object · Gutter: reserve AI section · Esc cancels' : 'Click to insert Flow · Alt-drag to create Float · Esc cancels'}</p>}
    {editable && tool === 'paragraph' && <p className="segment-notice" role="status">Click a boundary to insert a paragraph. Escape cancels.</p>}
    {minimap && <Minimap stage={stage} sheet={sheet} canvasId={canvasId} sizing={minimapSize} />}
    {editable && zoomHost && createPortal(zoomControl, zoomHost)}
    {!editable && !staticWidgets && <div className="reading-zoom">{zoomControl}</div>}
  </div>
}
