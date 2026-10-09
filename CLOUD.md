# Cloud workspace

Mote is one private workspace protected by the existing `nginx_auth` cookie key. Everyone with the key has the same access. There are no user accounts, roles, editable share links, or collaborative merging yet.

## Documents and local work

- `/` opens **Files**; `/d/:id` opens a stable document URL. Nginx serves the existing server-wide `/var/www/login.html` at the requested URL when the cookie is missing or invalid, matching the other protected apps. The shared login sets the cookie and reloads that same URL; Mote does not bundle its own login page. APIs return JSON `401`, not login HTML. Expired authentication never intentionally discards local edits.
- **Files** opens, creates, imports, renames, and deletes documents. Names need not be unique and are separate from authored Title paragraphs. Renaming preserves URLs. Importing `.mote` or Mote-exported HTML always creates a new document with a fresh ID. The filename, without its extension, supplies the new cloud name; invalid files leave the workspace unchanged. The former browser draft is offered for explicit import, never automatically uploaded.
- Every tab has a separate IndexedDB working copy. A session-identity Web Lock prevents duplicated tabs from writing the same record. The lock does not grant exclusive document editing. Without Web Locks, sessions always fork and previous dirty copies remain in **Local recovery**.
- Changes save locally promptly. The active document syncs every 10 seconds while dirty, on **Sync**, and on Ctrl/⌘S. Switching documents attempts a sync and requires successful local preservation before leaving. Inactive documents do not continuously sync.
- A cloud save compares its base revision atomically with the current revision. An operation ID is persisted before sending, so a retry after a lost response can recover its original acknowledgment. Edits made during a request remain pending and are drained by the next save.
- **Synced** means an acknowledged cloud save; **Saved locally · changes pending** is not a backup. Local saving, cloud failure, sign-in, conflicts, and deletion have distinct feedback. Local-save failure warns before leaving.
- A conflict pauses automatic sync. **Save as copy** creates another file; **Discard local changes** fetches the latest cloud content; **Overwrite cloud version** still checks the exact version shown to the user. If that version changed again, it conflicts again. Overwrite directly replaces the current cloud version; it creates no extra recovery copy.
- **Local recovery** lists pending working copies, including those from closed tabs. There is no server recovery-copy browser, merging, or conflict-comparison renderer. Immutable revisions used by snapshot sharing, AI inputs, and request acknowledgments are separate from overwrite recovery.
- A deleted document is tombstoned, all its links are revoked, and stale tabs cannot resurrect it through autosave. Their local work can be saved as another file or explicitly discarded.
- Undo/redo remains an editing-session history in memory, not a cloud-wide stack. Sync does not clear it; undo after sync makes a new local change. Reload, adoption of remote content, and reset clear history. Undo history is never exported in `.mote`.
- Clean private editors can adopt newer server revisions; dirty copies are never silently replaced. Browser recovery can be evicted or cleared, so unsynced work is not durable cloud storage.

## Sharing

The Share dialog creates and manages two link types:

- **Current snapshot** waits for successful synchronization and pins exactly that acknowledged revision. Later edits do not change it.
- **Latest version** resolves the current cloud revision once when the link is opened. Unsynced local changes are not included. Reuse the active link for that document rather than creating duplicates.

Both use `/s/:token`, work without login, and mount the read-only canvas. The reader makes one scoped document request: no polling, SSE, update notification, or automatic refresh. Reloading a Latest version link fetches the then-current cloud document. Interactive widget code may independently load network resources; a content snapshot does not archive external dependencies or runtime state.

Links have 256-bit random tokens. The UI lists their type, creation time, URL, and Copy/Revoke actions. Revocation and file deletion stop future access, not copies already opened or downloaded. Shared APIs expose only the selected document, filename, and revision, never AI state or other files. Public navigation uses no-referrer/noindex/no-store headers. Sharing is read-only even when the visitor holds the workspace cookie.

## AI is document-associated

The assistant is part of the workspace and uses same-origin authenticated APIs. Model outages do not prevent manual editing.

Before a first built-in request or external handoff, the editor syncs its document, records the acknowledged revision and target, and captures matching rendered context. The backend resolves that immutable revision and rejects a different supplied snapshot. Both executors receive a full document snapshot plus the guide/target/output contract; they never mutate the cloud database. Executor switches retain the original input.

The reservation's **Built-in / External** choice is server-owned. External grants a random 256-bit bearer capability at `/api/agent/:token`, providing scoped immutable reads and candidate submission without workspace login. Built-in creates no public grant and uses a task-local Unix socket exposing only the same scoped agent protocol, not the private Mote API. Each switch advances an executor revision and revokes the previous credentials; old links/runs cannot become valid after a round trip. Switches use revision checks and retry-safe operation IDs. The client disables chat/submission and copy controls until confirmation, including after an uncertain response or reload.

The handoff is readable Markdown with a JSON manifest, pinned guide digest, native document, target, PNG, and portable helpers. Candidates upload actual image bytes rather than server filesystem paths. Submission is candidate-revision checked and retry-safe; authorization is checked again when committing under the task mutation lock. External agents can submit successive candidates but cannot accept their own work, change unrelated content, or access other files. Completed candidates survive executor changes. Mote cancels old built-in workers when switching, but cannot terminate external processes.

Acceptance, assistant-state removal, and document deletion durably revoke agent access independently of artifact cleanup. An explicit release can also retain recovery artifacts while withdrawing all grants. Revocation cannot retract downloaded content. Capability routes are no-store/no-referrer/noindex and omitted from Nginx access logs; tokens are not stored in exported documents or client task recovery JSON. The normal Share dialog remains separate and read-only.

