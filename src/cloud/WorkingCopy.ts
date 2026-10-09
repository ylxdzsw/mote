import type { MoteDocument } from '../document/model'
import { initializeDocument } from '../document/initialize'
import { CloudError, cloudRequest, mergeDocumentMeta, mergePrivacyMeta, normalizeDocumentMeta, type CloudDocument, type DocumentMeta, type Share } from './api'
import { saveWorkingCopy, type WorkingRecord } from './workingCopies'

export interface PrivacyChange {
  private: boolean
  basePrivacyRevision: number
  operationId: string
}

export interface PrivacyState {
  pending?: PrivacyChange
  busy: boolean
  error: string
  message: string
}

export interface CopyState {
  record: WorkingRecord
  local: 'saving' | 'saved' | 'error'
  syncing: boolean
  error: string
  auth: boolean
  conflict?: DocumentMeta
  deleted: boolean
  epoch: number
  privacy: PrivacyState
}

export class WorkingCopy {
  private listeners = new Set<() => void>()
  private saving: Promise<unknown> = Promise.resolve()
  private flight?: Promise<CloudDocument | null>
  private checkingRemote = false
  private checkingPrivacy = false
  private generation = 0
  private state: CopyState
  constructor(record: WorkingRecord) {
    this.state = { record: { ...record, meta: normalizeDocumentMeta(record.meta) }, local: 'saved', syncing: false, error: '', auth: false, deleted: false, epoch: 0,
      privacy: { pending: record.pendingPrivacy, busy: false,
        error: record.pendingPrivacy ? 'Privacy change status was not confirmed. Check the server or retry.' : '', message: '' } }
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
    if (error instanceof CloudError && error.current) {
      const record = this.state.record, meta = mergePrivacyMeta(record.meta, error.current)
      if (meta.private !== record.meta.private || meta.privacyRevision !== record.meta.privacyRevision) {
        this.publish({ record: { ...record, meta } })
        void this.persist().catch(() => {})
      }
    }
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
        const { document: _document, ...resultMeta } = result
        const meta = mergeDocumentMeta(current.meta, resultMeta)
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
    const { document, ...incomingMeta } = result
    const meta = mergeDocumentMeta(this.state.record.meta, incomingMeta)
    initializeDocument(document)
    this.generation++
    this.publish({ record: { ...this.state.record, meta, document, dirty: false, pending: undefined, updatedAt: Date.now() },
      error: '', auth: false, conflict: undefined, deleted: false, epoch: this.state.epoch + 1 })
    await this.persist()
  }
  async checkRemote() {
    if (this.checkingRemote || this.flight || this.state.record.dirty || this.state.conflict || this.state.deleted) return
    this.checkingRemote = true
    const generation = this.generation
    try {
      const result = await cloudRequest<CloudDocument>(`/api/documents/${this.state.record.meta.id}`)
      if (generation !== this.generation || this.state.record.dirty) return
      if (result.revision !== this.state.record.meta.revision) await this.adopt(result)
      else {
        const previous = this.state.record.meta, meta = mergeDocumentMeta(previous, result)
        if (meta.name !== previous.name || meta.private !== previous.private || meta.privacyRevision !== previous.privacyRevision
          || meta.createdAt !== previous.createdAt || meta.updatedAt !== previous.updatedAt) {
          this.publish({ record: { ...this.state.record, meta } })
          void this.persist().catch(() => {})
        }
      }
    } catch (error) { this.failure(error) }
    finally { this.checkingRemote = false }
  }

  private async mergePrivacy(metadata: DocumentMeta): Promise<DocumentMeta> {
    const record = this.state.record
    const meta = mergePrivacyMeta(record.meta, metadata)
    if (meta.private !== record.meta.private || meta.privacyRevision !== record.meta.privacyRevision) {
      this.publish({ record: { ...record, meta } })
      await this.persist().catch(() => {})
    }
    return this.state.record.meta
  }

  private finishPrivacy(change: PrivacyChange, failure = 'The privacy change is not confirmed yet.') {
    const current = this.state
    if (current.privacy.pending?.operationId !== change.operationId) return
    const metadata = current.record.meta
    if (metadata.privacyRevision > change.basePrivacyRevision) {
      const confirmed = metadata.private === change.private
      if (current.record.pendingPrivacy?.operationId === change.operationId) {
        const { pendingPrivacy: _pendingPrivacy, ...record } = current.record
        this.publish({ record })
        void this.persist().catch(() => {})
      }
      this.publish({ privacy: { busy: false, error: confirmed ? '' : 'Privacy changed in another tab. The current server setting is shown; choose again if you still want to change it.',
        message: confirmed ? `Private ${change.private ? 'enabled' : 'disabled'}.` : '' } })
    } else {
      this.publish({ privacy: { ...current.privacy, busy: false, error: failure, message: '' } })
    }
  }

