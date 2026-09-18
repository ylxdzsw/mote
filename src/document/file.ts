import type { MoteDocument } from './model'
import { initializeDocument } from './initialize'
import { MoteFileError, validateDocument } from './validate'

const maxCompressedBytes = 128 * 1024 * 1024
const maxDecompressedBytes = 128 * 1024 * 1024

async function gzip(data: Blob): Promise<ArrayBuffer> {
  try {
    return await new Response(data.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  } catch {
    throw new Error('Could not gzip the document in this browser.')
  }
}

async function gunzip(data: Blob): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = data.stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  } catch {
    throw new MoteFileError('This .mote file could not be opened as gzip data.')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > maxDecompressedBytes) {
        try { await reader.cancel() } catch { /* The size error is the useful one. */ }
        throw new MoteFileError('The .mote file expands beyond the 128 MiB limit.')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } catch (error) {
    if (error instanceof MoteFileError) throw error
    throw new MoteFileError('This .mote file is not valid gzip-compressed UTF-8.')
  }
  return chunks.join('')
}

export async function encodeMote(doc: MoteDocument): Promise<Blob> {
  let json: string
  try {
    json = JSON.stringify(doc)
  } catch {
    throw new Error('The document could not be serialized for export.')
  }
  if (!json) throw new Error('The document could not be serialized for export.')
  const input = new Blob([json])
  if (input.size > maxDecompressedBytes) throw new MoteFileError('The document exceeds the 128 MiB .mote limit.')
  const compressed = await gzip(input)
  if (compressed.byteLength > maxCompressedBytes) throw new MoteFileError('The compressed document exceeds the 128 MiB .mote limit.')
  return new Blob([compressed], { type: 'application/gzip' })
}

export async function decodeMote(file: File): Promise<MoteDocument> {
  if (!file.name.toLowerCase().endsWith('.mote')) throw new MoteFileError('Choose a .mote file.')
  if (file.size > maxCompressedBytes) throw new MoteFileError('The .mote file is larger than the 128 MiB limit.')

  let compressed: Uint8Array
  try { compressed = new Uint8Array(await file.slice(0, 2).arrayBuffer()) }
  catch { throw new MoteFileError('The .mote file could not be read.') }
  if (compressed.length < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new MoteFileError('The .mote file is not gzip-compressed.')

  const json = await gunzip(file)
  let value: unknown
  try { value = JSON.parse(json) }
  catch { throw new MoteFileError('The .mote file does not contain valid JSON.') }
  validateDocument(value)
  try { return initializeDocument(value) }
  catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : ''
    throw new MoteFileError(`The .mote document content is not valid for V0${detail}`)
  }
}
