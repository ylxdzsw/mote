import { promises as fs, constants } from 'node:fs'
import path from 'node:path'

export function storagePaths(options = {}, env = process.env) {
  const stateDir = path.resolve(options.stateDir || env.MOTED_STATE_DIR || '/var/lib/mote-ai')
  const dataDir = path.resolve(options.dataDir || env.MOTED_DATA_DIR || (options.stateDir ? path.join(stateDir, 'data') : '/var/lib/mote'))
  const backupDir = path.resolve(options.backupDir || env.MOTED_BACKUP_DIR || '/var/backups/mote')
  for (const directory of [dataDir, backupDir]) {
    if (stateDir === directory || stateDir.startsWith(directory + path.sep)) throw new Error('AI workspace must be outside private data and backup directories')
  }
  return { stateDir, dataDir, backupDir, databasePath: path.join(dataDir, 'documents.sqlite') }
}

// Refuse symlink ancestors as well as symlink leaves before changing permissions.
export async function privateDirectory(directory) {
  let current = path.parse(directory).root
  for (const part of path.resolve(directory).slice(current.length).split(path.sep)) {
    current = path.join(current, part)
    try { await fs.mkdir(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${current} must be a real directory`)
  }
  await fs.chmod(directory, 0o700)
}

export async function privateFile(file) {
  const handle = await fs.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${file} must be a regular file`)
    await handle.chmod(0o600)
  } finally { await handle.close() }
}
