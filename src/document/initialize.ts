import { getSchema } from '@tiptap/core'
import { extensions } from '../editor/extensions'
import type { MoteDocument } from './model'
import { validatePaletteReferences } from '../theme/palette'
import { validateDocument } from './validate'
import { supportsCaption } from './model'

export function initializeDocument(draft: MoteDocument): MoteDocument {
  validateDocument(draft)
  if (draft.version !== 'V0') throw new Error('Unsupported document version')
  if (draft.language !== undefined && !['en', 'zh-Hans'].includes(draft.language)) throw new Error('Unsupported document language')
  if (draft.aiModel !== undefined && (typeof draft.aiModel !== 'string' || draft.aiModel.length > 256 || /[\u0000-\u001F\u007F-\u009F]/.test(draft.aiModel))) throw new Error('Invalid AI model')
  if (draft.theme.autospace !== undefined && typeof draft.theme.autospace !== 'boolean') throw new Error('Invalid mixed-script spacing')
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const margin = draft.margins[side]
    if (!Number.isFinite(margin) || margin < 0) throw new Error(`Invalid ${side} margin`)
  }
  validatePaletteReferences(draft)
  const content = getSchema(extensions(true)).nodeFromJSON(draft.content)
  content.check()
  draft.content = content.toJSON()
  validateDocument(draft)
  for (const object of draft.floating) {
    if ('content' in object) getSchema(extensions(false, object.kind === 'table')).nodeFromJSON(object.content).check()
    if (supportsCaption(object) && object.caption) getSchema(extensions(false, false, true)).nodeFromJSON(object.caption).check()
  }
  return draft
}
