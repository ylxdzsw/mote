# Portable reservation backend

This is the private-client and operator contract. New agent work uses the
reusable, public, unversioned skill set under [`public/skills`](../public/skills/)
and its shared authoring, native-format, preview, and submission references.
New tasks do not copy or pin a guide, skill version, or guide digest. Public
skills/helpers contain no task data and remain accessible after task-grant
revocation; static responses retain `Cache-Control: no-store`. Each task still
pins its immutable document inputs and target. Existing task artifacts and
unresolved work are preserved; legacy task-local guides are not converted or
rewritten.

The document format is V1 (`format: 'mote', version: 1`); the distinct agent
transport protocol is `mote-agent-v1`. See [FORMAT.md](../FORMAT.md) for the
normative native schema.

## Native Flow and Float contract

Cloud documents use the V1 `MoteDocument` directly in storage and on the wire.
Native objects live in ordered `document.objects`; saved geometry is nested in
each object's `layout`. There is no V0 runtime adapter, extension bag, or
implicit conversion. Unknown fields and unsupported versions are rejected.

Every Flow object has exactly one top-level main-content Flow atom
`{type:'flow',attrs:{id:uniqueBlockId,objectId:objectId}}`. Its atom ID and
object ID are distinct. The object saves
`layout.placement:{type:'flow',x:number|'center'}`; it has no saved anchor ID,
y, or `centered` flag. The Flow atom supplies its block position. Numeric x is
an offset from the text-column left; `'center'` centers within the text width.
A Float saves
`layout.placement:{type:'float',anchorId:string|null,x:number,y:number}`.
Its anchor is a main paragraph, spacer, Flow atom, or null for document top.
Ordinary anchors use page x and nonnegative anchor-relative y. A Float anchored
to a Flow block uses signed x/y from that Flow object's measured top-left.
Intersecting Floats leave one main-text interval to their left; text does not
continue to their right. Floats may overlap Flow objects and other Floats.

`theme.flow` is document-level Flow spacing, not a paragraph semantic. Its
optional `spaceBefore`/`spaceAfter` use `{value,unit:'px'|'em'}`; omission means
Before 0 and After follows resolved Body `spaceAfter`. A layout may include
signed `margins:{top,right,bottom,left}` in document pixels; omission means
zero. Margins affect layout footprint, not object dimensions. Clipboard and
conversion operations retain them. See FORMAT.md for theme lengths and exact
object fields.

Captions belong only to image, HTML, and table owners. Their exact shape is
`{content:JSONContent,width?:number}` with a doc containing one paragraph whose
attrs contain only `id`. Caption paragraphs use the shared inline marks and
fixed Caption styling. Omitted width follows the owner; an explicit positive
width in document pixels remains fixed on owner resize. Captions have no
separate object ID, layout, x/y, or placement. A caption is part of its owner's
reservation and composition.

Segment scope includes Flow blocks, their objects and captions, and anchored
Floats. Candidate segment data is a V1 transfer envelope:
`{version:1,type:'segment',content:[...],objects:[...],geometry:{...},anchorTops:{...},originTop:number}`.
It uses `objects`, never `floating`; object records use V1 `layout`. Geometry,
anchor tops, and origin top are transfer-only data, not saved document fields.
Flow references must be one-to-one and internal. Main-text tasks accept
paragraphs only and cannot cross Flow blocks. Individual-object candidates
retain target placement, layout dimensions, centering-as-`x:'center'`, and
user-owned margins; backend normalization preserves the snapshot values and
acceptance rebinds the latest values. Omitting an existing caption preserves
it; an explicit empty caption paragraph clears it. Caption text is reserved,
width is user-owned, and a new caption on an existing object follows its owner.
Section candidates may author margins. A new single-object placeholder may be
Float. Indexing reads captions and both placements from the same native V1
document under the source's current Private policy.

Internal Notes are `authoring.notes`, an ordered array of plain-text strings.
Authorized task snapshots and workspace reads may include them as tentative
user context, but candidates cannot target or edit them. Public shares and
HTML exports omit the entire `authoring` object; native `.mote` exports retain
it.

## Native fixed palette contract

