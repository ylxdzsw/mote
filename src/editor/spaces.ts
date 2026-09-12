import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const spaceRemovalThreshold = 12
export interface SpaceMerge { id: string; anchorId: string; offset: number }
export interface SpacePreview { from: number; height: number; existing: boolean }
interface SpaceLayout { decorations: DecorationSet; merges: SpaceMerge[] }
export const spaceLayoutKey = new PluginKey<SpaceLayout>('spaceLayout')

export const Spaces = Extension.create({
  name: 'spaces',
  addProseMirrorPlugins: () => [new Plugin<SpaceLayout>({
    key: spaceLayoutKey,
    state: {
      init: () => ({ decorations: DecorationSet.empty, merges: [] }),
      apply(transaction, previous) {
        const meta = transaction.getMeta(spaceLayoutKey) as { preview?: SpacePreview | null; merges?: SpaceMerge[] } | undefined
        let decorations = previous.decorations.map(transaction.mapping, transaction.doc)
        if (meta && 'preview' in meta) {
          const preview = meta.preview
          decorations = !preview ? DecorationSet.empty : DecorationSet.create(transaction.doc, [preview.existing
            ? Decoration.node(preview.from, preview.from + 1, { style: `--spacer-preview-height: ${preview.height}px` })
            : Decoration.widget(preview.from, () => {
              const element = document.createElement('div')
              element.dataset.spacer = ''
              element.dataset.spacePreview = ''
              element.style.setProperty('--spacer-height', `${preview.height}px`)
              return element
            }, { side: -1 })])
        }
        const merges = transaction.docChanged && !transaction.getMeta('appendedTransaction') ? [] : previous.merges
        return { decorations, merges: [...merges, ...(meta?.merges ?? [])] }
      },
    },
    appendTransaction(transactions, _old, state) {
      if (!transactions.some(transaction => transaction.docChanged || transaction.getMeta('normalizeSpaces'))) return
      const transaction = state.tr
      const merges: SpaceMerge[] = []
      let preceding: { from: number; id: string; height: number } | null = null
      state.doc.forEach((node, from) => {
        if (node.type.name !== 'spacer') { preceding = null; return }
        if (!preceding) { preceding = { from, id: node.attrs.id, height: node.attrs.height }; return }
        merges.push({ id: node.attrs.id, anchorId: preceding.id, offset: preceding.height })
        preceding.height += node.attrs.height
        transaction.setNodeAttribute(transaction.mapping.map(preceding.from), 'height', preceding.height)
        transaction.delete(transaction.mapping.map(from), transaction.mapping.map(from + node.nodeSize))
      })
      if (merges.length) return transaction.setMeta(spaceLayoutKey, { merges })
    },
    props: { decorations: state => spaceLayoutKey.getState(state)!.decorations },
  })],
})
