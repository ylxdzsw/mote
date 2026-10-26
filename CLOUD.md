# Cloud workspace

Mote is one private workspace protected by the existing `nginx_auth` cookie key. Everyone with the key has the same access. There are no user accounts, roles, editable share links, or collaborative merging yet.

## Documents and local work

- `/` opens **Files**; `/d/:id` opens a stable document URL. Nginx serves the existing server-wide `/var/www/login.html` at the requested URL when the cookie is missing or invalid, matching the other protected apps. The shared login sets the cookie and reloads that same URL; Mote does not bundle its own login page. APIs return JSON `401`, not login HTML. Expired authentication never intentionally discards local edits.
- **Files** opens, creates, imports, renames, and deletes documents. Names need not be unique and are separate from authored Title paragraphs. Renaming preserves URLs. Importing `.mote` or Mote-exported HTML always creates a new document with a fresh ID. The filename, without its extension, supplies the new cloud name; invalid files leave the workspace unchanged. The former browser draft remains available for recovery; unsupported formats are not converted or automatically uploaded.
- **New** opens a creation form for Name, Appearance, Text language, and Private; **From example** uses the same form. Cancel creates nothing. Submitting all untouched defaults starts a local-only working copy with a stable ID, not a cloud record. Remembered appearance/language become its browser-local blank baseline, so these defaults alone do not retain an empty file. Entering a name or changing any form field, even reverting it, retains the file through an immediately queued, retry-safe first create. Content (including Notes, objects, or explicit structure), subsequent document settings, or a submitted AI request also retain a draft. Private selected in the form is included atomically in the creation body; it is shown as pending until acknowledged and blocks sharing/external handoff locally meanwhile. Examples and imports always start saving immediately; existing cloud files are not auto-deleted when emptied. Draft URLs can reopen only where their browser-local copy is available until their first cloud save; clearing browser storage loses local-only drafts.
- Every tab has a separate IndexedDB working copy. A session-identity Web Lock prevents duplicated tabs from writing the same record. The lock does not grant exclusive document editing. Without Web Locks, sessions always fork and previous dirty copies remain in **Local recovery**.
- Changes save locally promptly. The active document syncs every 10 seconds while dirty, on the sync indicator, and on Ctrl/⌘S. Offline mode pauses ordinary cloud requests while local editing/saving continues. The indicator retries a validated read-only connection check; the open document also probes every ten seconds and on the browser's online event. Successful reconnection resumes synchronization and AI result monitoring without resubmitting generation. Invalid responses (including Wi-Fi login HTML) never acknowledge a save. Switching documents attempts a sync when connected and requires successful local preservation before leaving. Inactive documents do not continuously sync.
- A cloud save compares its base revision atomically with the current revision. An operation ID is persisted before sending, so a retry after a lost response can recover its original acknowledgment. Edits made during a request remain pending and are drained by the next save.
- A draft’s first save persists the exact creation body and operation ID before its POST. Uncertain creation replays that same operation before draining newer edits through revision-checked saves; reloading or recovering a draft must not replace its unacknowledged creation body.
- **Synced** means an acknowledged cloud save; **Saved locally · changes pending** is not a backup. Local saving, cloud failure, sign-in, conflicts, and deletion have distinct feedback. Local-save failure warns before leaving.
- A conflict pauses automatic sync. **Save as copy** creates another file; **Discard local changes** fetches the latest cloud content; **Overwrite cloud version** still checks the exact version shown to the user. If that version changed again, it conflicts again. Overwrite directly replaces the current cloud version; it creates no extra recovery copy.
- **Local recovery** lists pending or unsupported working copies, including those from closed tabs and copies with pending assistant input even when the document itself is synced. Opening a recognized recovery carries its assistant checkpoint into the new tab's working-copy identity without changing pending operation bodies or IDs. It never replaces another local pending checkpoint; use a new tab when necessary. **Download recovery** preserves raw working-copy JSON and its local assistant checkpoint, and explicitly attempts to include the cloud assistant state without interpreting its document version. Unavailable sources are identified in the download; a network or assistant-storage failure does not prevent downloading the working copy. The earlier browser-only draft is download-only. There is no server recovery-copy browser, merging, or conflict-comparison renderer. Immutable revisions used by AI inputs and request acknowledgments are separate from overwrite recovery.
- A deleted document is tombstoned, all its links are revoked, and stale tabs cannot resurrect it through autosave. Their local work can be saved as another file or explicitly discarded.
- Undo/redo remains an editing-session history in memory, not a cloud-wide stack. Sync does not clear it; undo after sync makes a new local change. Reload and adoption of remote content clear history. Undo history is never exported in `.mote`.
- Optional V1 `authoring.notes` stores an ordered array of user-maintained plain-text scratchpads. Notes save in the same document revision, local recovery, and native `.mote` exports. If `authoring` is omitted there are no notes or document model override. Notes are outside the rendered page and hidden in reading mode. Public shared responses and HTML export omit the entire `authoring` object; PNG only renders the page.
- Clean private editors can adopt newer server revisions; dirty copies are never silently replaced. Browser recovery can be evicted or cleared, so unsynced work is not durable cloud storage.