`theme.appearance` contains `mode:'light'|'dark'`, `primaryHue`, and
`secondaryHue`; both hues are finite degrees in `[0,360)`. Theme lengths use
`{value,unit:'px'|'em'}`; line height can also use
`{value,unit:'ratio'}`. `em` resolves against `theme.defaults.size`, while a
ratio multiplies the resolved style font size. Full defaults and sparse
`paragraphs`/`objects` overrides are described in FORMAT.md. Missing styles
inherit defaults; there is no special implicit Subheading fallback. New
creation seeds its Subheading style.

The fixed color references are `primary`, `secondary`, `red`, `amber`,
`green`, `pink`, `blue`, and `violet`, each also supporting `:soft`, plus
single-tone `gray1` through `gray6`. Every slot adapts to mode; Primary and
Secondary follow the theme hues. The page background follows the mode. Drawing
`background` is `"gray6"` or `null`. Text-box `decoration.color` is a pair:
a family ID or `gray4` (Gray 4 / Gray 5).

Inline rich text accepts only `bold`, fixed-palette `color`, Box `decoration`,
and safe absolute HTTP(S) `link` marks. Link hrefs have no credentials or
control characters and cannot be relative, `mailto:`, or `tel:`. Marks have
exact attributes and cannot be duplicated. `theme.palette`, arbitrary raw
colors, and custom color definitions are not part of V1. Clipboard/candidate
payloads carry no palette definitions; fixed references adopt destination mode
and hues.

## Private task API

New tasks pin their V1 document snapshot, target, and supplied visual context; the transport protocol remains `mote-agent-v1`. They do not pin public skills or a guide digest. Existing cloud documents, task artifacts, and unresolved AI state are preserved. Old task snapshots are not converted: any operation that would interpret or mutate an unsupported task input fails explicitly, without deleting the task or automatically retrying generation.

Authenticated `/api/ai/tasks` routes retain their exact-Origin check.
`RemoteTask` includes `executor: 'builtin' | 'external'`, `executorRevision`,
global `candidateRevision`, `workspaceRead`, `workspaceReadRevision`, and
`released`. Counters start at zero; workspace reads default to false. Candidate
records are `{id:'C1',label?,revision,candidate,history?:[{revision,label?,candidate}]}`.
Candidate IDs are stable and never reused. Each task defaults to one candidate; alternatives are intentional. `candidateRevision` is the task-wide
compare-and-swap revision for candidate-set mutations. `externalPath` appears
only for an authorized external reservation; owner inactivity pauses its use
without changing the persisted token. `waiting` means an external task awaits a
candidate; existing candidate records may coexist.

- **POST `/api/ai/tasks`** takes the validated snapshot body, `executor` (default
  builtin), and an `operationId` UUID. Built-in creation uses the explicit task-request `model`
  (the client sources a document override from `authoring.aiModel`) or the
  workspace built-in default.
  Without either, it returns 400 with Settings guidance and creates no task;
  the client may correct its settings and prepare a fresh request. Server/Mu
  defaults are never used. Existing task models remain pinned.
  An external create needs no prompt, model,
  provider configuration, or worker. Cloud tasks must already be acknowledged in
  that document's assistant state with matching ID, target, and baseRevision,
  without acceptance/release. Snapshot JSON must match the named saved revision.
  Identical task-ID/operation-ID/input retries return authoritative current state
  without repeating work. A changed body or ID collision is 409. Operation IDs are mandatory for cloud tasks; direct builtin fake-development
  test calls may omit them.
- **GET `/api/ai/tasks/:id`** is authoritative for executor/candidate revisions,
  status, retained candidate records, release, and the current externalPath.
- **POST `/api/ai/tasks/:id/executor`** takes
  `{executor,baseExecutorRevision,operationId}`. A mismatched base returns 409
  with `current: RemoteTask`. Each actual switch increments executorRevision and
  invalidates both old external and old builtin credentials. Every return to
  external creates a fresh 128-bit random base64url token, exactly 22
  characters, at `/a/:token`. Selecting the current executor is an acknowledged
  no-op. Retrying the same operation/body returns
  current state without reapplying it; reusing the operation with changed input
  returns 409. A complete candidate is never removed by switching. Switching to
  builtin does **not** launch work or require configured provider credentials.
- **POST `/revise`** takes `{prompt,executorRevision}` and is builtin-only. The
  revision is required; stale mode/revision is 409. A valid explicit revision
  starts another generation using the immutable input and any recorded session.
