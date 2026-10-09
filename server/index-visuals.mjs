import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 40 * 1024 * 1024
const MAX_IMAGES = 128
const TYPES = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/jpg', 'jpg'],
  ['image/webp', 'webp'], ['image/gif', 'gif'], ['image/avif', 'avif'],
])

async function realDirectory(directory) {
  try {
    const stat = await fs.lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('visual output path must be a real directory')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await fs.mkdir(directory, { mode: 0o700 })
  }
}

function embeddedImage(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return
  const comma = value.indexOf(',')
  if (comma < 0) return
  const [mime, ...parameters] = value.slice(5, comma).split(';')
  const extension = TYPES.get(mime.toLowerCase())
  if (!extension || parameters.pop()?.toLowerCase() !== 'base64') return
  if (parameters.some(parameter => !/^[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+$/i.test(parameter))) return
  const encoded = value.slice(comma + 1)
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) return
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return
  return { extension, bytes }
}

export async function extractNativeVisuals(documentPath, outputDir) {
  const inputStat = await fs.lstat(documentPath)
  if (inputStat.isSymbolicLink() || !inputStat.isFile() || inputStat.size > MAX_DOCUMENT_BYTES) throw new Error('native document is not a bounded regular file')
  const document = JSON.parse(await fs.readFile(documentPath, 'utf8'))
  const output = path.resolve(outputDir)
  await realDirectory(output)
  const visualDir = path.join(output, 'visuals')
  await realDirectory(visualDir)

  const images = []
  let skipped = 0, totalBytes = 0
  const visit = (value, key) => {
    if (key === 'src' || key === 'screenshot') {
      const image = embeddedImage(value)
      if (image) {
        if (images.length >= MAX_IMAGES || totalBytes + image.bytes.length > MAX_TOTAL_BYTES) skipped++
        else { images.push(image); totalBytes += image.bytes.length }
      }
    }
    if (Array.isArray(value)) value.forEach(item => visit(item, ''))
    else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey)
  }
  visit(document, '')

  const paths = []
  for (const [index, image] of images.entries()) {
    const name = `visual-${String(index + 1).padStart(3, '0')}.${image.extension}`
    const file = path.join(visualDir, name)
    const handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    try { await handle.writeFile(image.bytes); await handle.chmod(0o600) } finally { await handle.close() }
    paths.push(file)
  }
  return { paths, skipped }
}

async function main() {
  const [documentPath, outputDir] = process.argv.slice(2)
  if (!documentPath || !outputDir || process.argv.length !== 4) throw new Error('usage: node index-visuals.mjs DOCUMENT.json OUTPUT_DIR')
  const result = await extractNativeVisuals(documentPath, outputDir)
  for (const file of result.paths) console.log(file)
  if (result.skipped) console.log(`Skipped ${result.skipped} embedded images due to extraction limits.`)
  if (!result.paths.length) console.log('No supported embedded images or widget screenshots were found.')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(String(error.message || error).replace(/[\r\n\t]+/g, ' ')); process.exitCode = 1 })
}