## V1 documents and layout

Native documents use the V1 clean-break schema. The complete field, rich-text, theme, layout, ownership, coordinate, and validation rules are normative in [FORMAT.md](FORMAT.md). Cloud storage and APIs use the same V1 `MoteDocument`; there is no V0-shaped runtime adapter. Objects are stored in ordered `objects` with all saved geometry nested in `layout`. Flow atoms remain first-class main-content blocks, and a Flow object's position comes from its matching atom rather than saved anchor/y/centering fields. Floats retain main-block anchors; Flow-relative Float offsets are signed on both axes, while ordinary anchor y offsets are nonnegative.

Captions are owned subobjects on image, HTML, and table objects. They remain below and centered on their owner and participate in the owner's composition, reservation, segment, layout, and export behavior. Clipboard and AI segment compositions preserve block/object/anchor relationships and remap IDs on paste. Individual AI object revisions preserve user-owned margins and caption width; section reservations lock their composition. The renderer and measured Flow mounts are shared by editing, reading, minimap, PNG, and standalone HTML.

## Sharing

Public sharing is disabled for new documents. The Share dialog's **Link** tab controls at most one active, latest-version link per document. Opening the dialog reads the server-owned share state but never creates a link. For the open document, enabling first synchronizes its working copy; if synchronization fails, no share is enabled and no URL is issued. Files → row menu → Share opens this same dialog for any document without navigating. For another document, enabling uses its already cloud-saved content, never syncing the active document or adopting another tab’s recovery copy. Once enabled, the tab shows the URL and **Copy link**. **Replace link** asks for confirmation before revoking the current token and issuing a fresh URL. **Disable sharing** also requires confirmation; confirmed revocation is permanent, and enabling later creates a new URL. Copy, replace, and disable have no document-save prerequisite. Share state is server metadata, not document content, undo history, or export settings.

Share state has its own server-owned revision. `GET /api/documents/:id/shares` returns `{revision, share: null | {id, token}}`; `PUT /api/documents/:id/shares` accepts `action: "enable" | "disable" | "replace"`, `baseRevision`, and `operationId`. Each operation atomically compares the base share revision, and operation IDs make uncertain retries safe. There is no link-list endpoint or snapshot-creation `POST`. These operations do not change document or AI revisions.

Links use 256-bit random tokens at `/s/:token`, work without login, and mount the read-only canvas. Opening a public link makes one scoped document fetch of the then-current cloud revision; unsynced local changes are not included. The reader does not poll, use SSE, announce updates, or refresh automatically. Later cloud saves appear after reload, which fetches the then-current document. The entire `authoring` object is omitted from the public shared response. Interactive widget code may independently load network resources; sharing does not archive external dependencies or runtime state.

Revocation and file deletion stop future access, not copies already opened or downloaded. Shared APIs expose only the selected document, filename, and current revision, never AI state or other files. Public navigation uses no-referrer/noindex/no-store headers. Sharing is read-only even when the visitor holds the workspace cookie. The latest-only public-link change leaves AI capability grants, executor rules, immutable AI input revisions, and candidate protocols unchanged.

