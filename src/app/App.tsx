import { useEffect, useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { DocumentCanvas } from '../canvas/DocumentCanvas'
import { blockClasses, createDocument, inlineClasses, paragraph, replaceMainContent, type MoteDocument } from '../document/model'
import { loadDraft, saveDraft } from '../document/storage'
import { ThemePanel } from '../theme/ThemePanel'

function useMobile() {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const query = matchMedia('(max-width: 767px)')
    const update = () => setMobile(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return mobile
}

export function App() {
  const [doc, setDoc] = useState<MoteDocument | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [status, setStatus] = useState<'saving' | 'saved' | 'error'>('saving')
  const latest = useRef(doc)
  latest.current = doc
  const [mode, setMode] = useState<'edit' | 'read'>('edit')
  const mobile = useMobile()
  const editable = !mobile && mode === 'edit'
  const [mainEditor, setMainEditor] = useState<Editor | null>(null)
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null)

  useEffect(() => {
    let cancelled = false
    loadDraft().then(draft => {
      if (!cancelled) setDoc(draft ?? createDocument())
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

  const selection = useEditorState({
    editor: activeEditor,
    selector: ({ editor }) => ({
      paragraph: editor?.isActive('paragraph') ?? false,
      semantic: editor?.getAttributes('paragraph').semantic ?? 'body',
      inline: editor?.getAttributes('semanticText').semantic ?? '',
      spacer: editor?.isActive('spacer') ?? false,
      height: editor?.getAttributes('spacer').height ?? 120,
      undo: editor?.can().undo() ?? false,
      redo: editor?.can().redo() ?? false,
    }),
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

  function addNote() {
    if (!mainEditor) return
    const selection = mainEditor.state.selection
    const block = selection instanceof NodeSelection ? selection.node
      : selection.$from.depth ? selection.$from.node(1) : selection.$from.nodeAfter ?? selection.$from.nodeBefore!
    setDoc(current => current && ({
      ...current,
      floating: [...current.floating, {
        id: crypto.randomUUID(), anchorId: block.attrs.id,
        x: Math.max(0, current.width - 112 - 280), y: 32, width: 280,
        content: { type: 'doc', content: [paragraph('A new thought', 'heading'), paragraph('Write something here.', 'caption')] },
      }],
    }))
  }

  if (loadError) return <main className="loading"><h1>Mote</h1><p>Couldn’t open the local draft. Check that browser storage is available.</p><button onClick={() => location.reload()}>Try again</button></main>
  if (!doc) return <main className="loading"><h1>Mote</h1><p>Opening your local draft…</p></main>

  return <div className="app">
    <header className="app-header">
      <a className="brand" href="./" aria-label="Mote home"><span className="brand-mark">m</span>Mote</a>
      <div className="document-label">Untitled notebook <span className="version">V0</span></div>
      <div className={`save-status ${status}`} role="status"><span className="status-dot" />
        {status === 'saved' ? 'Saved in this browser' : status === 'saving' ? 'Saving locally…' : 'Local save failed'}
        {status === 'error' && <button onClick={() => setDoc({ ...doc })}>Retry</button>}
      </div>
      {!mobile ? <div className="mode-switch" aria-label="Document mode">
        <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>Edit</button>
        <button aria-pressed={mode === 'read'} onClick={() => setMode('read')}>Read</button>
      </div> : <span className="mobile-mode">Reading</span>}
    </header>

    {editable && <div className="toolbar" aria-label="Text editing tools">
      <div className="tool-group">
        <label className="sr-only" htmlFor="paragraph-class">Paragraph class</label>
        <select id="paragraph-class" value={selection?.semantic ?? 'body'} disabled={!selection?.paragraph}
          onChange={event => activeEditor?.chain().focus().updateAttributes('paragraph', { semantic: event.target.value }).run()}>
          {blockClasses.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
        </select>
        <label className="sr-only" htmlFor="phrase-class">Phrase class</label>
        <select id="phrase-class" value={selection?.inline ?? ''} disabled={!selection?.paragraph}
          onChange={event => event.target.value
            ? activeEditor?.chain().focus().setMark('semanticText', { semantic: event.target.value }).run()
            : activeEditor?.chain().focus().unsetMark('semanticText').run()}>
          <option value="">Plain phrase</option>
          {inlineClasses.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
        </select>
      </div>
      <div className="tool-group">
        <button disabled={!mainEditor || activeEditor !== mainEditor} onMouseDown={event => event.preventDefault()} onClick={addSpacer}>＋ Space</button>
        <button disabled={!mainEditor || activeEditor !== mainEditor} onMouseDown={event => event.preventDefault()} onClick={addNote}>＋ Anchored text</button>
      </div>
      <div className="tool-group history">
        <button aria-label="Undo text edit" title="Undo text edit" disabled={!selection?.undo} onMouseDown={event => event.preventDefault()} onClick={() => activeEditor?.chain().focus().undo().run()}>↶</button>
        <button aria-label="Redo text edit" title="Redo text edit" disabled={!selection?.redo} onMouseDown={event => event.preventDefault()} onClick={() => activeEditor?.chain().focus().redo().run()}>↷</button>
      </div>
      <span className="editing-context">{activeEditor === mainEditor ? 'Main text' : 'Floating text'}</span>
    </div>}

    <main className={`workspace ${editable ? '' : 'reader'}`}>
      <DocumentCanvas key={doc.id} doc={doc} editable={editable}
        onMainReady={editor => { setMainEditor(editor); setActiveEditor(editor) }} onActive={setActiveEditor}
        onMainChange={content => setDoc(current => current && replaceMainContent(current, content))}
        onNoteChange={(id, patch) => setDoc(current => current && ({ ...current, floating: current.floating.map(note => note.id === id ? { ...note, ...patch } : note) }))}
        onNoteRemove={id => {
          setActiveEditor(mainEditor)
          setDoc(current => current && ({ ...current, floating: current.floating.filter(note => note.id !== id) }))
        }} />
      {editable && <aside className="inspector" aria-label="Document settings">
        <div className="inspector-heading">NOTEBOOK SETTINGS</div>
        <section className="panel-section">
          <h2>Document</h2>
          <label>Page width <output>{doc.width}px</output>
            <input aria-label="Document width" type="range" min="480" max="1200" step="20" value={doc.width}
              onChange={event => setDoc({ ...doc, width: Number(event.target.value) })} />
          </label>
          <p className="hint">Reading mode scales the page to fit, keeping its spatial layout.</p>
        </section>
        {selection?.spacer && <section className="panel-section">
          <h2>Selected space</h2>
          <label>Height <output>{selection.height}px</output>
            <input aria-label="Spacer height" type="range" min="24" max="480" step="8" value={selection.height}
              onChange={event => activeEditor?.chain().focus().updateAttributes('spacer', { height: Number(event.target.value) }).run()} />
          </label>
          <button onClick={() => activeEditor?.chain().focus().deleteSelection().run()}>Remove space</button>
        </section>}
        <ThemePanel theme={doc.theme} onChange={theme => setDoc({ ...doc, theme })} />
        <section className="panel-section local-note">
          <h2>Only on this device</h2>
          <p className="hint">Your draft is stored in this browser’s IndexedDB. Clearing site data removes it. There’s no cloud backup.</p>
          <button className="text-button" onClick={() => {
            if (!window.confirm('Replace your local draft with the example? This cannot be undone.')) return
            setMainEditor(null); setActiveEditor(null); setDoc(createDocument())
          }}>Reset to example</button>
        </section>
      </aside>}
    </main>
  </div>
}
