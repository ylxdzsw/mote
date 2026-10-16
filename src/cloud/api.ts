import type { MoteDocument } from '../document/model'
import { isRecord, requestJSON, RequestError } from './connection'

export interface DocumentMeta {
  id: string
  name: string
  revision: string
  createdAt: number
  updatedAt: number
  private: boolean
  privacyRevision: number
}

export function normalizeDocumentMeta(meta: DocumentMeta | Partial<DocumentMeta>): DocumentMeta {
  return { id: meta.id!, name: meta.name!, revision: meta.revision!, createdAt: meta.createdAt!, updatedAt: meta.updatedAt!,
    private: meta.private ?? false, privacyRevision: meta.privacyRevision ?? 0 }
}

export function mergeDocumentMeta(current: DocumentMeta, incoming: DocumentMeta | Partial<DocumentMeta>): DocumentMeta {
  const previous = normalizeDocumentMeta(current), next = normalizeDocumentMeta(incoming)
  return { ...previous, ...next,
    private: next.privacyRevision >= previous.privacyRevision ? next.private : previous.private,
    privacyRevision: Math.max(previous.privacyRevision, next.privacyRevision) }
}

export function mergePrivacyMeta(current: DocumentMeta, incoming: DocumentMeta | Partial<DocumentMeta>): DocumentMeta {
  const previous = normalizeDocumentMeta(current), next = normalizeDocumentMeta(incoming)
  return next.privacyRevision < previous.privacyRevision ? previous
    : { ...previous, private: next.private, privacyRevision: next.privacyRevision }
}

export interface CloudDocument extends DocumentMeta {
  document: MoteDocument
}

export interface Share {
  id: string
  token: string
  mode: 'snapshot' | 'latest'
  createdAt: number
  revision: string | null
}

export class CloudError extends Error {
  status: number
  current?: DocumentMeta

  constructor(message: string, status: number, current?: DocumentMeta) {
    super(message)
    this.name = 'CloudError'
    this.status = status
    this.current = current
  }
}

export async function cloudRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  try {
    return await requestJSON<T>(path, method, body, value => validResponse(path, method, value))
  } catch (error) {
    if (!(error instanceof RequestError)) throw error
    const message = error.status === 401 ? 'Sign in to use cloud files, then retry. Your local edits have not been discarded.'
      : error.status === 409 ? 'This document changed in the cloud. Review the latest version before trying again.'
      : error.status === 410 ? 'This cloud document has been deleted. Your local edits have not been discarded.' : error.message
    const current = validMeta(error.detail?.current) ? error.detail!.current as unknown as DocumentMeta : undefined
    throw new CloudError(message, error.status, current)
  }
}

function validMeta(value: unknown) {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.revision === 'string'
    && typeof value.createdAt === 'number' && typeof value.updatedAt === 'number'
    && typeof value.private === 'boolean' && Number.isSafeInteger(value.privacyRevision)
}
function validShare(value: unknown) {
  return isRecord(value) && typeof value.id === 'string' && typeof value.token === 'string'
    && ['snapshot', 'latest'].includes(String(value.mode)) && typeof value.createdAt === 'number'
    && (value.revision === null || typeof value.revision === 'string')
}
function validResponse(path: string, method: string, value: unknown) {
  if (!isRecord(value)) return false
  if (method === 'DELETE') return value.ok === true
  if (path.startsWith('/api/shared/')) return typeof value.name === 'string' && isRecord(value.document)
  if (path.endsWith('/shares')) return method === 'GET' ? Array.isArray(value.shares) && value.shares.every(validShare) : validShare(value)
  if (path === '/api/documents' && method === 'GET') return Array.isArray(value.documents) && value.documents.every(validMeta)
  if (!validMeta(value)) return false
  // V0 content validation/recovery remains separate from the response envelope.
  return path.endsWith('/privacy') || method === 'PATCH' || isRecord(value.document)
}
