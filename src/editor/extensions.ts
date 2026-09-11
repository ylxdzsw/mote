import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import UniqueID from '@tiptap/extension-unique-id'
import { Gapcursor } from '@tiptap/extensions'
import { NodeSelection, Plugin } from '@tiptap/pm/state'
import { Fragment, Slice } from '@tiptap/pm/model'
import { CellSelection } from '@tiptap/pm/tables'
import { blockClasses, inlineClasses } from '../document/model'
import { TableParagraph, tableExtensions } from './table'
import { SegmentSizing } from './segmentSizing'
import { ParagraphBehavior } from './paragraphBehavior'

const SemanticParagraph = Paragraph.extend({
  addAttributes() {
    return {
      semantic: {
        default: 'body',
        keepOnSplit: false,
        parseHTML: element => {
          if (element.tagName === 'PRE') return 'code'
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
  parseHTML: () => [{ tag: 'pre', preserveWhitespace: 'full' }, { tag: 'p' }],
  renderHTML: ({ node, HTMLAttributes }) => node.attrs.semantic === 'code'
    ? ['pre', HTMLAttributes, ['code', 0]] : ['p', HTMLAttributes, 0],
})

const MainParagraph = SemanticParagraph.extend({
  addNodeView() {
    return ({ node }) => {
      const code = node.attrs.semantic === 'code'
      const dom = document.createElement(code ? 'pre' : 'p')
      dom.className = 'main-paragraph'
      const contentDOM = document.createElement(code ? 'code' : 'span')
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
          if (next.type !== node.type || (next.attrs.semantic === 'code') !== code) return false
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
        default: 'primary',
        parseHTML: element => {
          if (element.matches('strong, b')) return 'bold'
          const value = element.getAttribute('data-inline-semantic')
          const semantic = value === 'emphasis' ? 'primary' : value
          return inlineClasses.find(name => name === semantic) ?? 'primary'
        },
        renderHTML: attrs => ({ 'data-inline-semantic': attrs.semantic }),
      },
    }
  },
  parseHTML: () => [
    { tag: 'span[data-inline-semantic]' },
    { tag: 'strong', getAttrs: () => ({ semantic: 'bold' }) },
    { tag: 'b', getAttrs: () => ({ semantic: 'bold' }) },
  ],
  addKeyboardShortcuts() {
    return {
      'Mod-b': ({ editor }) => {
        const { selection } = editor.state
        if (!editor.isEditable || selection instanceof NodeSelection || (!selection.$from.parent.isTextblock && !(selection instanceof CellSelection))) return false
        if (selection.$from.parent.attrs.semantic === 'code') return true
        return editor.commands.toggleMark('semanticText', { semantic: 'bold' })
      },
    }
  },
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
})

const LabelParagraph = Paragraph.extend({
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: () => ['p', { 'data-semantic': 'label' }, 0],
})

function labelInlineContent(node: import('@tiptap/pm/model').Node, content: import('@tiptap/pm/model').Node[] = []) {
  if (node.isText || node.type.name === 'hardBreak') {
    content.push(node)
    return content
  }
  node.forEach(child => {
    if (child.isBlock && content.length) content.push(node.type.schema.nodes.hardBreak.create())
    labelInlineContent(child, content)
  })
  return content
}

const LabelBehavior = Extension.create<{ onFinish?: () => void }>({
  name: 'labelBehavior',
  addOptions: () => ({ onFinish: undefined }),
  addKeyboardShortcuts() {
    const editor = this.editor
    return {
      Enter: () => {
        if (this.options.onFinish) this.options.onFinish()
        else editor.commands.blur()
        return true
      },
      'Shift-Enter': () => editor.commands.setHardBreak(),
    }
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handlePaste: (view, event, slice) => {
          const clipboard = event.clipboardData
          const content = clipboard && !clipboard.getData('text/html')
            ? clipboard.getData('text/plain').replace(/\r\n?/g, '\n').split('\n').flatMap((line, index) => [
              ...(index ? [view.state.schema.nodes.hardBreak.create()] : []),
              ...(line ? [view.state.schema.text(line)] : []),
            ])
            : (() => {
              const content: import('@tiptap/pm/model').Node[] = []
              slice.content.forEach((node, index) => {
                if (index) content.push(view.state.schema.nodes.hardBreak.create())
                labelInlineContent(node, content)
              })
              return content
            })()
          view.dispatch(view.state.tr.replaceSelection(new Slice(
            Fragment.from(view.state.schema.nodes.paragraph.create(null, content)), 1, 1,
          )).setMeta('paste', true).scrollIntoView())
          return true
        },
      },
    })]
  },
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

export function extensions(spatial: boolean, table = false, singleLabel = false, onFinish?: () => void) {
  if (singleLabel) return [
    Document.extend({ content: 'paragraph' }), LabelParagraph, Text, HardBreak, SemanticText, Gapcursor,
    LabelBehavior.configure({ onFinish }),
  ]
  return [
    table ? Document.extend({ content: 'table' }) : Document,
    table ? TableParagraph : spatial ? MainParagraph : SemanticParagraph, Text, HardBreak, SemanticText, Gapcursor,
    UniqueID.configure({ types: spatial ? ['paragraph', 'spacer'] : ['paragraph'] }),
    ...(spatial ? [Spacer, SegmentSizing] : []),
    ...(table ? tableExtensions : [ParagraphBehavior]),
  ]
}
