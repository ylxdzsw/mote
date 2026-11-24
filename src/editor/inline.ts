import { Mark, type Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { InlineLink } from './links'

const paletteReference = /^[A-Za-z0-9_-]+(?::soft)?$/
const reservedReferences = new Set(['__proto__', 'constructor', 'prototype'])

function safePaletteReference(value: unknown): value is string {
  if (typeof value !== 'string' || !paletteReference.test(value)) return false
  return !reservedReferences.has(value.split(':', 1)[0])
}

function paletteVariable(reference: string) {
  return `var(--palette-${reference.replace(':', '-')})`
}

function paletteSurfaceVariable(reference: string) {
  return `var(--palette-${reference.split(':', 1)[0]}-surface)`
}

const InlineColor = Mark.create({
  name: 'color',
  priority: 110,
  addAttributes() {
    return {
      color: {
        default: null,
        validate: (value: unknown) => {
          if (!safePaletteReference(value)) throw new Error('Inline color must be a safe palette reference')
        },
        parseHTML: element => {
          const color = element.getAttribute('data-inline-color')
          if (color === null) return null
          return safePaletteReference(color) ? color : false
        },
        renderHTML: attributes => {
          const color = attributes.color
          if (!safePaletteReference(color)) return {}
          return {
            'data-inline-color': color,
            style: `color: ${paletteVariable(color)}; --inline-surface: ${paletteSurfaceVariable(color)};`,
          }
        },
      },
    }
  },
  parseHTML: () => [{ tag: 'span[data-inline-color]', getAttrs: element => safePaletteReference(element.getAttribute('data-inline-color')) ? {} : false }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
})

const InlineBox = Mark.create({
  name: 'box',
  priority: 109,
  parseHTML: () => [{ tag: 'span[data-inline-decoration="box"]' }],
  renderHTML: () => ['span', { 'data-inline-decoration': 'box' }, 0],
})

const InlineBold = Mark.create({
  name: 'bold',
  priority: 108,
  parseHTML: () => [
    { tag: 'strong' },
    { tag: 'b' },
  ],
  addKeyboardShortcuts() {
    return {
      'Mod-b': ({ editor }) => {
        const { selection } = editor.state
        if (!editor.isEditable || selection instanceof NodeSelection) return false
        if (!selection.$from.parent.isTextblock && !(selection instanceof CellSelection)) return false
        if (selectedParagraphsAreBold(editor)) return true
        return editor.commands.toggleMark('bold')
      },
    }
  },
  renderHTML: () => ['strong', 0],
})

export const inlineMarks = [InlineColor, InlineBox, InlineBold, InlineLink]

export function selectedParagraphsAreBold(editor: Editor | null): boolean {
  if (!editor || editor.state.selection instanceof NodeSelection) return false
  let found = false, allBold = true
  for (const { $from, $to } of editor.state.selection.ranges) {
    editor.state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.type.name !== 'paragraph' || $from.pos !== $to.pos && pos + 1 >= $to.pos) return
      found = true
      const dom = editor.view.nodeDOM(pos) as HTMLElement
      if (Number(dom.ownerDocument.defaultView!.getComputedStyle(dom).fontWeight) < 700) allBold = false
      return false
    })
  }
  return found && allBold
}

interface InlineSelection {
  bold: boolean | 'mixed'
  color: string | null | 'mixed'
  box: boolean | 'mixed'
}

function oneValue<T>(values: T[]): T | 'mixed' {
  return values.every(value => Object.is(value, values[0])) ? values[0] : 'mixed'
}

function marksValues(editor: Editor, type: string, attr?: string) {
  const values: (string | boolean | null)[] = []
  const { selection, doc, storedMarks } = editor.state
  const add = (marks: readonly import('@tiptap/pm/model').Mark[]) => {
    const mark = marks.find(value => value.type.name === type)
    values.push(attr ? mark?.attrs[attr] ?? null : !!mark)
  }
  if (selection.empty) add(storedMarks ?? selection.$from.marks())
  else for (const { $from, $to } of selection.ranges) {
    let found = false
    doc.nodesBetween($from.pos, $to.pos, node => {
      if (!node.isText) return
      found = true
      add(node.marks)
    })
    if (!found) add([])
  }
  return values
}

export function selectedInlineMarks(editor: Editor | null): InlineSelection {
  if (!editor || editor.state.selection instanceof NodeSelection) return { bold: false, color: null, box: false }
  const color = oneValue(marksValues(editor, 'color', 'color') as (string | null)[])
  return {
    bold: oneValue(marksValues(editor, 'bold') as boolean[]),
    color: color === 'mixed' ? 'mixed' : color,
    box: oneValue(marksValues(editor, 'box') as boolean[]),
  }
}
