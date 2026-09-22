import { promises as fs } from 'node:fs'
import path from 'node:path'

export const DEFAULT_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024
export const DEFAULT_TRANSCRIPT_MAX_EVENTS = 2048
export const DEFAULT_TRANSCRIPT_MAX_EVENT_TEXT = 128 * 1024
export const DEFAULT_TRANSCRIPT_MAX_PENDING = 256

function lineFor(event) { return `${JSON.stringify(event)}\n` }
function byteLength(value) { return Buffer.byteLength(value) }
function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.floor(maxBytes))
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}
function validEvent(value) {
  return value && Number.isSafeInteger(value.id) && value.id > 0 && Number.isSafeInteger(value.attempt) && value.attempt > 0 &&
    (value.kind === 'request' || value.kind === 'stdout' || value.kind === 'stderr') && typeof value.text === 'string'
}

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    await fs.writeFile(temporary, value, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}

export class TranscriptJournal {
  constructor(taskDir, options = {}) {
    this.file = path.join(taskDir, 'transcript.ndjson')
    this.maxBytes = Math.max(256, positive(options.maxBytes, DEFAULT_TRANSCRIPT_MAX_BYTES))
    this.maxEvents = Math.max(1, Math.floor(positive(options.maxEvents, DEFAULT_TRANSCRIPT_MAX_EVENTS)))
    this.maxEventText = Math.max(64, positive(options.maxEventText, DEFAULT_TRANSCRIPT_MAX_EVENT_TEXT))
    this.maxPending = Math.max(8, Math.floor(positive(options.maxPending, DEFAULT_TRANSCRIPT_MAX_PENDING)))
    this.events = []
    this.nextId = 1
    this.maxAttempt = 0
    this.pending = 0
    this.writeChain = Promise.resolve()
    this.listeners = new Set()
    this.needsRewrite = false
    this.closed = false
    this.warning = ''
  }

  async init() {
    let raw
    try {
      const stat = await fs.stat(this.file)
      if (stat.size > Math.max(this.maxBytes * 2, 16 * 1024 * 1024)) {
        this.needsRewrite = true; this.warn('Saved transcript exceeds the output limit and is unavailable.'); return
      }
      raw = await fs.readFile(this.file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return
    }
    const lines = raw.toString('utf8').split('\n')
    let maximum = 0
    for (const line of lines) {
      if (!line) continue
      try {
        const event = JSON.parse(line)
        if (!validEvent(event) || event.id <= maximum) throw new Error('invalid transcript event')
        if (byteLength(event.text) > this.maxEventText) { event.text = truncateUtf8(event.text, this.maxEventText); this.needsRewrite = true; this.warn('Some transcript output was omitted by the output limit.') }
        this.events.push(event); maximum = event.id; this.maxAttempt = Math.max(this.maxAttempt, event.attempt)
      } catch { this.needsRewrite = true }
    }
    this.nextId = maximum + 1
    const before = this.events.length
    const beforeText = this.events.map(event => event.text).join('\u0000')
    this.prune()
    if (before !== this.events.length || beforeText !== this.events.map(event => event.text).join('\u0000') || lines.length - 1 !== this.events.length) this.needsRewrite = true
  }

  prune() {
    let bytes = this.events.reduce((total, event) => total + byteLength(lineFor(event)), 0)
    while (this.events.length > this.maxEvents || (this.events.length > 1 && bytes > this.maxBytes)) {
      bytes -= byteLength(lineFor(this.events.shift()))
    }
    if (this.events.length === 1 && bytes > this.maxBytes) {
      const event = this.events[0]
      // JSON escaping can use six bytes for one control character.
      const room = Math.max(0, this.maxBytes - byteLength(lineFor({ ...event, text: '' })))
      while (byteLength(JSON.stringify(event.text)) - 2 > room) event.text = truncateUtf8(event.text, Math.floor(byteLength(event.text) / 2))
    }
  }

  append(attempt, kind, text) {
    if (this.closed || typeof text !== 'string' || !text) return Promise.resolve(false)
    if (kind !== 'request' && this.pending >= this.maxPending) { this.warn('Some transcript output was omitted because it arrived faster than it could be saved.'); return Promise.resolve(false) }
    if (byteLength(text) > this.maxEventText) this.warn('Some transcript output was omitted by the output limit.')
    const event = { id: this.nextId++, attempt, kind, text: truncateUtf8(text, this.maxEventText) }
    this.pending++
    const write = this.writeChain.then(async () => {
      this.events.push(event)
      this.maxAttempt = Math.max(this.maxAttempt, event.attempt)
      const before = this.events.length
      const beforeText = event.text
      this.prune()
      const evicted = before !== this.events.length || beforeText !== event.text || this.needsRewrite
      if (evicted) {
        await atomicWrite(this.file, this.events.map(lineFor).join(''))
        this.needsRewrite = false
      } else {
        await fs.appendFile(this.file, lineFor(event), { mode: 0o600 })
      }
      for (const listener of this.listeners) listener.event(event)
      return true
    }).catch(error => {
      this.needsRewrite = true
      this.warn('Transcript storage failed. Some output may be unavailable after reconnecting.')
      throw error
    }).finally(() => { this.pending-- })
    this.writeChain = write.catch(() => {})
    return write
  }

  replay(after) { return this.events.filter(event => after === null || event.id > after) }
  wasTruncated(after) { return after !== null && (after >= this.nextId || this.events.length > 0 && this.events[0].id > after + 1) }

  warn(message) {
    if (this.warning === message) return
    this.warning = message
    for (const listener of this.listeners) listener.warning(message)
  }

  subscribe(event, close = () => {}, warning = () => {}) {
    if (this.closed) { close(); return () => {} }
    const listener = { event, close, warning }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    if (this.closed) return this.writeChain
    this.closed = true
    for (const listener of this.listeners) listener.close()
    this.listeners.clear()
    return this.writeChain
  }
}
