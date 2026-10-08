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

Before a first request, the editor syncs its document, records the acknowledged revision and target, and captures matching rendered context. The backend resolves that immutable revision and rejects a different supplied snapshot. Workers receive a full document snapshot plus the existing guide/target/output contract; they never mutate the cloud database.

Task recovery uses a separate cloud revision and per-working-copy local checkpoint. Conflicting task state is preserved for explicit resolution, and stale target candidates remain inspectable without locking incompatible content. Original input snapshots and result candidates survive closing a tab or switching documents. Temporary execution state has no 24-hour automatic expiry.

Acceptance is one ordinary local history action. An acceptance receipt retains the original/candidate until the exact accepted document and task-state removal are acknowledged. An uncertain save or cleanup retains artifacts rather than losing a result. Bounded execution transcripts remain outside document content and exports.

Cloud saving sends documents to Mote. Explicit AI generation additionally shares the whole input document with the configured model/provider. Generated HTML stays in sandboxed opaque-origin iframes.

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
