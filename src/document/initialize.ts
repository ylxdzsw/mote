import { getSchema } from '@tiptap/core'
import { extensions } from '../editor/extensions'
import type { MoteDocument } from './model'

export function initializeDocument(draft: MoteDocument): MoteDocument {
  if (draft.version !== 'V0') throw new Error('Unsupported document version')
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const margin = draft.margins[side]
    if (!Number.isFinite(margin) || margin < 0) throw new Error(`Invalid ${side} margin`)
  }
  const content = getSchema(extensions(true)).nodeFromJSON(draft.content)
  content.check()
  draft.content = content.toJSON()
  for (const object of draft.floating) if ('content' in object) {
    getSchema(extensions(false, object.kind === 'table', object.kind === 'label')).nodeFromJSON(object.content).check()
  }
  return draft
}
