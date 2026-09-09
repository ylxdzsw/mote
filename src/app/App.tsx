import { useEffect, useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import type { Command } from '@tiptap/pm/state'
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, isInTable, selectedRect } from '@tiptap/pm/tables'
import { DocumentCanvas } from '../canvas/DocumentCanvas'
import { blockClasses, createDocument, defaultTheme, inlineClasses, paragraph, replaceMainContent, tableContent, type FloatingObject, type FloatingPatch } from '../document/model'
import { readImage } from '../document/image'
import { loadDraft, saveDraft } from '../document/storage'
import { type ThemeClass } from '../theme/ThemePanel'
import { GlobalSettings, useViewSettings } from './GlobalSettings'
import { DocumentSettings } from './DocumentSettings'
import { HistoryContext, useDocumentHistory } from '../document/history'

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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedObject = doc?.floating.find(object => object.id === selectedId)
  const imageInput = useRef<HTMLInputElement>(null)
  const imageTarget = useRef<{ documentId: string; anchorId: string | null; objectId?: string } | null>(null)
  const [imageError, setImageError] = useState('')
  const [imageLoading, setImageLoading] = useState(false)

  useEffect(() => {
    if (selectedId && !doc?.floating.some(object => object.id === selectedId)) {
      setSelectedId(null); setActiveEditor(mainEditor)
    }
  }, [doc?.floating, selectedId, mainEditor])

  useEffect(() => {
    let cancelled = false
    loadDraft().then(draft => {
      if (!cancelled) {
        if (draft) {
          draft.margins ??= { left: 55, right: 55 }
          if (!draft.theme.defaults) {
            for (const name of blockClasses) draft.theme.blocks[name] = { ...defaultTheme.blocks[name], ...draft.theme.blocks[name] }
            draft.theme.defaults = { ...defaultTheme.defaults }
          }
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
    if (!editable) return
    function keydown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return
      const key = event.key.toLowerCase()
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
        semantic: editor?.getAttributes('paragraph').semantic ?? 'body',
        inline: editor?.getAttributes('semanticText').semantic ?? '',
        spacer: editor?.isActive('spacer') ?? false,
        height: editor?.getAttributes('spacer').height ?? 120,
        table: !!editor?.schema.nodes.table,
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

  function updateObject(id: string, patch: FloatingPatch) {
    setDoc(current => current && ({ ...current, floating: current.floating.map(object => object.id === id ? { ...object, ...patch } : object) }))
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

  if (loadError) return <main className="loading"><h1>Mote</h1><p>Couldn’t open the local draft. Check that browser storage is available.</p><button onClick={() => location.reload()}>Try again</button></main>
  if (!doc) return <main className="loading"><h1>Mote</h1><p>Opening your local draft…</p></main>

  return <HistoryContext value={history}><div className="app">
    <header className="app-header">
      <a className="brand" href="./" aria-label="Mote home"><span className="brand-mark">m</span>Mote</a>
      <div className="document-label">Untitled notebook <span className="version">V0</span></div>
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

    {editable && <div className="toolbar" aria-label="Text editing tools">
      <div className="tool-group">
        <label className="sr-only" htmlFor="paragraph-class">Paragraph class</label>
        <select id="paragraph-class" value={selection?.semantic ?? 'body'} disabled={!selection?.paragraph || selection.table}
          onChange={event => activeEditor?.chain().focus().updateAttributes('paragraph', { semantic: event.target.value }).run()}>
          {blockClasses.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
        </select>
        <label className="sr-only" htmlFor="phrase-class">Phrase class</label>
        <select id="phrase-class" value={selection?.inline ?? ''} disabled={!selection?.paragraph && !selection?.tableRect}
          onChange={event => event.target.value
            ? activeEditor?.chain().focus().setMark('semanticText', { semantic: event.target.value }).run()
            : activeEditor?.chain().focus().unsetMark('semanticText').run()}>
          <option value="">Plain phrase</option>
          {inlineClasses.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
        </select>
        <button disabled={!selection?.paragraph} onMouseDown={event => event.preventDefault()} onClick={() => {
          history.boundary(); setThemeClass((selection?.inline || selection?.semantic || 'body') as ThemeClass)
          setSettingsTab('theme'); setDocumentSettingsOpen(true); setViewSettingsOpen(false)
        }}>Edit class style…</button>
      </div>
      <div className="tool-group">
        <button disabled={!mainEditor || activeEditor !== mainEditor} onMouseDown={event => event.preventDefault()} onClick={addSpacer}>＋ Space</button>
        <button disabled={!mainEditor || activeEditor !== mainEditor} onMouseDown={event => event.preventDefault()} onClick={() => addObject('text')}>＋ Text</button>
        <button disabled={!mainEditor || activeEditor !== mainEditor || imageLoading} onMouseDown={event => event.preventDefault()} onClick={() => chooseImage()}>＋ Image</button>
        <button disabled={!mainEditor || activeEditor !== mainEditor} onMouseDown={event => event.preventDefault()} onClick={() => addObject('table')}>＋ Table</button>
      </div>
      <div className="tool-group history">
        <button aria-label="Undo" title="Undo · Ctrl/⌘Z" disabled={!history.canUndo} onClick={history.undo}>↶</button>
        <button aria-label="Redo" title="Redo · Ctrl/⌘Shift+Z" disabled={!history.canRedo} onClick={history.redo}>↷</button>
      </div>
      <span className="editing-context">{imageLoading ? 'Opening image…' : selectedObject?.kind === 'image' ? 'Floating image' : selection?.table ? 'Table · Body text' : activeEditor === mainEditor ? 'Main text' : 'Floating text'}</span>
    </div>}
    <input ref={imageInput} type="file" hidden aria-label="Image file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadImage(file) }} />
    {imageError && <div className="image-error" role="alert">{imageError}<button aria-label="Dismiss image error" onClick={() => setImageError('')}>×</button></div>}

    <main className={`workspace ${showInspector ? '' : 'reader'} ${editable && documentSettingsOpen && !viewSettingsOpen ? 'with-document-settings' : ''}`}>
      <DocumentCanvas key={doc.id} doc={doc} editable={editable} minimap={showMinimap} minimapSize={settings.minimapSize} zoomHost={zoomHost}
        onMainReady={editor => { setMainEditor(editor); setActiveEditor(editor) }} onActive={setActiveEditor} onSelect={setSelectedId}
        onMainChange={content => setDoc(current => current && replaceMainContent(current, content))}
        onNoteChange={updateObject}
        onNoteRemove={id => {
          setActiveEditor(mainEditor)
          setSelectedId(null)
          setDoc(current => current && ({ ...current, floating: current.floating.filter(note => note.id !== id) }))
        }} />
      {editable && documentSettingsOpen && !viewSettingsOpen ? <DocumentSettings doc={doc} tab={settingsTab} onTab={setSettingsTab}
        selectedClass={themeClass} onClass={setThemeClass} onChange={setDoc} onClose={() => { history.boundary(); setDocumentSettingsOpen(false) }} />
      : showInspector && <aside className="inspector" id="view-settings" aria-label={viewSettingsOpen || !editable ? 'View settings' : 'Selection inspector'}>
        <div className="inspector-heading">{viewSettingsOpen || !editable ? 'VIEW SETTINGS' : 'INSPECTOR'}
          {viewSettingsOpen && <button aria-label="Close view settings" onClick={() => setViewSettingsOpen(false)}>×</button>}
        </div>
        {(viewSettingsOpen || !editable) && <GlobalSettings settings={settings} onChange={updateSettings} saveError={settingsSaveError} />}
        {editable && !viewSettingsOpen && <>
        {!selectedObject && !selection?.spacer && <section className="panel-section"><h2>Text & space</h2><p className="hint">Select an object or a space to adjust it here. Open Document to edit page layout and semantic styles.</p></section>}
        {selectedObject && <section className="panel-section">
          <h2>Selected object</h2>
          <label>Main text flow
            <select value={selectedObject.textFlow ?? 'overlap'} onChange={event => updateObject(selectedObject.id, { textFlow: event.target.value as 'overlap' | 'repel' })}>
              <option value="overlap">Overlap</option>
              <option value="repel">Repel</option>
            </select>
          </label>
          <p className="hint">Repel keeps main-text lines from passing through this object; floating objects do not repel each other.</p>
        </section>}
        {selectedObject?.kind === 'image' && <section className="panel-section">
          <h2>Selected image</h2>
          <label>Image description
            <input type="text" value={selectedObject.alt} onFocus={() => history.begin(`description:${selectedObject.id}`)} onBlur={history.boundary}
              onChange={event => updateObject(selectedObject.id, { alt: event.target.value })} />
          </label>
          <button disabled={imageLoading} onClick={() => chooseImage(selectedObject)}>Replace image</button>
          <p className="hint">Drag the top, left, or bottom border to move; the right border resizes. Proportions stay intact. Focus the object and press Delete to remove it. Image files stay in this browser. Up to 10 MB.</p>
        </section>}
        {selection?.table && <section className="panel-section">
          <h2>Selected table</h2>
          <div className="table-tools" onMouseDown={event => event.preventDefault()}>
            <button disabled={!selection.tableRect} onClick={() => tableCommand(addRowAfter)}>Add row below</button>
            <button disabled={!selection.tableRect} onClick={() => tableCommand(addColumnAfter)}>Add column after</button>
            <button disabled={!selection.tableRect?.removeRow} onClick={() => tableCommand(deleteRow)}>Remove row</button>
            <button disabled={!selection.tableRect?.removeColumn} onClick={() => tableCommand(deleteColumn)}>Remove column</button>
          </div>
          <p className="hint">Click a cell to edit. Tab / Shift+Tab moves between cells. All paragraphs use Body; select a phrase to apply an inline class. Drag the top, left, or bottom border to move; the right border resizes. Focus the outer border and press Delete to remove the table.</p>
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
        <section className="panel-section local-note">
          <h2>Only on this device</h2>
          <p className="hint">Your draft is stored in this browser’s IndexedDB. Clearing site data removes it. There’s no cloud backup.</p>
          <button className="text-button" onClick={() => {
            if (!window.confirm('Replace your local draft with the example? This cannot be undone.')) return
            setMainEditor(null); setActiveEditor(null); setSelectedId(null); setImageError(''); setDoc(createDocument())
          }}>Reset to example</button>
        </section>
        </>}
      </aside>}
    </main>
  </div></HistoryContext>
}
