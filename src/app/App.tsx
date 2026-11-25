import { objectAnchorId } from '../document/model'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { Command } from '@tiptap/pm/state'
import { isInTable, selectedRect } from '@tiptap/pm/tables'
import { DocumentCanvas, type CanvasActions, type CreationTool } from '../canvas/DocumentCanvas'
import { replaceMainContent, type FloatingImage, type FloatingObject, type FloatingPatch, type MoteDocument } from '../document/model'
import { columnAlignment } from '../editor/table'
import { readImage } from '../document/image'
import { useWidgetScreenshot } from './useWidgetScreenshot'
import { CloudWorkspace, loginURL } from '../cloud/CloudWorkspace'
import { WorkingCopy } from '../cloud/WorkingCopy'
import { connectionSnapshot, retryConnection, useConnection } from '../cloud/connection'
import { subscribeDocumentUpdates, useDocumentStream } from '../cloud/documentEvents'
import { ShareWindow } from '../cloud/ShareWindow'
import { deleteWorkingCopy } from '../cloud/workingCopies'
import { ThemePanel, type ThemeClass } from '../theme/ThemePanel'
import { GlobalSettings, useViewSettings } from './GlobalSettings'
import { DocumentSettings } from './DocumentSettings'
import { HistoryContext, useDocumentHistory } from '../document/history'
import { useRecentColors } from './useRecentColors'
import { FloatingInspector, ObjectEditingHelp } from './FloatingInspector'
import { DrawingEditor } from './DrawingEditor'
import { ReservationMarkupEditor } from '../ai/ReservationMarkupEditor'
import { patchFloating } from '../canvas/patchFloating'
import { constrainCaptionResize, extentBounds } from '../canvas/floatingGeometry'
import { reconcileObjectDeletions } from '../document/flow'
import { WorkspaceSettings } from '../cloud/WorkspaceSettings'
import { PanelIcon } from './PanelIcon'
import { useMedia } from './useMedia'
import { isComposingKey } from '../editor/composition'
import { isCaptionEditor } from '../editor/extensions'
import { ContextHeading, ParagraphHelp, TableControls, TextInspector, TextToolsRow } from './Inspector'
import './embeds.css'
import { useAssistant } from '../ai/useAssistant'
import { selectedCandidateVersion } from '../ai/candidates'
import { AssistantHelp, AssistantPanel, type ReservationSelection } from '../ai/AssistantPanel'
import type { Area, AITarget, AITask } from '../ai/types'
import { containsTarget, overlaps, paragraphSelection } from '../ai/reservations'
import { makeSegmentTarget } from '../ai/segments'
import { recordSpaceEdit, type SegmentRange } from '../document/segment'
import { uiThemeVariables } from '../theme/ui'
import { Launchpad, type LaunchpadTool } from './Launchpad'
import { DocumentNotes } from './DocumentNotes'
import { ReaderPage } from '../reader/ReaderPage'
import { usePreview } from '../reader/usePreview'

export function App() {
  return <CloudWorkspace renderDocument={(copy, onFiles, onOpen) => <DraftSession key={copy.getSnapshot().record.key} copy={copy} onFiles={onFiles} onOpen={onOpen} />} />
}

interface CloudEditorProps { copy: WorkingCopy; onFiles: () => void; onOpen: (id: string) => void }
function DraftSession({ copy, onFiles, onOpen }: CloudEditorProps) {
  const state = useSyncExternalStore(copy.subscribe, copy.getSnapshot)
  useDocumentStream(state.record.meta.id, !state.record.draft && !state.deleted && !state.auth)
  return <DraftApp key={state.epoch} initial={state.record.document} copy={copy} onFiles={onFiles} onOpen={onOpen} />
}

function PopupDialog({ id, open, onClose, title, children }: { id?: string; open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (open) ref.current?.showModal()
    else ref.current?.close()
  }, [open])
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const handler = () => onClose()
    dialog.addEventListener('close', handler)
    return () => dialog.removeEventListener('close', handler)
  }, [onClose])
  return <dialog ref={ref} id={id} className="settings-dialog" aria-label={title} onClick={e => { if (e.target === ref.current) onClose() }}>
    <div className="settings-dialog-inner">
      <div className="settings-dialog-header">
        <h2>{title}</h2>
        <div className="settings-dialog-actions"><button aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>×</button></div>
      </div>
      {children}
    </div>
  </dialog>
}

