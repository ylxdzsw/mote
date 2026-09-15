import { useEffect, useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import type { Command } from '@tiptap/pm/state'
import { addRowAfter, deleteRow, isInTable, selectedRect } from '@tiptap/pm/tables'
import { DocumentCanvas, type CanvasActions } from '../canvas/DocumentCanvas'
import { createDocument, paragraph, replaceMainContent, tableContent, type FloatingObject, type FloatingPatch, type MoteDocument } from '../document/model'
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
import './floating-controls.css'
import './embeds.css'

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
  const [status, setStatus] = useState<'saving' | 'saved' | 'error'>('saving')
  const latest = useRef(doc)
  latest.current = doc
  const [mode, setMode] = useState<'edit' | 'read'>('edit')
  const mobile = useMedia('(max-width: 767px)')
  const smallScreen = useMedia('(max-width: 1050px)')
  const editable = writable && !mobile && mode === 'edit'
  const { settings, update: updateSettings, saveError: settingsSaveError } = useViewSettings()
  const [viewSettingsOpen, setViewSettingsOpen] = useState(false)
  const [documentSettingsOpen, setDocumentSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'layout' | 'theme'>('layout')
  const [themeClass, setThemeClass] = useState<ThemeClass>('defaults')
  const showInspector = editable || viewSettingsOpen
  const showMinimap = settings.minimap === 'show' || (settings.minimap === 'auto' && !smallScreen)
  const [mainEditor, setMainEditor] = useState<Editor | null>(null)
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null)
  const [zoomHost, setZoomHost] = useState<HTMLDivElement | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [tool, setTool] = useState<'rectangle' | 'ellipse' | 'line' | 'label' | null>(null)
  const [widgetRuns, setWidgetRuns] = useState<Record<string, number>>({})
  const actions = useRef<CanvasActions | null>(null)
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
      if (!editable || event.isComposing) return
      if (key !== 'z' && key !== 'y') return
      const target = event.target as HTMLElement
      if (target.matches('textarea, input:not([type=range]):not([type=color]):not([type=checkbox])')) return
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
        inline: editor?.getAttributes('semanticText').semantic ?? '',
        table: !!editor?.schema.nodes.table,
        columnAlignment: rect && columnAlignment(editor!.state),
        tableRect: rect && { removeRow: rect.bottom - rect.top < rect.map.height, removeColumn: rect.right - rect.left < rect.map.width },
      }
    },
  })

  function addSpacer() {
    if (!mainEditor) return
    const { selection } = mainEditor.state
    const position = selection instanceof NodeSelection ? selection.to
      : selection.$from.depth ? selection.$from.after(1) : selection.from
    const node = mainEditor.schema.nodes.spacer.create({ id: crypto.randomUUID(), height: 120 })
    const transaction = mainEditor.state.tr.insert(position, node).setMeta('historyBoundary', true)
    mainEditor.view.dispatch(transaction)
    mainEditor.commands.focus()
    setActiveEditor(mainEditor)
  }

  function anchorId() {
    if (!mainEditor) return
    const selection = mainEditor.state.selection
    const block = selection instanceof NodeSelection ? selection.node
      : selection.$from.depth ? selection.$from.node(1) : selection.$from.nodeAfter ?? selection.$from.nodeBefore!
    return block.attrs.id as string
  }

  function addObject(kind: 'text' | 'table' | 'katex') {
    const anchor = anchorId()
    if (!anchor) return
    const id = crypto.randomUUID()
    const object = kind === 'katex' ? {
      id, kind, anchorId: anchor, x: 0, y: 32, width: 340, textFlow: 'overlap' as const, latex: 'E = mc^2',
    } : {
      id, anchorId: anchor, kind,
      x: 0, y: 32, width: 340, textFlow: 'overlap' as const,
      content: kind === 'table' ? tableContent() : { type: 'doc', content: [paragraph('A new thought', 'heading'), paragraph('Write something here.', 'caption')] },
    }
    setDoc(current => {
      if (!current) return current
      const width = kind === 'katex' ? Math.min(340, current.width - current.margins.left - current.margins.right) : 340
      return { ...current, floating: [...current.floating, { ...object, width, x: Math.max(current.margins.left, current.width - current.margins.right - width) }] }
    })
    if (kind === 'katex') { setSelectedIds([id]); setActiveEditor(null) }
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

  async function uploadImage(file: File) {
    const target = imageTarget.current!
    let createdWidgetId = ''
    setImageLoading(true)
    setImageError('')
    try {
      const src = await readImage(file)
      setDoc(current => {
        if (!current || current.id !== target.documentId) return current
        if (target.objectId) return { ...current, floating: current.floating.map(object => object.id === target.objectId
          ? target.kind === 'widget' && object.kind === 'html' ? { ...object, screenshot: src } : { ...object, src }
          : object) }
        const anchor = target.anchorId === null || current.content.content!.some(node => node.attrs?.id === target.anchorId)
          ? target.anchorId : current.content.content![0].attrs!.id as string
        if (target.kind === 'widget') {
          const id = crypto.randomUUID()
          const width = Math.min(340, current.width - current.margins.left - current.margins.right)
          createdWidgetId = id
          return { ...current, floating: [...current.floating, {
            id, kind: 'html', anchorId: anchor,
            x: Math.max(current.margins.left, current.width - current.margins.right - width), y: 32, width, height: 220, textFlow: 'overlap' as const,
            html: DEFAULT_WIDGET_HTML, screenshot: src, alt: file.name.replace(/\.[^.]+$/, ''),
          }] }
        }
        return { ...current, floating: [...current.floating, {
          id: crypto.randomUUID(), kind: 'image', anchorId: anchor,
          x: Math.max(current.margins.left, current.width - current.margins.right - 340), y: 32, width: 340, textFlow: 'overlap' as const,
          src, alt: file.name.replace(/\.[^.]+$/, ''),
        }] }
      })
      if (createdWidgetId) { setSelectedIds([createdWidgetId]); setActiveEditor(null); setTool(null) }
    } catch (error) { setImageError((error as Error).message) }
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

  if (!doc) return <main className="loading"><h1>Mote</h1><p>Opening your local draft…</p></main>

  const itemType = selectedIds.length > 1 ? `${selectedIds.length} floating objects` : selectedObject
    ? selectedObject.kind === 'image' ? 'Floating image' : selectedObject.kind === 'table' ? 'Floating table' : selectedObject.kind === 'rectangle' ? 'Rectangle' : selectedObject.kind === 'ellipse' ? 'Ellipse' : selectedObject.kind === 'line' ? 'Line' : selectedObject.kind === 'label' ? 'Label' : selectedObject.kind === 'katex' ? 'KaTeX' : selectedObject.kind === 'html' ? 'HTML widget' : 'Floating text'
    : 'Main text'

  return <HistoryContext value={history}><div className="app">
    <header className="app-header">
      <a className="brand" href="./" aria-label="Mote home"><span className="brand-mark">m</span>Mote</a>
      <div className="document-label">Untitled notebook <span className="version">V0</span></div>
      {editable && <button className="reset-example" onClick={() => {
        if (!window.confirm('Replace your local draft with the example? This cannot be undone.')) return
        setMainEditor(null); setActiveEditor(null); setSelectedIds([]); setTool(null); setImageError(''); setDoc(createDocument())
      }}>Reset to example</button>}
      <div className={`save-status ${writable ? status : 'reading'}`} role="status"><span className="status-dot" />
        <span className="save-message">{!writable ? 'Reading local draft' : status === 'saved' ? 'Saved in this browser' : status === 'saving' ? 'Saving locally…' : 'Local save failed'}</span>
        {writable && status === 'error' && <button onClick={() => setDoc({ ...doc })}>Retry</button>}
      </div>
      <div className="header-zoom" ref={setZoomHost} />
      <DocumentFiles doc={doc} onImport={writable && !mobile ? onImport : undefined} />
      {editable && <button className="view-settings-toggle" aria-label="Document settings" aria-expanded={documentSettingsOpen && !viewSettingsOpen}
        aria-controls="document-settings" onClick={() => { history.boundary(); setDocumentSettingsOpen(!documentSettingsOpen || viewSettingsOpen); setViewSettingsOpen(false) }}>Document</button>}
      <button className="view-settings-toggle" aria-label="View settings" aria-expanded={viewSettingsOpen}
        aria-controls="view-settings" onClick={() => { history.boundary(); setViewSettingsOpen(!viewSettingsOpen) }}>View</button>
      {!mobile && writable ? <div className="mode-switch" aria-label="Document mode">
        <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>Edit</button>
        <button aria-pressed={mode === 'read'} onClick={() => setMode('read')}>Read</button>
      </div> : <span className="mobile-mode">Reading</span>}
    </header>

    {!writable && (blocked || !mobile) && <div className="draft-notice" role="status">
      <span>{blocked ? 'This draft is being edited in another tab.' : 'This tab is reading the local draft.'}</span>
      {!mobile && <button onClick={onTryEditing}>Try editing</button>}
    </div>}

    {editable && <Toolbar editor={activeEditor} canInsert={!!mainEditor && activeEditor === mainEditor} imageLoading={imageLoading}
      theme={doc.theme} tool={tool} canUndo={history.canUndo} canRedo={history.canRedo} undo={history.undo} redo={history.redo}
      onInsert={kind => {
        if (kind === 'rectangle' || kind === 'ellipse' || kind === 'line' || kind === 'label') {
          setTool(tool === kind ? null : kind); setSelectedIds([])
        } else {
          setTool(null)
          if (kind === 'space') addSpacer()
          else if (kind === 'image') chooseImage()
          else if (kind === 'html') chooseWidgetScreenshot()
          else if (kind === 'katex') addObject(kind)
          else addObject(kind)
        }
      }} />}
    <input ref={imageInput} type="file" hidden aria-label="Image file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadImage(file) }} />
    {imageError && <div className="image-error" role="alert">{imageError}<button aria-label="Dismiss image error" onClick={() => setImageError('')}>×</button></div>}

    <main className={`workspace ${showInspector ? '' : 'reader'} ${editable && documentSettingsOpen && !viewSettingsOpen ? 'with-document-settings' : ''}`}>
      <DocumentCanvas key={doc.id} doc={doc} editable={editable} minimap={showMinimap} minimapSize={settings.minimapSize} zoomHost={zoomHost}
        widgetRuns={widgetRuns} tool={tool} onToolChange={setTool} selectedIds={selectedIds} onSelect={ids => { setSelectedIds(ids); if (!ids.length) setActiveEditor(mainEditor) }}
        onActions={(value: CanvasActions) => { actions.current = value }} onFloatingChange={updateFloating}
        onMainReady={editor => { setMainEditor(editor); setActiveEditor(editor) }} onActive={setActiveEditor}
        onMainChange={(content, merges) => setDoc(current => current && replaceMainContent(current, content, merges))}
        onNoteChange={updateObject} />
      {editable && documentSettingsOpen && !viewSettingsOpen ? <DocumentSettings doc={doc} tab={settingsTab} onTab={setSettingsTab}
        selectedClass={themeClass} onClass={setThemeClass} onChange={setDoc} onClose={() => { history.boundary(); setDocumentSettingsOpen(false) }} />
      : showInspector && <aside className="inspector" id="view-settings" aria-label={viewSettingsOpen || !editable ? 'View settings' : 'Selection inspector'}>
        <div className="inspector-heading">{viewSettingsOpen || !editable ? 'VIEW SETTINGS' : itemType}
          {viewSettingsOpen && <button aria-label="Close view settings" onClick={() => setViewSettingsOpen(false)}>×</button>}
        </div>
        {(viewSettingsOpen || !editable) && <GlobalSettings settings={settings} onChange={updateSettings} saveError={settingsSaveError} />}
        {editable && !viewSettingsOpen && <>
        {!selectedObject && !['code', 'list'].includes(selection?.semantic) && <section className="panel-section"><h2>Text & space</h2><p className="hint">Hold Alt and drag between paragraphs to add room. Drag inside a gap or its first text line below to resize it; pull up to close it. Drag empty space or either side gutter to select objects.</p></section>}
        {selection?.semantic === 'code' && <section className="panel-section"><h2>Code block</h2><p className="hint">Plain text with preserved whitespace. Enter inserts a newline; Tab inserts two spaces. Ctrl/⌘Enter starts a Body paragraph after this block.</p></section>}
        {selection?.semantic === 'list' && <section className="panel-section"><h2>List item · Level {selection.listLevel + 1}</h2><p className="hint">Each item is independent. Enter creates an item at the same level; Shift+Enter adds a line within this item. Tab / Shift+Tab changes indentation. Backspace at the start decreases the level, or returns a top-level item to Body.</p></section>}
        {selectedObject && <FloatingInspector object={selectedObject} count={selectedIds.length} themeColor={doc.theme.defaults.color}
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
          <p className="hint">Alignment applies to entire selected columns. Enter / Shift+Enter adds a newline within a cell; Tab / Shift+Tab moves between cells. All cells use the Table style; inline classes remain available.</p>
          <p className="hint">Drag an internal divider to resize adjacent columns without changing table width. The outer right border resizes the whole table proportionally; the top, left, and bottom borders move it. Focus the outer border and press Delete to remove the table.</p>
        </section>}
        {selectedObject?.kind !== 'katex' && selectedObject?.kind !== 'html' && <section className="panel-section">
          <h2>Edit style</h2>
          <div className="style-actions" onMouseDown={event => event.preventDefault()}>
            <button disabled={selectedIds.length > 1 || (selectedObject?.kind !== 'label' && !selection?.paragraph && !selection?.tableRect)} onClick={() => openThemeClass(selectedObject?.kind === 'label' ? 'label' : selection?.semantic || 'body')}>{classLabel(selectedObject?.kind === 'label' ? 'label' : selection?.semantic || 'body')} style…</button>
            <button disabled={!activeEditor?.isEditable || selection?.semantic === 'code' || (!selection?.paragraph && !selection?.tableRect)}
              onClick={() => openThemeClass(selection?.inline || 'primary')}>{classLabel(selection?.inline || 'primary')} style…</button>
          </div>
        </section>}
        </>}
      </aside>}
    </main>
  </div></HistoryContext>
}
