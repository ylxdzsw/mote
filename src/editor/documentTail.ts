import { Extension } from '@tiptap/core'
import { GapCursor } from '@tiptap/pm/gapcursor'
import { Plugin, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const atDocumentTail = (state: EditorState) => state.selection instanceof GapCursor && state.selection.head === state.doc.content.size

export const DocumentTail = Extension.create({
  name: 'documentTail',
  priority: 1100,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (!atDocumentTail(this.editor.state)) return false
        return this.editor.commands.command(({ tr, state }) => {
          const end = tr.doc.content.size
          const paragraph = () => state.schema.nodes.paragraph.create({ id: crypto.randomUUID(), semantic: 'body' })
          tr.insert(end, [paragraph(), paragraph()])
            .setSelection(TextSelection.create(tr.doc, end + 3)).setStoredMarks([]).setMeta('historyBoundary', true).scrollIntoView()
          return true
        })
      },
      Escape: () => {
        if (!atDocumentTail(this.editor.state)) return false
        this.editor.commands.blur()
        return true
      },
    }
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        attributes: state => ({ class: atDocumentTail(state) ? 'has-tail-caret' : '' }),
        decorations: state => {
          const first = state.doc.firstChild
          return this.editor.isEditable && state.doc.childCount === 1 && first?.type.name === 'paragraph' && !first.content.size
            ? DecorationSet.create(state.doc, [Decoration.node(0, first.nodeSize, { 'data-writing-placeholder': 'Start writing…' })])
            : DecorationSet.empty
        },
      },
    })]
  },
})
