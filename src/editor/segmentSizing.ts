import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface SegmentStyle {
  from: number
  to: number
  property: 'padding-bottom' | '--spacer-preview-height'
  value: number
}

interface SegmentLayout { styles: SegmentStyle[] | null; decorations: DecorationSet }
export const segmentLayoutKey = new PluginKey<SegmentLayout>('segmentLayout')
export const heightTolerance = .1 // Document pixels; accommodates browser subpixel layout rounding.

export const SegmentSizing = Extension.create({
  name: 'segmentSizing',
  addGlobalAttributes: () => [{
    // The document owns the leading text run; each spacer owns the run following it.
    types: ['doc', 'spacer'],
    attributes: {
      minSegmentHeight: {
        default: null,
        keepOnSplit: false,
        rendered: false,
      },
    },
  }],
  addProseMirrorPlugins: () => [new Plugin<SegmentLayout>({
    key: segmentLayoutKey,
    state: {
      init: () => ({ styles: [], decorations: DecorationSet.empty }),
      apply(transaction, previous) {
        const styles = transaction.getMeta(segmentLayoutKey) as SegmentStyle[] | undefined
        if (styles) return {
          styles,
          decorations: DecorationSet.create(transaction.doc, styles.map(({ from, to, property, value }) =>
            Decoration.node(from, to, { style: `${property}: ${value}px` }))),
        }
        return { styles: transaction.docChanged ? null : previous.styles, decorations: previous.decorations.map(transaction.mapping, transaction.doc) }
      },
    },
    props: { decorations: state => segmentLayoutKey.getState(state)!.decorations },
  })],
})
