import { Mark, type Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'

const paletteReference = /^[A-Za-z0-9_-]+(?::soft)?$/
const reservedReferences = new Set(['__proto__', 'constructor', 'prototype'])

export function safePaletteReference(value: unknown): value is string {
  if (typeof value !== 'string' || !paletteReference.test(value)) return false
  return !reservedReferences.has(value.split(':', 1)[0])
}

function paletteVariable(reference: string) {
  return `var(--palette-${reference.replace(':', '-')})`
}

function paletteSurfaceVariable(reference: string) {
  return `var(--palette-${reference.split(':', 1)[0]}-surface)`
}

export const InlineColor = Mark.create({
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

export const InlineDecoration = Mark.create({
  name: 'decoration',
  priority: 109,
  addAttributes() {
    return {
      decoration: {
        default: null,
        validate: (value: unknown) => {
          if (value !== 'box' && value !== 'underline') throw new Error('Inline decoration is unsupported')
        },
        parseHTML: element => {
          const decoration = element.getAttribute('data-inline-decoration')
          if (decoration === null) return null
          return decoration === 'box' || decoration === 'underline' ? decoration : false
        },
        renderHTML: attributes => ({ 'data-inline-decoration': attributes.decoration }),
      },
    }
  },
  parseHTML: () => [
    { tag: 'span[data-inline-decoration]', getAttrs: element => {
      const decoration = element.getAttribute('data-inline-decoration')
      return decoration === 'box' || decoration === 'underline' ? {} : false
    } },
    { tag: 'u', getAttrs: () => ({ decoration: 'underline' }) },
  ],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
})

export const InlineBold = Mark.create({
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
        if (selection.ranges.some(({ $from, $to }) => {
          let code = $from.parent.attrs.semantic === 'code' || $to.parent.attrs.semantic === 'code'
          editor.state.doc.nodesBetween($from.pos, $to.pos, node => {
            if (node.type.name === 'paragraph' && node.attrs.semantic === 'code') code = true
          })
          return code
        })) return true
        return editor.commands.toggleMark('bold')
      },
    }
  },
  renderHTML: () => ['strong', 0],
})

export const inlineMarks = [InlineColor, InlineDecoration, InlineBold]

export type InlineDecorationValue = 'box' | 'underline'

export interface InlineSelection {
  bold: boolean | 'mixed'
  color: string | null | 'mixed'
  decoration: InlineDecorationValue | null | 'mixed'
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
  if (!editor || editor.state.selection instanceof NodeSelection) return { bold: false, color: null, decoration: null }
  const color = oneValue(marksValues(editor, 'color', 'color') as (string | null)[])
  return {
    bold: oneValue(marksValues(editor, 'bold') as boolean[]),
    color: color === 'mixed' ? 'mixed' : color,
    decoration: oneValue(marksValues(editor, 'decoration', 'decoration') as (InlineDecorationValue | null)[]),
  }
}
