import * as sqlite from 'node:sqlite'
import { promises as fs, constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { storagePaths, privateDirectory } from './storage-paths.mjs'

export async function backupDatabase(options = {}, env = process.env) {
  const { databasePath, backupDir } = storagePaths(options, env)
  const source = await fs.lstat(databasePath)
  if (!source.isFile() || source.isSymbolicLink()) throw new Error('backup source must be a regular SQLite file')
  await privateDirectory(backupDir)
  const pending = await fs.mkdtemp(path.join(backupDir, '.pending-'))
  await fs.chmod(pending, 0o700)
  const temporary = path.join(pending, 'documents.sqlite')
  const destination = path.join(backupDir, `documents-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`)
  const db = new sqlite.DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=5000')
    // backup was introduced in 22.16. VACUUM INTO provides a consistent snapshot
    // including WAL contents on 22.12; never copy the live database file alone.
    if (typeof sqlite.backup === 'function' && !options.vacuum) await sqlite.backup(db, temporary)
    else db.prepare('VACUUM INTO ?').run(temporary)
    await fs.chmod(temporary, 0o600)
    const check = new sqlite.DatabaseSync(temporary, { readOnly: true })
    try { if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('backup integrity check failed') } finally { check.close() }
    const handle = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
    // link fails rather than overwriting an existing backup. No retention deletion.
    await fs.link(temporary, destination)
    const directory = await fs.open(backupDir, constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
    return destination
  } finally { db.close(); await fs.rm(pending, { recursive: true, force: true }) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { console.log(await backupDatabase()) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
