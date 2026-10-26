import type { MoteDocument } from './model'
import { validateDocument as validate, DocumentFormatError } from '../../shared/document.mjs'
export { DocumentFormatError as MoteFileError } from '../../shared/document.mjs'
export function validateDocument(value: unknown): asserts value is MoteDocument { validate(value) }
export { DocumentFormatError }
