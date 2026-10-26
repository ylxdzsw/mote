import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { paletteEntries } from '../shared/palette.mjs'

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

function drawingImage(object, theme) {
  const number = value => typeof value === 'number' && Number.isFinite(value)
  const positive = value => number(value) && value > 0
  if (!positive(object.layout?.width) || !positive(object.layout?.height) || ![null, 'gray6'].includes(object.background)
    || !Array.isArray(object.strokes) || object.strokes.length > 10000 || !Array.isArray(object.labels) || object.labels.length > 1000) return
  const colors = new Map()
  for (const entry of paletteEntries(theme)) {
    if (/^#[0-9a-f]{6}$/i.test(entry?.strong)) colors.set(entry.id, entry.strong)
    if (/^#[0-9a-f]{6}$/i.test(entry?.soft)) colors.set(`${entry.id}:soft`, entry.soft)
  }
  const escape = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character])
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${object.layout?.width}" height="${object.layout?.height}" viewBox="0 0 ${object.layout?.width} ${object.layout?.height}">`]
  if (object.background === 'gray6') parts.push(`<rect width="100%" height="100%" fill="${colors.get('gray6')}"/>`)
  let points = 0
  for (const stroke of object.strokes) {
    if (!stroke || !positive(stroke.width) || !colors.has(stroke.color) || !Array.isArray(stroke.points) || !stroke.points.length
      || (points += stroke.points.length) > 100000 || stroke.points.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(number))) return
    if (stroke.points.length === 1) parts.push(`<circle cx="${stroke.points[0][0]}" cy="${stroke.points[0][1]}" r="${stroke.width / 2}" fill="${colors.get(stroke.color)}"/>`)
    else {
      let path = `M${stroke.points[0].join(' ')}`
      for (let i = 1; i < stroke.points.length - 1; i++) {
        const a = stroke.points[i], b = stroke.points[i + 1]
        path += `Q${a.join(' ')} ${(a[0] / 2 + b[0] / 2)} ${(a[1] / 2 + b[1] / 2)}`
      }
      path += `L${stroke.points.at(-1).join(' ')}`
      parts.push(`<path d="${path}" fill="none" stroke="${colors.get(stroke.color)}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`)
    }
  }
  for (const label of object.labels) {
    if (!label || !number(label.x) || !number(label.y) || !positive(label.size) || !colors.has(label.color) || typeof label.text !== 'string' || label.text.length > 4096) return
    parts.push(`<text x="${label.x}" y="${label.y}" font-size="${label.size}" font-family="ui-sans-serif, system-ui, sans-serif" fill="${colors.get(label.color)}" dominant-baseline="text-before-edge" xml:space="preserve">${label.text.split('\n').map((line, index) => `<tspan x="${label.x}" dy="${index ? label.size * 1.2 : 0}">${escape(line)}</tspan>`).join('')}</text>`)
  }
  parts.push('</svg>')
  const bytes = Buffer.from(parts.join(''))
  return bytes.length <= MAX_IMAGE_BYTES ? { extension: 'svg', bytes } : undefined
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
  const add = image => {
    if (images.length >= MAX_IMAGES || totalBytes + image.bytes.length > MAX_TOTAL_BYTES) skipped++
    else { images.push(image); totalBytes += image.bytes.length }
  }
  const visit = (value, key) => {
    if (key === 'src' || key === 'screenshot') {
      const image = embeddedImage(value)
      if (image) add(image)
    }
    if (Array.isArray(value)) value.forEach(item => visit(item, ''))
    else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey)
  }
  visit(document, '')
  for (const object of document.objects ?? []) if (object?.kind === 'drawing') {
    const image = drawingImage(object, document.theme)
    if (image) add(image)
    else skipped++
  }

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
  if (result.skipped) console.log(`Skipped ${result.skipped} visuals due to invalid data or extraction limits.`)
  if (!result.paths.length) console.log('No supported embedded images, widget screenshots, or drawings were found.')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(String(error.message || error).replace(/[\r\n\t]+/g, ' ')); process.exitCode = 1 })
}
