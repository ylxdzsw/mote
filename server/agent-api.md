# Portable reservation backend

`guide.md` is the transport-neutral authoring/delivery guide, read in full. It and the standalone
submission/preview helpers are copied into each task's immutable input directory.
The guide SHA-256 is the exact-version identifier in the manifest. This file is
the private-client and operator contract, not part of the agent's instructions.
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

New tasks pin both the V1 document snapshot and `mote-agent-v1` protocol. Existing cloud documents and unresolved AI state are preserved. Old task snapshots are not converted: any operation that would interpret or mutate an unsupported task input fails explicitly, without deleting the task or automatically retrying generation.

Authenticated `/api/ai/tasks` routes retain their exact-Origin check.
`RemoteTask` includes `executor: 'builtin' | 'external'`, `executorRevision`,
`candidateRevision`, `workspaceRead`, `workspaceReadRevision`, and `released`. Counters start at zero; workspace reads default to false. `externalPath`
appears only for a currently authorized external reservation. `waiting` means an
external task awaits a candidate; a previous complete candidate may coexist.

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
  status, retained candidate, release, and the current externalPath.
- **POST `/api/ai/tasks/:id/executor`** takes
  `{executor,baseExecutorRevision,operationId}`. A mismatched base returns 409
  with `current: RemoteTask`. Each actual switch increments executorRevision and
  invalidates both old external and old builtin credentials. Every return to
  external creates a new random 32-byte base64url token. Selecting the current
  executor is an acknowledged no-op. Retrying the same operation/body returns
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
  stops workers best effort, and retains input/candidate/session/artifacts. It
  returns RemoteTask and is idempotent. It does not edit the cloud document or
  assistant JSON. Acceptance receipts can remain until their document save is
  confirmed. There is no reactivation endpoint for a released task ID.
- **DELETE `/api/ai/tasks/:id`** revokes first, then waits outside the task lock
  for workers and removes artifacts. An uncooperative worker yields 409 with
  revoked artifacts retained, rather than deleting files beneath the worker.

Assistant CAS acceptance (`acceptance` set), `released` state, and task removal
write permanent SQLite task-revocation tombstones in the same transaction.
Document deletion tombstones the document and revokes its reservations. Every
grant check consults this authority; filesystem cleanup and best-effort worker
termination are not authorization boundaries. Reintroducing old assistant JSON
cannot reactivate a revoked ID. Cleanup failure preserves private inspection but
never public access. A fresh reservation uses a fresh task UUID.

## Agent API

Only `/api/agent/:token[/resource]` is public. No private cookies or Origin are
required and no cross-origin browser permission is granted. Unknown/revoked
grants return 404 for all reads/submissions. Responses are no-store, no-referrer,
nosniff, and noindex; source helpers download as inert text attachments.

- GET base: curl-readable Markdown handoff, instructions, and resource links.
- GET `manifest.json`: `protocol:'mote-agent-v1'`, `taskId`, `executor`,
  `executorRevision`, `candidateRevision`, `guideVersion`, `resources` keyed by
  filenames, and `instructions`, `candidate`, `submit` paths.
- With confirmed `workspaceRead`, GET `workspace-index.md` supplies a filtered
  catalog. Agents are instructed to download and search the file, not read the
  whole catalog, and to read actual documents before relying on descriptions.
  GET `workspace-document.json?id=DOCUMENT_ID[&revision=REVISION]` returns a full
  native document envelope and non-secret owner `sourceUrl`. Latest is the
  default. Current source privacy/deletion is checked on every fetch, including
  historical reads. Denied/unknown sources return 404. Other Private documents
  are omitted completely, including filenames and derived descriptions; the
  builtin task's own Private document may be present. Embedded assets inherit
  the same envelope authorization. Neither route exists for an opted-out task.
- Immutable `document.json`, `target.json`, optional `snapshot.png`, `guide.md`,
  `submit.mjs`, `preview.mjs`, `preview-harness.html`.
- `instructions.md`: current explicit request and transport-specific input/delivery
  instructions, selected by Mote from the authorized request scope. Agents do not
  choose between executor-specific branches.