On rollout, existing snapshot links are retired while each document's existing Latest URL remains active, so those documents stay enabled. No document content or AI state is rewritten or deleted.

## AI is document-associated

The assistant is part of the workspace and uses same-origin authenticated APIs. Model outages do not prevent manual editing.

**Settings → Workspace** stores workspace model defaults and opt-in `indexingEnabled` through authenticated `GET`/`PUT /api/settings`. Updates compare a settings revision; a conflict or uncertain response never silently overwrites newer settings. Built-in model precedence is an explicit document override, then the workspace default. At least one must be configured; server environment and Mu defaults are not used. New documents inherit; an already selected task/session model stays pinned. Blank indexing inherits the workspace built-in default, not a document override; without either workspace model, indexing fails with a Settings message and requires explicit retry. Settings are independent of V1 documents and exports. Reading them never invokes Mu or checks provider connectivity; enabling auto-indexing authorizes background model work.

Generation has no automatic restart loop. Missing Mu/configuration, provider failure, timeout, or a service restart leaves an explicit recoverable error/stopped task. Mu's own provider retries are finite and backed off; see [Availability and retry boundaries](README.md#availability-and-retry-boundaries). Network failures retain pending AI state and pause ordinary requests until connectivity is verified; status checks, transcripts, and assistant recovery then resume automatically. Other status failures back off then pause, and authentication/conflicts retain their explicit recovery actions. Worker cleanup also has bounded attempts. If cleanup cannot be confirmed, its execution and artifacts remain fenced from future built-in runs until the underlying service is recovered and moted restarted; manual document work remains available. Browser cloud requests time out rather than indefinitely blocking a retained working copy behind a stalled response.

Before a first built-in request or external handoff, the editor syncs its document, records the acknowledged revision and target, and captures matching rendered context. The backend resolves that immutable revision and rejects a different supplied snapshot. Both executors receive a full document snapshot plus the guide/target/output contract; they never mutate the cloud database. Executor switches retain the original input.

Authorized full-document snapshots and workspace source reads include internal Notes under the same document privacy/access policy. Notes may contain outlines, spare text, plans, or abandoned/unverified ideas: agents use them as tentative context, not automatic task instructions or published content. Notes are never an agent write target. The trusted indexer may use them as supporting context while describing the actual page first; planned content must not be represented as already present. Notes edits change the document fingerprint and follow the ordinary indexing debounce.

The reservation's **Built-in / External** choice is server-owned. External grants a random 256-bit bearer capability at `/api/agent/:token`, providing scoped immutable reads and candidate submission without workspace login. Built-in creates no public grant and uses a task-local Unix socket exposing only the same scoped agent protocol, not the private Mote API. Each switch advances an executor revision and revokes the previous credentials; old links/runs cannot become valid after a round trip. Switches use revision checks and retry-safe operation IDs. The client disables chat/submission and copy controls until confirmation, including after an uncertain response or reload.

The handoff is readable Markdown with a JSON manifest, pinned guide digest, native document, target, PNG, and portable helpers. Candidates upload actual image bytes rather than server filesystem paths. Submission is candidate-revision checked and retry-safe; authorization is checked again when committing under the task mutation lock. External agents can submit successive candidates but cannot accept their own work, change unrelated content, or access other files. Completed candidates survive executor changes. Mote cancels old built-in workers when switching, but cannot terminate external processes.

Acceptance, assistant-state removal, and document deletion durably revoke agent access independently of artifact cleanup. An explicit release can also retain recovery artifacts while withdrawing all grants. Revocation cannot retract downloaded content. Capability routes are no-store/no-referrer/noindex and omitted from Nginx access logs; tokens are not stored in exported documents or client task recovery JSON. The normal Share dialog remains separate and read-only.

Task recovery uses a separate cloud revision and per-working-copy local checkpoint. Conflicting task state is preserved for explicit resolution, and stale target candidates remain inspectable without locking incompatible content. Original input snapshots and result candidates survive closing a tab or switching documents. Temporary execution state has no 24-hour automatic expiry.

