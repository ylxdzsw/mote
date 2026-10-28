import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import UniqueID from '@tiptap/extension-unique-id'
import { Gapcursor } from '@tiptap/extensions'
import { Plugin } from '@tiptap/pm/state'
import { blockClasses } from '../document/model'
import { CaptionBehavior, TableParagraph, tableExtensions } from './table'
import { Spaces } from './spaces'
import { ParagraphBehavior } from './paragraphBehavior'
import { inlineMarks } from './inline'
import { DocumentTail } from './documentTail'

const SemanticParagraph = Paragraph.extend({
  addAttributes() {
    return {
      semantic: {
        default: 'body',
        keepOnSplit: false,
        parseHTML: element => {
          const value = element.getAttribute('data-semantic')
          return blockClasses.find(name => name === value) ?? 'body'
        },
        renderHTML: attrs => ({ 'data-semantic': attrs.semantic }),
      },
      listLevel: {
        default: 0,
        parseHTML: element => Math.max(0, parseInt(element.getAttribute('data-list-level') ?? '0') || 0),
        renderHTML: attrs => attrs.semantic === 'list' ? { 'data-list-level': attrs.listLevel, style: `--list-level: ${attrs.listLevel}` } : {},
      },
    }
  },
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: ({ HTMLAttributes }) => ['p', HTMLAttributes, 0],
})

const CaptionParagraph = Paragraph.extend({
  renderHTML: ({ HTMLAttributes }) => ['p', mergeAttributes(HTMLAttributes, { 'data-semantic': 'caption' }), 0],
})

const MainParagraph = SemanticParagraph.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('p')
      dom.className = 'main-paragraph'
      const contentDOM = document.createElement('span')
      contentDOM.className = 'paragraph-content'
      dom.append(contentDOM)
      const attributes = (value: typeof node) => {
        dom.dataset.id = value.attrs.id
        dom.dataset.semantic = value.attrs.semantic
        if (value.attrs.semantic === 'list') {
          dom.dataset.listLevel = value.attrs.listLevel
          dom.style.setProperty('--list-level', value.attrs.listLevel)
        } else {
          delete dom.dataset.listLevel
          dom.style.removeProperty('--list-level')
        }
      }
      attributes(node)
      return {
        dom, contentDOM,
        update(next) {
          if (next.type !== node.type) return false
          attributes(next)
          return true
        },
        // Exclusion geometry belongs to the view, not to editable document content.
        ignoreMutation: mutation => mutation.type !== 'selection' && mutation.target === dom,
      }
    }
  },
})

export const Spacer = Node.create({
  name: 'spacer',
  group: 'block',
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      height: {
        default: 120,
        parseHTML: element => Number(element.getAttribute('data-height')),
        renderHTML: attrs => ({ 'data-height': attrs.height, style: `--spacer-height: ${attrs.height}px` }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-spacer]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-spacer': '', 'aria-label': 'Vertical space' })],
})

export const Flow = Node.create({
  name: 'flow',
  group: 'block',
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      objectId: {
        default: null,
        parseHTML: element => element.getAttribute('data-object-id'),
        renderHTML: attrs => ({ 'data-object-id': attrs.objectId }),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-flow]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-flow': '', contenteditable: 'false' }), ['div', { 'data-flow-mount': '' }]],
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.dataset.flow = ''
      dom.contentEditable = 'false'
      const mount = document.createElement('div')
      mount.dataset.flowMount = ''
      dom.append(mount)
      const attributes = (value: typeof node) => {
        dom.dataset.id = value.attrs.id
        dom.dataset.objectId = value.attrs.objectId
      }
      attributes(node)
      return {
        dom,
        update(next) {
          if (next.type !== node.type) return false
          attributes(next)
          return true
        },
        ignoreMutation: () => true,
        stopEvent: event => event.target instanceof globalThis.Node && mount.contains(event.target),
      }
    }
  },
})

const CaptionMode = Extension.create({ name: 'captionMode' })

export const SlideBreak = Node.create({
  name: 'slideBreak',
  group: 'block',
  atom: true,
  selectable: false,
  parseHTML: () => [{ tag: 'div[data-slide-break]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-slide-break': '', contenteditable: 'false' })],
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some(transaction => transaction.docChanged)) return null
        const positions: number[] = []
        let empty = true, hasBreak = false
        state.doc.forEach((node, pos) => {
          if (node.type.name === 'slideBreak') {
            hasBreak = true
            if (empty) positions.push(pos)
            empty = true
          } else empty = false
        })
        if (!hasBreak) return null
        if (empty) positions.push(state.doc.content.size)
        if (!positions.length) return null
        const tr = state.tr
        for (const pos of positions.reverse()) {
          tr.insert(pos, state.schema.nodes.paragraph.create({ id: crypto.randomUUID(), semantic: 'body' }))
        }
        return tr
      },
    })]
  },
})

export function isCaptionEditor(editor: Editor | null | undefined) {
  return !!editor && !editor.isDestroyed && editor.extensionManager.extensions.some(extension => extension.name === 'captionMode')
}

export function extensions(spatial: boolean, table = false, caption = false) {
  return [
    caption ? Document.extend({ content: 'paragraph' }) : table ? Document.extend({ content: 'table' })
      : spatial ? Document.extend({ content: '(paragraph | spacer | flow | slideBreak)+' }) : Document,
    caption ? CaptionParagraph : table ? TableParagraph : spatial ? MainParagraph : SemanticParagraph, Text, HardBreak, ...inlineMarks, Gapcursor,
    UniqueID.configure({ types: spatial && !caption ? ['paragraph', 'spacer', 'flow', 'slideBreak'] : ['paragraph'] }),
    ...(spatial && !caption ? [Spacer, Flow, SlideBreak, Spaces, DocumentTail] : []),
    ...(caption ? [CaptionMode, CaptionBehavior] : table ? tableExtensions : [ParagraphBehavior]),
  ]
}