- `candidate.json`: last complete validated candidate (404 if absent).
- POST `submit`: `{operationId,executorRevision,candidateRevision,candidate,
  assets?:{relativeName:PNG_data_URL}}`. Result-root `screenshotPath` or
  `screenshotPaths` names keys in that map, **never server paths/URLs**. Embedded
  native images carry their own data URLs. The validator never executes HTML or
  fetches caller-supplied URLs/files. Native rich text must match the supported
  node grammar. PNGs are bounded and dimension-checked: an individual HTML
  candidate uses the snapshot object's body width/height, excluding caption and
  margin extents in `target.area`; segment widgets use their authored body sizes.
  A successful delivery only changes this task's candidate, not the document or
  task list. Its receipt is `{taskId,executorRevision,candidateRevision,
  status:'ready'}`. Candidate revision advances once; identical retry returns
  the original receipt. Stale candidate/executor revisions or changed operation
  input return 409. Invalid delivery returns 400/413 and retains the last result.

## Builtin transport and concurrency

Builtin workers receive a per-run Unix HTTP socket inside their own task bind
mount. This listener implements **only** the agent handler with task ID, run
generation, executor generation, and a random internal token. The public
listener never accepts builtin tokens. It is not a relay to the general moted
socket, and workers never receive that socket. Systemd additionally masks the
general socket, private cloud database/backups, Nginx configuration, and siblings.

Both executors share the resource/submission handler, pinned authoring guide,
and validator. Mote selects separate instruction templates: built-in prompts
point to immutable local inputs/helpers and the current run's absolute output
directory, with concrete socket read/submission commands; external handoffs
describe downloading resources and submitting from a local output directory,
without server paths or socket instructions. The base handoff and instructions.md
use the same selection as the worker prompt. The common guide has no executor
branches and remains one fully loaded reference, not a set of optional fragments.
Existing pinned guides are never rewritten by an instruction update or switch.

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

Metadata, operation fingerprints/receipts, tokens, counters, and candidates are
atomically replaced with file/directory fsync. SQLite revocations use the cloud
store's full-synchronous transaction stream. Restart preserves external tokens,
results and retries, but invalidates builtin tokens and never auto-runs a worker.
Creation recovery binds persisted task metadata to its immutable cloud revision.
No artifact expiration, automatic backup, or scheduled cleanup is added.

## Operator boundary and checks

The production service remains on its authenticated general Unix socket. Nginx
may exempt **only** `/api/agent/` (with access logging off) in addition to existing
read-only share routes. Keep `/api/ai` and `/api/documents` private. Never expose
the general TCP listener publicly. Configure a 128 MiB body limit and no caching.
Token URLs are secrets; the supervisor does not print request URLs.

Owner-only indexing controls use `GET /api/indexing` for status and
`POST /api/indexing/retry` for an explicit retry of failed/stopped work. Both
stay behind the workspace login gate; mutations require the exact allowed
Origin. `GET`/`PUT /api/settings` includes `indexingEnabled`, default false,
alongside revision-checked model defaults. Enabling authorizes background
full-document model processing, including Private documents. A failed indexer
never blocks ordinary cloud saving or agent generation.

Node.js 22.12+ is sufficient for the downloadable submission helper. It has no
Mu, Mote source, browser, or third-party dependency. Builtin execution still uses
the administrator's configured Mu runtime/provider, non-root worker account and
systemd sandbox; this does not apply to external agents. Provider Unix sockets
use only administrator-configured task-local relays, not caller-supplied URLs.

Essential offline checks, without real model calls:

```sh
npm run test:ai
```

For just the task lifecycle and cloud-store subset:

```sh
node --experimental-sqlite --test server/moted.test.mjs server/cloud.test.mjs
```

`server/check-result.mjs` remains a local validation convenience using the same
delivery validator. It does not submit. `submit.mjs` is the portable delivery
helper and accepts fixed operation/revision arguments for lost-response retries.
It requires a successful delivery receipt with matching revisions; unrelated
JSON or redirects are not acknowledgment. An unexpected reply is uncertain,
not a reason to generate another operation ID or automatically rebase.
