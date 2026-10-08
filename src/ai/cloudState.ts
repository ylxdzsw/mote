import type { AITask, AssistantCloudState } from './types'
import type { AssistantRecovery } from './storage'

interface Transport {
  get: () => Promise<AssistantCloudState>
  put: (body: NonNullable<AssistantRecovery['pending']>) => Promise<AssistantCloudState>
  save: (record: AssistantRecovery) => Promise<void>
  changed: () => void
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// One serialized CAS stream per working copy. A failed request keeps its exact
// operation ID/body, including across reload, until its outcome is known.
export class AssistantState {
  record: AssistantRecovery
  conflict: AssistantCloudState | null = null
  warning = ''
  localWarning = ''
  ready = false
  private transport: Transport
  private writes = Promise.resolve()
  private network = Promise.resolve(true)

  constructor(record: AssistantRecovery, transport: Transport) {
    this.record = record
    this.transport = transport
  }
  private emit() { this.transport.changed() }
  private save() {
    const snapshot = structuredClone(this.record)
    this.writes = this.writes.catch(() => {}).then(() => this.transport.save(snapshot)).then(() => {
      this.localWarning = ''; this.emit()
    }, error => {
      this.localWarning = 'AI recovery could not be saved in this browser. Keep this tab open and retry.'
      this.emit(); throw error
    })
    void this.writes.catch(() => {})
    return this.writes
  }
  replace(tasks: AITask[]) {
    if (equal(this.record.tasks, tasks)) return
    this.record = { ...this.record, tasks, dirty: true }
    void this.save().catch(() => {}); this.emit()
  }
  private adopt(remote: AssistantCloudState) {
    this.record = { ...this.record, revision: remote.revision, tasks: remote.tasks, dirty: false, pending: undefined }
  }
  private compare(remote: AssistantCloudState) {
    if (this.record.dirty && this.record.revision !== remote.revision) {
      this.conflict = remote
      this.warning = 'AI tasks changed in another working copy. Cloud saving is paused; your local requests and results are retained. Review both copies below.'
    } else if (!this.record.dirty) this.adopt(remote)
    this.ready = true
  }
  private serialized(action: () => Promise<boolean>) {
    this.network = this.network.catch(() => false).then(action).catch(error => {
      this.warning = `${(error as Error).message} AI cloud saving is paused; this working copy is retained.`
      this.emit(); return false
    })
    return this.network
  }
  initialize() {
    return this.serialized(async () => {
      const remote = await this.transport.get()
      // An unacknowledged PUT may itself have advanced the remote revision.
      const pending = !!this.record.pending
      if (pending && !await this.send()) return false
      this.compare(pending ? await this.transport.get() : remote)
      if (!this.conflict) this.warning = ''
      await this.save(); this.emit(); return !this.conflict
    })
  }
  private async send() {
    const pending = this.record.pending!
    let remote: AssistantCloudState
    try { remote = await this.transport.put(pending) }
    catch (error) {
      if ((error as { status?: number }).status !== 409) throw error
      // Never advance the base revision automatically following a conflict.
      this.conflict = await this.transport.get()
      this.warning = 'AI task conflict: another working copy saved first. Your requests and candidates are kept locally; choose a version explicitly below.'
      this.ready = true; this.emit(); return false
    }
    const unchanged = equal(this.record.tasks, pending.tasks)
    this.record = { ...this.record, revision: remote.revision, pending: undefined, dirty: !unchanged,
      tasks: unchanged ? remote.tasks : this.record.tasks }
    await this.save(); this.emit(); return true
  }
  flush() {
    return this.serialized(async () => {
      if (!this.ready || this.conflict) return false
      while (this.record.dirty || this.record.pending) {
        this.record = { ...this.record, pending: this.record.pending ?? {
          baseRevision: this.record.revision!, tasks: this.record.tasks, operationId: crypto.randomUUID(),
        } }
        // Do not send an operation whose recovery record failed to persist.
        await this.save()
        if (!await this.send()) return false
      }
      this.warning = ''; this.emit(); return true
    })
  }
  refresh() {
    return this.serialized(async () => {
      if (this.conflict || this.record.dirty || this.record.pending) return false
      this.compare(await this.transport.get())
      if (!this.conflict) this.warning = ''
      await this.save(); this.emit(); return !this.conflict
    })
  }
  resolve(choice: 'local' | 'cloud') {
    return this.serialized(async () => {
      if (!this.conflict) return false
      // Confirm the version the user inspected is still the cloud head.
      const remote = await this.transport.get()
      if (remote.revision !== this.conflict.revision) {
        this.conflict = remote; this.warning = 'Cloud tasks changed again. Review the latest cloud copy before choosing.'; this.emit(); return false
      }
      const displaced = choice === 'cloud' ? this.record.tasks : remote.tasks
      this.record = { ...this.record, archives: [...this.record.archives, {
        id: crypto.randomUUID(), label: `${choice === 'cloud' ? 'Local' : 'Cloud'} conflict copy · ${new Date().toLocaleString()}`, tasks: displaced,
      }], revision: remote.revision, pending: undefined, dirty: choice === 'local', tasks: choice === 'cloud' ? remote.tasks : this.record.tasks }
      await this.save()
      this.conflict = null; this.warning = ''; this.emit(); return true
    })
  }
  discardArchive(id: string) {
    this.record = { ...this.record, archives: this.record.archives.filter(archive => archive.id !== id) }
    void this.save().catch(() => {}); this.emit()
  }
}
