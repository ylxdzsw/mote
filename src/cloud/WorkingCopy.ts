import type { MoteDocument } from '../document/model'
import { initializeDocument } from '../document/initialize'
import { CloudError, cloudRequest, type CloudDocument, type DocumentMeta } from './api'
import { saveWorkingCopy, type WorkingRecord } from './workingCopies'

export interface CopyState {
  record: WorkingRecord
  local: 'saving' | 'saved' | 'error'
  syncing: boolean
  error: string
  auth: boolean
  conflict?: DocumentMeta
  deleted: boolean
  epoch: number
}

export class WorkingCopy {
  private listeners = new Set<() => void>()
  private saving: Promise<unknown> = Promise.resolve()
  private flight?: Promise<CloudDocument | null>
  private generation = 0
  private state: CopyState
  constructor(record: WorkingRecord) {
    this.state = { record, local: 'saved', syncing: false, error: '', auth: false, deleted: false, epoch: 0 }
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<CopyState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private persist() {
    const record = this.state.record
    this.publish({ local: 'saving' })
    const write = this.saving.catch(() => {}).then(() => saveWorkingCopy(record))
    this.saving = write
    void write.then(() => {
      if (this.state.record === record) this.publish({ local: 'saved' })
    }, () => {
      if (this.state.record === record) this.publish({ local: 'error' })
    })
    return write
  }
  update(document: MoteDocument) {
    if (document === this.state.record.document) return
    this.generation++
    this.publish({ record: { ...this.state.record, document, dirty: true, updatedAt: Date.now() } })
    void this.persist().catch(() => {})
  }
  replaceLocal(document: MoteDocument) {
    this.update(document)
    this.publish({ epoch: this.state.epoch + 1 })
  }
  retryLocal = () => { void this.persist().catch(() => {}) }
  async flushLocal() {
    for (;;) {
      const generation = this.generation
      await this.saving
      if (generation === this.generation) return
    }
  }
  private failure(error: unknown) {
    this.publish({
      error: error instanceof Error ? error.message : 'Synchronization failed. Your working copy has not been discarded.',
      auth: error instanceof CloudError && error.status === 401,
      ...(error instanceof CloudError && error.status === 409 ? { conflict: error.current } : {}),
      ...(error instanceof CloudError && (error.status === 410 || error.status === 404) ? { deleted: true } : {}),
    })
  }
  sync = async (): Promise<CloudDocument | null> => {
    if (this.flight) return this.flight
    if (this.state.conflict || this.state.deleted) return null
    this.flight = this.performSync().finally(() => { this.flight = undefined; this.publish({ syncing: false }) })
    return this.flight
  }
  private async performSync(): Promise<CloudDocument | null> {
    this.publish({ syncing: true, error: '', auth: false })
    try {
      // Finish an uncertain request before sending newer edits. Its stable operation ID
      // lets a retry recover a committed revision without claiming a false conflict.
      for (;;) {
        const record = this.state.record
        if (!record.dirty && !record.pending) return { ...record.meta, document: record.document }
        const pending = record.pending ?? { operationId: crypto.randomUUID(), baseRevision: record.meta.revision, document: record.document }
        if (!record.pending) this.publish({ record: { ...record, pending } })
        await this.persist()
        const result = await cloudRequest<CloudDocument>(`/api/documents/${record.meta.id}`, 'PUT', pending)
        const current = this.state.record
        const dirty = current.document !== pending.document
        const { document: _document, ...meta } = result
        this.publish({ record: { ...current, meta, pending: undefined, dirty }, conflict: undefined, deleted: false })
        await this.persist()
        if (!dirty) return { ...meta, document: current.document }
        // Drain edits made during the request without reusing its operation ID.
      }
    } catch (error) { this.failure(error); return null }
  }
  overwrite = async () => {
    const conflict = this.state.conflict
    if (!conflict || this.state.syncing) return null
    this.publish({ conflict: undefined, record: { ...this.state.record, dirty: true,
      pending: { operationId: crypto.randomUUID(), baseRevision: conflict.revision, document: this.state.record.document } } })
    return this.sync()
  }
  discard = async () => {
    if (this.state.syncing) return false
    const generation = this.generation
    try {
      const result = await cloudRequest<CloudDocument>(`/api/documents/${this.state.record.meta.id}`)
      if (generation !== this.generation) throw new Error('The working copy changed while loading the cloud version. Nothing was discarded; confirm again to discard these newer edits.')
      await this.adopt(result)
      return true
    } catch (error) { this.failure(error); return false }
  }
  async adopt(result: CloudDocument) {
    const { document, ...meta } = result
    initializeDocument(document)
    this.generation++
    this.publish({ record: { ...this.state.record, meta, document, dirty: false, pending: undefined, updatedAt: Date.now() },
      error: '', auth: false, conflict: undefined, deleted: false, epoch: this.state.epoch + 1 })
    await this.persist()
  }
  async checkRemote() {
    if (this.flight || this.state.record.dirty || this.state.conflict || this.state.deleted) return
    const generation = this.generation
    try {
      const result = await cloudRequest<CloudDocument>(`/api/documents/${this.state.record.meta.id}`)
      if (generation !== this.generation || this.state.record.dirty) return
      if (result.revision !== this.state.record.meta.revision) await this.adopt(result)
      else if (result.name !== this.state.record.meta.name) this.publish({ record: { ...this.state.record, meta: { ...this.state.record.meta, name: result.name } } })
    } catch (error) { this.failure(error) }
  }
  async saveAs(name: string): Promise<CloudDocument | null> {
    if (this.flight) await this.flight
    try {
      const id = crypto.randomUUID(), document = { ...this.state.record.document, id }
      const result = await cloudRequest<CloudDocument>('/api/documents', 'POST', { id, document, name, operationId: id })
      // The old local copy is deliberately kept as recovery until explicitly discarded.
      return result
    } catch (error) { this.failure(error); return null }
  }
}
