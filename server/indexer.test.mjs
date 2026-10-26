import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { paletteEntries } from '../shared/palette.mjs'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { CloudStore } from './cloud-store.mjs'
import { DocumentIndexer } from './indexer.mjs'
import { extractNativeVisuals } from './index-visuals.mjs'

function document(id, text = 'initial content') {
  return {
    id, format: 'mote', version: 1, language: 'en', page: { width: 960, margins: { top: 48, right: 48, bottom: 48, left: 48 } },
    theme: {
      appearance: { mode: 'light', primaryHue: 145, secondaryHue: 260 }, autospace: true,
      defaults: { family: 'sans', size: 16, color: 'gray1', weight: 400, lineHeight: { value: 1.5, unit: 'ratio' }, spaceBefore: { value: 0, unit: 'em' }, spaceAfter: { value: 1, unit: 'em' }, letterSpacing: { value: 0, unit: 'em' } },
      paragraphs: {}, objects: {}, flow: {},
    },
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1', semantic: 'body' }, content: [{ type: 'text', text }] }] },
    objects: [],
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-indexer-test-'))
  const store = await CloudStore.open({ stateDir: root, backupDir: path.join(root, 'backups') }, { MOTED_STATE_DIR: root, MOTED_BACKUP_DIR: path.join(root, 'backups') })
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  return { root, store }
}

async function addDocument(store, name, content = 'initial content', isPrivate = false, notes) {
  const id = randomUUID()
  const value = document(id, content)
  if (notes !== undefined) value.authoring = { notes: [notes] }
  return store.create({ id, name, document: value, private: isPrivate, operationId: randomUUID() })
}

function managerFor(root, store, extra = {}) {
  const tasksDir = path.join(root, 'tasks')
  return {
    store, env: { MOTED_FAKE_RUNNER: '1' }, stateDir: root, tasksDir,
    dataDir: path.join(root, 'data'), backupDir: path.join(root, 'backups'), sourcePath: root,
    useSystemd: false, timeoutMs: 3000, active: 0,
    async prepareScope() {}, ...extra,
  }
}

function enable(store, enabled = true) {
  const current = store.settings()
  return store.putSettings({ baseRevision: current.revision, models: { builtin: 'fake', indexing: '' }, indexingEnabled: enabled })
}

async function waitFor(predicate, message = 'condition') {
  const until = Date.now() + 2500
  while (Date.now() < until) {
    const result = predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${message}`)
}

function fakeRunner(run) {
  return async context => {
    const source = JSON.parse(await readFile(path.join(context.inputDir, 'document.json'), 'utf8'))
    return run(context, source)
  }
}

test('settings migration is additive and omitted indexingEnabled retains its value', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-indexer-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = path.join(root, 'data')
  await mkdir(data, { recursive: true })
  const db = new DatabaseSync(path.join(data, 'documents.sqlite'))
  db.exec(`CREATE TABLE workspace_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,builtin TEXT NOT NULL,indexing TEXT NOT NULL);
    INSERT INTO workspace_settings VALUES(1,7,'workspace/model','workspace/indexer');`)
  db.close()
  const store = await CloudStore.open({ stateDir: root, backupDir: path.join(root, 'backups') }, { MOTED_STATE_DIR: root, MOTED_BACKUP_DIR: path.join(root, 'backups') })
  t.after(() => store.close())
  assert.deepEqual(store.settings(), { revision: 7, models: { builtin: 'workspace/model', indexing: 'workspace/indexer' }, indexingEnabled: false })
  const enabled = store.putSettings({ baseRevision: 7, models: { builtin: 'workspace/model', indexing: 'workspace/indexer' }, indexingEnabled: true })
  assert.equal(enabled.indexingEnabled, true)
  assert.equal(store.putSettings({ baseRevision: 8, models: { builtin: 'next', indexing: '' } }).indexingEnabled, true)
  assert.throws(() => store.putSettings({ baseRevision: 8, models: { builtin: 'next', indexing: '' } }), error => error.status === 409)
})

test('visual extraction accepts only embedded native image fields and writes fixed paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-index-visuals-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const jpeg = Buffer.from([255, 216, 255, 217])
  const documentPath = path.join(root, 'document.json')
  await writeFile(documentPath, JSON.stringify({
    objects: [
      { id: 'flow-image', kind: 'image', layout: { width: 100, placement: { type: 'flow', x: 0 } }, src: `data:image/png;base64,${png.toString('base64')}` },
      { kind: 'html', screenshot: `data:image/jpeg;base64,${jpeg.toString('base64')}`, html: '<script>not run</script>' },
      { kind: 'image', src: 'https://example.invalid/image.png', alt: '../../outside.png' },
    ],
  }))
  const result = await extractNativeVisuals(documentPath, path.join(root, 'output'))
  assert.equal(result.paths.length, 2)
  assert.deepEqual(await readFile(result.paths[0]), png)
  assert.deepEqual(await readFile(result.paths[1]), jpeg)
  assert.deepEqual(result.paths.map(file => path.basename(file)), ['visual-001.png', 'visual-002.jpg'])
  assert.equal(result.skipped, 0)
  await assert.rejects(fsStat(path.join(root, 'outside.png')))
})

test('drawing extraction generates bounded inert SVG with escaped labels and palette colors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mote-drawing-visuals-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = document('drawing-doc')
  source.content.content.push({ type: 'flow', attrs: { id: 'drawing-block', objectId: 'flow-drawing' } })
  source.objects.push({ id: 'flow-drawing', kind: 'drawing', layout: { width: 200, height: 100, placement: { type: 'flow', x: 0 } }, background: 'gray6',
    strokes: [{ points: [[1, 2], [3, 4], [5, 6]], color: 'primary', width: 2.5 }],
    labels: [{ x: 5, y: 6, text: '<script>alert("x")</script>\nA & B', color: 'gray1', size: 16 }] })
  source.objects.push({ ...source.objects[0], labels: [{ ...source.objects[0].labels[0], color: 'url(https://example.invalid)' }] })
  const input = path.join(root, 'document.json')
  for (const mode of ['light', 'dark']) {
    source.theme.appearance.mode = mode
    await writeFile(input, JSON.stringify(source))
    const result = await extractNativeVisuals(input, path.join(root, `output-${mode}`))
    assert.equal(result.paths.length, 1)
    assert.equal(result.skipped, 1)
    assert.equal(path.basename(result.paths[0]), 'visual-001.svg')
    const svg = await readFile(result.paths[0], 'utf8')
    const colors = new Map(paletteEntries(source.theme).map(entry => [entry.id, entry]))
    assert.match(svg, /viewBox="0 0 200 100"/)
    assert.ok(svg.includes(`fill="${colors.get('gray6').strong}"`))
    assert.ok(svg.includes(`stroke="${colors.get('primary').strong}"`))
    assert.ok(svg.includes(`fill="${colors.get('gray1').strong}"`))
    assert.match(svg, /d="M1 2Q3 4 4 5L5 6"/)
    assert.match(svg, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/)
    assert.match(svg, /A &amp; B/)
    assert.doesNotMatch(svg, /<script|https:\/\/example|onload=/)
  }
})

test('workspace index and historical reads enforce current source privacy, including Private own document', async t => {
  const { store } = await fixture(t)
  const own = await addDocument(store, 'Own private doc', 'owner-only content', true)
  const otherPrivate = await addDocument(store, 'Hidden private doc', 'hidden material', true)
  const publicSource = await addDocument(store, 'Public source', 'public initial')
  const oldRevision = publicSource.revision
  const changed = store.put(publicSource.id, { baseRevision: oldRevision, operationId: randomUUID(), document: document(publicSource.id, 'public current') })
  const digest = 'a'.repeat(64)
  const runId = randomUUID()
  enable(store)
  store.setIndexTarget(own.id, own.revision, store.indexDocuments().find(row => row.id === own.id).createdAt, digest)
  assert.equal(store.startIndexRun(own.id, own.revision, digest, runId, `moted-${runId}-1`, 'fake'), true)
  store.finishIndexRun(runId, own.revision, digest, 'fake', 'Own private discovery description')

  const filtered = store.workspaceIndex(own.id)
  assert.match(filtered, /Own private doc/)
  assert.doesNotMatch(filtered, /Hidden private doc/)
  assert.match(filtered, /Own private discovery description/)
  const external = store.workspaceIndex(publicSource.id)
  assert.doesNotMatch(external, /Own private doc|Hidden private doc|Own private discovery description|hidden material/)
  assert.equal(store.workspaceDocument(own.id, own.id).document.id, own.id)
  assert.equal(store.workspaceDocument(own.id, publicSource.id, oldRevision).revision, oldRevision)
  assert.equal(store.workspaceDocument(own.id, publicSource.id).revision, changed.revision)
  assert.throws(() => store.workspaceDocument(publicSource.id, otherPrivate.id), error => error.status === 404)

  store.putPrivacy(publicSource.id, { private: true, basePrivacyRevision: 0, operationId: randomUUID() })
  assert.throws(() => store.workspaceDocument(own.id, publicSource.id, oldRevision), error => error.status === 404)
  assert.doesNotMatch(store.workspaceIndex(own.id), /Public source|public current|public initial/)
  assert.equal(store.workspaceDocument(publicSource.id, publicSource.id, oldRevision).revision, oldRevision)
  store.delete(publicSource.id, { baseRevision: changed.revision })
  assert.throws(() => store.workspaceDocument(publicSource.id, publicSource.id), error => error.status === 404)
  assert.doesNotMatch(store.workspaceIndex(publicSource.id), /Public source/)
})

test('indexing debounces from the latest saved revision and passes the complete native document to one isolated runner', async t => {
  const { root, store } = await fixture(t)
  const created = await addDocument(store, 'Debounced private source', 'initial content', true, 'Unverified outline for later work')
  assert.equal(store.settings().indexingEnabled, false)
  const seen = []
  let inputMode, nativeFileMode, indexPrompt
  const runner = fakeRunner(async (context, source) => {
    seen.push(source)
    inputMode = (await fsStat(context.inputDir)).mode & 0o777
    nativeFileMode = (await fsStat(path.join(context.inputDir, 'document.json'))).mode & 0o777
    indexPrompt = await readFile(context.promptPath, 'utf8')
    assert.equal((await fsStat(path.join(context.taskDir, 'shared', 'palette.mjs'))).mode & 0o777, 0o444)
    await promisify(execFile)(process.execPath, [path.join(context.inputDir, 'index-visuals.mjs'), path.join(context.inputDir, 'document.json'), context.outputDir])
    await writeFile(path.join(context.outputDir, 'index.json'), JSON.stringify({ description: 'A concise reusable discovery.' }))
  })
  const manager = managerFor(root, store)
  await mkdir(manager.tasksDir, { recursive: true })
  store.putSettings({ baseRevision: store.settings().revision, models: { builtin: 'workspace/builtin', indexing: 'workspace/indexer' }, indexingEnabled: true })
  const resolution = new DocumentIndexer(manager)
  assert.equal(await resolution.resolveModel(), 'workspace/indexer')
  store.putSettings({ baseRevision: store.settings().revision, models: { builtin: 'workspace/builtin', indexing: '' } })
  assert.equal(await resolution.resolveModel(), 'workspace/builtin')
  store.putSettings({ baseRevision: store.settings().revision, models: { builtin: '', indexing: '' } })
  manager.env.MOTED_MU_DEFAULT_MODEL = 'global/ignored'
  assert.equal(await resolution.resolveModel(), '')
  store.putSettings({ baseRevision: store.settings().revision, models: { builtin: 'workspace/builtin', indexing: 'workspace/indexer' } })
  const models = []
  const modelRunner = fakeRunner(async (context, source) => { models.push(context.model); return runner(context, source) })
  const indexer = new DocumentIndexer(manager, { debounceMs: 180, runner: modelRunner })
  await indexer.init()
  await new Promise(resolve => setTimeout(resolve, 90))
  const latest = document(created.id, 'latest saved body')
  latest.content.content.push({ type: 'flow', attrs: { id: 'flow-block', objectId: 'flow-text' } })
  latest.objects.push({ id: 'flow-text', kind: 'text', layout: { width: 240, placement: { type: 'flow', x: 'center' } },
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'flow-paragraph', semantic: 'body' }, content: [{ type: 'text', text: 'Flow content belongs in the index input' }] }] } })
  latest.objects.push({ id: 'indexed-image', kind: 'image', layout: { width: 180, placement: { type: 'flow', x: 0 } }, src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Index figure', caption: { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'indexed-image-caption' }, content: [{ type: 'text', text: 'Caption belongs in the index input' }] }] } } })
  latest.content.content.push({ type: 'flow', attrs: { id: 'image-block', objectId: 'indexed-image' } })
  const saved = store.put(created.id, { baseRevision: created.revision, operationId: randomUUID(), document: latest })
  indexer.wake()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(seen.length, 0, 'an older revision deadline must not start indexing the latest revision early')
  await waitFor(() => indexer.status().ready === 1, 'debounced index completion')
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], saved.document)
  assert.equal(seen[0].objects.find(object => object.id === 'indexed-image').caption.content.content[0].content[0].text, 'Caption belongs in the index input')
  assert.match(indexPrompt, /Read each object\.caption\.content as part of its owning table, image, or HTML widget/)
  assert.equal(inputMode, 0o755)
  assert.equal(nativeFileMode, 0o444)
  assert.deepEqual(models, ['workspace/indexer'])
  assert.equal(indexer.status().documents[0].revision, saved.revision)
  assert.equal(indexer.status().documents[0].indexedRevision, saved.revision)
  assert.match(store.workspaceIndex(created.id), /A concise reusable discovery/)
  const identical = store.put(created.id, { baseRevision: saved.revision, operationId: randomUUID(), document: saved.document })
  indexer.wake()
  await waitFor(() => indexer.status().documents[0].status === 'ready' && indexer.status().documents[0].indexedRevision === identical.revision, 'fingerprint reuse')
  assert.equal(seen.length, 1, 'an unchanged complete-document fingerprint reuses the prior index')
  const notesOnly = store.put(created.id, {
    baseRevision: identical.revision, operationId: randomUUID(), document: { ...identical.document, authoring: { notes: ['Revised supporting notes'] } },
  })
  indexer.wake()
  await waitFor(() => indexer.status().documents[0].status === 'ready' && indexer.status().documents[0].indexedRevision === notesOnly.revision, 'notes-only index')
  assert.equal(seen.length, 2, 'a notes-only change has a distinct full-document fingerprint')
  assert.deepEqual(seen[1].authoring, notesOnly.document.authoring)
  const editedDocument = document(created.id, 'another latest edit')
  editedDocument.authoring = notesOnly.document.authoring
  const editedAgain = store.put(created.id, { baseRevision: notesOnly.revision, operationId: randomUUID(), document: editedDocument })
  indexer.wake()
  const staleCatalog = store.workspaceIndex(created.id)
  assert.match(staleCatalog, /description status: stale/)
  assert.match(staleCatalog, new RegExp(`indexed revision: ${notesOnly.revision}`))
  assert.match(staleCatalog, /A concise reusable discovery/)
  assert.equal(indexer.status().documents[0].revision, editedAgain.revision)
  await indexer.shutdown()
})

test('failures remain stopped until explicit retry; disabling retains ready indexes; restart fails queued jobs closed', async t => {
  const { root, store } = await fixture(t)
  const first = await addDocument(store, 'Retry me')
  const second = await addDocument(store, 'Restart me')
  enable(store)
  let calls = 0
  const runner = fakeRunner(async (context, source) => {
    calls++
    if (source.id === first.id) throw new Error('fake failure')
    await writeFile(path.join(context.outputDir, 'index.json'), JSON.stringify({ description: `Summary of ${source.id}.` }))
  })
  const manager = managerFor(root, store)
  await mkdir(manager.tasksDir, { recursive: true })
  const indexer = new DocumentIndexer(manager, { debounceMs: 0, runner })
  await indexer.init()
  await waitFor(() => indexer.status().failed === 1 && indexer.status().ready === 1, 'failed and completed indexes')
  const failedCalls = calls
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(calls, failedCalls, 'a failed index must not retry automatically')
  assert.equal(indexer.status().documents.find(item => item.id === first.id).error, 'fake failure')

  const before = store.indexDocuments().find(item => item.id === second.id).indexedRevision
  const paused = enable(store, false)
  assert.equal(paused.indexingEnabled, false)
  indexer.wake()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(indexer.status().documents.find(item => item.id === second.id).status, 'ready')
  assert.equal(store.indexDocuments().find(item => item.id === second.id).indexedRevision, before)
  enable(store, true)
  indexer.wake()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(calls, failedCalls, 'reenabling must preserve and reuse completed indexes')

  const third = await addDocument(store, 'Queued at shutdown')
  indexer.wake()
  await waitFor(() => indexer.status().documents.find(item => item.id === third.id)?.status === 'queued', 'queued job')
  await indexer.shutdown()
  assert.equal(store.indexDocuments().find(item => item.id === third.id).status, 'failed')

  const restartedManager = managerFor(root, store)
  let restartCalls = 0
  const restarted = new DocumentIndexer(restartedManager, { debounceMs: 0, runner: fakeRunner(async (context, source) => {
    restartCalls++
    await writeFile(path.join(context.outputDir, 'index.json'), JSON.stringify({ description: `Recovered ${source.id}.` }))
  }) })
  await restarted.init()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(restartCalls, 0, 'restart must not automatically rerun queued work')
  assert.equal(restarted.status().documents.find(item => item.id === third.id).status, 'failed')
  await restarted.retry()
  await waitFor(() => restarted.status().documents.find(item => item.id === third.id)?.status === 'ready', 'explicit restart retry')
  await waitFor(() => restarted.status().documents.filter(item => item.status === 'ready').length === 3, 'all explicit retries')
  assert.equal(restartCalls, 2)
  assert.equal(store.indexDocuments().find(item => item.id === first.id).status, 'ready')
  await restarted.shutdown()
})

test('disabling cancels an in-flight worker and re-enabling resumes the paused revision', async t => {
  const { root, store } = await fixture(t)
  const source = await addDocument(store, 'Pause an active job')
  enable(store)
  const manager = managerFor(root, store)
  await mkdir(manager.tasksDir, { recursive: true })
  let runs = 0
  const runner = async context => {
    runs++
    if (runs === 1) {
      await new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
      return
    }
    await writeFile(path.join(context.outputDir, 'index.json'), JSON.stringify({ description: 'Finished after resuming.' }))
  }
  const indexer = new DocumentIndexer(manager, { debounceMs: 0, runner })
  await indexer.init()
  await waitFor(() => runs === 1, 'runner start')
  enable(store, false)
  indexer.wake()
  await waitFor(() => indexer.status().documents.find(item => item.id === source.id)?.status === 'queued', 'paused index')
  assert.equal(runs, 1)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(runs, 1, 'disabled indexing must not restart the paused job')
  enable(store, true)
  indexer.wake()
  await waitFor(() => indexer.status().documents.find(item => item.id === source.id)?.status === 'ready', 'resumed index')
  assert.equal(runs, 2)
  await indexer.shutdown()
})

test('at most one indexing runner is active at once', async t => {
  const { root, store } = await fixture(t)
  await addDocument(store, 'Serial one')
  await addDocument(store, 'Serial two')
  enable(store)
  const manager = managerFor(root, store)
  await mkdir(manager.tasksDir, { recursive: true })
  let active = 0, peak = 0, runs = 0
  const runner = fakeRunner(async (context, source) => {
    active++; runs++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 35))
    await writeFile(path.join(context.outputDir, 'index.json'), JSON.stringify({ description: `Summary for ${source.id}.` }))
    active--
  })
  const indexer = new DocumentIndexer(manager, { debounceMs: 0, runner })
  await indexer.init()
  await waitFor(() => indexer.status().ready === 2, 'serial indexes')
  assert.equal(runs, 2)
  assert.equal(peak, 1)
  await indexer.shutdown()
})

test('unconfirmed worker cleanup retains artifacts and blocks future indexing', async t => {
  const { root, store } = await fixture(t)
  const source = await addDocument(store, 'Cleanup failure')
  enable(store)
  const manager = managerFor(root, store)
  await mkdir(manager.tasksDir, { recursive: true })
  const runner = async context => {
    context.cleanupFailed = true
    throw new Error('cleanup unavailable')
  }
  const indexer = new DocumentIndexer(manager, { debounceMs: 0, runner })
  await indexer.init()
  await waitFor(() => indexer.status().documents.find(item => item.id === source.id)?.status === 'failed', 'cleanup failure')
  assert.equal(indexer.blockedCleanup, true)
  const record = store.indexDocuments().find(item => item.id === source.id)
  assert.ok(record.workerUnit)
  await assert.rejects(indexer.retry(), error => error.status === 503)
  const runDir = path.join(manager.tasksDir, 'indexer', record.runId)
  const directoryStat = await (await import('node:fs/promises')).stat(runDir)
  assert.equal(directoryStat.isDirectory(), true)
  await indexer.shutdown()

  const restarted = new DocumentIndexer(manager, { debounceMs: 0, runner })
  await restarted.init()
  assert.equal(restarted.blockedCleanup, true, 'a non-systemd restart must not signal a possibly recycled PID')
  assert.equal((await fsStat(runDir)).isDirectory(), true)
  await restarted.shutdown()
})

test('shutdown bounds an uncooperative runner and fences its late completion', async t => {
  const { root, store } = await fixture(t)
  const source = await addDocument(store, 'Uncooperative runner')
  enable(store)
  const manager = managerFor(root, store, { timeoutMs: 10 })
  await mkdir(manager.tasksDir, { recursive: true })
  let releaseRunner
  const runner = () => new Promise(resolve => { releaseRunner = resolve })
  const indexer = new DocumentIndexer(manager, { debounceMs: 0, runner, runnerSettleTimeoutMs: 20 })
  await indexer.init()
  await waitFor(() => releaseRunner, 'runner start')
  const runId = indexer.running.runId
  const runDir = path.join(indexer.indexDir, runId)
  await indexer.shutdown()

  const record = store.indexDocuments().find(item => item.id === source.id)
  assert.equal(record.status, 'failed')
  assert.equal(record.runId, runId)
  assert.ok(record.workerUnit)
  assert.equal(indexer.blockedCleanup, true)
  assert.equal((await fsStat(runDir)).isDirectory(), true)
  await assert.rejects(indexer.retry(), error => error.status === 503)

  releaseRunner()
  await new Promise(resolve => setTimeout(resolve, 30))
  const afterLateCompletion = store.indexDocuments().find(item => item.id === source.id)
  assert.equal(afterLateCompletion.status, 'failed')
  assert.equal(afterLateCompletion.indexedRevision, null)
})
