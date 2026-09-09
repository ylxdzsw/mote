import { Extension, type Editor } from '@tiptap/core'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import type { BlockClass } from '../document/model'

export function setParagraphClass(editor: Editor, semantic: BlockClass) {
  return editor.chain().focus().updateAttributes('paragraph', { semantic, listLevel: 0 }).run()
}

export function changeListLevel(editor: Editor, delta: number) {
  return editor.commands.command(({ tr, dispatch }) => {
    const { from, to } = tr.selection
    let found = false
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name !== 'paragraph' || node.attrs.semantic !== 'list' || (from !== to && pos + 1 === to)) return
      found = true
      if (dispatch) {
        const level = node.attrs.listLevel + delta
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, semantic: level < 0 ? 'body' : 'list', listLevel: Math.max(0, level) })
      }
      return false
    })
    if (found) tr.setMeta('historyBoundary', true).scrollIntoView()
    return found
  })
}

// Clipboard lists become flat paragraphs, never parent/child document nodes.
function flattenLists(html: string) {
  const container = document.createElement('div')
  container.innerHTML = html
  function flatten(list: Element, level: number): DocumentFragment {
    const result = document.createDocumentFragment()
    for (const item of list.children) {
      if (item.tagName !== 'LI') continue
      const paragraph = document.createElement('p')
      paragraph.dataset.semantic = list.tagName === 'UL' ? 'list' : 'body'
      paragraph.dataset.listLevel = String(level)
      const nested: Element[] = []
      for (const child of item.childNodes) {
        if (child instanceof Element && child.matches('ul, ol')) { nested.push(child); continue }
        if (child instanceof Element && child.matches('p, div, h1, h2, h3, h4, h5, h6')) {
          if (paragraph.hasChildNodes()) paragraph.append(document.createElement('br'))
          paragraph.append(...[...child.childNodes].map(node => node.cloneNode(true)))
        } else paragraph.append(child.cloneNode(true))
      }
      result.append(paragraph)
      for (const child of nested) result.append(flatten(child, level + 1))
    }
    return result
  }
  for (const list of container.querySelectorAll('ul, ol')) {
    if (!list.parentElement?.closest('ul, ol')) list.replaceWith(flatten(list, 0))
  }
  return container.innerHTML
}

export const ParagraphBehavior = Extension.create({
  name: 'paragraphBehavior',
  priority: 1000,
  addKeyboardShortcuts() {
    const editor = this.editor
    const current = () => editor.state.selection.$from.parent.attrs.semantic
    const exitCode = () => {
      if (current() !== 'code') return false
      return editor.commands.command(({ tr, state }) => {
        const pos = tr.selection.$from.after()
        tr.insert(pos, state.schema.nodes.paragraph.create({ id: crypto.randomUUID(), semantic: 'body' }))
        tr.setSelection(TextSelection.create(tr.doc, pos + 1)).setMeta('historyBoundary', true).scrollIntoView()
        return true
      })
    }
    return {
      Enter: () => {
        if (current() === 'code') return editor.commands.setHardBreak()
        if (current() !== 'list') return false
        return editor.commands.command(({ tr }) => {
          tr.deleteSelection()
          const { $from } = tr.selection
          tr.split($from.pos, 1, [{ type: $from.parent.type, attrs: { ...$from.parent.attrs, id: crypto.randomUUID() } }])
          tr.setSelection(TextSelection.create(tr.doc, $from.pos + 2)).setMeta('historyBoundary', true).scrollIntoView()
          return true
        })
      },
      'Ctrl-Enter': exitCode,
      'Meta-Enter': exitCode,
      Tab: () => current() === 'code' ? editor.commands.insertContent('  ') : changeListLevel(editor, 1),
      'Shift-Tab': () => changeListLevel(editor, -1),
      Backspace: () => {
        const selection = editor.state.selection
        const node = selection instanceof NodeSelection ? selection.node : selection.empty && selection.$from.parentOffset === 0 ? selection.$from.parent : null
        if (node?.attrs.semantic === 'list') return changeListLevel(editor, -1)
        if (node?.attrs.semantic === 'code') return setParagraphClass(editor, 'body')
        return false
      },
    }
  },
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({
      props: {
        transformPastedHTML: flattenLists,
        handlePaste: (view, event, slice) => {
          const { $from, $to } = view.state.selection
          if (!$from.sameParent($to)) return false
          if ($from.parent.attrs.semantic !== 'code') {
            const first = slice.content.firstChild
            if ($from.parentOffset !== 0 || $to.parentOffset !== $to.parent.content.size || !['code', 'list'].includes(first?.attrs.semantic)) return false
            const tr = view.state.tr.setNodeMarkup($from.before(), undefined, {
              ...$from.parent.attrs, semantic: first!.attrs.semantic, listLevel: first!.attrs.listLevel,
            })
            view.dispatch(tr.replaceSelection(slice).setMeta('paste', true).scrollIntoView())
            return true
          }
          const text = event.clipboardData?.getData('text/plain')
          if (text === undefined) return false
          const content = text.replace(/\r\n?/g, '\n').split('\n').flatMap((line, index) => [
            ...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : []),
          ])
          return editor.commands.insertContent(content)
        },
      },
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some(transaction => transaction.docChanged)) return null
        const tr = state.tr
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'paragraph') return
          if (node.attrs.semantic !== 'list' && node.attrs.listLevel !== 0) tr.setNodeAttribute(pos, 'listLevel', 0)
          const code = node.attrs.semantic === 'code'
          if (node.content.content.some(child => child.text?.includes('\n') || (code && child.marks.length))) {
            const content = node.content.content.flatMap(child => {
              const marks = code ? [] : child.marks
              return child.isText ? child.text!.split('\n').flatMap((line, index) => [
                ...(index ? [state.schema.nodes.hardBreak.create(null, null, marks)] : []),
                ...(line ? [state.schema.text(line, marks)] : []),
              ]) : [child.mark(marks)]
            })
            tr.replaceWith(pos + 1, pos + 1 + node.content.size, content)
          }
          return false
        })
        if (state.selection.$from.parent.attrs.semantic === 'code' && state.storedMarks?.length) tr.setStoredMarks([])
        return tr.docChanged || tr.storedMarksSet ? tr : null
      },
    })]
  },
})