- **POST `/workspace-read`** takes `{enabled,baseWorkspaceReadRevision,operationId}`.
  This server-owned per-session permission is independent of content/assistant
  recovery JSON. Updates are CAS-checked and retry-safe; responses return the
  authoritative task. Both creation and draft UI may explicitly opt in using
  `workspaceRead`. Every actual executor switch (including a privacy-forced
  switch) resets the permission to false and advances its revision. Disabling
  blocks future catalog and source reads, including known IDs and historical
  revisions, without recalling prior downloads or expanding write authority.
- **POST `/stop`** stops builtin execution, preserving a complete candidate.
- **POST `/release`** accepts an empty body, permanently revokes credentials,
  stops workers best effort, and retains input/candidate records/session/artifacts. It
  returns RemoteTask and is idempotent. It does not edit the cloud document or
  assistant JSON. Acceptance receipts can remain until their document save is
  confirmed. There is no reactivation endpoint for a released task ID.
- **DELETE `/api/ai/tasks/:id`** revokes first, then waits outside the task lock
  for workers and removes artifacts. An uncooperative worker yields 409 with
  revoked artifacts retained, rather than deleting files beneath the worker.

Assistant CAS acceptance (`acceptance` set), `released` state, and task removal
write permanent SQLite task-revocation tombstones in the same transaction.
Acceptance is bound to the exact candidate ID and candidate revision displayed
to the owner. The owner action closes the reservation locally immediately and
requests permanent server-side revocation immediately; it does not wait for the
document save to disable the grant. Preserve the acceptance receipt and all
candidate data until the exact accepted document is cloud-acknowledged. Only
after that acknowledgment may the other alternatives be cleaned up.
Document deletion tombstones the document and revokes its reservations. Every
grant check consults this authority; filesystem cleanup and best-effort worker
termination are not authorization boundaries. Reintroducing old assistant JSON
cannot reactivate a revoked ID. Cleanup failure preserves private inspection but
never public access. A fresh reservation uses a fresh task UUID.

## Agent API

External grants use only `/a/<22-character-base64url-token>` (128 random bits),
with resources relative to that base. No workspace cookie or Origin is
required. The public `/api/agent/` route is retired and returns 404 without
logging credentials. Its 43-character built-in transport is available only on
task-local sockets, never on the public listener. Agent responses return no-store, no-referrer, nosniff, and
noindex responses. An external grant paused after owner inactivity returns HTTP
423 with this message:

```text
External task access is paused. Ask the owner to reopen this document in Mote, then continue with the same task URL. Your task and candidates are retained.
```

Reopening resumes the same grant and token. An unknown, permanently revoked,
or unavailable grant/resource returns HTTP 404; it does not resume by
reopening. Capability URLs are secrets and must not enter logs.

Public skill/helper files under `/skills/` are separate static resources. They
are intentionally grant-independent and remain publicly accessible after task
revocation, with `Cache-Control: no-store`; they contain no document, task,
token, or other private workspace data. New tasks do not include a `guideVersion`
in their manifest. Task-specific instructions select only the transport input
and delivery details appropriate to the executor.

- GET `manifest.json` provides `protocol:'mote-agent-v1'`, `taskId`, `executor`,
  `executorRevision`, global `candidateRevision`, the allowed task resource
  paths, and task instructions. It has no skill/guide version field.
- The immutable `document.json`, `target.json`, and optional `snapshot.png`
  remain pinned task inputs. Built-in task briefs provide local paths and the
  task-local Unix socket. External briefs provide the HTTPS base URL. Both use
  the same resource and candidate contract.
- With confirmed `workspaceRead`, GET `workspace-index.md` supplies a filtered
  catalog. Agents download and search the file, not read the whole catalog, and
  read actual documents before relying on descriptions. GET
  `workspace-document.json?id=DOCUMENT_ID[&revision=REVISION]` returns a full
  native document envelope and non-secret owner `sourceUrl`. Latest is the
  default. Current source privacy/deletion is checked on every fetch, including
  historical reads. Denied/unknown sources return 404. Other Private documents
  are omitted completely, including filenames and derived descriptions; the
  task's own Private document may be present for built-in work. Embedded assets
  inherit the same authorization. Neither resource exists for an opted-out
  task.
