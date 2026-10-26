import { getSchema } from '@tiptap/core'
import { extensions } from '../editor/extensions'
import { supportsCaption, type MoteDocument } from './model'
import { loadDocument } from '../../shared/document.mjs'

export function initializeDocument(value: unknown): MoteDocument {
  const draft = loadDocument(value)
  getSchema(extensions(true)).nodeFromJSON(draft.content).check()
  for (const object of draft.objects) {
    if ('content' in object) getSchema(extensions(false, object.kind === 'table')).nodeFromJSON(object.content).check()
    if (supportsCaption(object) && object.caption) getSchema(extensions(false, false, true)).nodeFromJSON(object.caption.content).check()
  }
  return draft
}
