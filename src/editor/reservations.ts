import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { useDocumentHistory } from '../document/history'

export function reservationExtension(history: ReturnType<typeof useDocumentHistory>, id: string) {
  return Extension.create({
    name: 'aiReservations',
    addProseMirrorPlugins: () => [new Plugin({
      filterTransaction(transaction, state) {
        return !transaction.docChanged || transaction.getMeta('historyRestore')
          || history.guardEditor.current(id, state.doc.toJSON(), transaction.doc.toJSON())
      },
      props: { decorations(state) {
        if (id !== 'main') return DecorationSet.empty
        const decorations: Decoration[] = []
        state.doc.forEach((node, position) => {
          const task = history.lockedBlocks.current[node.attrs.id]
          if (task) decorations.push(Decoration.node(position, position + node.nodeSize, {
            class: 'ai-reserved', 'data-ai-reservation': task, title: 'Reserved by AI — accept or discard to edit',
          }))
        })
        return DecorationSet.create(state.doc, decorations)
      } },
    })],
  })
}