- GET `candidates.json` returns current full candidate records. Each record is
  `{id:'C1',label?,revision,candidate,history?:[{revision,label?,candidate}]}`.
  GET `candidates/C1.json?revision=N` returns the exact current or historical
  version. Candidate IDs are stable and never reused; candidate revision is
  distinct from the task-wide `candidateRevision` CAS counter.
- POST `submit` accepts the existing envelope
  `{operationId,executorRevision,candidateRevision,candidate,
  assets?:{relativeName:PNG_data_URL}}` plus optional top-level `candidateId`
  and `label`. A supplied `candidateId` revises that record; omitting it creates
  a separate alternative. Labels are limited to 80 characters. Do not create
  alternatives merely to preserve old versions; each record retains its own
  revision history. The agent should remove alternatives only on an explicit
  user request.
- POST `candidates/C1/remove` accepts
  `{operationId,executorRevision,candidateRevision}` and uses the same global
  candidate-set CAS. It is not routine cleanup.

Result-root `screenshotPath` or segment `screenshotPaths` name keys in the
uploaded assets map, never server paths or URLs. Embedded native images carry
their own data URLs. The validator never executes HTML or fetches caller-supplied
URLs/files. Native rich text must match V1. PNGs are bounded and dimension-
checked: an individual HTML candidate uses the snapshot object's body
width/height, excluding caption and margin extents in `target.area`; segment
widgets use their authored body sizes. Each successful mutation advances the
global `candidateRevision`; the receipt identifies `candidateId` and the
resulting candidate `revision` in addition to the task/executor/global state.
Identical retries return the original receipt. Stale executor/candidate-set
revisions or changed operation input return 409. Invalid delivery returns
400/413 and preserves existing candidates.

## External-grant presence and revocation

The open document's existing privacy poll and initial opening request use
`GET /api/documents/:id/privacy?open=1`. Only a successful marked privacy read
renews the persisted 24-hour external access window; unmarked owner GETs,
including `/assistant` recovery downloads, do not. Document creation and
content saves also renew the window. The marker adds no new polling loop.
Agent requests do not renew it. When 24 hours pass without owner-open activity,
all external task-resource reads and mutations pause. Reopening the document
resumes the same token and task; no agent keepalive is used. This inactivity
pause does not delete task artifacts or release the reservation.

Acceptance, explicit release, executor switch, task/document deletion, and
Private permanently revoke the current external token. Reopening or later
disabling Private never revives a revoked token; a newly authorized External
switch creates a fresh short token when allowed. Public share tokens and their
latest-version reader are separate and unaffected by this agent-access window.

### One-time external credential rollout

At startup, active supported external tasks without `externalGrantVersion:1`
receive a fresh random 22-character token. Both earlier short tokens and
43-character tokens are invalidated. The marker and replacement token are
persisted atomically before serving; new grants carry the marker immediately,
so retries and later restarts never rotate them again. This marker versions
credentials, not the public skill or native document schema.

Rotation preserves executor/candidate revisions, candidates/history, input
snapshots, task sessions, permissions, receipts, and document activity times.
Paused grants remain paused. Unsupported inputs are not converted or issued
new credentials; released/deleted/Private grants cannot be revived. Owners
copy replacement links from existing reservations and provide them to their
external agent. No task is generated or resubmitted by the rollout. Public
document-share tokens and built-in execution are unaffected.

## Builtin transport and concurrency

Builtin workers receive a per-run Unix HTTP socket inside their own task bind
mount. This listener implements **only** the agent handler with task ID, run
generation, executor generation, and a random internal token. The public
listener never accepts builtin tokens. It is not a relay to the general moted
socket, and workers never receive that socket. Systemd additionally masks the
general socket, private cloud database/backups, Nginx configuration, and siblings.

Both executors share the resource/submission handler, current public skill
references, and validator. Mote selects separate task instructions: built-in prompts
point to immutable local inputs/helpers and the current run's absolute output
directory, with concrete socket read/submission commands; external handoffs
describe downloading resources and submitting from a local output directory,
without server paths or socket instructions. New tasks do not pin/copy a guide
or public skill version. Shared skill references and static helpers are fetched
independently of task grants; immutable task document inputs remain pinned.
Existing legacy guide copies and unresolved task artifacts are retained and are
not converted by this redesign.

Built-in briefs and manifests use absolute `http://moted.local/...` resource
URLs, all requiring the supplied Unix socket. Briefs include a separate UUID
initialization command for a new payload and the actual submission command.
Retain that UUID with the payload; repeat only submission after an uncertain
reply, never UUID generation. A relative resource path is not a socket command.