Document switching, browser Back navigation, and adoption of a newer cloud document preserve the assistant checkpoint before replacing its in-memory owner. A failed local assistant write keeps the current document open so user-written requests can be saved or downloaded; a network connection is not required to preserve locally. Recovering a checkpoint never automatically sends generation. If a backend task is missing, a locally retained candidate can still be accepted after normal document/target validation, without confirming permissions for a remote session that no longer exists.

Acceptance is one ordinary local history action. An acceptance receipt retains the original/candidate until the exact accepted document and task-state removal are acknowledged. An uncertain save or cleanup retains artifacts rather than losing a result. Bounded execution transcripts remain outside document content and exports.

Cloud saving sends documents to Mote. Explicit AI generation and enabled automatic indexing additionally share the whole input document with the configured model/provider. Generated HTML stays in sandboxed opaque-origin iframes.

## Widget screenshot capture

**Update screenshot** is an explicit owner action, available through the login-gated, exact-Origin `POST /api/widgets/screenshot`. The request contains only `{html,width,height}` from the local working copy, including unsynced source; it does not read a cloud document or grant workspace access. The response contains an embedded PNG in `{screenshot}`. The browser applies it as one local undoable change, then saves it through normal revision-checked synchronization. Capture does not save documents directly, call a model, or alter AI reservations. Public readers and agent capabilities cannot invoke it. Private documents support owner-requested capture under the same boundary.

Limits are 1 MiB of HTML within a 2 MiB JSON body, dimensions from 1 to 2048 CSS pixels per axis (rounded to integers), at most 2 megapixels of native area, and a 10 MiB PNG at 2× resolution. Two captures may run concurrently; additional requests receive a retryable busy response rather than queueing. Each job has a 25-second deadline plus bounded teardown; the browser request allows 35 seconds. Capture-specific errors stay local to the action rather than taking the workspace offline. A disconnected client aborts its job. Unconfirmed worker teardown fences new captures until service recovery.

Real captures use a disposable systemd service with an empty filesystem root, read-only runtime/font mounts, a fresh Chromium profile, unprivileged dynamic user, private PID/network namespaces, and bounded CPU, memory, process count, and runtime. The worker receives only the widget source/dimensions and capture harness; cloud storage, AI task directories, host credentials, and the private Mote socket are absent. Chromium keeps its own sandbox enabled and uses the same opaque-origin `allow-scripts` iframe as ordinary widget rendering.

The browser has no host-network access. A bounded CONNECT proxy permits only public destinations on port 443 for HTTPS resources, pins checked public IPv4 addresses at connection time, and checks every new destination, including redirects. Private/reserved addresses, the server's own addresses, IPv6, plain HTTP, and other ports are blocked. The browser starts without workspace cookies or credentials; any cookies or requests created by the widget stay within this disposable run. Public resources can observe requests made by the widget; capture is not an offline or network-free execution promise. Resource loading is bounded, and a fresh animation or asynchronous app may render differently from an interaction already open on the page.

Captures are transient, not durable AI tasks: no automatic retry after reconnection or restart. The previous saved screenshot survives failures; source/geometry changes, undo/redo, reservation, deletion, leaving editing, or document switching prevent late results from being applied. Existing embedded screenshots are retained, including manually supplied ones. Minimap and PNG export keep using the saved image without executing widget code. Fake development returns a deterministic PNG without starting Chromium.

## Automatic indexing and session retrieval

Auto-indexing is off by default. A server-owned queue waits **100 seconds after the latest saved content revision** (10× autosave), coalescing later saves and continuing after browser closure. Renaming, changing Private, and assistant-state updates are not content saves. Jobs are document-local, revision-bound, low-concurrency isolated workers with no database or workspace retrieval access. Each receives the complete native document and writes a concise free-form discovery description. The prompt invites short descriptions of meaningful visuals and interactive/reusable material, without requiring section/object inventories or describing decoration. No vector database, embeddings, or separate Segment Library is introduced.

Completed indexes are derived cloud metadata, not native document content or exports. Stale descriptions remain searchable with their indexed revision clearly labeled; working agents must verify the actual source. An embedded-visual helper lets indexers inspect native images and saved widget screenshots without following remote URLs or executing document code. A failed job does not block editing/saving and does not run an unbounded retry loop. Settings → Workspace shows status through `GET /api/indexing` and offers explicit `POST /api/indexing/retry`. Disabling auto-indexing pauses maintenance and retains completed descriptions; it does not revoke session reads. Privacy changes do not require reindexing.

