import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { HttpError, UUID, record, text, validateDocument, loadDocument, publishDocument } from './validation.mjs'
import { validateReservations } from './reservation-validation.mjs'
import { fingerprint } from './agent-protocol.mjs'
import { privateDirectory, privateFile, storagePaths } from './storage-paths.mjs'


const now = () => Date.now()
const META_COLUMNS = 'id,name,revision,createdAt,updatedAt,deletedAt,assistantRevision,private,privacyRevision,shareRevision,archived,archiveRevision'
const metadata = row => ({ id: row.id, name: row.name, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, private: row.private === 1, privacyRevision: Number(row.privacyRevision), archived: row.archived === 1, archiveRevision: Number(row.archiveRevision) })
function uuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `${label} must be a UUID`); return value }
function revision(value, label = 'baseRevision') { return text(value, label, 128, true) }
function privacyRevision(value, label) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${label} must be a non-negative safe integer`); return value }
function shareRevision(value, label = 'baseRevision') { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${label} must be a non-negative safe integer`); return value }
function name(value) { return text(value, 'name', 1024, true) }

// V9 can expose formerly cropped content. A saved continuous page needs no revocation.
const legacyDeck = "json_extract(body,'$.value.version') BETWEEN 2 AND 8 AND json_extract(body,'$.value.page.slideHeight') > 0"

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
        private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0,1)), privacyRevision INTEGER NOT NULL DEFAULT 0 CHECK(privacyRevision >= 0),
        shareRevision INTEGER NOT NULL DEFAULT 0 CHECK(shareRevision >= 0),
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), archiveRevision INTEGER NOT NULL DEFAULT 0 CHECK(archiveRevision >= 0)
      );
      CREATE TABLE IF NOT EXISTS revisions (
        documentId TEXT NOT NULL REFERENCES documents(id), revision TEXT NOT NULL,
        createdAt INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(documentId, revision)
      );
      CREATE TABLE IF NOT EXISTS document_reservations (
        documentId TEXT NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(documentId, revision), FOREIGN KEY(documentId,revision) REFERENCES revisions(documentId,revision)
      );
      CREATE TABLE IF NOT EXISTS task_credentials (
        taskId TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id), token TEXT NOT NULL UNIQUE
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
      CREATE INDEX IF NOT EXISTS shares_document ON shares(documentId);
      CREATE TABLE IF NOT EXISTS workspace_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
        builtin TEXT NOT NULL, indexing TEXT NOT NULL,
        indexingEnabled INTEGER NOT NULL DEFAULT 0 CHECK(indexingEnabled IN (0,1))
      );`)
    this.transaction(() => {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS active_share ON shares(documentId) WHERE revokedAt IS NULL')
      // Keep the old NOT NULL indexing columns inert; existing stores need no schema rewrite.
      db.prepare(`INSERT OR IGNORE INTO workspace_settings
        (id,revision,builtin,indexing,indexingEnabled) VALUES (1,0,'','',0)`).run()
      // The active link itself is the checkpoint: once revoked it cannot match again.
      const links = db.prepare(`SELECT d.id,d.shareRevision FROM shares s JOIN documents d ON d.id=s.documentId
        JOIN revisions r ON r.documentId=d.id AND r.revision=d.revision WHERE s.mode='latest' AND s.revokedAt IS NULL AND ${legacyDeck}`).all()
      for (const row of links) this.revokeLatestShare(row)
    })
  }

  close() { this.db.close() }
  settings() {
    const { revision, builtin } = this.db.prepare('SELECT revision,builtin FROM workspace_settings WHERE id=1').get()
    return { revision, models: { builtin } }
  }
  putSettings(value) {
    const body = record(value, 'settings'), models = record(body.models, 'models')
    const baseRevision = privacyRevision(body.baseRevision, 'baseRevision')
    const builtin = text(models.builtin, 'models.builtin', 256).trim()
    if (/[\x00-\x1f\x7f]/.test(builtin)) throw new HttpError(400, 'models.builtin contains an invalid character')
    return this.transaction(() => {
      const current = this.settings()
      if (current.revision !== baseRevision) throw new HttpError(409, 'Workspace settings changed. Reload before saving.', current)
      if (current.models.builtin === builtin) return current
      if (!Number.isSafeInteger(baseRevision + 1)) throw new HttpError(409, 'settings revision exhausted')
      this.db.prepare('UPDATE workspace_settings SET revision=revision+1,builtin=? WHERE id=1').run(builtin)
      return this.settings()
    })
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    const updates = []; this.pendingUpdates = updates
    let result
    try { result = action(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { this.pendingUpdates = undefined }
    for (const { id, kind, end } of updates) {
      this.documentEvents?.publish(id, { kind })
      if (end) this.documentEvents?.end(id)
    }
    return result
  }
  notify(id, kind, end = false) { this.pendingUpdates.push({ id, kind, end }) }

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
    // Owner reads retain raw unsupported records for recovery; load boundaries reject them without rewriting storage.
    return { ...metadata(row), revision: token, document: this.unpack(saved.body), reservations: this.reservations(row.id, token) }
  }
  taskDocument(id, taskId) {
    this.assertReservation(taskId, id)
    const row = this.row(id)
    const document = loadDocument(this.unpack(this.saved(id, row.revision).body))
    return { ...metadata(row), document }
  }
  list() {
    const rows = this.db.prepare(`SELECT ${META_COLUMNS} FROM documents WHERE deletedAt IS NULL ORDER BY updatedAt DESC,id`).all()
    return { documents: rows.map(metadata) }
  }
  get(id) { return this.envelope(this.row(id)) }
  privacyMeta(id) { return metadata(this.row(id)) }
  assertExternal(id) {
    const row = this.row(id)
    if (row.private) throw new HttpError(403, 'document is private; external access is disabled')
    return metadata(row)
  }
  compare(row, baseRevision) { if (row.revision !== revision(baseRevision)) throw new HttpError(409, 'document revision conflict', metadata(row)) }
  nextShareRevision(row) {
    const current = Number(row.shareRevision)
    if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(current + 1)) throw new HttpError(409, 'share revision exhausted', this.shareState(row.id))
    return current + 1
  }

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
      this.saveReservations(id, token, body.reservations === undefined ? [] : body.reservations, document)
      this.notify(id, 'document')
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
      this.saveReservations(id, token, body.reservations === undefined ? this.reservations(id, row.revision) : body.reservations, document)
      if (document.page.slideHeight !== undefined) this.revokeLatestShare(row)
      this.notify(id, 'document')
      return this.remember(id, 'put', body, retry.digest, this.get(id))
    })
  }

  putArchive(id, value) {
    const body = record(value, 'request')
    if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be a boolean')
    const baseArchiveRevision = privacyRevision(body.baseArchiveRevision, 'baseArchiveRevision')
    uuid(body.operationId, 'operationId')
    return this.transaction(() => {
      const row = this.row(id); const retry = this.retry(id, 'archive', body)
      if (retry.response) return metadata(row)
      if (row.archiveRevision !== baseArchiveRevision) throw new HttpError(409, 'archive revision conflict', metadata(row))
      if (Boolean(row.archived) !== body.archived) {
        if (!Number.isSafeInteger(row.archiveRevision + 1)) throw new HttpError(409, 'archive revision exhausted', metadata(row))
        this.db.prepare('UPDATE documents SET archived=?,archiveRevision=? WHERE id=?').run(body.archived ? 1 : 0, row.archiveRevision + 1, id)
        this.notify(id, 'document')
      }
      return this.remember(id, 'archive', body, retry.digest, metadata(this.row(id)))
    })
  }

  putPrivacy(id, value) {
    const body = record(value, 'request')
    if (typeof body.private !== 'boolean') throw new HttpError(400, 'private must be a boolean')
    const basePrivacyRevision = privacyRevision(body.basePrivacyRevision, 'basePrivacyRevision')
    const baseShareRevision = body.baseShareRevision === undefined ? undefined : shareRevision(body.baseShareRevision, 'baseShareRevision')
    uuid(body.operationId, 'operationId')
    return this.transaction(() => {
      const row = this.row(id); const retry = this.retry(id, 'privacy', body)
      if (retry.response) return retry.response
      if (row.privacyRevision !== basePrivacyRevision) throw new HttpError(409, 'privacy revision conflict', metadata(row))
      if (body.private && baseShareRevision !== undefined && row.shareRevision !== baseShareRevision) throw new HttpError(409, 'sharing changed before privacy confirmation', metadata(row))
      if (Boolean(row.private) !== body.private) {
        if (!Number.isSafeInteger(row.privacyRevision + 1)) throw new HttpError(409, 'privacy revision exhausted', metadata(row))
        const nextPrivacyRevision = row.privacyRevision + 1
        const nextShareRevision = this.nextShareRevision(row)
        this.db.prepare('UPDATE documents SET private=?,privacyRevision=?,shareRevision=? WHERE id=?').run(body.private ? 1 : 0, nextPrivacyRevision, nextShareRevision, id)
        if (body.private) this.db.prepare('UPDATE shares SET revokedAt=? WHERE documentId=? AND revokedAt IS NULL').run(now(), id)
        this.notify(id, 'privacy')
      }
      return this.remember(id, 'privacy', body, retry.digest, this.privacyMeta(id))
    })
  }

  rename(id, value) {
    const title = name(record(value, 'request').name)
    return this.transaction(() => { this.row(id); this.db.prepare('UPDATE documents SET name=?,updatedAt=? WHERE id=?').run(title, now(), id); this.notify(id, 'document'); return metadata(this.row(id)) })
  }
  delete(id, value) {
    const body = record(value, 'request')
    return this.transaction(() => {
      const row = this.row(id)
      this.compare(row, body.baseRevision)
      const time = now()
      this.db.prepare('UPDATE documents SET deletedAt=?,updatedAt=?,shareRevision=? WHERE id=?').run(time, time, this.nextShareRevision(row), id)
      this.db.prepare('UPDATE shares SET revokedAt=? WHERE documentId=? AND revokedAt IS NULL').run(time, id)
      this.notify(id, 'deleted', true)
      return { ok: true }
    })
  }

  revokeLatestShare(row) {
    if (this.db.prepare("UPDATE shares SET revokedAt=? WHERE documentId=? AND mode='latest' AND revokedAt IS NULL").run(now(), row.id).changes) {
      this.db.prepare('UPDATE documents SET shareRevision=? WHERE id=?').run(this.nextShareRevision(row), row.id)
      this.notify(row.id, 'privacy')
    }
  }
  shareState(id) {
    const row = this.row(id)
    const share = this.db.prepare("SELECT id,token FROM shares WHERE documentId=? AND mode='latest' AND revokedAt IS NULL").get(id)
    return { revision: Number(row.shareRevision), share: share ? { id: share.id, token: share.token } : null }
  }
  shares(id) { return this.shareState(id) }
  putShares(id, value) {
    const body = record(value, 'request')
    const baseRevision = shareRevision(body.baseRevision)
    uuid(body.operationId, 'operationId')
    if (!['enable', 'disable', 'replace'].includes(body.action)) throw new HttpError(400, 'action must be enable, disable, or replace')
    return this.transaction(() => {
      const document = this.row(id)
      const retry = this.retry(id, 'shares', body)
      // A replay returns today's state, not a saved token that may since have been revoked.
      if (retry.response) return this.shareState(id)
      const current = this.shareState(id)
      if (current.revision !== baseRevision) throw new HttpError(409, 'share revision conflict', current)
      if (document.private && body.action !== 'disable') throw new HttpError(403, 'Private documents cannot be shared; turn off Private to create a new share link')

      const previous = this.db.prepare("SELECT id FROM shares WHERE documentId=? AND mode='latest' AND revokedAt IS NULL").get(id)
      if (body.action === 'enable' && previous) throw new HttpError(409, 'share is already enabled', current)
      if (body.action === 'replace' && !previous) throw new HttpError(409, 'share is not enabled', current)
      if (body.action === 'disable' && !previous) {
        this.remember(id, 'shares', body, retry.digest, { ok: true })
        return current
      }

      const nextRevision = this.nextShareRevision(document)
      const time = now()
      if (previous) this.db.prepare('UPDATE shares SET revokedAt=? WHERE id=?').run(time, previous.id)
      if (body.action !== 'disable') {
        if (this.db.prepare(`SELECT 1 FROM revisions WHERE documentId=? AND revision=? AND ${legacyDeck}`).get(id, document.revision)) throw new HttpError(422, 'Open the converted document in the current editor and save it before enabling sharing.')
        const share = { id: randomUUID(), token: randomBytes(32).toString('base64url') }
        this.db.prepare("INSERT INTO shares(id,documentId,token,mode,revision,createdAt) VALUES (?,?,?,'latest',NULL,?)").run(share.id, id, share.token, time)
      }
      this.db.prepare('UPDATE documents SET shareRevision=? WHERE id=?').run(nextRevision, id)
      this.notify(id, 'privacy')
      this.remember(id, 'shares', body, retry.digest, { ok: true })
      return this.shareState(id)
    })
  }
  shared(token) {
    // Legacy snapshot rows remain stored but can never resolve through public sharing.
    const row = this.db.prepare(`SELECT d.id,d.name,d.revision FROM shares s JOIN documents d ON d.id=s.documentId
      WHERE s.token=? AND s.mode='latest' AND s.revokedAt IS NULL AND d.deletedAt IS NULL AND d.private=0`).get(token)
    if (!row) throw new HttpError(404, 'share not found')
    const document = publishDocument(this.unpack(this.saved(row.id, row.revision).body))
    return { name: row.name, revision: row.revision, document }
  }

  assistant(id) { const row = this.row(id, true); return { revision: row.assistantRevision, tasks: this.unpack(row.tasks) } }
  reservations(id, token = this.row(id).revision) {
    const saved = this.db.prepare('SELECT body FROM document_reservations WHERE documentId=? AND revision=?').get(id, token)
    return saved ? this.unpack(saved.body) : []
  }
  saveReservations(id, token, values, document) {
    validateReservations(values, document)
    for (const item of values) {
      const previous = this.credential(item.id)
      if (previous && previous.documentId !== id) throw new HttpError(409, 'reservation ID belongs to another document')
      this.db.prepare('INSERT OR IGNORE INTO task_credentials(taskId,documentId,token) VALUES (?,?,?)').run(item.id, id, randomBytes(16).toString('base64url'))
    }
    this.db.prepare('INSERT INTO document_reservations(documentId,revision,body) VALUES (?,?,?)').run(id, token, this.pack(values))
  }
  credential(taskId) { return this.db.prepare('SELECT * FROM task_credentials WHERE taskId=?').get(taskId) }
  credentialByToken(token) { return this.db.prepare('SELECT * FROM task_credentials WHERE token=?').get(token) }
  reservation(taskId, id = this.credential(taskId)?.documentId) {
    if (!id) throw new HttpError(404, 'reservation not found')
    const item = this.reservations(id).find(item => item.id === taskId)
    if (!item) throw new HttpError(404, 'reservation not found')
    return item
  }
  assertReservation(taskId, id) {
    const task = this.reservation(taskId, id)
    if (task.released || task.expiresAt !== undefined && task.expiresAt <= now()) throw new HttpError(410, 'reservation was released or expired')
    return task
  }
}
