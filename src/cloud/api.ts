import type { MoteDocument } from '../document/model'

export interface DocumentMeta {
  id: string
  name: string
  revision: string
  createdAt: number
  updatedAt: number
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
  let response: Response
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new CloudError('Could not reach the cloud service. Check your connection and try again.', 0)
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    const message = response.status === 401 ? 'Sign in to use cloud files, then retry. Your local edits have not been discarded.'
      : response.status === 409 ? 'This document changed in the cloud. Review the latest version before trying again.'
      : response.status === 410 ? 'This cloud document has been deleted. Your local edits have not been discarded.'
      : typeof detail?.error === 'string' ? detail.error : `The cloud service returned an error (${response.status}). Please try again.`
    throw new CloudError(message, response.status, detail?.current)
  }
  if (response.status === 204) return undefined as T
  try { return await response.json() as T }
  catch { throw new CloudError('The cloud service returned an invalid response. Refresh the list before retrying a change.', response.status) }
}
