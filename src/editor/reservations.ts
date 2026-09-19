import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer } from '@tiptap/pm/model'
import type { RefObject } from 'react'
import type { useDocumentHistory } from '../document/history'
import { reviewControls, reviewKey, type AIReview } from '../ai/ReviewControls'

const candidates = new WeakMap<object, number>()
let nextCandidate = 0
function candidateKey(content: object) {
  if (!candidates.has(content)) candidates.set(content, ++nextCandidate)
  return candidates.get(content)
}

export function reservationExtension(history: ReturnType<typeof useDocumentHistory>, id: string, review: RefObject<AIReview | undefined>) {
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
        const selected = new Set<string>()
        if (review.current?.mainActive) state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
          if (node.type.name === 'paragraph' && (state.selection.empty || position + 1 < state.selection.to)) selected.add(node.attrs.id)
          return false
        })
        state.doc.forEach((node, position) => {
          const task = review.current?.tasks.find(task => task.target.kind === 'text' && task.target.blockIds.includes(node.attrs.id))
          if (!task || task.target.kind !== 'text') return
          const ids = task.target.blockIds
          const candidate = task.preview && task.candidate?.content
          const first = position === 0, last = state.doc.lastChild?.attrs.id === ids.at(-1)
          decorations.push(Decoration.node(position, position + node.nodeSize, {
            class: candidate ? 'ai-original-hidden' : 'ai-reserved', 'data-ai-reservation': task.id,
          }))
          if (candidate && node.attrs.id === ids[0]) decorations.push(Decoration.widget(position, view => {
            const root = document.createElement('div')
            root.className = 'ai-text-preview'
            root.contentEditable = 'false'
            root.dataset.aiPreview = task.id
            const select = () => {
              let from = 0, to = 0
              view.state.doc.forEach((block, offset) => {
                if (block.attrs.id === ids[0]) from = offset + 1
                if (block.attrs.id === ids.at(-1)) to = offset + block.nodeSize - 1
              })
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
              review.current!.selectText()
            }
            root.onpointerdown = event => { if (event.button === 0) { event.preventDefault(); select(); view.focus() } }
            root.addEventListener('focusin', select)
            if (first) root.dataset.aiFirst = ''
            if (last) root.dataset.aiLast = ''
            const serializer = DOMSerializer.fromSchema(state.schema)
            for (const [index, paragraph] of candidate.entries()) {
              const element = serializer.serializeNode(state.schema.nodeFromJSON(paragraph)) as HTMLElement
              element.removeAttribute('data-id')
              element.dataset.aiBlock = ids[index] ?? ''
              element.className = 'main-paragraph ai-reserved ai-candidate'
              element.tabIndex = 0
              element.setAttribute('aria-label', 'AI paragraph preview')
              const content = element.tagName === 'PRE' ? element.firstElementChild! : document.createElement('span')
              if (element.tagName !== 'PRE') { content.append(...element.childNodes); element.append(content) }
              content.className = 'paragraph-content'
              root.append(element)
            }
            // Removed anchors follow the final replacement paragraph, as on acceptance.
            for (const id of ids.slice(candidate.length)) {
              const anchor = document.createElement('span'); anchor.dataset.aiBlock = id
              root.lastElementChild!.firstElementChild!.append(anchor)
            }
            return root
          }, { key: `candidate:${task.id}:${candidateKey(candidate)}:${first}:${last}`, side: -1, stopEvent: () => true }))
          if (node.attrs.id === ids[0] && ids.some(id => selected.has(id))) decorations.push(Decoration.widget(position, () => {
            const root = document.createElement('div')
            root.className = 'ai-text-review'
            root.contentEditable = 'false'
            root.append(reviewControls(task, () => review.current!))
            return root
          }, { key: reviewKey(task), side: -2, stopEvent: () => true }))
        })
        return DecorationSet.create(state.doc, decorations)
      } },
    })],
  })
}
