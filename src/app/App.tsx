import { useEffect, useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import type { Command } from '@tiptap/pm/state'
import { addRowAfter, deleteRow, isInTable, selectedRect } from '@tiptap/pm/tables'
import { DocumentCanvas, type CanvasActions, type CreationTool } from '../canvas/DocumentCanvas'
import { createDocument, replaceMainContent, tableContent, type FloatingObject, type FloatingPatch, type LineEnd, type MoteDocument } from '../document/model'
import { alignColumns, changeColumns, columnAlignment } from '../editor/table'
import { readImage } from '../document/image'
import { saveDraft } from '../document/storage'
import { useLocalDraft } from '../document/useLocalDraft'
import { classLabel, type ThemeClass } from '../theme/ThemePanel'
import { GlobalSettings, useViewSettings } from './GlobalSettings'
import { DocumentSettings } from './DocumentSettings'
import { HistoryContext, useDocumentHistory } from '../document/history'
import { Toolbar } from './Toolbar'
import { FloatingInspector } from './FloatingInspector'
import { DocumentFiles } from './DocumentFiles'
import { useMedia } from './useMedia'
import { isComposingKey } from '../editor/composition'
import './floating-controls.css'
import './embeds.css'
import { useAssistant } from '../ai/useAssistant'
import { AssistantPanel } from '../ai/AssistantPanel'
import type { Area } from '../ai/types'
import { paragraphSelection } from '../ai/reservations'

const DEFAULT_WIDGET_HTML = `<button id="counter" type="button">Count: <span>0</span></button>
<style>
  #counter { border: 1px solid #9eb392; border-radius: 6px; padding: 8px 12px; background: #e9efdf; color: #355b43; cursor: pointer; }
</style>
<script>
  const button = document.querySelector('#counter');
  const count = button.querySelector('span');
  let value = 0;
  button.addEventListener('click', () => { count.textContent = String(++value); });
</script>`

export function App() {
  const mobile = useMedia('(max-width: 767px)')
  const session = useLocalDraft(!mobile)
  useEffect(() => {
    function saveShortcut(event: KeyboardEvent) {
      if (isComposingKey(event)) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopPropagation()
      }
    }
    window.addEventListener('keydown', saveShortcut, true)
    return () => window.removeEventListener('keydown', saveShortcut, true)
  }, [])
  if (session.state !== 'ready') return <main className="loading"><h1>Mote</h1>
    <p>{session.state === 'loading' ? 'Opening your local draft…'
      : session.state === 'storage-error' ? 'Local storage could not be opened. Check that browser storage is available.'
      : session.state === 'lock-error' ? 'Editing access could not be acquired.'
      : 'This local draft could not be opened. The saved draft has not been changed.'}</p>
    {session.access === 'blocked' && <p>This draft is being edited in another tab.</p>}
    {session.state !== 'loading' && <button onClick={() => session.retry()}>Retry</button>}
    {session.state === 'document-error' && session.access !== 'writer' && !mobile && <button onClick={session.tryEditing}>Try editing</button>}
  </main>
  return <DraftSession initial={session.doc} writable={session.access === 'writer'} blocked={session.access === 'blocked'} onTryEditing={session.tryEditing} />
}

interface DraftProps {
  initial: MoteDocument; writable: boolean; blocked: boolean; onTryEditing: () => void
}

function DraftSession(props: DraftProps) {
  const [replacement, setReplacement] = useState({ doc: props.initial, revision: 0 })
  return <DraftApp {...props} key={replacement.revision} initial={replacement.doc}
    onImport={doc => setReplacement(current => ({ doc, revision: current.revision + 1 }))} />
}

