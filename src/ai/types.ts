import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, MoteDocument } from '../document/model'
import type { SegmentClipboard, SegmentRange } from '../document/segment'

export interface Area { x: number; y: number; width: number; height: number }
export interface SegmentBookmark { blockId: string | null; offset: number; after?: boolean }
export interface SegmentBookmarks { start: SegmentBookmark; end: SegmentBookmark }
export interface SegmentTarget {
  kind: 'segment'
  range: SegmentRange
  blockIds: string[]
  objectIds: string[]
  area: Area
  selectedText?: string
  bookmarks: SegmentBookmarks
}
export type AITarget = { kind: 'object'; objectId: string; isNew: boolean; area: Area; selection?: { from: number; to: number }; selectedText?: string }
  | { kind: 'text'; blockIds: string[]; selection: { from: number; to: number }; selectedText?: string; insert: boolean; area: Area }
  | SegmentTarget
interface CandidateBase { summary: string; sources?: { title: string; url: string }[] }
export type Candidate = CandidateBase & (
  { object: FloatingObject; content?: never; segment?: never }
  | { content: JSONContent[]; object?: never; segment?: never }
  | { segment: SegmentClipboard; object?: never; content?: never }
)
export type Executor = 'builtin' | 'external'
export interface RemoteTask {
  protocol?: string; documentVersion?: number
  id: string; status: 'queued' | 'running' | 'ready' | 'stopped' | 'error' | 'waiting'; progress: string
  error?: string; candidate?: Candidate; expiresAt?: number
  executor?: Executor; executorRevision?: number; candidateRevision?: number
  workspaceRead: boolean; workspaceReadRevision: number
  externalPath?: string
  released?: boolean
}
export interface AITask extends Omit<RemoteTask, 'status' | 'externalPath'> {
  title?: string
  draftPrompt?: string
  createdAt?: number
  remoteMissing?: boolean
  documentId: string; target: AITarget; prompt: string; original: FloatingObject | JSONContent[] | SegmentClipboard
  status: RemoteTask['status'] | 'draft' | 'preparing'; submitted: boolean; preview: boolean
  requestSent?: boolean
  creation?: { executor: Executor; operationId: string; prompt: string; model?: string; snapshot: string }
  pendingExecutor?: { executor: Executor; operationId: string; baseExecutorRevision?: number }
  pendingWorkspaceRead?: { enabled: boolean; baseWorkspaceReadRevision: number; operationId: string }
  workspaceReadConfirmed?: boolean
  snapshotDocument?: MoteDocument
  cloudDocumentId?: string
  baseRevision?: string
  preparingCopyId?: string
  acceptance?: { workingCopyId: string; document: MoteDocument }
  segmentOriginalBlocks?: JSONContent[]
  segmentOriginalObjects?: FloatingObject[]
}
export interface AssistantCloud {
  draft?: boolean
  documentId: string
  workingCopyId: string
  privateDocument: boolean
  externalBlocked: boolean
  sync: () => Promise<{ revision: string; document: MoteDocument } | null>
}
export interface AssistantCloudState { revision: string; tasks: AITask[] }
