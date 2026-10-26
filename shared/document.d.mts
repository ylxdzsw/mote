import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, MoteDocument } from '../src/document/model'

export const DOCUMENT_VERSION: 1
export class DocumentFormatError extends Error {
  path: string
  code: string
  constructor(message: string, path?: string, code?: string)
}
export function validateDocument(value: unknown): MoteDocument
export function loadDocument(value: unknown): MoteDocument
export function publishDocument(value: MoteDocument): MoteDocument
export function validateObject(value: unknown, options?: { allowMissingScreenshot?: boolean }): FloatingObject
export function validateContent(value: unknown, mode?: 'main' | 'text' | 'table' | 'caption'): JSONContent
export function validateComposition(blocks: unknown, objects: unknown, options?: {
  allowEmpty?: boolean
  allowMissingScreenshotIds?: Set<string>
}): void