**Use workspace documents** (built-in) and **Allow workspace reads** (external) are separate server-confirmed per-session permissions, off by default. Permission changes use their own monotonic revision and retry-safe operation IDs, outside content undo/redo. Every executor change resets workspace reads; a previously enabled built-in session does not silently grant workspace access to an external executor. Unknown responses remain unconfirmed until reconciliation/retry. Capability resources recheck the active task and current permission on each request.

An enabled agent is told where to download `workspace-index.md` and instructed to **search it with focused queries instead of reading it as a whole**. Each eligible document has a description and server-generated identity/revision/source reference. The agent decides whether to search, then fetches and reads relevant full native documents before referring to or reusing their material. The index is a discovery aid, not evidence. Scoped source reads default to the latest cloud revision and can pin a revision for consistent subsequent reads; current access policy always wins. Native assets travel within the authorized document envelope. Retrieval never expands the reserved write target or permits automatic acceptance. Source attribution uses the ordinary owner document URL, never a secret bearer URL. Direct user queries are planned, not implemented.

## Document Private policy

**Status: Private, opt-in workspace indexing, and session-scoped cross-document agent retrieval are implemented.** Document settings exposes Private, Files identifies private documents, and the server enforces source policy on public sharing, external handoff, catalog delivery, and direct reads.

**Private controls access, not indexing: no public exposure and no cross-document agent access.** It is distinct from the workspace's existing login protection. A non-private document is still inside the authenticated workspace; it does not become public automatically.

### Access matrix

Each agent task belongs to one server-bound document. “Own document” below means that document, not an ID the agent supplies to a search or read request. Existing task/grant validity checks still apply.

| Operation on a source document | Non-private source | Private source |
| --- | --- | --- |
| Workspace owner finds it in Files, opens, or edits it | Allowed | Allowed |
| Trusted built-in indexer processes its assigned document | Allowed | Allowed |
| Built-in agent reads its own document and index | Allowed | Allowed |
| Built-in agent on another document discovers or reads its content/index | Allowed | Denied |
| External agent works on the source document itself | Allowed with an active external grant | Denied |
| External agent on another document discovers or reads its content/index | Requires an active external grant with optional workspace-read permission | Denied |
| Public latest-version sharing | Requires the document's active link | Denied |

Private protects the source, not the destination: a built-in agent working on private document A may retrieve non-private B, but cannot retrieve another private document C. Built-in agents are trusted to process their own private context; that trust does not grant them access to every private document. Cross-document reading never expands the task's reserved write region or permits automatic acceptance.

Private does **not** mean hidden from the workspace owner, disabled AI, disabled indexing, encryption, or a promise that content never reaches the configured model/provider. Trusted built-in indexing and generation may process it. External handoff is forbidden even for the private document's own task because it exposes context through a public bearer capability. That capability is separate from a Share-dialog link; both access paths must enforce Private independently.

### Index and retrieval boundaries

- All documents, including private ones, may use the same indexing pipeline. Preserve a private document's index for its own built-in agent; do not skip, cancel, or purge indexing merely because Private is checked.
- Every derived index record belongs to its source document and revision. The source's access policy covers filenames/titles, snippets, summaries, keywords, composition descriptions, previews, extracted text, native segments, assets, and any future embeddings. Do not expose private-document existence through result counts or suggestions either.
- Indexing remains document-local. Do not use private source material to enrich another document's index or an unrestricted workspace summary. Derived metadata must not bypass the source's access policy.
- Enforce authorization on the server before returning search results and again on every direct read, preview, or asset fetch. An agent instruction, hidden UI control, omitted URL, known document ID, or old search result is not an authorization boundary. Workers still use scoped service access, not direct database access.
- Check the source document's **current** privacy policy, including when reading historical revisions. Index freshness, pinned snapshots, and previously issued capabilities do not preserve permission after it is withdrawn. Index cleanup/rebuilding must never delay access restrictions.

### Changing Private

