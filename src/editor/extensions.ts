import { Mark, Node, mergeAttributes } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import UniqueID from '@tiptap/extension-unique-id'
import { Gapcursor } from '@tiptap/extensions'
import { blockClasses, inlineClasses } from '../document/model'
import { TableParagraph, tableExtensions } from './table'
import { SegmentSizing } from './segmentSizing'

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
    }
  },
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

const SemanticText = Mark.create({
  name: 'semanticText',
  addAttributes() {
    return {
      semantic: {
        default: 'emphasis',
        parseHTML: element => {
          const value = element.getAttribute('data-inline-semantic')
          return inlineClasses.find(name => name === value) ?? 'emphasis'
        },
        renderHTML: attrs => ({ 'data-inline-semantic': attrs.semantic }),
      },
    }
  },
  parseHTML: () => [{ tag: 'span[data-inline-semantic]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
})

export const Spacer = Node.create({
  name: 'spacer',
  group: 'block',
  atom: true,
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

export function extensions(spatial: boolean, table = false) {
  return [
    table ? Document.extend({ content: 'table' }) : Document,
    table ? TableParagraph : spatial ? MainParagraph : SemanticParagraph, Text, HardBreak, SemanticText, Gapcursor,
    UniqueID.configure({ types: spatial ? ['paragraph', 'spacer'] : ['paragraph'] }),
    ...(spatial ? [Spacer, SegmentSizing] : []),
    ...(table ? tableExtensions : []),
  ]
}