function DraftApp({ initial, copy, onFiles, onOpen }: CloudEditorProps & { initial: MoteDocument }) {
  const history = useDocumentHistory(initial, copy.getSnapshot().record.reservations ?? [])
  const { doc, setDoc } = history
  const cloud = useSyncExternalStore(copy.subscribe, copy.getSnapshot)
  const [slowLocalSave, setSlowLocalSave] = useState(false)
  useEffect(() => {
    if (cloud.local !== 'saving') { setSlowLocalSave(false); return }
    const timer = window.setTimeout(() => setSlowLocalSave(true), 500)
    return () => window.clearTimeout(timer)
  }, [cloud.local])
  const showLocalSaving = cloud.local === 'saving' && slowLocalSave
  const connection = useConnection()
  const [shareOpen, setShareOpen] = useState(false)
  const privateDocument = cloud.record.meta.private
  const creatingPrivate = cloud.record.pendingCreate?.private === true
  const sharingBlocked = privateDocument || creatingPrivate || cloud.privacy.pending?.private === true
  const recentColors = useRecentColors(doc?.id ?? initial.id)
  const uiStyle = useMemo(() => doc ? uiThemeVariables(doc.theme, doc.language ?? 'en') : undefined, [doc?.theme, doc?.language])
  const actions = useRef<CanvasActions | null>(null)
  const assistant = useAssistant(history, true, id => actions.current?.without([id]),
    id => measuredArea(document.querySelector(`.workspace [data-note-id="${id}"]`)), () => actions.current?.segmentContext(),
    { documentId: cloud.record.meta.id, sync: () => copy.sync(true), earlySync: copy.requestEarlySync, revision: cloud.record.meta.revision, workingCopyId: cloud.record.key,
      localSaved: cloud.local === 'saved' && cloud.record.document === doc && cloud.record.reservations === history.reservations,
      privateDocument, externalBlocked: sharingBlocked, draft: cloud.record.draft })
  useLayoutEffect(() => {
    copy.preserveAssistant = assistant.flushLocal
    return () => { copy.preserveAssistant = undefined }
  }, [copy, assistant.flushLocal])
  const latest = useRef(doc)
  latest.current = doc
  const preview = usePreview()
  const mobile = useMedia('(max-width: 767px)')
  const smallScreen = useMedia('(max-width: 1050px)')
  const editable = assistant.loaded && !mobile
  const screenshot = useWidgetScreenshot(history, editable, assistant.lockedIds)
  const { settings, update: updateSettings, saveError: settingsSaveError } = useViewSettings(['minimap', 'minimapSize', 'formattingMarks', 'verticalSpacers'])
  const [settingsDialog, setSettingsDialog] = useState<'settings' | 'theme' | null>(null)
  const settingsOpen = settingsDialog === 'settings'
  const themeOpen = settingsDialog === 'theme'
  const [settingsSection, setSettingsSection] = useState<'document' | 'workspace' | 'browser'>('document')
  const [themeClass, setThemeClass] = useState<ThemeClass>('defaults')
  // The shell and canvas keep editing geometry while recovery gates editing permissions.
  const showInspector = !mobile
  const showMinimap = settings.minimap === 'show' || (settings.minimap === 'auto' && !smallScreen)
  const [mainEditor, setMainEditor] = useState<Editor | null>(null)
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null)
  const [zoomHost, setZoomHost] = useState<HTMLDivElement | null>(null)
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedSegment, setSelectedSegment] = useState<{ range: SegmentRange | null; taskId: string | null }>({ range: null, taskId: null })
  const [tool, setTool] = useState<CreationTool>(null)
  const [widgetRuns, setWidgetRuns] = useState<Record<string, number>>({})
  const [launchpadPoint, setLaunchpadPoint] = useState<{ x: number; y: number } | null>(null)
  const [launchpadAnchor, setLaunchpadAnchor] = useState<{ x: number; y: number } | null>(null)
  const selectedObject = doc?.objects.find(object => object.id === selectedIds[0])
  const selectedObjectTask = selectedIds.length === 1 && selectedObject
    ? assistant.tasks.find(task => task.target.kind === 'object' && task.target.objectId === selectedObject.id)
    : undefined
  const [drawingId, setDrawingId] = useState<string | null>(null)
  const drawing = doc?.objects.find(object => object.id === drawingId)
  const [markupId, setMarkupId] = useState<string | null>(null)
  const markupTask = assistant.tasks.find(task => task.id === markupId)
  const imageInput = useRef<HTMLInputElement>(null)
  const imageTarget = useRef<{ documentId: string; anchorId: string | null; objectId?: string } | null>(null)
  const [imageError, setImageError] = useState('')
  const [imageLoading, setImageLoading] = useState(false)
  const workspace = useRef<HTMLElement>(null)

  useEffect(() => {
    if (drawingId && (!editable || drawing?.kind !== 'drawing' || assistant.lockedIds.has(drawingId))) setDrawingId(null)
  }, [drawingId, drawing, editable, assistant.lockedIds])

  useEffect(() => { if (!editable || !markupTask) setMarkupId(null) }, [editable, markupTask])

  useEffect(() => {
    if (editable) return
    setSettingsDialog(null)
    setShareOpen(false)
    setLaunchpadPoint(null)
    setLaunchpadAnchor(null)
    setDrawingId(null)
  }, [editable])

  useEffect(() => {
    if (!settingsOpen) return
    actions.current?.clearSelection()
    assistant.followSelection()
    setActiveEditor(null)
  }, [settingsOpen])

  function followCanvasSelection() {
    if (!editable) return
    assistant.followSelection()
  }

  useEffect(() => {
    if (selectedIds.some(id => !doc?.objects.some(object => object.id === id))) {
      setSelectedIds(ids => ids.filter(id => doc?.objects.some(object => object.id === id))); setActiveEditor(null)
    }
  }, [doc?.objects, selectedIds, mainEditor])

  const previousReservations = useRef(history.reservations)
  useLayoutEffect(() => {
    if (doc) copy.update(doc, history.reservations)
    if (previousReservations.current !== history.reservations) {
      previousReservations.current = history.reservations
      copy.requestEarlySync()
    }
  }, [doc, history.reservations, copy])
  useEffect(() => () => copy.cancelEarlySync(), [copy])

  useEffect(() => {
    void copy.refreshPrivacy()
    if (copy.getSnapshot().record.pendingCreate) void copy.sync()
    const autosave = window.setInterval(() => {
      if (!connectionSnapshot().offline && copy.getSnapshot().record.dirty) void copy.sync()
    }, 30000)
    const reconnect = window.setInterval(() => { if (connectionSnapshot().offline) void retryConnection() }, 10000)
    const unsubscribe = subscribeDocumentUpdates(copy.getSnapshot().record.meta.id, event => {
      if (event.kind === 'deleted') { copy.remoteDeleted(); return }
      if (event.kind === 'ready' || event.kind === 'privacy' || event.kind === 'document') void copy.refreshPrivacy()
      if (event.kind === 'ready' || event.kind === 'document') void copy.checkRemote()
    })
    const online = () => { void retryConnection() }
    window.addEventListener('online', online)
    function saveShortcut(event: KeyboardEvent) {
      if (isComposingKey(event)) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopPropagation(); void copy.save()
      }
    }
    window.addEventListener('keydown', saveShortcut, true)
    return () => {
      clearInterval(autosave); clearInterval(reconnect); unsubscribe()
      window.removeEventListener('online', online); window.removeEventListener('keydown', saveShortcut, true)
    }
  }, [copy])

  useEffect(() => {
    if (connection.offline || !connection.revision) return
    void copy.refreshPrivacy()
    if (copy.getSnapshot().record.dirty) void copy.sync()
    else void copy.checkRemote()
  }, [copy, connection.offline, connection.revision])

  useEffect(() => {
    if (cloud.local === 'saved') return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [cloud.local])

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (!editable || isComposingKey(event)) return
      if (key !== 'z' && key !== 'y') return
      const target = event.target as HTMLElement
      if (target.closest('.drawing-editor')) return
      if (!target.matches('[data-code-source], [data-document-notes]') && target.matches('textarea, input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=radio])')) return
      event.preventDefault(); event.stopPropagation()
      if (key === 'y' || event.shiftKey) history.redo(); else history.undo()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [editable, history])

  const selection = useEditorState({
    editor: activeEditor,
    selector: () => {
      // Include focus-only editor changes, especially the null editor for images.
      const editor = activeEditor?.isDestroyed ? null : activeEditor
      const caption = isCaptionEditor(editor)
      const rect = editor && !caption && isInTable(editor.state) ? selectedRect(editor.state) : null
      return {
        paragraph: editor?.isActive('paragraph') ?? false,
        semantic: caption ? 'caption' : editor?.schema.nodes.table ? 'table' : editor?.getAttributes('paragraph').semantic ?? 'body',
        listLevel: editor?.getAttributes('paragraph').listLevel ?? 0,
        table: !caption && !!editor?.schema.nodes.table,
        columnAlignment: rect && columnAlignment(editor!.state),
        tableRect: rect && { removeRow: rect.bottom - rect.top < rect.map.height, removeColumn: rect.right - rect.left < rect.map.width },
        paragraphs: editor && editor === mainEditor ? paragraphSelection(editor.state.doc, editor.state.selection.from, editor.state.selection.to) : null,
      }
    },
  })

  function anchorId() {
    if (!mainEditor) return
    const selection = mainEditor.state.selection
    const block = selection instanceof NodeSelection ? selection.node
      : selection.$from.depth ? selection.$from.node(1) : selection.$from.nodeAfter ?? selection.$from.nodeBefore!
    return block.attrs.id as string
  }

  function updateFloating(objects: FloatingObject[]) { setDoc(current => current && reconcileObjectDeletions(current, objects, actions.current?.segmentContext())) }

  function updateObject(id: string, patch: FloatingPatch) {
    setDoc(current => current && ({ ...current, objects: current.objects.map(object => object.id === id
      ? patchFloating(object, patch.x === undefined ? constrainCaptionResize(object, patch, actions.current?.segmentContext()?.geometry[id], current.page.width - 2) : patch) : object) }))
  }

  function editDrawing(id: string) {
    setMarkupId(null)
    history.boundary(); setActiveEditor(null); setTool(null); setDrawingId(id)
  }

  function closeDrawing() {
    history.boundary(); setDrawingId(null)
    requestAnimationFrame(() => workspace.current?.querySelector<HTMLElement>(`[data-note-id="${drawingId}"]`)?.focus({ preventScroll: true }))
  }

  function editMarkup(task: AITask) {
    if (!editable || assistant.inactiveReason(task)) return
    history.boundary(); assistant.openTask(task.id); setTool(null); setDrawingId(null); setMarkupId(task.id)
  }

  function closeMarkup() {
    history.boundary(); setMarkupId(null)
    if (markupTask) { locateTask(markupTask, false); assistant.openTask(markupTask.id) }
  }

  function reorder(front: boolean) {
    if (selectedIds.length < 1) return
    setDoc(current => { if (!current) return current; const chosen = current.objects.filter(object => selectedIds.includes(object.id)); const rest = current.objects.filter(object => !selectedIds.includes(object.id)); return { ...current, objects: front ? [...rest, ...chosen] : [...chosen, ...rest] } })
  }

  function handleCanvasContextMenu(point: { x: number; y: number }) {
    setTool(null)
    setLaunchpadPoint(point)
    setLaunchpadAnchor(null)
  }

  function handleLaunchpadChoose(kind: LaunchpadTool) {
    setLaunchpadPoint(null)
    setLaunchpadAnchor(null)
    if (kind === 'image') { setTool(null); chooseImage(); return }
    setTool(kind); setSelectedIds([])
  }

  function chooseImage(object?: FloatingObject) {
    const anchor = object ? objectAnchorId(object, doc!.content) : anchorId()
    if (!doc || (!object && anchor === undefined)) return
    imageTarget.current = { documentId: doc.id, anchorId: anchor === undefined ? null : anchor, objectId: object?.id }
    setImageError('')
    imageInput.current!.click()
  }

  const imageGeneration = useRef(0)
  useEffect(() => () => { imageGeneration.current++ }, [editable, doc?.id, history.revision])

  async function uploadImages(files: File[], target: NonNullable<typeof imageTarget.current>, position?: { x: number; y: number; anchorId: string | null }) {
    if (!editable || imageLoading || !files.length) return
    const generation = imageGeneration.current
    setImageLoading(true); setImageError('')
    try {
      const sources = await Promise.all(files.map(readImage))
      if (generation !== imageGeneration.current || latest.current?.id !== target.documentId) return
      if (target.objectId) {
        updateObject(target.objectId, { src: sources[0] })
        return
      }
      const current = latest.current!
      const anchor = target.anchorId === null || current.content.content!.some(node => node.attrs?.id === target.anchorId)
        ? target.anchorId : null
      const width = Math.min(340, current.page.width - current.page.margins.left - current.page.margins.right)
      const objects: FloatingImage[] = sources.map((src, index) => {
        const base = { id: crypto.randomUUID(), layout: { width, placement: position ? { type: 'float' as const, anchorId: anchor, x: position.x, y: position.y } : { type: 'flow' as const, x: 'center' as const } }, alt: files[index].name.replace(/\.[^.]+$/, '') }
        return { ...base, kind: 'image', src }
      })
      if (position) actions.current?.insert(objects)
      else {
        const image = new Image(); image.src = sources[0]; await image.decode()
        if (generation !== imageGeneration.current || latest.current?.id !== target.documentId) return
        setSelectedIds([]); setActiveEditor(null)
        setTool({ image: objects[0], ratio: image.naturalWidth / image.naturalHeight })
      }
    } catch (error) { if (generation === imageGeneration.current) setImageError((error as Error).message) }
    finally { setImageLoading(false) }
  }

  function tableCommand(command: Command) {
    if (!activeEditor) return
    activeEditor.commands.focus()
    command(activeEditor.state, activeEditor.view.dispatch)
  }

  function openThemeClass(className: string) {
    history.boundary()
    setThemeClass(className as ThemeClass)
    setSettingsDialog('theme')
  }

  function openHeaderTheme() {
    if (tool || !activeEditor?.isEditable || !(activeEditor.state.selection instanceof TextSelection)) return openThemeClass(themeClass)
    const { $head } = activeEditor.state.selection
    openThemeClass(isCaptionEditor(activeEditor) ? 'caption' : activeEditor.schema.nodes.table ? 'table' : $head.parent.attrs.semantic)
  }

  function runWidget(id: string) {
    history.boundary()
    setWidgetRuns(current => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
  }

  function measuredArea(element: Element | null): Area {
    const sheet = document.querySelector<HTMLElement>('.workspace > .canvas-pane .sheet')
    if (!element || !sheet) return { x: doc!.page.margins.left, y: doc!.page.margins.top, width: doc!.page.width - doc!.page.margins.left - doc!.page.margins.right, height: 24 }
    const origin = sheet.getBoundingClientRect(), rect = element.getBoundingClientRect(), scale = origin.width / sheet.offsetWidth
    const caption = element.querySelector('.object-caption')?.getBoundingClientRect()
    const object = doc!.objects.find(object => object.id === element.getAttribute('data-note-id'))
    if (object) return extentBounds({ x: (rect.left - origin.left) / scale - sheet.clientLeft, y: (rect.top - origin.top) / scale - sheet.clientTop,
      width: rect.width / scale, height: rect.height / scale, captionWidth: caption ? caption.width / scale : undefined, margins: object.layout.margins })
    const left = Math.min(rect.left, caption?.left ?? rect.left), right = Math.max(rect.right, caption?.right ?? rect.right)
    return { x: (left - origin.left) / scale - sheet.clientLeft, y: (rect.top - origin.top) / scale - sheet.clientTop, width: (right - left) / scale, height: rect.height / scale }
  }
  function selectionTarget(): AITarget | null {
    if (!doc || tool) return null
    if (selectedIds.length === 1 && selectedObject) {
      const range = activeEditor && !isCaptionEditor(activeEditor) && activeEditor !== mainEditor && !activeEditor.state.selection.empty ? activeEditor.state.selection : null
      return { kind: 'object', objectId: selectedObject.id, isNew: false,
        ...(range ? { selection: { from: range.from, to: range.to }, selectedText: activeEditor!.state.doc.textBetween(range.from, range.to, '\n') } : {}),
        area: measuredArea(document.querySelector(`.workspace [data-note-id="${selectedObject.id}"]`)) }
    }
    if (!mainEditor || selectedIds.length) return null
    const segment = actions.current?.segmentSelection()
    if (selectedSegment.range && segment) return makeSegmentTarget(doc, segment.range, segment.area)
    if (activeEditor !== mainEditor) return null
    const { $from, $to, empty } = mainEditor.state.selection
    const blocks = doc.content.content!, start = $from.index(0)
    const end = Math.min(blocks.length, Math.max(start + 1, empty ? start + 1 : $to.index(0) + ($to.depth && $to.parentOffset ? 1 : 0)))
    if (start >= blocks.length) return null
    const first = measuredArea(document.querySelector(`.workspace .main-text [data-id="${blocks[start].attrs!.id}"]`))
    const last = measuredArea(document.querySelector(`.workspace .main-text [data-id="${blocks[end - 1].attrs!.id}"]`))
    const area = { x: 0, y: first.y, width: doc.page.width - 2, height: last.y + last.height - first.y }
    // Existing prose-only tasks keep their authority; only their navigation uses this path.
    const paragraphs = selection?.paragraphs
    if (paragraphs && assistant.tasks.some(task => task.target.kind === 'text' && paragraphs.blockIds.every(id => task.target.kind === 'text' && task.target.blockIds.includes(id))))
      return { kind: 'text', ...paragraphs, insert: false, area }
    return makeSegmentTarget(doc, { start: { index: start, offset: 0 }, end: { index: end, offset: 0 } }, area)
  }
  const target = selectionTarget()
  const overlappingTasks = target && doc ? assistant.tasks.filter(task => overlaps(task.target, target, doc))
    : assistant.tasks.filter(task => selectedIds.some(id => task.target.kind === 'object' ? task.target.objectId === id : task.target.kind === 'segment' && task.target.objectIds.includes(id)))
  const selectedTask = assistant.tasks.find(task => task.id === selectedSegment.taskId)
    ?? (target && doc && overlappingTasks.length === 1 && containsTarget(overlappingTasks[0].target, target, doc) ? overlappingTasks[0] : undefined)
  const reservationSelection: ReservationSelection = {
    detail: overlappingTasks.length && !selectedTask ? 'Select one reserved area to view its task.'
      : selectedIds.length > 1 ? 'Select one object, or select a section using the gutter.'
      : selectedObject ? selectedObject.kind === 'table' ? selectedObject.caption ? 'Entire table and caption.' : 'Entire table.' : 'caption' in selectedObject && selectedObject.caption ? 'Includes its caption.' : undefined
      : target?.kind === 'segment' ? target.blockIds.length || target.objectIds.length ? 'Reserves this section and its owned objects.' : 'Creates a section at this insertion point.'
      : activeEditor === mainEditor && mainEditor ? 'Select text or use the gutter to reserve a section and its owned objects.'
      : undefined,
    canReserve: !!target && !overlappingTasks.length,
  }
  const assistantTaskId = assistant.tasks.some(task => task.id === assistant.activeId) ? assistant.activeId : selectedTask?.id ?? null

  const showProperties = !assistantTaskId && !overlappingTasks.length || selectedObjectTask && assistantTaskId === selectedObjectTask.id
  const panelScroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { panelScroll.current?.scrollTo(0, 0) }, [selectedObject?.id, assistantTaskId, tool])

  function reserveSelection() {
    if (!target || !reservationSelection.canReserve) return
    const task = assistant.reserve(target)
    if (!task) return
    if (target.kind === 'segment') { setActiveEditor(null); actions.current?.locateSegment(task.id) }
    else if (target.kind === 'text') mainEditor?.commands.setTextSelection(target.selection)
    focusRequest(task)
  }
  function focusRequest(task?: AITask) {
    if (task) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-ai-task="${task.id}"] textarea`)?.focus())
  }
  function createAIArea(object: FloatingObject, area: Area) {
    if (!doc) return
    const next = { ...doc, objects: [...doc.objects, object] }
    focusRequest(assistant.reserve({ kind: 'object', objectId: object.id, isNew: true, area }, next))
  }
  function locateTask(task: AITask, reveal = true) {
    setTool(null)
    const hasCandidate = !!selectedCandidateVersion(task)
    if (task.target.kind === 'segment') { actions.current?.locateSegment(task.id, reveal); return }
    if (task.target.kind === 'object') { setSelectedIds([task.target.objectId]); setActiveEditor(null) }
    else if (mainEditor) {
      const ids = task.target.blockIds
      let from = 0, to = 0
      mainEditor.state.doc.forEach((node, offset) => {
        if (node.attrs.id === ids[0]) from = offset + 1
        if (node.attrs.id === ids.at(-1)) to = offset + node.nodeSize - 1
      })
      setSelectedIds([]); setActiveEditor(mainEditor); mainEditor.commands.setTextSelection({ from, to })
    }
    if (reveal) requestAnimationFrame(() => {
      const selector = task.target.kind === 'object' ? `[data-note-id="${task.target.objectId}"]`
        : task.preview && hasCandidate ? `[data-ai-preview="${task.id}"] > .main-paragraph` : `[data-ai-reservation="${task.id}"]`
      const element = document.querySelector<HTMLElement>(`.workspace > .canvas-pane ${selector}`)
      element?.scrollIntoView({ block: 'center', inline: 'nearest' })
      if (task.target.kind === 'object' || task.preview && hasCandidate) element?.focus({ preventScroll: true })
      else mainEditor?.view.focus()
    })
  }

  if (!doc) return null
  const status = cloud.local === 'error' || connection.offline || cloud.error || cloud.conflict || cloud.deleted ? 'error' : cloud.syncing || cloud.record.dirty ? 'saving' : 'saved'
  const statusText = cloud.local === 'error' ? 'Local save failed'
    : connection.checking ? 'Reconnecting…' : connection.offline ? showLocalSaving ? 'Offline · saving locally…' : cloud.record.dirty ? 'Offline · changes pending' : 'Offline · saved locally'
    : cloud.conflict ? 'Conflict · action required' : cloud.deleted ? 'Deleted on server' : cloud.auth ? 'Sign in to sync' : cloud.syncing ? 'Syncing…'
    : cloud.error ? 'Sync needs attention' : showLocalSaving ? 'Saving locally…' : cloud.record.dirty ? 'Changes pending'
    : cloud.record.draft ? 'Empty draft · not saved to cloud' : 'Synced'

  const syncNotice = (cloud.conflict || cloud.deleted || cloud.error || cloud.local === 'error') && <div className="cloud-sync-actions" role="alert">
      <p>{cloud.local === 'error' ? 'Local saving failed. Keep this tab open and retry.'
        : cloud.conflict ? `The cloud document changed (${new Date(cloud.conflict.updatedAt).toLocaleString()}). Your working copy is preserved.`
        : cloud.deleted ? 'This document was deleted on the server. Your working copy is preserved.' : cloud.error}</p>
      {cloud.auth && <a href={loginURL()} target="_blank" rel="noopener noreferrer">Sign in</a>}
      {cloud.local === 'error' && <button onClick={copy.retryLocal}>Retry local save</button>}
      {(cloud.conflict || cloud.deleted) ? <>
        <button disabled={cloud.syncing} onClick={() => {
          const name = window.prompt('Name for the new cloud document', `${cloud.record.meta.name} (copy)`)
          if (name?.trim()) void copy.saveAs(name.trim()).then(result => { if (result) onOpen(result.id) })
        }}>Save as copy</button>
        <button disabled={cloud.syncing} onClick={() => {
          if (!window.confirm("Discard this local working copy's changes? This cannot be undone.")) return
          if (cloud.deleted) {
            void copy.flushLocal().then(() => deleteWorkingCopy(cloud.record.key)).then(() => { location.assign('/') }).catch(() => copy.retryLocal())
          } else void copy.discard()
        }}>Discard local changes</button>
        {cloud.conflict && <button disabled={cloud.syncing} onClick={() => {
          if (window.confirm('Overwrite the cloud version with this working copy? No recovery copy will be created.')) void copy.overwrite()
        }}>Overwrite cloud version</button>}
      </> : <button disabled={cloud.syncing} onClick={() => void copy.sync()}>Retry sync</button>}
    </div>

  if (mobile) return <ReaderPage initial={doc} notice={syncNotice} />

  const captionSelected = selectedIds.length === 1 && selectedCaptionId === selectedObject?.id
  const sectionSelected = selectedSegment.range && target?.kind === 'segment'
  const semantic = selection?.semantic ?? 'body'
  const editingHelp = !showProperties ? null : selectedObject
    ? <ObjectEditingHelp key={selectedObject.id} object={selectedObject} count={selectedIds.length} captionSelected={captionSelected} reserved={!!selectedObjectTask} />
    : !tool && !sectionSelected && activeEditor ? <ParagraphHelp key={semantic} semantic={semantic} /> : null

  return <HistoryContext value={history}><div className="app" data-mode={doc.theme.appearance.mode} style={uiStyle}>
    <header className="app-header cloud-header">
      <button className="document-switch" onClick={onFiles} aria-label={`Switch document: ${cloud.record.meta.name}`} title={`${cloud.record.meta.name} · Switch document`}>
        <span>{cloud.record.meta.name}</span><PanelIcon name="chevron" />
      </button>
      <div className={`save-status ${status}`} role="status">
        <button aria-label={`${statusText}. ${cloud.local === 'error' ? 'Retry local save' : connection.offline ? 'Retry connection' : 'Sync document'}`} title={`${statusText} · ${cloud.local === 'error' ? 'Click to retry local save' : connection.offline ? `${connection.reason} Click to retry connection` : 'Click to sync · Ctrl/⌘S'}`}
          disabled={connection.checking || !connection.offline && (cloud.syncing || !!cloud.conflict || cloud.deleted)} onClick={() => cloud.local === 'error' ? copy.retryLocal() : connection.offline ? void retryConnection() : void copy.save()}>
          <span className="status-dot" aria-hidden="true" /><span className="save-message">{statusText}</span>
        </button>
      </div>
      <div className="header-actions">
        {showInspector && <div className="history-buttons" role="group" aria-label="Document history">
          <button className="header-icon-btn" aria-label="Undo" title="Undo · Ctrl/⌘Z" disabled={!editable || !history.canUndo} onClick={history.undo}><PanelIcon name="undo" /></button>
          <button className="header-icon-btn" aria-label="Redo" title="Redo · Ctrl/⌘Shift+Z" disabled={!editable || !history.canRedo} onClick={history.redo}><PanelIcon name="redo" /></button>
        </div>}
        {showInspector && <button className="header-action-btn" aria-label="Add object" title="Add · right-click on canvas"
          disabled={!editable} aria-haspopup="menu" aria-expanded={!!launchpadAnchor}
          onClick={event => {
            const box = event.currentTarget.getBoundingClientRect()
            setLaunchpadPoint(null)
            setLaunchpadAnchor({ x: box.right - 268, y: box.bottom + 8 })
          }}>
          <PanelIcon name="plus" /><span>Add</span>
        </button>}
        <div className="header-zoom" ref={setZoomHost} />
        {showInspector && <>
          <button className="header-icon-btn" aria-label="Share" title="Share or export" disabled={!editable} aria-haspopup="dialog" aria-expanded={shareOpen}
            onClick={() => setShareOpen(true)}><PanelIcon name="share" /></button>
          <button className="header-icon-btn" aria-label="Theme" title="Theme" disabled={!editable} aria-haspopup="dialog" aria-controls="document-theme" aria-expanded={themeOpen}
            onMouseDown={event => event.preventDefault()} onClick={openHeaderTheme}><PanelIcon name="palette" /></button>
          <button className="header-icon-btn" aria-label="Settings" title="Settings" disabled={!editable} aria-haspopup="dialog" aria-expanded={settingsOpen}
            onClick={() => { history.boundary(); setSettingsDialog('settings') }}><PanelIcon name="settings" /></button>
        </>}
        <button className="preview-button" aria-label="Preview document" title="Preview in a new tab or window" disabled={preview.busy}
          onClick={() => void preview.open(doc)}><span>Preview</span><PanelIcon name="export" /></button>
      </div>
    </header>

    <ShareWindow open={editable && shareOpen} onClose={() => setShareOpen(false)} copy={copy} documentId={doc.id} name={cloud.record.meta.name} privateDocument={sharingBlocked} />
    {preview.error && <div className="image-error" role="alert">{preview.error}<button aria-label="Dismiss preview error" onClick={preview.dismiss}>×</button></div>}
    {syncNotice}

    <input ref={imageInput} type="file" hidden aria-label="Image file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file && imageTarget.current) void uploadImages([file], imageTarget.current) }} />
    {imageError && <div className="image-error" role="alert">{imageError}<button aria-label="Dismiss image error" onClick={() => setImageError('')}>x</button></div>}
    {editable && assistant.notice && <div className="image-error" role="alert">{assistant.notice}{!assistant.cloudWarning && <button aria-label="Dismiss AI notice" onClick={() => assistant.setNotice('')}>x</button>}</div>}

    <PopupDialog id="document-theme" open={editable && themeOpen} onClose={() => { history.boundary(); setSettingsDialog(null) }} title="Document Theme">
      <div className="document-settings-body">
        <div className="document-theme"><ThemePanel theme={doc.theme} language={doc.language ?? 'en'} selected={themeClass} onSelect={setThemeClass}
          onChange={theme => setDoc({ ...doc, theme })} /></div>
      </div>
    </PopupDialog>
    <PopupDialog open={editable && settingsOpen} onClose={() => { history.boundary(); setSettingsDialog(null) }} title="Settings">
      <div className="settings-tabs settings-scopes" role="tablist" aria-label="Settings scope">
        {(['document', 'workspace', 'browser'] as const).map((section, index, sections) => <button key={section} id={`settings-${section}-tab`}
          role="tab" aria-selected={settingsSection === section} aria-controls={`settings-${section}-panel`} tabIndex={settingsSection === section ? 0 : -1}
          onClick={() => { history.boundary(); setSettingsSection(section) }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault(); history.boundary()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + sections.length) % sections.length
            setSettingsSection(sections[next]); document.getElementById(`settings-${sections[next]}-tab`)?.focus()
          }}>{section[0].toUpperCase() + section.slice(1)}</button>)}
      </div>
      <div className="settings-scope-panel settings-document" id="settings-document-panel" role="tabpanel" aria-labelledby="settings-document-tab" hidden={settingsSection !== 'document'}>
        <div className="settings-document-heading">
          <button className="document-privacy-toggle" aria-label="Private document" aria-pressed={cloud.record.meta.private}
            title={creatingPrivate ? 'Private will be confirmed when this file is saved to the cloud.' : cloud.record.meta.private
              ? 'Private document. Click to allow sharing and external agents. Revoked Share links stay revoked.'
              : 'Not private. Click to block public sharing and external agents. The built-in agent remains available.'}
            disabled={creatingPrivate || cloud.privacy.busy || !!cloud.privacy.pending}
            onClick={() => void copy.setPrivate(!cloud.record.meta.private, () => window.confirm(
              `Make "${cloud.record.meta.name}" private?\n\nThis will revoke the current Share link permanently. External agents will be blocked while Private is on.`
            ))}><PanelIcon name={cloud.record.meta.private ? 'lock' : 'unlock'} /><span>Private</span></button>
        </div>
        {creatingPrivate && <p className="settings-dialog-note" role="status">Private is awaiting the first cloud save. Sharing and external agents are blocked. Use the sync indicator to retry.</p>}
        <DocumentSettings doc={doc}
          onChange={setDoc} privacy={cloud.privacy}
          onPrivacyRetry={() => void copy.retryPrivacy()}
          onPrivacyReconcile={() => void copy.reconcilePrivacy()} />
      </div>
      <div className="settings-scope-panel settings-dialog-section" id="settings-workspace-panel" role="tabpanel" aria-labelledby="settings-workspace-tab" hidden={settingsSection !== 'workspace'}>
        <p className="settings-dialog-note">Shared across all documents. Use Save settings to apply changes.</p>
        <WorkspaceSettings active={editable && settingsOpen && settingsSection === 'workspace'} />
      </div>
      <div className="settings-scope-panel settings-dialog-section" id="settings-browser-panel" role="tabpanel" aria-labelledby="settings-browser-tab" hidden={settingsSection !== 'browser'}>
        <p className="settings-dialog-note">These settings are saved in this browser only.</p>
        <GlobalSettings settings={settings} onChange={updateSettings} saveError={settingsSaveError} />
      </div>
    </PopupDialog>
    <main ref={workspace} className={`workspace ${showInspector ? '' : 'reader'}`}>
      {showInspector && <aside className="inspector side-panel" aria-label="Context and assistant">
        <div className="side-panel-body">
          {!tool && !assistantTaskId && !overlappingTasks.length && <TextToolsRow editor={activeEditor} theme={doc.theme} caption={isCaptionEditor(activeEditor)} onPalette={() => openThemeClass('palette')}
            recentColors={recentColors.colors} onColorApplied={recentColors.remember} />}
          <div className="side-panel-scroll" ref={panelScroll}>
            {showProperties && <div key={selectedObject?.id ?? (tool ? `tool-${tool}` : 'text')} className="selection-inspector" aria-label="Selection inspector">
              {selectedObject ? <FloatingInspector object={selectedObject} captionSelected={captionSelected}
                captionMaxWidth={doc.page.width} onCaptionWidth={width => actions.current?.captionWidth(width)} onSelectOwner={() => actions.current?.selectOwner()} count={selectedIds.length} theme={doc.theme} defaultFontSize={doc.theme.defaults.size}
                onCaption={() => actions.current?.caption()}
                textStyle={activeEditor && activeEditor !== mainEditor && selection?.paragraph ? selection.semantic : undefined}
                tableControls={isCaptionEditor(activeEditor) ? null : <TableControls selection={selection?.table ? selection : null} onCommand={tableCommand} />}
                onChange={patch => updateObject(selectedObject.id, patch)} onAction={action => actions.current?.[action]()} onFront={() => reorder(true)} onBack={() => reorder(false)}
                onPlacement={placement => actions.current?.placement(placement)}
                onHistoryBegin={history.begin} onHistoryEnd={history.boundary} imageLoading={imageLoading} onTheme={openThemeClass}
                onWidgetRun={runWidget}
                onUpdateScreenshot={object => void screenshot.capture(object)} screenshotStatus={screenshot.status} screenshotOffline={connection.offline}
                onReplaceImage={() => chooseImage(selectedObject)} onDrawingEdit={() => editDrawing(selectedObject.id)}
                reserved={!!selectedObjectTask}
                newAIObject={selectedObjectTask?.target.kind === 'object' && selectedObjectTask.target.isNew} />
              : tool ? <div className="context-inspector">
                  <ContextHeading title={tool === 'ai' ? 'New AI area' : typeof tool === 'object' ? 'Image' : tool === 'text' ? 'Text box' : tool === 'html' ? 'HTML widget' : tool[0].toUpperCase() + tool.slice(1)} subtitle={tool === 'paragraph' ? 'Click a boundary to insert a paragraph.' : tool === 'ai' ? 'Click or drag on the page to reserve one AI object.' : 'Click to insert Flow · Alt-drag to create Float · Esc cancels'} />
                  <button onClick={() => setTool(null)}>Cancel placement <kbd>Esc</kbd></button>
                </div>
              : sectionSelected ? <div className="context-inspector"><ContextHeading title={target.blockIds.length || target.objectIds.length ? 'Document section' : 'New section'} /></div>
              : activeEditor ? <TextInspector semantic={semantic} listLevel={selection?.listLevel ?? 0} onTheme={openThemeClass} />
              : <div className="context-inspector"><p className="hint">Select text or an object.</p></div>}
            </div>}
            <AssistantPanel assistant={assistant} activeId={assistantTaskId} selection={tool ? null : reservationSelection} onReserve={reserveSelection} onLocate={locateTask} onAnnotate={editMarkup} theme={doc.theme} />
            <div className="panel-help" role="group" aria-label="Help">
              {editingHelp}
              {(assistantTaskId || (!tool && reservationSelection.canReserve)) && <AssistantHelp />}
            </div>
          </div>
        </div>
      </aside>}
      <DocumentCanvas key={doc.id} doc={doc} editable={editable} editingLayout minimap={showMinimap} minimapSize={settings.minimapSize} zoomHost={zoomHost}
        formattingMarks={settings.formattingMarks} verticalSpacers={settings.verticalSpacers}
        onInteraction={followCanvasSelection} onCaptionSelection={setSelectedCaptionId}
        onSegmentSelection={(range, taskId) => setSelectedSegment({ range, taskId })}
        lockedIds={assistant.lockedIds} onAICreate={createAIArea} onDeleteObjects={assistant.deleteObjects}
        aiReview={{ tasks: assistant.tasks, previewFailed: assistant.previewFailed, activeTaskId: assistantTaskId, editMarkup,
          selectText: () => { setSelectedIds([]); setActiveEditor(mainEditor) }, deleteTarget: assistant.deleteTarget }}
        aiWidgetIds={new Set(Object.keys(assistant.runs))}
        widgetRuns={Object.fromEntries(doc.objects.map(object => [object.id, (widgetRuns[object.id] ?? 0) + (assistant.runs[object.id] ?? 0)]))} tool={tool} onToolChange={setTool} selectedIds={selectedIds} onSelect={ids => {
          setSelectedIds(ids)
        }}
        onActions={(value: CanvasActions) => { actions.current = value }} onFloatingChange={updateFloating}
        onMainReady={setMainEditor} onActive={setActiveEditor}
        onMainChange={(content, merges, shift) => setDoc(current => current && recordSpaceEdit(current,
          replaceMainContent(current, content, merges, shift, actions.current?.segmentContext()), merges, shift))}
        onNoteChange={updateObject} onDropImages={(files, position) => void uploadImages(files, { documentId: doc.id, anchorId: position.anchorId }, position)}
        onContextMenu={handleCanvasContextMenu} onDrawingEdit={editDrawing} />
      {showInspector && <DocumentNotes key={`notes:${doc.id}`} value={doc.authoring?.notes ?? []}
        onFocus={() => { setActiveEditor(null); setTool(null) }} />}
    </main>
    {editable && drawing?.kind === 'drawing' && !assistant.lockedIds.has(drawing.id) && createPortal(
      <DrawingEditor key={drawing.id} drawing={drawing} theme={doc.theme}
        maxWidth={drawing.layout.placement.type === 'flow' ? doc.page.width - doc.page.margins.left - doc.page.margins.right : doc.page.width}
        signedY={doc.content.content!.some(node => node.type === 'flow' && node.attrs?.id === objectAnchorId(drawing, doc.content))} onChange={patch => updateObject(drawing.id, patch)} onClose={closeDrawing} />,
      document.querySelector('.app')!)}
    {editable && markupTask && createPortal(
      <ReservationMarkupEditor key={markupTask.id} doc={doc} reservation={markupTask}
        onChange={markup => assistant.setMarkup(markupTask.id, markup)} onClose={closeMarkup} />,
      document.querySelector('.app')!)}
    {editable && <Launchpad
      point={launchpadPoint}
      anchor={launchpadAnchor}
      onChoose={handleLaunchpadChoose}
      onClose={() => { setLaunchpadPoint(null); setLaunchpadAnchor(null) }}
    />}
  </div></HistoryContext>
}
