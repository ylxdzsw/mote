import { useEffect, useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor, JSONContent } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import type { Command } from '@tiptap/pm/state'
import { addRowAfter, deleteRow, isInTable, selectedRect } from '@tiptap/pm/tables'
import { DocumentCanvas, type CanvasActions } from '../canvas/DocumentCanvas'
import { themeBlockClasses, createDocument, defaultTheme, inlineClasses, paragraph, replaceMainContent, tableContent, type FloatingObject, type FloatingPatch } from '../document/model'
import { normalizeTableContent } from '../document/table'
import { alignColumns, changeColumns, columnAlignment } from '../editor/table'
import { readImage } from '../document/image'
import { loadDraft, saveDraft } from '../document/storage'
import { classLabel, type ThemeClass } from '../theme/ThemePanel'
import { GlobalSettings, useViewSettings } from './GlobalSettings'
import { DocumentSettings } from './DocumentSettings'
import { HistoryContext, useDocumentHistory } from '../document/history'
import { Toolbar } from './Toolbar'
import { FloatingInspector } from './FloatingInspector'
import './floating-controls.css'

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const update = () => setMatches(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

export function App() {
  const history = useDocumentHistory()
  const { doc, setDoc } = history
  const [loadError, setLoadError] = useState(false)
  const [status, setStatus] = useState<'saving' | 'saved' | 'error'>('saving')
  const latest = useRef(doc)
  latest.current = doc
  const [mode, setMode] = useState<'edit' | 'read'>('edit')
  const mobile = useMedia('(max-width: 767px)')
  const smallScreen = useMedia('(max-width: 1050px)')
  const editable = !mobile && mode === 'edit'
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
  const actions = useRef<CanvasActions | null>(null)
  const selectedObject = doc?.floating.find(object => object.id === selectedIds[0])
  const imageInput = useRef<HTMLInputElement>(null)
  const imageTarget = useRef<{ documentId: string; anchorId: string | null; objectId?: string } | null>(null)
  const [imageError, setImageError] = useState('')
  const [imageLoading, setImageLoading] = useState(false)

  useEffect(() => {
    if (selectedIds.some(id => !doc?.floating.some(object => object.id === id))) {
      setSelectedIds(ids => ids.filter(id => doc?.floating.some(object => object.id === id))); setActiveEditor(mainEditor)
    }
  }, [doc?.floating, selectedIds, mainEditor])

  useEffect(() => {
    let cancelled = false
    loadDraft().then(draft => {
      if (!cancelled) {
        if (draft) {
          draft.margins ??= { left: 55, right: 55 }
          if (!draft.theme.defaults) {
            for (const name of themeBlockClasses) draft.theme.blocks[name] = { ...defaultTheme.blocks[name], ...draft.theme.blocks[name] }
            draft.theme.defaults = { ...defaultTheme.defaults }
          }
          for (const name of themeBlockClasses) draft.theme.blocks[name] ??= { ...defaultTheme.blocks[name] }
          const inline = draft.theme.inline as typeof draft.theme.inline & { emphasis?: typeof draft.theme.inline.primary }
          if (inline.emphasis) { inline.primary ??= inline.emphasis; delete inline.emphasis }
          for (const name of inlineClasses) inline[name] ??= { ...defaultTheme.inline[name] }
          function renameEmphasis(node: JSONContent) {
            for (const mark of node.marks ?? []) if (mark.type === 'semanticText' && mark.attrs?.semantic === 'emphasis') mark.attrs.semantic = 'primary'
            node.content?.forEach(renameEmphasis)
          }
          renameEmphasis(draft.content)
          for (const object of draft.floating) if ('content' in object) renameEmphasis(object.content)
          for (const object of draft.floating) if (object.kind === 'table') object.content = normalizeTableContent(object.content)
        }
        setDoc(draft ?? createDocument())
      }
    }).catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!doc) return
    setStatus('saving')
    saveDraft(doc).then(() => {
      if (latest.current === doc) setStatus('saved')
    }).catch(() => { if (latest.current === doc) setStatus('error') })
  }, [doc])

  useEffect(() => {
    if (status === 'saved') return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [status])

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 's') { event.preventDefault(); event.stopPropagation(); return }
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
        spacer: editor?.isActive('spacer') ?? false,
        height: editor?.getAttributes('spacer').height ?? 120,
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
    const transaction = mainEditor.state.tr.insert(position, node)
    mainEditor.view.dispatch(transaction.setSelection(NodeSelection.create(transaction.doc, position)))
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

  function addObject(kind: 'text' | 'table') {
    const anchor = anchorId()
    if (!anchor) return
    setDoc(current => current && ({
      ...current,
      floating: [...current.floating, {
        id: crypto.randomUUID(), anchorId: anchor, kind,
        x: Math.max(current.margins.left, current.width - current.margins.right - 340), y: 32, width: 340, textFlow: 'overlap',
        content: kind === 'table' ? tableContent() : { type: 'doc', content: [paragraph('A new thought', 'heading'), paragraph('Write something here.', 'caption')] },
      }],
    }))
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
    imageTarget.current = { documentId: doc.id, anchorId: anchor === undefined ? null : anchor, objectId: object?.id }
    setImageError('')
    imageInput.current!.click()
  }

  async function uploadImage(file: File) {
    const target = imageTarget.current!
    setImageLoading(true)
    setImageError('')
    try {
      const src = await readImage(file)
      setDoc(current => {
        if (!current || current.id !== target.documentId) return current
        if (target.objectId) return { ...current, floating: current.floating.map(object => object.id === target.objectId ? { ...object, src } : object) }
        const anchor = target.anchorId === null || current.content.content!.some(node => node.attrs?.id === target.anchorId)
          ? target.anchorId : current.content.content![0].attrs!.id as string
        return { ...current, floating: [...current.floating, {
          id: crypto.randomUUID(), kind: 'image', anchorId: anchor,
          x: Math.max(current.margins.left, current.width - current.margins.right - 340), y: 32, width: 340, textFlow: 'overlap',
          src, alt: file.name.replace(/\.[^.]+$/, ''),
        }] }
      })
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

  if (loadError) return <main className="loading"><h1>Mote</h1><p>Couldn’t open the local draft. Check that browser storage is available.</p><button onClick={() => location.reload()}>Try again</button></main>
  if (!doc) return <main className="loading"><h1>Mote</h1><p>Opening your local draft…</p></main>

  const itemType = selectedIds.length > 1 ? `${selectedIds.length} floating objects` : selectedObject
    ? selectedObject.kind === 'image' ? 'Floating image' : selectedObject.kind === 'table' ? 'Floating table' : selectedObject.kind === 'rectangle' ? 'Rectangle' : selectedObject.kind === 'ellipse' ? 'Ellipse' : selectedObject.kind === 'line' ? 'Line' : selectedObject.kind === 'label' ? 'Label' : 'Floating text'
    : selection?.spacer ? 'Space' : 'Main text'

  return <HistoryContext value={history}><div className="app">
    <header className="app-header">
      <a className="brand" href="./" aria-label="Mote home"><span className="brand-mark">m</span>Mote</a>
      <div className="document-label">Untitled notebook <span className="version">V0</span></div>
      {editable && <button className="reset-example" onClick={() => {
        if (!window.confirm('Replace your local draft with the example? This cannot be undone.')) return
        setMainEditor(null); setActiveEditor(null); setSelectedIds([]); setTool(null); setImageError(''); setDoc(createDocument())
      }}>Reset to example</button>}
      <div className={`save-status ${status}`} role="status"><span className="status-dot" />
        <span className="save-message">{status === 'saved' ? 'Saved in this browser' : status === 'saving' ? 'Saving locally…' : 'Local save failed'}</span>
        {status === 'error' && <button onClick={() => setDoc({ ...doc })}>Retry</button>}
      </div>
      <div className="header-zoom" ref={setZoomHost} />
      {editable && <button className="view-settings-toggle" aria-label="Document settings" aria-expanded={documentSettingsOpen && !viewSettingsOpen}
        aria-controls="document-settings" onClick={() => { history.boundary(); setDocumentSettingsOpen(!documentSettingsOpen || viewSettingsOpen); setViewSettingsOpen(false) }}>Document</button>}
      <button className="view-settings-toggle" aria-label="View settings" aria-expanded={viewSettingsOpen}
        aria-controls="view-settings" onClick={() => { history.boundary(); setViewSettingsOpen(!viewSettingsOpen) }}>View</button>
      {!mobile ? <div className="mode-switch" aria-label="Document mode">
        <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>Edit</button>
        <button aria-pressed={mode === 'read'} onClick={() => setMode('read')}>Read</button>
      </div> : <span className="mobile-mode">Reading</span>}
    </header>

    {editable && <Toolbar editor={activeEditor} canInsert={!!mainEditor && activeEditor === mainEditor} imageLoading={imageLoading}
      theme={doc.theme} tool={tool} canUndo={history.canUndo} canRedo={history.canRedo} undo={history.undo} redo={history.redo}
      onInsert={kind => {
        if (kind === 'rectangle' || kind === 'ellipse' || kind === 'line' || kind === 'label') {
          setTool(tool === kind ? null : kind); setSelectedIds([])
        } else {
          setTool(null)
          if (kind === 'space') addSpacer()
          else if (kind === 'image') chooseImage()
          else addObject(kind)
        }
      }} />}
    <input ref={imageInput} type="file" hidden aria-label="Image file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadImage(file) }} />
    {imageError && <div className="image-error" role="alert">{imageError}<button aria-label="Dismiss image error" onClick={() => setImageError('')}>×</button></div>}

    <main className={`workspace ${showInspector ? '' : 'reader'} ${editable && documentSettingsOpen && !viewSettingsOpen ? 'with-document-settings' : ''}`}>
      <DocumentCanvas key={doc.id} doc={doc} editable={editable} minimap={showMinimap} minimapSize={settings.minimapSize} zoomHost={zoomHost}
        tool={tool} onToolChange={setTool} selectedIds={selectedIds} onSelect={ids => { setSelectedIds(ids); if (!ids.length) setActiveEditor(mainEditor) }}
        onActions={(value: CanvasActions) => { actions.current = value }} onFloatingChange={updateFloating}
        onMainReady={editor => { setMainEditor(editor); setActiveEditor(editor) }} onActive={setActiveEditor}
        onMainChange={content => setDoc(current => current && replaceMainContent(current, content))}
        onNoteChange={updateObject} />
      {editable && documentSettingsOpen && !viewSettingsOpen ? <DocumentSettings doc={doc} tab={settingsTab} onTab={setSettingsTab}
        selectedClass={themeClass} onClass={setThemeClass} onChange={setDoc} onClose={() => { history.boundary(); setDocumentSettingsOpen(false) }} />
      : showInspector && <aside className="inspector" id="view-settings" aria-label={viewSettingsOpen || !editable ? 'View settings' : 'Selection inspector'}>
        <div className="inspector-heading">{viewSettingsOpen || !editable ? 'VIEW SETTINGS' : itemType}
          {viewSettingsOpen && <button aria-label="Close view settings" onClick={() => setViewSettingsOpen(false)}>×</button>}
        </div>
        {(viewSettingsOpen || !editable) && <GlobalSettings settings={settings} onChange={updateSettings} saveError={settingsSaveError} />}
        {editable && !viewSettingsOpen && <>
        {!selectedObject && !selection?.spacer && !['code', 'list'].includes(selection?.semantic) && <section className="panel-section"><h2>Text & space</h2><p className="hint">Select an object or a space to adjust it here. Open Document to edit page layout and semantic styles.</p></section>}
        {selection?.semantic === 'code' && <section className="panel-section"><h2>Code block</h2><p className="hint">Plain text with preserved whitespace. Enter inserts a newline; Tab inserts two spaces. Ctrl/⌘Enter starts a Body paragraph after this block.</p></section>}
        {selection?.semantic === 'list' && <section className="panel-section"><h2>List item · Level {selection.listLevel + 1}</h2><p className="hint">Each item is independent. Enter creates an item at the same level; Shift+Enter adds a line within this item. Tab / Shift+Tab changes indentation. Backspace at the start decreases the level, or returns a top-level item to Body.</p></section>}
        {selectedObject && <FloatingInspector object={selectedObject} count={selectedIds.length} themeColor={doc.theme.defaults.color}
          targetKind={selectedObject.kind === 'label' && selectedObject.attachment ? doc.floating.find(object => object.id === selectedObject.attachment?.targetId)?.kind : undefined}
          onChange={patch => updateObject(selectedObject.id, patch)} onAction={action => actions.current?.[action]()} onFront={() => reorder(true)} onBack={() => reorder(false)}
          onHistoryBegin={history.begin} onHistoryEnd={history.boundary} />}
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
        {selection?.spacer && <section className="panel-section">
          <h2>Selected space</h2>
          <label>Height <output>{Math.round(selection.height)}px</output>
            <input aria-label="Spacer height" type="range" min="24" max={Math.max(480, selection.height)} step="1" value={selection.height}
              onPointerDown={() => history.begin('spacer-height')} onPointerUp={history.boundary} onBlur={history.boundary}
              onKeyDown={() => history.begin('spacer-height')} onKeyUp={history.boundary}
              onChange={event => activeEditor?.commands.updateAttributes('spacer', { height: Number(event.target.value) })} />
          </label>
          <button onClick={() => activeEditor?.chain().focus().deleteSelection().run()}>Remove space</button>
        </section>}
        <section className="panel-section">
          <h2>Edit style</h2>
          <div className="style-actions" onMouseDown={event => event.preventDefault()}>
            <button disabled={selectedIds.length > 1 || (selectedObject?.kind !== 'label' && !selection?.paragraph && !selection?.tableRect)} onClick={() => openThemeClass(selectedObject?.kind === 'label' ? 'label' : selection?.semantic || 'body')}>{classLabel(selectedObject?.kind === 'label' ? 'label' : selection?.semantic || 'body')} style…</button>
            <button disabled={!activeEditor?.isEditable || selection?.semantic === 'code' || (!selection?.paragraph && !selection?.tableRect)}
              onClick={() => openThemeClass(selection?.inline || 'primary')}>{classLabel(selection?.inline || 'primary')} style…</button>
          </div>
        </section>
        </>}
      </aside>}
    </main>
  </div></HistoryContext>
}
