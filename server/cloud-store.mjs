import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { HttpError, UUID, record, text, validateDocument } from './validation.mjs'
import { fingerprint } from './agent-protocol.mjs'
import { privateDirectory, privateFile, storagePaths } from './storage-paths.mjs'

const now = () => Date.now()
const META_COLUMNS = 'id,name,revision,createdAt,updatedAt,deletedAt,assistantRevision,private,privacyRevision'
const metadata = row => ({ id: row.id, name: row.name, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, private: row.private === 1, privacyRevision: Number(row.privacyRevision) })
const shareView = row => ({ id: row.id, token: row.token, mode: row.mode, createdAt: row.createdAt, revision: row.revision })
function uuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `${label} must be a UUID`); return value }
function revision(value, label = 'baseRevision') { return text(value, label, 128, true) }
function privacyRevision(value, label) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${label} must be a non-negative safe integer`); return value }
function name(value) { return text(value, 'name', 1024, true) }

export class CloudStore {
  static async open(options = {}, env = process.env) {
    const paths = storagePaths(options, env)
    await privateDirectory(paths.dataDir)
    await privateFile(paths.databasePath)
    const db = new DatabaseSync(paths.databasePath)
    try { return new CloudStore(db, paths) } catch (error) { db.close(); throw error }
  }

  constructor(db, paths) {
    this.db = db; Object.assign(this, paths)
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, revision TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER,
        assistantRevision TEXT NOT NULL DEFAULT '0', tasks TEXT NOT NULL DEFAULT '{"value":[],"assets":[]}',
        private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0,1)), privacyRevision INTEGER NOT NULL DEFAULT 0 CHECK(privacyRevision >= 0)
      );
      CREATE TABLE IF NOT EXISTS revisions (
        documentId TEXT NOT NULL REFERENCES documents(id), revision TEXT NOT NULL,
        createdAt INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(documentId, revision)
      );
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id),
        kind TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id), token TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL CHECK(mode IN ('snapshot','latest')), revision TEXT, createdAt INTEGER NOT NULL, revokedAt INTEGER,
        FOREIGN KEY(documentId, revision) REFERENCES revisions(documentId, revision)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_latest ON shares(documentId) WHERE mode='latest' AND revokedAt IS NULL;
      CREATE INDEX IF NOT EXISTS shares_document ON shares(documentId);
      CREATE TABLE IF NOT EXISTS task_revisions (
        taskId TEXT PRIMARY KEY, documentId TEXT NOT NULL, revision TEXT NOT NULL,
        FOREIGN KEY(documentId, revision) REFERENCES revisions(documentId, revision)
      );
      CREATE TABLE IF NOT EXISTS task_revocations (
        taskId TEXT PRIMARY KEY, documentId TEXT NOT NULL, revokedAt INTEGER NOT NULL
      );`)
    this.transaction(() => {
      const columns = new Set(db.prepare('PRAGMA table_info(documents)').all().map(column => column.name))
      if (!columns.has('private')) db.exec('ALTER TABLE documents ADD COLUMN private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0,1))')
      if (!columns.has('privacyRevision')) db.exec('ALTER TABLE documents ADD COLUMN privacyRevision INTEGER NOT NULL DEFAULT 0 CHECK(privacyRevision >= 0)')
    })
  }

  close() { this.db.close() }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  // A sidecar path map avoids interpreting authored objects/strings as asset references.
  pack(value) {
    const assets = []
    const visit = (value, path = []) => {
      if (path.length > 128) throw new HttpError(413, 'JSON nesting is too deep')
      if (typeof value === 'string' && /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value)) {
        const id = createHash('sha256').update(value).digest('hex')
        this.db.prepare('INSERT OR IGNORE INTO assets(id,data) VALUES (?,?)').run(id, value)
        assets.push({ path, id }); return null
      }
      if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index]))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]))
      return value
    }
    const packed = visit(value)
    return JSON.stringify({ value: packed, assets })
  }

  unpack(body) {
    const packed = JSON.parse(body)
    const cache = new Map()
    for (const { path, id } of packed.assets) {
      if (!cache.has(id)) {
        const asset = this.db.prepare('SELECT data FROM assets WHERE id=?').get(id)
        if (!asset) throw new Error('missing stored asset')
        cache.set(id, asset.data)
      }
      if (!path.length) { packed.value = cache.get(id); continue }
      const parent = path.slice(0, -1).reduce((value, key) => value[key], packed.value)
      Object.defineProperty(parent, path.at(-1), { value: cache.get(id), enumerable: true, writable: true, configurable: true })
    }
    return packed.value
  }

  row(id, withTasks = false) {
    const row = this.db.prepare(`SELECT ${META_COLUMNS}${withTasks ? ',tasks' : ''} FROM documents WHERE id=?`).get(id)
    if (!row) throw new HttpError(404, 'document not found')
    if (row.deletedAt) throw new HttpError(410, 'document was deleted')
    return row
  }
  saved(id, token) {
    const saved = this.db.prepare('SELECT * FROM revisions WHERE documentId=? AND revision=?').get(id, token)
    if (!saved) throw new HttpError(404, 'document revision not found')
    return saved
  }
  envelope(row, token = row.revision) {
    const saved = this.saved(row.id, token)
    // Deliberately no V0 validation on reads: older JSON must reach the reset UI.
    return { ...metadata(row), revision: token, document: this.unpack(saved.body) }
  }
  list() { return { documents: this.db.prepare(`SELECT ${META_COLUMNS} FROM documents WHERE deletedAt IS NULL ORDER BY updatedAt DESC,id`).all().map(metadata) } }
  get(id) { return this.envelope(this.row(id)) }
  privacyMeta(id) { return metadata(this.row(id)) }
  assertExternal(id, privacyEpoch) {
    const row = this.row(id)
    if (row.private) throw new HttpError(403, 'document is private; external access is disabled')
    if (privacyEpoch !== undefined && privacyEpoch !== row.privacyRevision) throw new HttpError(403, 'external capability privacy revision is stale')
    return metadata(row)
  }
  compare(row, baseRevision) { if (row.revision !== revision(baseRevision)) throw new HttpError(409, 'document revision conflict', metadata(row)) }

  retry(id, kind, body) {
    uuid(body.operationId, 'operationId')
    const digest = fingerprint(body)
    const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(body.operationId)
    if (previous && (previous.documentId !== id || previous.kind !== kind || previous.fingerprint !== digest)) throw new HttpError(409, 'operationId was already used for different input')
    return { digest, response: previous ? this.unpack(previous.response) : undefined }
  }
  remember(id, kind, body, digest, response) {
    this.db.prepare('INSERT INTO operations(id,documentId,kind,fingerprint,response) VALUES (?,?,?,?,?)').run(body.operationId, id, kind, digest, this.pack(response))
    return response
  }
  document(value, id) { const document = validateDocument(value); if (document.id !== id) throw new HttpError(400, 'document.id must match cloud document id'); return document }

  create(value) {
    const body = record(value, 'request'); const id = uuid(body.id, 'id')
    if (body.private !== undefined && typeof body.private !== 'boolean') throw new HttpError(400, 'private must be a boolean')
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT ${META_COLUMNS} FROM documents WHERE id=?`).get(id)
      if (existing?.deletedAt) throw new HttpError(410, 'document was deleted')
      const retry = this.retry(id, 'create', body)
      if (retry.response) return retry.response
      if (existing) throw new HttpError(409, 'document ID already exists', metadata(existing))
      const document = this.document(body.document, id); const title = name(body.name); const time = now(); const token = randomUUID()
      this.db.prepare('INSERT INTO documents(id,name,revision,createdAt,updatedAt,private) VALUES (?,?,?,?,?,?)').run(id, title, token, time, time, body.private ? 1 : 0)
      this.db.prepare('INSERT INTO revisions(documentId,revision,createdAt,body) VALUES (?,?,?,?)').run(id, token, time, this.pack(document))
      return this.remember(id, 'create', body, retry.digest, this.get(id))
    })
  }

  put(id, value) {
    const body = record(value, 'request')
    return this.transaction(() => {
      const row = this.row(id); const retry = this.retry(id, 'put', body)
      if (retry.response) return retry.response
      this.compare(row, body.baseRevision)
      const document = this.document(body.document, id); const time = now(); const token = randomUUID()
      this.db.prepare('INSERT INTO revisions(documentId,revision,createdAt,body) VALUES (?,?,?,?)').run(id, token, time, this.pack(document))
      this.db.prepare('UPDATE documents SET revision=?,updatedAt=? WHERE id=?').run(token, time, id)
      return this.remember(id, 'put', body, retry.digest, this.get(id))
    })
  }

  putPrivacy(id, value) {
    const body = record(value, 'request')
    if (typeof body.private !== 'boolean') throw new HttpError(400, 'private must be a boolean')
    const basePrivacyRevision = privacyRevision(body.basePrivacyRevision, 'basePrivacyRevision')
    uuid(body.operationId, 'operationId')
    return this.transaction(() => {
      const row = this.row(id); const retry = this.retry(id, 'privacy', body)
      if (retry.response) return retry.response
      if (row.privacyRevision !== basePrivacyRevision) throw new HttpError(409, 'privacy revision conflict', metadata(row))
      if (Boolean(row.private) !== body.private) {
        if (!Number.isSafeInteger(row.privacyRevision + 1)) throw new HttpError(409, 'privacy revision exhausted', metadata(row))
        const nextPrivacyRevision = row.privacyRevision + 1
        this.db.prepare('UPDATE documents SET private=?,privacyRevision=? WHERE id=?').run(body.private ? 1 : 0, nextPrivacyRevision, id)
        if (body.private) this.db.prepare('UPDATE shares SET revokedAt=? WHERE documentId=? AND revokedAt IS NULL').run(now(), id)
      }
      return this.remember(id, 'privacy', body, retry.digest, this.privacyMeta(id))
    })
  }

  rename(id, value) {
    const title = name(record(value, 'request').name)
    return this.transaction(() => { this.row(id); this.db.prepare('UPDATE documents SET name=?,updatedAt=? WHERE id=?').run(title, now(), id); return metadata(this.row(id)) })
  }
  delete(id, value) {
    const body = record(value, 'request')
    return this.transaction(() => {
      this.compare(this.row(id), body.baseRevision)
      const time = now()
      this.db.prepare('UPDATE documents SET deletedAt=?,updatedAt=? WHERE id=?').run(time, time, id)
      this.db.prepare('UPDATE shares SET revokedAt=? WHERE documentId=? AND revokedAt IS NULL').run(time, id)
      for (const task of this.assistantTasks(id)) this.revokeTask(task.id, id)
      for (const task of this.db.prepare('SELECT taskId FROM task_revisions WHERE documentId=?').all(id)) this.revokeTask(task.taskId, id)
      return { ok: true }
    })
  }

  shares(id) { this.row(id); return { shares: this.db.prepare('SELECT * FROM shares WHERE documentId=? AND revokedAt IS NULL ORDER BY createdAt,id').all(id).map(shareView) } }
  share(id, value) {
    const body = record(value, 'request')
    if (!['snapshot', 'latest'].includes(body.mode)) throw new HttpError(400, 'mode must be snapshot or latest')
    return this.transaction(() => {
      const document = this.row(id)
      if (document.private) throw new HttpError(403, 'Private documents cannot be shared; turn off Private to create a new share link')
      if (body.mode === 'latest') {
        if (body.revision !== undefined && body.revision !== null) throw new HttpError(400, 'latest links do not pin a revision')
        const previous = this.db.prepare("SELECT * FROM shares WHERE documentId=? AND mode='latest' AND revokedAt IS NULL").get(id)
        if (previous) return shareView(previous)
      } else this.saved(id, revision(body.revision, 'revision'))
      const share = { id: randomUUID(), token: randomBytes(32).toString('base64url'), mode: body.mode, revision: body.mode === 'snapshot' ? body.revision : null, createdAt: now() }
      this.db.prepare('INSERT INTO shares(id,documentId,token,mode,revision,createdAt) VALUES (?,?,?,?,?,?)').run(share.id, id, share.token, share.mode, share.revision, share.createdAt)
      return share
    })
  }
  revoke(id, shareId) {
    return this.transaction(() => {
      this.row(id)
      const share = this.db.prepare('SELECT id FROM shares WHERE documentId=? AND id=?').get(id, shareId)
      if (!share) throw new HttpError(404, 'share not found')
      this.db.prepare('UPDATE shares SET revokedAt=? WHERE id=?').run(now(), shareId)
      return { ok: true }
    })
  }
  shared(token) {
    // One statement resolves the head exactly once and checks deletion/revocation.
    const row = this.db.prepare(`SELECT d.name, r.revision, r.body FROM shares s
      JOIN documents d ON d.id=s.documentId
      JOIN revisions r ON r.documentId=d.id AND r.revision=CASE WHEN s.mode='latest' THEN d.revision ELSE s.revision END
      WHERE s.token=? AND s.revokedAt IS NULL AND d.deletedAt IS NULL AND d.private=0`).get(token)
    if (!row) throw new HttpError(404, 'share not found')
    return { name: row.name, revision: row.revision, document: this.unpack(row.body) }
  }

  assistant(id) { const row = this.row(id, true); return { revision: row.assistantRevision, tasks: this.unpack(row.tasks) } }
  putAssistant(id, value) {
    const body = record(value, 'request')
    return this.transaction(() => {
      const row = this.row(id); const retry = this.retry(id, 'assistant', body)
      if (retry.response) return retry.response
      if (row.assistantRevision !== revision(body.baseRevision)) throw new HttpError(409, 'assistant revision conflict', this.assistant(id))
      if (!Array.isArray(body.tasks)) throw new HttpError(400, 'tasks must be an array')
      const ids = new Set()
      for (const value of body.tasks) { const task = record(value, 'task'); uuid(task.id, 'task.id'); if (ids.has(task.id)) throw new HttpError(400, 'duplicate task id'); ids.add(task.id) }
      const active = new Set(body.tasks.filter(task => !task.acceptance && !task.released).map(task => task.id))
      for (const task of [...this.assistantTasks(id), ...body.tasks]) if (!active.has(task.id)) this.revokeTask(task.id, id)
      // Recovery JSON is inert. Only TaskManager.create can validate and launch work.
      this.db.prepare('UPDATE documents SET assistantRevision=?,tasks=? WHERE id=?').run(randomUUID(), this.pack(body.tasks), id)
      return this.remember(id, 'assistant', body, retry.digest, this.assistant(id))
    })
  }

  taskSnapshot(value) {
    const body = record(value, 'request'); const id = uuid(body.cloudDocumentId, 'cloudDocumentId')
    const row = this.row(id); const token = revision(body.baseRevision)
    const reservation = this.assertReservation(body.id, id)
    if (!isDeepStrictEqual(reservation.target, body.target) || reservation.baseRevision !== token) throw new HttpError(409, 'task does not match the active cloud reservation')
    const document = this.envelope(row, token).document
    if (body.document !== undefined && !isDeepStrictEqual(body.document, document)) throw new HttpError(409, 'task document differs from saved revision', metadata(row))
    return { ...body, document, cloudDocumentId: id, baseRevision: token }
  }
  bindTask(taskId, id, token) {
    this.transaction(() => {
      this.assertReservation(taskId, id); this.saved(id, token)
      const existing = this.db.prepare('SELECT * FROM task_revisions WHERE taskId=?').get(taskId)
      if (existing && (existing.documentId !== id || existing.revision !== token)) throw new HttpError(409, 'task ID already bound')
      this.db.prepare('INSERT OR IGNORE INTO task_revisions(taskId,documentId,revision) VALUES (?,?,?)').run(taskId, id, token)
    })
  }
  assistantTasks(id) { return this.unpack(this.db.prepare('SELECT tasks FROM documents WHERE id=?').get(id).tasks) }
  revokeTask(taskId, documentId) { this.db.prepare('INSERT OR IGNORE INTO task_revocations(taskId,documentId,revokedAt) VALUES (?,?,?)').run(taskId, documentId, now()) }
  assertReservation(taskId, id) {
    this.row(id)
    const task = this.assistantTasks(id).find(task => task.id === taskId)
    if (!task || task.acceptance || task.released || this.db.prepare('SELECT 1 FROM task_revocations WHERE taskId=?').get(taskId)) throw new HttpError(410, 'reservation was released or is not active')
    return task
  }
}