Task recovery uses a separate cloud revision and per-working-copy local checkpoint. Conflicting task state is preserved for explicit resolution, and stale target candidates remain inspectable without locking incompatible content. Original input snapshots and result candidates survive closing a tab or switching documents. Temporary execution state has no 24-hour automatic expiry.

Acceptance is one ordinary local history action. An acceptance receipt retains the original/candidate until the exact accepted document and task-state removal are acknowledged. An uncertain save or cleanup retains artifacts rather than losing a result. Bounded execution transcripts remain outside document content and exports.

Cloud saving sends documents to Mote. Explicit AI generation additionally shares the whole input document with the configured model/provider. Generated HTML stays in sandboxed opaque-origin iframes.

## Document Private policy

**Status: Private is implemented; workspace indexing and cross-document agent retrieval remain planned.** Document settings exposes the checkbox, Files identifies private documents, and the server enforces public-sharing and external-agent restrictions. The indexing and cross-document rows below define the required policy for those future features; no workspace retrieval is currently available to either executor.

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
| Public Current snapshot or Latest version sharing | Requires an explicit share link | Denied |

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

New documents default to non-private. Save as copy preserves Private; native exports contain document content, not cloud access settings. Privacy has its own monotonically increasing revision and retry-safe update operation, independent of content revisions. Clients refresh it even with unsynced text and never adopt an older privacy revision from a delayed save acknowledgment.

Checking Private must revoke existing public share links (both snapshot and latest) and the document's external-agent grants, reject new shares/external handoffs, and immediately prevent other-document discovery and reads. Its own built-in agent and indexing remain available. Revocation must not depend on index updates or delayed worker cleanup; revoked external grants also cannot submit late candidates.

Revoked external tasks return to Built-in without starting generation, retaining their reservation and any completed candidate. External capabilities are bound to the privacy revision at grant creation, so they remain invalid after an on/off cycle even if task-file cleanup failed. Privacy mutations serialize with task commits; the server acknowledges the policy only after preceding commits finish. Every external read and delivery also checks the current policy.

Unchecking Private makes the existing index eligible for cross-document retrieval again, subject to ordinary freshness and grant checks. It does not require reindexing solely for the policy change, and it must not resurrect old share links or external grants. New access requires fresh authorization.

Revocation governs future access. It cannot recall already fetched content, erase an agent's existing context, terminate an external process, or retroactively remove material copied into another document. Private is not a content-tracking or remote-erasure mechanism.

### Essential implementation checks

- A private document is indexed and usable by its own built-in agent while absent from another document's agent search, including metadata-only results.
- Other-document agents cannot bypass Private with a known ID, old result reference, historical revision, preview/asset URL, or broad workspace-read grant.
- Marking a document private takes effect despite a stale index or in-flight indexing job; indexing may finish without making its results accessible elsewhere.
- Existing snapshot/latest links and external-agent capabilities stop working when Private is enabled and stay revoked after it is disabled. Its own built-in access remains available.
- Private A can retrieve non-private B, not private C; owner access through Files remains unchanged, and stale content saves cannot clear Private.

## V0 remains disposable-format development

There is still no backward compatibility or migration layer for the document format. Authenticated loading of unsupported V0 content offers a confirmed reset to the example, which also replaces the cloud save using a revision-checked write. Declining preserves stored content. Network/storage failures never trigger reset. Public readers cannot reset documents. Revisit this before finalizing V1.

## Storage and service

- Node.js 22.12+; use `--experimental-sqlite` on the service command (needed on early Node 22, accepted on newer releases). No database package is installed.
- `/var/lib/mote/documents.sqlite`: SQLite WAL, full synchronous commits, document metadata, immutable revisions, deduplicated embedded-image assets, operation acknowledgments, shares, and inert assistant state. Request documents still use the self-contained V0 JSON representation over the network; image upload delta optimization is not implemented.
- `/var/lib/mote-ai/tasks`: durable task-local execution inputs, outputs, Mu sessions, and bounded logs. Accepted/discarded task cleanup is explicit. Unresolved artifacts are not automatically expired.
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
MOTED_FAKE_RUNNER=1 MOTED_USE_SYSTEMD=0 MOTED_PORT=5174 \
  MOTED_DEV_ORIGIN=http://127.0.0.1:5173 \
  MOTED_STATE_DIR=/tmp/mote-dev/ai MOTED_DATA_DIR=/tmp/mote-dev/data \
  node --experimental-sqlite server/moted.mjs
npm run dev -- --host 127.0.0.1
```

Open exactly `http://127.0.0.1:5173`. Vite dev and preview proxy `/api` to port 5174. Use isolated state directories, not production data. Tests never need the workspace cookie or real model calls.

`npm run check`, `npm run build`, and `npm run test:ai` include the essential cloud CAS, retry, recovery, sharing/revocation, assistant-state, backup, and fake AI lifecycle invariants. Scoped Chromium checks exercise the local working-copy controller, UI conflicts, sharing, imports/recovery, mobile reading, and AI acceptance. There is no general regression framework.

Production deployment builds/copies static files, installs the Nginx configuration and service units, validates Nginx, then restarts/reloads services. Check active workers first. Build deployment must never replace or delete `/var/lib/mote`, `/var/lib/mote-ai`, or `/var/backups/mote`.
