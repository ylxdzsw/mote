import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, MoteDocument } from '../src/document/model'

export const DOCUMENT_VERSION: 7
export const DOCUMENT_VERSIONS: readonly number[]
export class DocumentFormatError extends Error {
  path: string
  code: string
  constructor(message: string, path?: string, code?: string)
}
export function validateDocument(value: unknown): MoteDocument
export function loadDocument(value: unknown): MoteDocument
export function migrationBreaking(version: number): boolean
export function publishDocument(value: MoteDocument): MoteDocument
export function validateObject(value: unknown, options?: { allowMissingScreenshot?: boolean; version?: number }): FloatingObject
export function validateContent(value: unknown, mode?: 'main' | 'text' | 'table' | 'caption', options?: { slides?: boolean }): JSONContent
export function validateComposition(blocks: unknown, objects: unknown, options?: {
  version?: number
  allowEmpty?: boolean
  slides?: boolean
  allowMissingScreenshotIds?: Set<string>
}): void
