# Portable reservation backend

`guide.md` is the agent-independent authoring/delivery guide. It and the standalone
submission/preview helpers are copied into each task's immutable input directory.
The guide SHA-256 is the exact-version identifier in the manifest. This file is
the private-client and operator contract, not part of the agent's instructions.

## Native Flow and Float contract

V0 keeps all object kinds in `document.floating`. Objects require
`placement: 'flow' | 'float'` and may have `centered: boolean`; `textFlow` is
unsupported. Each Flow has exactly one top-level main node
`{type:'flow',attrs:{id: uniqueBlockId,objectId: objectId}}`, with the object’s
`anchorId` equal to that block ID and `y:0`. Its `x` offsets the left text margin,
or `centered:true` centers it within the text width. A Float anchored to a Flow
block uses `x,y` relative to that Flow object’s top-left; other Floats use page
`x` and nonnegative anchor-relative `y`. Flow-relative Float offsets may be negative.
The optional `theme.flow` object is document-level Flow spacing, not a paragraph
semantic: its optional `spaceBefore` and `spaceAfter` use nonnegative theme
lengths (finite numbers or `px`/`em` strings). Omitted `spaceBefore` is 0;
omitted `spaceAfter` follows the resolved Body `spaceAfter`. Every object kind
may have optional `margins: {top,right,bottom,left}` with four signed finite
document-pixel values; omission means zero. Margins affect layout footprint,
not object dimensions. Clipboard and conversion operations retain them.
Optional captions belong only to image, HTML, and table objects. They always
appear below the owner, including tables, and use the document's Caption theme.
The schema is `{content: JSONContent, width?: number}`: `content` is a doc with
exactly one paragraph whose `attrs` contains only `id`; inline text and hard
breaks use the shared bold, color, and decoration marks. An omitted width
follows the owner's width; an explicit width is a finite positive document-pixel
value that remains fixed when the owner is resized. Captions have no separate
floating-object ID, x/y, or placement and cannot be detached. Previous V0
bare-document captions and legacy `attachment` keys are rejected without
migration. Intersecting Floats leave one main-text interval to their left; text
does not continue to their right. They do not displace Flow blocks or objects.

Segment scope includes Flow blocks, their objects and built-in captions, and
anchored Floats. A segment delivery may generate or replace these complete
compositions; its Flow node/object references must be internal and one-to-one.
Captions remain within the owning object's fields and are not separate
`objectIds` or geometry entries. Main-text tasks accept paragraphs only and
cannot cross Flow blocks. An individual object target treats margins as
user-owned geometry: candidate margins are validated but normalized to the
snapshot object's value (or omission), and acceptance rebinds the latest
original value so changes made since submission survive. Section/segment
candidates may author object margins. A single-object revision retains the
current target placement, centered state, geometry, and existing caption when
the candidate omits `caption`; an explicit empty `caption.content` paragraph
clears it.
Caption rich text belongs to the reservation, but width is user-owned: the
frontend preserves its current value and the backend normalizes candidate width
to the saved value (or omission when the saved width followed the owner). A
caption added to an existing object follows the owner. It does not replace main
nodes. A new single-object placeholder may remain Float. Indexing
reads both placements and built-in captions from the same full native document
and remains subject to the source’s current Private policy.

Authorized task snapshots and workspace source reads may include internal
`notes` (an ordered array of plain-text notes, or a string for one note). They
are tentative user context, not published page content or automatic task
instructions. Candidate writes cannot target or edit Notes. Public shares and
HTML/PNG exports omit them; native `.mote` exports preserve them.

## Native fixed palette contract

V0 requires `theme.mode` (`light` or `dark`), `theme.hue` (Primary), and
`theme.secondaryHue` (Secondary). Each hue must be finite and in `[0, 360)`.
The fixed color references are `primary`, `secondary`, `red`, `amber`, `green`,
`blue`, `violet`, and `pink`, each also supporting `:soft`, plus the single-tone
`gray1` through `gray6`. Every slot adapts to the document mode; Primary and
Secondary also follow their theme hues. The page background follows the mode.
Drawing `background` is `"gray6"` or `null`. Text-box `decoration.color` is a
pair: a family ID or `gray4` (Gray 4 / Gray 5).

Document validation rejects `theme.palette` and `theme.defaults.background`.
Segment/clipboard payloads reject any `palette` field, including `[]`; fixed
references adopt the destination theme without importing color definitions.
Legacy fields and color references are rejected without migration. Code syntax
colors follow the document mode; embedded images and widget source retain
their independent colors.

## Private task API

Existing authenticated `/api/ai/tasks` routes retain their exact-Origin check.
`RemoteTask` includes `executor: 'builtin' | 'external'`, `executorRevision`,
`candidateRevision`, `workspaceRead`, `workspaceReadRevision`, and `released`. Counters start at zero; workspace reads default to false. `externalPath`
appears only for a currently authorized external reservation. `waiting` means an
external task awaits a candidate; a previous complete candidate may coexist.

- **POST `/api/ai/tasks`** takes the validated snapshot body, `executor` (default
  builtin), and an `operationId` UUID. Built-in creation uses the explicit `model`
  (the client sends the document override) or the workspace built-in default.
  Without either, it returns 400 with Settings guidance and creates no task;
  the client may correct its settings and prepare a fresh request. Server/Mu
  defaults are never used. Existing task models remain pinned.
  An external create needs no prompt, model,
  provider configuration, or worker. Cloud tasks must already be acknowledged in
  that document's assistant state with matching ID, target, and baseRevision,
  without acceptance/release. Snapshot JSON must match the named saved revision.
  Identical task-ID/operation-ID/input retries return authoritative current state
  without repeating work. A changed body or ID collision is 409. Operation IDs
  remain optional only for legacy direct builtin fake-development tasks.
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
- GET `manifest.json`: `protocol:'mote-agent-v0'`, `taskId`, `executor`,
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
- `instructions.md`: current explicit request and delivery instructions.
- `candidate.json`: last complete validated candidate (404 if absent).
- POST `submit`: `{operationId,executorRevision,candidateRevision,candidate,
  assets?:{relativeName:PNG_data_URL}}`. Result-root `screenshotPath` or
  `screenshotPaths` names keys in that map, **never server paths/URLs**. Embedded
  native images carry their own data URLs. The validator never executes HTML or
  fetches caller-supplied URLs/files. PNGs are bounded and dimension-checked.
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

Both executors share the instruction/resource/submission handler and validator.
Builtin agents read via that transport or identical immutable local materials,
and must actually POST a result. Supervisor filesystem pickup is removed. The
fake runner also submits over this HTTP Unix socket. Tests with custom file
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