Private is server-owned document metadata, separate from editable content and content undo/redo. A stale tab's content save must not reset it. Only a confirmed server update may be presented as an applied privacy change.

New documents default to non-private; the creation form can select Private for atomic first creation. Save as copy preserves Private; native exports contain document content, not cloud access settings. Privacy has its own monotonically increasing revision and retry-safe update operation, independent of content revisions. Clients refresh it even with unsynced text and never adopt an older privacy revision from a delayed save acknowledgment.

Checking Private must revoke the document's active latest-only public link and its external-agent grants, reject new shares/external handoffs, and immediately prevent other-document discovery and reads. Its own built-in agent and indexing remain available. Revocation must not depend on index updates or delayed worker cleanup; revoked external grants also cannot submit late candidates.

When enabling Private, the editor checks whether the one active public link exists. If it does, one confirmation warns that the link will be permanently revoked and turning Private off will not restore it. The privacy request carries the observed sharing revision; a concurrent sharing change rejects the update and requires reviewing Private again rather than revoking a newly issued link. Cancel leaves privacy and the link unchanged; a failed share-state check does not proceed with the change. No confirmation is shown when there is no active link or when disabling Private. The existing external-agent revocation policy is unchanged.

Revoked external tasks return to Built-in without starting generation, retaining their reservation and any completed candidate. External capabilities are bound to the privacy revision at grant creation, so they remain invalid after an on/off cycle even if task-file cleanup failed. Privacy mutations serialize with task commits; the server acknowledges the policy only after preceding commits finish. Every external read and delivery also checks the current policy.

Unchecking Private makes the existing index eligible for cross-document retrieval again, subject to ordinary freshness and grant checks. It does not require reindexing solely for the policy change, and it must not resurrect old share links or external grants. New access requires fresh authorization.

Revocation governs future access. It cannot recall already fetched content, erase an agent's existing context, terminate an external process, or retroactively remove material copied into another document. Private is not a content-tracking or remote-erasure mechanism.

### Essential implementation checks

- A private document is indexed and usable by its own built-in agent while absent from another document's agent search, including metadata-only results.
- Other-document agents cannot bypass Private with a known ID, old result reference, historical revision, preview/asset URL, or broad workspace-read grant.
- Marking a document private takes effect despite a stale index or in-flight indexing job; indexing may finish without making its results accessible elsewhere.
- The active latest-only link and external-agent capabilities stop working when Private is enabled and stay revoked after it is disabled. Its own built-in access remains available.
- Private A can retrieve non-private B, not private C; owner access through Files remains unchanged, and stale content saves cannot clear Private.

## Format versioning and unsupported records

V1 is the only recognized native format. Unknown versions and schema changes are rejected with an actionable error; they are not reset to an example or converted. The single `loadDocument` boundary validates V1 now, without mutating saved input; any future explicit conversion belongs there. No migration registry, compatibility adapter, extension bag, or V0 conversion exists. **From example** is an explicit New File choice, not a recovery action.

Cloud document records and unresolved AI state remain preserved. Unsupported imported data leaves the open document untouched and remains recoverable. Existing task inputs and snapshots are not converted or deleted; operations that would interpret or mutate unsupported task data fail explicitly, without automatically retrying generation. Public publication rejects unsupported documents rather than resetting or rewriting them. See [FORMAT.md](FORMAT.md) for the normative schema.

## Storage and service