function DraftApp({ initial, writable, blocked, onTryEditing, onImport }: DraftProps & { onImport: (doc: MoteDocument) => void }) {
  const history = useDocumentHistory(initial)
  const { doc, setDoc } = history
  const actions = useRef<CanvasActions | null>(null)
  const assistant = useAssistant(history, writable, id => actions.current?.without([id]),
    id => measuredArea(document.querySelector(`.workspace [data-note-id="${id}"]`)))
  const [status, setStatus] = useState<'saving' | 'saved' | 'error'>('saving')
  const latest = useRef(doc)
  latest.current = doc
  const [mode, setMode] = useState<'edit' | 'read'>('edit')
  const mobile = useMedia('(max-width: 767px)')
  const smallScreen = useMedia('(max-width: 1050px)')
  const editable = writable && assistant.loaded && !mobile && mode === 'edit'
  const { settings, update: updateSettings, saveError: settingsSaveError } = useViewSettings()
  const [viewSettingsOpen, setViewSettingsOpen] = useState(false)
  const [documentSettingsOpen, setDocumentSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'layout' | 'theme'>('layout')
  const [themeClass, setThemeClass] = useState<ThemeClass>('defaults')
  const showInspector = editable
  const showMinimap = settings.minimap === 'show' || (settings.minimap === 'auto' && !smallScreen)
  const [mainEditor, setMainEditor] = useState<Editor | null>(null)
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null)
  const [zoomHost, setZoomHost] = useState<HTMLDivElement | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [tool, setTool] = useState<CreationTool>(null)
  const [widgetRuns, setWidgetRuns] = useState<Record<string, number>>({})
  const selectedObject = doc?.floating.find(object => object.id === selectedIds[0])
  const imageInput = useRef<HTMLInputElement>(null)
  const imageTarget = useRef<{ documentId: string; anchorId: string | null; objectId?: string; kind: 'image' | 'widget' } | null>(null)
  const [imageError, setImageError] = useState('')
  const [imageLoading, setImageLoading] = useState(false)

  useEffect(() => {
    if (selectedIds.some(id => !doc?.floating.some(object => object.id === id))) {
      setSelectedIds(ids => ids.filter(id => doc?.floating.some(object => object.id === id))); setActiveEditor(mainEditor)
    }
  }, [doc?.floating, selectedIds, mainEditor])

  useEffect(() => {
    if (!writable || !doc) return
    setStatus('saving')
    saveDraft(doc).then(() => {
      if (latest.current === doc) setStatus('saved')
    }).catch(() => { if (latest.current === doc) setStatus('error') })
  }, [doc, writable])

  useEffect(() => {
    if (!writable || status === 'saved') return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [status, writable])

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (!editable || isComposingKey(event)) return
      if (key !== 'z' && key !== 'y') return
      const target = event.target as HTMLElement
      if (target.matches('textarea, input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=radio])')) return
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
      const editor = activeEditor
      const rect = editor && isInTable(editor.state) ? selectedRect(editor.state) : null
      return {
        paragraph: editor?.isActive('paragraph') ?? false,
        semantic: editor?.schema.nodes.table ? 'table' : editor?.getAttributes('paragraph').semantic ?? 'body',
        listLevel: editor?.getAttributes('paragraph').listLevel ?? 0,
        table: !!editor?.schema.nodes.table,
        columnAlignment: rect && columnAlignment(editor!.state),
        tableRect: rect && { removeRow: rect.bottom - rect.top < rect.map.height, removeColumn: rect.right - rect.left < rect.map.width },
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

  function addObject(kind: 'table' | 'katex', columns = 2, rows = 2) {
    const anchor = anchorId()
    if (!doc || anchor === undefined) return
    const width = Math.min(kind === 'table' ? Math.max(340, columns * 80) : 340, doc.width - doc.margins.left - doc.margins.right)
    const base = { id: crypto.randomUUID(), anchorId: anchor, x: doc.width - doc.margins.right - width, y: 32, width, textFlow: 'overlap' as const }
    const object: FloatingObject = kind === 'katex' ? { ...base, kind, latex: 'E = mc^2' }
      : { ...base, kind, content: tableContent(Array.from({ length: rows }, () => Array(columns).fill(''))) }
    actions.current?.insert([object])
  }

  function updateFloating(floating: FloatingObject[]) { setDoc(current => current && ({ ...current, floating })) }

  function updateObject(id: string, patch: FloatingPatch) {
    setDoc(current => current && ({ ...current, floating: current.floating.map(object => object.id === id ? { ...object, ...patch } : object) }))
  }

  function reorder(front: boolean) {
    if (selectedIds.length < 1) return
    setDoc(current => { if (!current) return current; const chosen = current.floating.filter(object => selectedIds.includes(object.id)); const rest = current.floating.filter(object => !selectedIds.includes(object.id)); return { ...current, floating: front ? [...rest, ...chosen] : [...chosen, ...rest] } })
  }

  function chooseImage(object?: FloatingObject) {
    const anchor = object ? object.anchorId : anchorId()
    if (!doc || (!object && anchor === undefined)) return
    imageTarget.current = { documentId: doc.id, anchorId: anchor === undefined ? null : anchor, objectId: object?.id, kind: 'image' }
    setImageError('')
    imageInput.current!.click()
  }

  function chooseWidgetScreenshot(object?: FloatingObject) {
    const anchor = object ? object.anchorId : anchorId()
    if (!doc || (!object && anchor === undefined)) return
    imageTarget.current = { documentId: doc.id, anchorId: anchor === undefined ? null : anchor, objectId: object?.id, kind: 'widget' }
    setImageError('')
    imageInput.current!.click()
  }

  const imageGeneration = useRef(0)
  useEffect(() => () => { imageGeneration.current++ }, [editable, doc?.id, history.revision])

  async function uploadImages(files: File[], target: NonNullable<typeof imageTarget.current>, position?: LineEnd) {
    if (!editable || imageLoading || !files.length) return
    const generation = imageGeneration.current
    setImageLoading(true); setImageError('')
    try {
      const sources = await Promise.all(files.map(readImage))
      if (generation !== imageGeneration.current || latest.current?.id !== target.documentId) return
      if (target.objectId) {
        updateObject(target.objectId, target.kind === 'widget' ? { screenshot: sources[0] } : { src: sources[0] })
        return
      }
      const current = latest.current!
      const anchor = target.anchorId === null || current.content.content!.some(node => node.attrs?.id === target.anchorId)
        ? target.anchorId : null
      const width = Math.min(340, current.width - current.margins.left - current.margins.right)
      const objects: FloatingObject[] = sources.map((src, index) => {
        const base = { id: crypto.randomUUID(), anchorId: anchor, x: position?.x ?? current.width - current.margins.right - width,
          y: position?.y ?? 32, width, textFlow: 'overlap' as const, alt: files[index].name.replace(/\.[^.]+$/, '') }
        return target.kind === 'widget' ? { ...base, kind: 'html', height: 220, html: DEFAULT_WIDGET_HTML, screenshot: src }
          : { ...base, kind: 'image', src }
      })
      actions.current?.insert(objects)
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
    setSettingsTab('theme')
    setDocumentSettingsOpen(true)
    setViewSettingsOpen(false)
  }

  function runWidget(id: string) {
    history.boundary()
    setWidgetRuns(current => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
  }

  function measuredArea(element: Element | null): Area {
    const sheet = document.querySelector<HTMLElement>('.workspace > .canvas-pane .sheet')
    if (!element || !sheet) return { x: doc!.margins.left, y: doc!.margins.top, width: doc!.width - doc!.margins.left - doc!.margins.right, height: 24 }
    const origin = sheet.getBoundingClientRect(), rect = element.getBoundingClientRect(), scale = origin.width / sheet.offsetWidth
    return { x: (rect.left - origin.left) / scale - sheet.clientLeft, y: (rect.top - origin.top) / scale - sheet.clientTop, width: rect.width / scale, height: rect.height / scale }
  }
  function reserveSelection() {
    if (!doc) return
    if (selectedIds.length === 1 && selectedObject) {
      const range = activeEditor && activeEditor !== mainEditor && !activeEditor.state.selection.empty ? activeEditor.state.selection : null
      assistant.reserve({ kind: 'object', objectId: selectedObject.id, isNew: false,
        ...(range ? { selection: { from: range.from, to: range.to }, selectedText: activeEditor!.state.doc.textBetween(range.from, range.to, '\n') } : {}),
        area: measuredArea(document.querySelector(`.workspace [data-note-id="${selectedObject.id}"]`)) })
      setActiveEditor(null)
      return
    }
    if (!mainEditor || selectedIds.length) return
    const { from, to } = mainEditor.state.selection
    const range = paragraphSelection(mainEditor.state.doc, from, to)
    if (!range) { assistant.setNotice('Select consecutive main-text paragraphs without crossing a space.'); return }
    const ids = range.blockIds
    const first = measuredArea(document.querySelector(`.workspace .main-text [data-id="${ids[0]}"]`))
    const last = measuredArea(document.querySelector(`.workspace .main-text [data-id="${ids.at(-1)}"]`))
    const task = assistant.reserve({ kind: 'text', ...range, insert: false, area: { ...first, height: last.y + last.height - first.y } })
    if (task) mainEditor.commands.setTextSelection(range.selection)
  }
  function createAIArea(object: FloatingObject, area: Area) {
    if (!doc) return
    const next = { ...doc, floating: [...doc.floating, object] }
    setDoc(next); assistant.reserve({ kind: 'object', objectId: object.id, isNew: true, area }, next)
  }

  if (!doc) return <main className="loading"><h1>Mote</h1><p>Opening your local draft…</p></main>

  const newArea = assistant.tasks.some(task => task.target.kind === 'object' && task.target.isNew && task.target.objectId === selectedObject?.id)
  const itemType = selectedIds.length > 1 ? `${selectedIds.length} floating objects` : selectedObject
    ? newArea ? 'Floating area' : selectedObject.kind === 'image' ? 'Floating image' : selectedObject.kind === 'table' ? 'Floating table' : selectedObject.kind === 'rectangle' ? 'Rectangle' : selectedObject.kind === 'ellipse' ? 'Ellipse' : selectedObject.kind === 'line' ? 'Line' : selectedObject.kind === 'label' ? 'Label' : selectedObject.kind === 'katex' ? 'KaTeX' : selectedObject.kind === 'html' ? 'HTML widget' : 'Floating text'
    : 'Main text'

  return <HistoryContext value={history}><div className="app">
    <header className={`app-header ${editable ? '' : 'floating-header'}`} hidden={mobile}>
      <a className="brand" href="./" aria-label="Mote home"><span className="brand-mark">m</span>Mote</a>
      <div className="document-label">Untitled notebook <span className="version">V0</span></div>
      {editable && <button className="reset-example" onClick={() => {
        if (!window.confirm('Replace your local draft with the example? This cannot be undone.')) return
        assistant.abandonAll()
        setMainEditor(null); setActiveEditor(null); setSelectedIds([]); setTool(null); setImageError(''); setDoc(createDocument())
      }}>Reset to example</button>}
      <div className={`save-status ${writable ? status : 'reading'}`} role="status"><span className="status-dot" />
        <span className="save-message">{!writable ? 'Reading local draft' : status === 'saved' ? 'Saved in this browser' : status === 'saving' ? 'Saving locally…' : 'Local save failed'}</span>
        {writable && status === 'error' && <button onClick={() => setDoc({ ...doc })}>Retry</button>}
      </div>
      <div className="header-zoom" ref={setZoomHost} />
      <DocumentFiles doc={doc} active={editable} onImport={writable && !mobile ? imported => { assistant.abandonAll(); onImport(imported) } : undefined} />
      {editable && <button className="view-settings-toggle" aria-label="AI assistant" aria-expanded={assistant.open} onClick={() => assistant.setOpen(!assistant.open)}>AI{assistant.tasks.length ? ` · ${assistant.tasks.length}` : ''}</button>}
      {editable && <button className="view-settings-toggle" aria-label="Document settings" aria-expanded={documentSettingsOpen && !viewSettingsOpen}
        aria-controls="document-settings" onClick={() => { history.boundary(); setDocumentSettingsOpen(!documentSettingsOpen || viewSettingsOpen); setViewSettingsOpen(false); assistant.setOpen(false) }}>Document</button>}
      <button className="view-settings-toggle" aria-label="View settings" aria-expanded={viewSettingsOpen}
        aria-controls="view-settings" onClick={() => { history.boundary(); setViewSettingsOpen(!viewSettingsOpen); assistant.setOpen(false) }}>View</button>
      {!mobile && (writable ? <div className="mode-switch" role="group" aria-label="Document mode">
        <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>Edit</button>
        <button aria-pressed={mode === 'read'} onClick={() => setMode('read')}>Read</button>
      </div> : <button className="reader-return"
        title={blocked ? 'This draft is being edited in another tab. Try to acquire editing access.' : 'Edit this local draft'}
        onClick={onTryEditing}>Try editing</button>)}
    </header>

    {!editable && writable && status === 'error' && <div className="image-error" role="alert">
      <span>Local save failed</span><button onClick={() => setDoc({ ...doc })}>Retry</button>
    </div>}

    {editable && <Toolbar editor={activeEditor} canInsert={!!mainEditor} imageLoading={imageLoading}
      canAIParagraphs={!!mainEditor && !selectedIds.length}
      onAIParagraphs={() => { setTool(null); reserveSelection() }}
      onAIObject={() => {
        if (selectedIds.length === 1) { setTool(null); reserveSelection() }
        else { setTool(tool === 'ai' ? null : 'ai'); setSelectedIds([]) }
      }}
      theme={doc.theme} onPalette={() => openThemeClass('palette')} tool={tool} canUndo={history.canUndo} canRedo={history.canRedo} undo={history.undo} redo={history.redo}
      onInsert={(kind, columns, rows) => {
        if (kind === 'text' || kind === 'rectangle' || kind === 'ellipse' || kind === 'line' || kind === 'label') {
          setTool(tool === kind ? null : kind); setSelectedIds([])
        } else {
          setTool(null)
          if (kind === 'image') chooseImage()
          else if (kind === 'html') chooseWidgetScreenshot()
          else addObject(kind, columns, rows)
        }
      }} />}
    <input ref={imageInput} type="file" hidden aria-label="Image file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file && imageTarget.current) void uploadImages([file], imageTarget.current) }} />
    {imageError && <div className="image-error" role="alert">{imageError}<button aria-label="Dismiss image error" onClick={() => setImageError('')}>×</button></div>}
    {editable && assistant.notice && <div className="image-error" role="alert">{assistant.notice}<button aria-label="Dismiss AI notice" onClick={() => assistant.setNotice('')}>×</button></div>}

    <main className={`workspace ${showInspector ? '' : 'reader'} ${editable && assistant.open ? 'with-ai' : editable && documentSettingsOpen && !viewSettingsOpen ? 'with-document-settings' : ''}`}>
      <DocumentCanvas key={doc.id} doc={doc} editable={editable} minimap={showMinimap} minimapSize={settings.minimapSize} zoomHost={zoomHost}
        lockedIds={assistant.lockedIds} onAICreate={createAIArea}
        aiReview={{ tasks: assistant.tasks, mainActive: !selectedIds.length && activeEditor === mainEditor,
          selectText: () => { setSelectedIds([]); setActiveEditor(mainEditor) }, accept: assistant.accept, discard: assistant.discard, stop: assistant.stop,
          toggle: id => { const task = assistant.tasks.find(task => task.id === id)!; assistant.update(id, { preview: !task.preview }) }, open: () => assistant.setOpen(true) }}
        aiWidgetIds={new Set(Object.keys(assistant.runs))}
        widgetRuns={Object.fromEntries(doc.floating.map(object => [object.id, (widgetRuns[object.id] ?? 0) + (assistant.runs[object.id] ?? 0)]))} tool={tool} onToolChange={setTool} selectedIds={selectedIds} onSelect={ids => { setSelectedIds(ids); if (!ids.length) setActiveEditor(mainEditor) }}
        onActions={(value: CanvasActions) => { actions.current = value }} onFloatingChange={updateFloating}
        onMainReady={editor => { setMainEditor(editor); setActiveEditor(editor) }} onActive={setActiveEditor}
        onMainChange={(content, merges, shift) => setDoc(current => current && replaceMainContent(current, content, merges, shift))}
        onNoteChange={updateObject} onDropImages={(files, position) => void uploadImages(files, { documentId: doc.id, anchorId: position.anchorId, kind: 'image' }, position)} />
      {editable && assistant.open ? <AssistantPanel assistant={assistant} onDraw={() => { setTool('ai'); setSelectedIds([]) }}
        onSelection={reserveSelection} canSelect={selectedIds.length === 1 || !!mainEditor && !selectedIds.length} />
      : editable && documentSettingsOpen && !viewSettingsOpen ? <DocumentSettings doc={doc} tab={settingsTab} onTab={setSettingsTab}
        selectedClass={themeClass} onClass={setThemeClass} onChange={setDoc} onClose={() => { history.boundary(); setDocumentSettingsOpen(false) }} />
      : showInspector && <aside className="inspector" id="view-settings" aria-label={viewSettingsOpen || !editable ? 'View settings' : 'Selection inspector'}>
        <div className="inspector-heading">{viewSettingsOpen || !editable ? 'VIEW SETTINGS' : itemType}
          {viewSettingsOpen && <button aria-label="Close view settings" onClick={() => setViewSettingsOpen(false)}>×</button>}
        </div>
        {(viewSettingsOpen || !editable) && <GlobalSettings settings={settings} onChange={updateSettings} saveError={settingsSaveError} />}
        {editable && !viewSettingsOpen && <>
        {selectedObject && assistant.lockedIds.has(selectedObject.id) ? <section className="panel-section"><h2>AI content reservation</h2><p className="hint">You can move this object, and resize it before its first request. Accept or discard to edit its content.</p><button onClick={() => assistant.setOpen(true)}>Open AI task</button></section> : <>
        {!selectedObject && !['code', 'list'].includes(selection?.semantic) && <section className="panel-section"><h2>Text & space</h2><p className="hint">Hold Alt and drag between paragraphs to add room. Drag inside a gap or its first text line below to resize it; pull up to close it. Drag empty space or either side gutter to select objects.</p></section>}
        {selection?.semantic === 'code' && <section className="panel-section"><h2>Code block</h2><p className="hint">Plain text with preserved whitespace. Enter inserts a newline; Tab inserts two spaces. Ctrl/⌘Enter starts a Body paragraph after this block.</p></section>}
        {selection?.semantic === 'list' && <section className="panel-section"><h2>List item · Level {selection.listLevel + 1}</h2><p className="hint">Each item is independent. Enter creates an item at the same level; Shift+Enter adds a line within this item. Tab / Shift+Tab changes indentation. Backspace at the start decreases the level, or returns a top-level item to Body.</p></section>}
        {selectedObject && <FloatingInspector object={selectedObject} count={selectedIds.length} theme={doc.theme} defaultFontSize={doc.theme.defaults.size}
          targetKind={selectedObject.kind === 'label' && selectedObject.attachment ? doc.floating.find(object => object.id === selectedObject.attachment?.targetId)?.kind : undefined}
          onChange={patch => updateObject(selectedObject.id, patch)} onAction={action => actions.current?.[action]()} onFront={() => reorder(true)} onBack={() => reorder(false)}
          onHistoryBegin={history.begin} onHistoryEnd={history.boundary} imageLoading={imageLoading} onTheme={openThemeClass}
          maxWidth={Math.max(16, doc.width - selectedObject.x - 2)} onWidgetRun={runWidget} onReplaceScreenshot={object => chooseWidgetScreenshot(object)} />}
        {selectedIds.length === 1 && selectedObject?.kind === 'image' && <section className="panel-section">
          <h2>Selected image</h2>
          <label>Image description
            <input type="text" value={selectedObject.alt} onFocus={() => history.begin(`description:${selectedObject.id}`)} onBlur={history.boundary}
              onChange={event => updateObject(selectedObject.id, { alt: event.target.value })} />
          </label>
          <button disabled={imageLoading} onClick={() => chooseImage(selectedObject)}>{imageLoading ? 'Opening image…' : 'Replace image'}</button>
          <p className="hint">Drag the image or its top, left, or bottom border to move; the right border resizes. Proportions stay intact. Double-click to select or create a label. Image files stay in this browser. Up to 10 MB.</p>
        </section>}
        {selection?.table && <section className="panel-section">
          <h2>Selected table</h2>
          <div className="table-tools" onMouseDown={event => event.preventDefault()}>
            <button disabled={!selection.tableRect} onClick={() => tableCommand(addRowAfter)}>Add row below</button>
            <button disabled={!selection.tableRect} onClick={() => tableCommand(changeColumns())}>Add column after</button>
            <button disabled={!selection.tableRect?.removeRow} onClick={() => tableCommand(deleteRow)}>Remove row</button>
            <button disabled={!selection.tableRect?.removeColumn} onClick={() => tableCommand(changeColumns(true))}>Remove column</button>
          </div>
          <div className="column-alignment" role="group" aria-label="Column alignment" onMouseDown={event => event.preventDefault()}>
            {(['left', 'center', 'right'] as const).map(align => <button key={align} disabled={!selection.tableRect}
              aria-pressed={selection.columnAlignment === align} onClick={() => tableCommand(alignColumns(align))}>{classLabel(align)}</button>)}
          </div>
          <p className="hint">Alignment applies to entire selected columns. Enter / Shift+Enter adds a newline within a cell; Tab / Shift+Tab moves between cells. All cells use the Table style; bold, palette colors, and decorations remain available.</p>
          <p className="hint">Drag an internal divider to resize adjacent columns without changing table width. The outer right border resizes the whole table proportionally; the top, left, and bottom borders move it. Focus the outer border and press Delete to remove the table.</p>
        </section>}
        {selectedObject?.kind !== 'katex' && selectedObject?.kind !== 'html' && <section className="panel-section">
          <h2>Edit style</h2>
          <div className="style-actions" onMouseDown={event => event.preventDefault()}>
            <button disabled={selectedIds.length > 1 || (selectedObject?.kind !== 'label' && !selection?.paragraph && !selection?.tableRect)} onClick={() => openThemeClass(selectedObject?.kind === 'label' ? 'label' : selection?.semantic || 'body')}>{classLabel(selectedObject?.kind === 'label' ? 'label' : selection?.semantic || 'body')} style…</button>
            <button onClick={() => openThemeClass('palette')}>Document palette…</button>
          </div>
        </section>}
        </>}
        </>}
      </aside>}
    </main>
  </div></HistoryContext>
}