  refreshPrivacy = async () => {
    if (this.checkingPrivacy) return
    this.checkingPrivacy = true
    try {
      const metadata = await cloudRequest<DocumentMeta>(`/api/documents/${this.state.record.meta.id}/privacy`)
      await this.mergePrivacy(normalizeDocumentMeta(metadata))
      const change = this.state.privacy.pending
      if (change && this.state.record.meta.privacyRevision > change.basePrivacyRevision) this.finishPrivacy(change)
    } catch { /* Privacy polling is independent of content sync; explicit changes expose retry/reconcile errors. */ }
    finally { this.checkingPrivacy = false }
  }

  private async reconcilePendingPrivacy(change: PrivacyChange, failure: string) {
    try {
      const metadata = await cloudRequest<DocumentMeta>(`/api/documents/${this.state.record.meta.id}/privacy`)
      await this.mergePrivacy(normalizeDocumentMeta(metadata))
      this.finishPrivacy(change, failure)
    } catch (error) {
      if (this.state.privacy.pending?.operationId === change.operationId) {
        const detail = error instanceof Error ? error.message : 'Could not check the server privacy setting.'
        this.publish({ privacy: { ...this.state.privacy, busy: false, error: `${failure} ${detail}` } })
      }
    }
  }

  private async sendPrivacy(change: PrivacyChange) {
    const path = `/api/documents/${this.state.record.meta.id}/privacy`
    try {
      const metadata = await cloudRequest<DocumentMeta>(path, 'PUT', change)
      await this.mergePrivacy(normalizeDocumentMeta(metadata))
      if (this.state.record.meta.privacyRevision > change.basePrivacyRevision) this.finishPrivacy(change)
      else await this.reconcilePendingPrivacy(change, 'The server did not confirm the privacy change.')
    } catch (error) {
      if (error instanceof CloudError && error.current) {
        await this.mergePrivacy(error.current)
        if (this.state.record.meta.privacyRevision > change.basePrivacyRevision) {
          this.finishPrivacy(change)
          return
        }
      }
      const detail = error instanceof Error ? error.message : 'The privacy change could not be confirmed.'
      await this.reconcilePendingPrivacy(change, `The privacy change could not be confirmed. ${detail}`)
    }
  }

  setPrivate = async (value: boolean, confirmRevoke: (count: number) => boolean) => {
    const meta = this.state.record.meta
    if (this.state.privacy.busy || this.state.privacy.pending || meta.private === value) return
    if (value) {
      this.publish({ privacy: { busy: true, error: '', message: 'Checking active share links…' } })
      try {
        const { shares } = await cloudRequest<{ shares: Share[] }>(`/api/documents/${meta.id}/shares`)
        if (this.state.record.meta.private || shares.length > 0 && !confirmRevoke(shares.length)) {
          this.publish({ privacy: { busy: false, error: '', message: '' } })
          return
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Please try again.'
        this.publish({ privacy: { busy: false, error: `Could not check active share links. Private was not changed. ${detail}`, message: '' } })
        return
      }
    }
    const change: PrivacyChange = { private: value, basePrivacyRevision: meta.privacyRevision, operationId: crypto.randomUUID() }
    this.publish({ record: { ...this.state.record, pendingPrivacy: change }, privacy: { pending: change, busy: true, error: '', message: '' } })
    try { await this.persist() }
    catch {
      this.publish({ privacy: { pending: change, busy: false, error: 'Privacy was not sent because its retry details could not be saved on this device. Retry to try again.', message: '' } })
      return
    }
    if (this.state.record.pendingPrivacy?.operationId !== change.operationId) return
    await this.sendPrivacy(change)
  }

  retryPrivacy = async () => {
    const change = this.state.privacy.pending
    if (!change || this.state.privacy.busy) return
    this.publish({ privacy: { ...this.state.privacy, busy: true, error: '', message: '' } })
    try { await this.persist() }
    catch {
      this.publish({ privacy: { ...this.state.privacy, busy: false, error: 'Privacy was not sent because its retry details could not be saved on this device.' } })
      return
    }
    if (this.state.record.pendingPrivacy?.operationId !== change.operationId) return
    await this.sendPrivacy(change)
  }

  reconcilePrivacy = async () => {
    const change = this.state.privacy.pending
    if (!change || this.state.privacy.busy) return
    this.publish({ privacy: { ...this.state.privacy, busy: true, error: '', message: '' } })
    await this.reconcilePendingPrivacy(change, 'The requested change was not found on the server.')
  }

  async saveAs(name: string): Promise<CloudDocument | null> {
    if (this.flight) await this.flight
    try {
      const id = crypto.randomUUID(), document = { ...this.state.record.document, id }
      const result = await cloudRequest<CloudDocument>('/api/documents', 'POST', { id, document, name, private: this.state.record.meta.private || this.state.privacy.pending?.private === true, operationId: id })
      // The old local copy is deliberately kept as recovery until explicitly discarded.
      return result
    } catch (error) { this.failure(error); return null }
  }
}