- Node.js 22.12+; use `--experimental-sqlite` on the service command (needed on early Node 22, accepted on newer releases). No database package is installed.
- `/var/lib/mote/documents.sqlite`: SQLite WAL, full synchronous commits, document metadata, immutable revisions, deduplicated embedded-image assets, operation acknowledgments, shares, inert assistant state, workspace settings, and revision-bound indexing state/descriptions. Request documents use the same self-contained V1 JSON representation as native documents over the network; image upload delta optimization is not implemented.
- `/var/lib/mote-ai/tasks`: durable task-local execution inputs, outputs, Mu sessions, and bounded logs. Accepted/discarded task cleanup is explicit. Unresolved artifacts are not automatically expired.
- `/var/lib/mote-ai/tasks/indexer`: isolated per-run indexing inputs/output and Mu scope. Finished index runs are removed after worker cleanup is confirmed; the description stays in SQLite. Unconfirmed cleanup retains run identity/artifacts and fences further indexing. Failed/restart-interrupted work requires explicit retry; no automatic backup or artifact-expiry schedule is added.
- `/var/backups/mote`: private manually requested SQLite backups. No backup runs automatically. Never copy only the live main database file while WAL is active. `server/backup.mjs` uses the SQLite backup API, or `VACUUM INTO` on early Node 22, then checks the result before publishing it.
- `moted.service` listens on `/run/moted/moted.sock`; Nginx is the production authentication boundary. Never expose the service TCP listener or an unguarded private API publicly. Fake development mode is loopback only.
- Workers use their own bind-mounted task directory under a masked task parent. Cloud data, backups, Nginx credentials, and sibling task directories are inaccessible. Worker provider credentials/source/config reads and outbound networking remain intentional trusted-deployment capabilities—not hostile-user isolation.
- All responses retain `Cache-Control: no-store`. Browser recovery is intentional local persistence, not HTTP caching. No service worker.

See `deploy/mote.nginx.conf` and `server/moted.service.example`. Backups are manual only; no backup timer or service is installed. Existing backup files are retained until explicitly removed. Backups are on the same host: they do not protect against loss of that host; copy them elsewhere if that guarantee is needed. AI execution directories are separate from SQLite backups, so backing up only the database does not back up complete Mu continuation sessions.

### Manual backup

Run on the server when desired:

```sh
node --experimental-sqlite /root/mote/server/backup.mjs
```

The command creates a consistent, verified database snapshot in `/var/backups/mote` and prints its path. It can run while Mote is online. It does not overwrite existing backups or start any schedule. Native `.mote` exports remain available for individual documents.

### Restore

1. Stop `moted.service` and ensure no manual backup is running; preserve the current database and any WAL/SHM files until recovery is verified.
2. Check the chosen backup with SQLite `PRAGMA integrity_check` and inspect its document list.
3. Restore the backup as `/var/lib/mote/documents.sqlite` with directory mode 0700 and file mode 0600. Do not combine it with WAL/SHM files from the replaced database.
4. Start `moted`, open a document, and verify a new save and backup. Old browser working copies may conflict; resolve them explicitly, never reset the database to make clients match.

### Development and checks

```sh
mote_dev_dir=$(mktemp -d /tmp/mote-dev.XXXXXX)
MOTED_FAKE_RUNNER=1 MOTED_USE_SYSTEMD=0 MOTED_PORT=5174 \
  MOTED_DEV_ORIGIN=http://127.0.0.1:5173 \
  MOTED_STATE_DIR="$mote_dev_dir/ai" MOTED_DATA_DIR="$mote_dev_dir/data" \
  node --experimental-sqlite server/moted.mjs
```

In another terminal, run `npm run dev -- --host 127.0.0.1` and open exactly `http://127.0.0.1:5173`. Vite dev and preview proxy `/api` to port 5174. For preview, use `npm run preview -- --host 127.0.0.1` and set the backend’s `MOTED_DEV_ORIGIN` to that exact origin, including its port. Use isolated state directories, not production data. Tests never need the workspace cookie or real model calls.

`npm run check`, `npm run build`, and `npm run test:ai` include the essential cloud CAS, retry, recovery, sharing/revocation, assistant-state, backup, and fake AI lifecycle invariants. Scoped Chromium checks exercise the local working-copy controller, UI conflicts, sharing, imports/recovery, mobile reading, and AI acceptance. There is no general regression framework.

Initial provisioning uses `deploy/mote.nginx.conf` and `server/moted.service.example`; routine deployment follows [README → Deployment](README.md#deployment). Publish static assets before HTML, validate/reload Nginx, and verify live assets and no-store headers. Restart moted only when backend changes require it, after checking active tasks/workers. Task creation reads the current guide/helpers from disk and pins them immutably; a guide-only update needs no backend restart and does not alter existing task inputs. Deployment must never replace or delete `/var/lib/mote`, `/var/lib/mote-ai`, or `/var/backups/mote`.
