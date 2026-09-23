import { Extension } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { RefObject } from 'react'
import type { useDocumentHistory } from '../document/history'
import { blockClasses } from '../document/model'
import { copyParagraphs, paragraphClipboardJSON, parseParagraphs, PARAGRAPH_MIME } from '../document/paragraphClipboard'
import { freshNode, mergePalette, remapPaletteContent, replaceSegment, serializeSegment } from '../document/segment'

interface Range { from: number; to: number }
interface CutRange extends Range { space?: { id: string; offset: number } }
const cutKey = new PluginKey<CutRange | null>('paragraphCut')

// A complete text selection need not include the following paragraph's first character.
export function wholeParagraphs(state: EditorState, caret = false): Range | null {
  const { selection, doc } = state
  if (!(selection instanceof TextSelection)) {
    const slice = selection.content()
    return !slice.openStart && !slice.openEnd && slice.content.childCount && slice.content.content.every(node => node.type.name === 'paragraph')
      ? { from: selection.from, to: selection.to } : null
  }
  const { $from, $to, empty } = selection
  if ($from.parent.type.name !== 'paragraph') return null
  if (empty) return caret ? { from: $from.before(), to: $from.after() } : null
  if ($from.parentOffset !== 0) return null
  let to: number
  if ($to.parentOffset === 0) to = $to.depth ? $to.before() : $to.pos
  else if ($to.parent.type.name === 'paragraph' && $to.parentOffset === $to.parent.content.size) to = $to.after()
  else return null
  const from = $from.before()
  const nodes = doc.slice(from, to).content
  return nodes.childCount && nodes.content.every(node => node.type.name === 'paragraph') ? { from, to } : null
}

export function paragraphClipboard(history: RefObject<ReturnType<typeof useDocumentHistory>>, historyId: string, structural: boolean) {
  return Extension.create({
    name: 'paragraphClipboard',
    priority: 1100,
    addProseMirrorPlugins() {
      let plain = false
      let plainShortcut = false
      const clear = (view: EditorView) => {
        if (cutKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(cutKey, null))
        return false
      }
      const copy = (view: EditorView, event: ClipboardEvent) => {
        if (!view.editable || view.composing || !event.clipboardData) return false
        const range = wholeParagraphs(view.state, true)
        if (!range) return false
        event.preventDefault()
        const { doc, schema } = view.state, source = doc.slice(range.from, range.to)
        if (historyId === 'main' && source.content.content.some(node => history.current.lockedBlocks.current[node.attrs.id])) return true
        const cutting = event.type === 'cut'
        const tr = view.state.tr
        if (cutting) {
          if (structural) tr.delete(range.from, range.to)
          else tr.delete(range.from + 1, range.to - 1)
          if (!history.current.guardEditor.current(historyId, doc.toJSON(), tr.doc.toJSON())) return true
        }
        const content = source.content.content.map(node => ({ ...node.toJSON(), attrs: {
          ...node.attrs, id: node.attrs.id ?? crypto.randomUUID(),
          semantic: blockClasses.includes(node.attrs.semantic) ? node.attrs.semantic : 'body', listLevel: node.attrs.listLevel ?? 0,
        } }))
        const payload = copyParagraphs(history.current.doc!, content), json = serializeSegment(payload)
        // Open edges retain ordinary replacement behavior in other rich-text editors.
        const { dom, text } = view.serializeForClipboard(new Slice(Fragment.from(content.map(node => schema.nodeFromJSON(node))), 1, 1))
        dom.setAttribute('data-mote-paragraphs', json)
        try {
          event.clipboardData.setData(PARAGRAPH_MIME, json)
          event.clipboardData.setData('text/html', dom.outerHTML)
          event.clipboardData.setData('text/plain', text || '\n')
        } catch { return true }
        if (cutting) {
          const from = Math.min(range.from, tr.doc.content.size)
          const placeholder = structural && range.from === 0 && range.to === doc.content.size
          const before = doc.resolve(range.from).nodeBefore, after = doc.resolve(range.to).nodeAfter
          const space = before?.type.name === 'spacer' && after?.type.name === 'spacer' ? { id: before.attrs.id, offset: before.attrs.height } : undefined
          tr.setMeta(cutKey, structural ? { from, to: placeholder ? tr.doc.content.size : from, space } : null)
          view.dispatch(tr.setMeta('historyBoundary', true).scrollIntoView())
        }
        return true
      }
      return [new Plugin<CutRange | null>({
        key: cutKey,
        state: {
          init: () => null,
          apply(tr, previous) {
            if (tr.getMeta(cutKey) !== undefined) return tr.getMeta(cutKey)
            if (previous && tr.getMeta('appendedTransaction')) return { ...previous, from: tr.mapping.map(previous.from, -1), to: tr.mapping.map(previous.to, -1) }
            return tr.docChanged || tr.selectionSet || tr.getMeta('historyRestore') ? null : previous
          },
        },
        props: {
          handleDOMEvents: {
            copy, cut: copy, pointerdown: clear,
            blur: view => { plainShortcut = false; return clear(view) },
            keyup: () => { plainShortcut = false; return false },
            keydown: (view, event) => {
              plainShortcut = event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v'
              return event.key === 'Escape' ? clear(view) : false
            },
          },
          transformPasted: (slice, _view, asText) => { plain = asText; return slice },
          handlePaste(view, event) {
            if (!structural || !view.editable || view.composing || !event.clipboardData) return false
            if (plainShortcut || (plain && event.clipboardData.getData('text/html'))) return false
            const json = paragraphClipboardJSON(event.clipboardData)
            if (!json) return false
            try {
              const payload = parseParagraphs(json)
              const cut = cutKey.getState(view.state)
              if (cut?.space) {
                const doc = history.current.doc!
                const index = doc.content.content!.findIndex(node => node.attrs?.id === cut.space!.id)
                const point = { index, offset: cut.space.offset }
                // Insertion alone needs no measured geometry: retained anchors split by offset.
                const next = replaceSegment(doc, { start: point, end: point }, payload, [], {})
                if (!history.current.guard.current(doc, next)) return true
                const content = view.state.schema.nodeFromJSON(next.content)
                const end = content.content.content.slice(0, index + 1 + payload.content.length).reduce((pos, node) => pos + node.nodeSize, 0)
                const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, content.content)
                view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end - 1)).setMeta('paragraphDocument', next).setMeta('paste', true).scrollIntoView())
                return true
              }
              const { palette, remap } = mergePalette(history.current.doc!, payload)
              const nodes = Fragment.from(payload.content.map(node => view.state.schema.nodeFromJSON(freshNode(remapPaletteContent(node, remap), new Set()))))
              const selection = view.state.selection
              let target = cutKey.getState(view.state) ?? wholeParagraphs(view.state)
              if (!target && selection.empty && selection.$from.parent.type.name === 'paragraph') {
                const { $from } = selection
                target = $from.parent.content.size ? { from: $from.after(), to: $from.after() } : { from: $from.before(), to: $from.after() }
              }
              const tr = view.state.tr
              if (target) {
                tr.replaceWith(target.from, target.to, nodes)
                tr.setSelection(TextSelection.create(tr.doc, target.from + nodes.size - 1))
              } else {
                if (selection.$from.sameParent(selection.$to) && selection.$from.parent.attrs.semantic === 'code') return false
                tr.replaceSelection(new Slice(nodes, 1, 1))
              }
              view.dispatch(tr.setMeta('paragraphPalette', palette).setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView())
            } catch { /* Invalid native data must not fall through to destructive text replacement. */ }
            return true
          },
        },
      })]
    },
  })
}
