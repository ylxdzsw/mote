import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, MoteDocument } from '../document/model'

export interface Area { x: number; y: number; width: number; height: number }
export type AITarget = { kind: 'object'; objectId: string; isNew: boolean; area: Area; selection?: { from: number; to: number }; selectedText?: string }
  | { kind: 'text'; blockIds: string[]; selection: { from: number; to: number }; selectedText?: string; insert: boolean; area: Area }
export interface Candidate { object?: FloatingObject; content?: JSONContent[]; summary: string; sources?: { title: string; url: string }[] }
export interface RemoteTask {
  id: string; status: 'queued' | 'running' | 'ready' | 'stopped' | 'error'; progress: string
  error?: string; candidate?: Candidate; expiresAt: number
}
export interface AITask extends Omit<RemoteTask, 'status'> {
  documentId: string; target: AITarget; prompt: string; original: FloatingObject | JSONContent[]
  status: RemoteTask['status'] | 'draft' | 'preparing'; submitted: boolean; preview: boolean
  requestSent?: boolean
  snapshotDocument?: MoteDocument
}