Agents must actually POST a result; supervisor filesystem pickup is not delivery.
The fake runner also submits over this HTTP Unix socket. Tests with custom file
fixtures use an explicit helper adapter; production does not.

One moted supervisor owns the filesystem task manager. Its per-task mutation
queue serializes switch, release, revision, and candidate commits; task creation
has a separate serialization queue. Submission checks authorization initially
and again after asynchronous input loading, immediately at commit. Worker stop
never awaits run completion inside that mutation queue; completion/submission
also need the queue. Best-effort process termination saves resources, but
credentials/generations establish correctness for uncooperative late workers.

Replacement builtin execution is additionally gated on **every prior execution
and cleanup promise for this task** finishing. A switch still acknowledges
immediately after durable revocation, but a later revision remains queued without
new credentials, socket, prompt, session discovery, or provider preparation while
the old worker survives. This prevents an old worker's live task bind mount from
revealing a future generation's token and prevents shared Mu/provider cleanup
overlap. Other tasks remain schedulable. Completion callbacks retire the gate and
reschedule outside mutation locks. Real systemd runner completion includes
process-tree stop, inactive/failed/unloaded unit and empty cgroup confirmation,
provider relay cleanup, and log cleanup; unknown teardown state stays blocked.
The pending worker unit is durable across switches and restart, so recovery must
also confirm teardown before allowing future builtin grants. Non-systemd process
groups are a trusted development-only fallback, not production containment.

Metadata, operation fingerprints/receipts, tokens, counters, and candidate
records are
atomically replaced with file/directory fsync. SQLite revocations use the cloud
store's full-synchronous transaction stream. Restart preserves external tokens,
results, candidate histories, owner-activity windows, and retries, but invalidates
builtin tokens and never auto-runs a worker.
Creation recovery binds persisted task metadata to its immutable cloud revision.
No artifact expiration, automatic backup, or scheduled cleanup is added.

## Operator boundary and checks

The production service remains on its authenticated general Unix socket. Nginx
may proxy **only** `/a/` publicly (with access logging off) in addition to
existing read-only share routes. Retired `/api/agent/` requests return 404 at
Nginx without access logging or proxying. Keep `/api/ai` and
`/api/documents` private. Never expose the general TCP listener publicly.
Configure a 128 MiB body limit and no caching for agent and public skill/helper
responses. Token URLs are secrets; the supervisor does not print request URLs.

Owner-only indexing controls use `GET /api/indexing` for status and
`POST /api/indexing/retry` for an explicit retry of failed/stopped work. Both
stay behind the workspace login gate; mutations require the exact allowed
Origin. `GET`/`PUT /api/settings` includes `indexingEnabled`, default false,
alongside revision-checked model defaults. Enabling authorizes background
full-document model processing, including Private documents. A failed indexer
never blocks ordinary cloud saving or agent generation.

Node.js 22.12+ is sufficient for the portable submission helper. Its CLI is
`node submit.mjs BASE OUTPUT EXECUTOR_REV CANDIDATE_REV OP_UUID
[CANDIDATE_ID|-] [LABEL]`; `MOTED_AGENT_SOCKET` supplies the task-local socket
for built-in tasks. Generate one UUID per new payload and retain it with the
exact revisions, candidate ID/label, JSON, and PNG bytes; retry only that
identical submission after an uncertain reply. See the [submission reference](../public/skills/submission.md)
for exact command examples and direct-JSON delivery. Builtin execution still
uses the administrator's configured Mu runtime/provider, non-root worker
account and systemd sandbox; this does not apply to external agents. Provider
Unix sockets use only administrator-configured task-local relays, not
caller-supplied URLs.

Essential offline checks, without real model calls:

```sh
npm run test:ai
```

For just the task lifecycle and cloud-store subset:

```sh
node --experimental-sqlite --test server/moted.test.mjs server/cloud.test.mjs
```

`server/check-result.mjs` remains a local validation convenience using the same
delivery validator. It does not submit. The public `submit.mjs` helper is an
optional transport convenience; a successful receipt must match the candidate
ID/revision and authoritative task revisions. Unrelated JSON or redirects are
not acknowledgment. An unexpected reply is uncertain, not a reason to generate
another operation ID or automatically rebase.
