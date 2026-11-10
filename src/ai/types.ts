import type { JSONContent } from '@tiptap/core'
import type { FloatingObject, MoteDocument } from '../document/model'
import type { SegmentClipboard, SegmentRange } from '../document/segment'

export interface Area { x: number; y: number; width: number; height: number }
export interface SegmentBookmark { blockId: string | null; offset: number; after?: boolean }
interface SegmentBookmarks { start: SegmentBookmark; end: SegmentBookmark }
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
export interface TaskVersion { id: string; label?: string; candidate: Candidate }
export type Executor = 'builtin' | 'external'
export interface RemoteTask {
  protocol?: string
  id: string; status: 'queued' | 'running' | 'ready' | 'stopped' | 'error' | 'waiting'; progress: string
  error?: string; expiresAt?: number
  versions?: TaskVersion[]
  selectedVersion?: string // Last request context, never the owner's review selection.
  workspaceRead: boolean
  externalPath?: string
  released?: boolean
}
// Document-owned editing state; execution and proposal data live separately.
export interface Reservation {
  id: string
  documentId: string
  target: AITarget
  original: FloatingObject | JSONContent[] | SegmentClipboard
  workspaceRead: boolean
  expiresAt?: number
  released?: boolean
  title?: string
  createdAt?: number
  documentVersion?: number
  snapshotDocument?: MoteDocument
  segmentOriginalBlocks?: JSONContent[]
  segmentOriginalObjects?: FloatingObject[]
}
export interface AITask extends Reservation {
  protocol?: string
  status: 'queued' | 'running' | 'ready' | 'stopped' | 'error' | 'waiting' | 'draft' | 'preparing'
  progress: string
  prompt: string
  submitted: boolean
  preview: boolean
  draftPrompt?: string
  versions?: TaskVersion[]
  selectedVersion?: string
  candidateNotice?: string
  error?: string
  remoteMissing?: boolean
  executor?: Executor // Browser-only tab selection, never authority.
  pendingRun?: { operationId: string; prompt: string; model?: string; selectedVersion?: string }
  // Retired recovery records remain downloadable, never executed or converted.
  requestSent?: boolean
  pendingExecutor?: { executor: Executor; operationId: string; baseExecutorRevision?: number }
  acceptance?: { workingCopyId: string; document: MoteDocument; versionId: string }
  cloudDocumentId?: string
  baseRevision?: string
  workspaceReadRevision?: number
}
export interface AssistantCloud {
  draft?: boolean
  documentId: string
  workingCopyId: string
  revision: string
  privateDocument: boolean
  externalBlocked: boolean
  earlySync: () => void
  sync: () => Promise<{ revision: string; document: MoteDocument; reservations?: Reservation[] } | null>
}
export interface AssistantCloudState { revision: string; tasks: AITask[] }

// Canvas hooks for reservation decorations; review actions themselves live in Assistant.
export interface AIReview {
  tasks: AITask[]
  segmentPreviews?: Array<{ taskId: string; taskIds: string[]; from: number; to: number; content: JSONContent[]; blockOwners: Record<string, string> }>
  segmentRanges?: Array<{ taskId: string; from: number; to: number; startOffset?: number; endOffset?: number }>
  activeSegmentId?: string | null
  selectSegment?: (id: string) => void
  selectText: () => void
  previewFailed: (id: string, error: unknown) => void
  deleteTarget: (id: string) => void
}
