Mote
====

## Status

The project is in early development.

1. Editing can be made directly without any backward compatibility;
2. Use V0 as document format version, which also does not maintain any compatibility; If saved document failed to parse, offer a confirmed reset to example that also replaces the cloud save using revision checks
3. Disable caching on the deployment;
4. Redeploy the demo after each task; no deployment backup required. Preserve cloud document data. Backups are manual, at the user's discretion; do not schedule or automatically run them.

Review these before making actual release.

## Final Goal

A private, AI-native cloud document workspace emphasizing simplicity, unification, and coherence. Naturally flowing rich text, explicit vertical spaces, and anchor-relative, PPT-like spatial placement share one continuous page. Paragraph typography is controlled by semantic classes and a document-wide theme. Inline formatting composes Bold, named palette colors, and None/Box/Underline decoration; arbitrary inline fonts and sizes are not supported. Native text and floating objects share one document palette.

## Guiding Rules and Key Decisions

- Desktop supports editing and reading; viewports under 768px are reading-only.
- Document width can be set in Document settings and defaults to 960px.
- Editing uses a seamless document surface with a stable right-hand Context/Assistant lane (288px desktop, 268px compact) and a separate fixed Text strip only for eligible native rich text. Document settings and browser preferences open in dialogs without changing canvas width. The minimap sits on the left, with bookmarks expanding toward the document.
- Creation uses a single-right-click launchpad or header Add, separate from formatting. Existing objects receive object actions; highlighted text, links, inputs, Code/source, widgets, and reading mode retain native/editor-specific context menus. Alt is for space and object manipulation, not opening menus.
- The title bar is 50px high. The Mote mark and document name open Files; More contains Export, Browser preferences, and confirmed Reset to example. Read/Edit share one fixed position, and Assistant access stays in the side-panel tab rather than a duplicate header button.
- Per-document **Private** blocks public sharing and external-agent handoff, but not the document's own built-in agent. Trusted indexing of Private is allowed, but other-document agents must never receive its content or derived indexes. Auto-indexing is opt-in; retrieval is a separate per-agent-session permission. Agents search the index file rather than reading it whole, then read relevant source documents before reference/reuse. Read `CLOUD.md` → **Document Private policy** before changing privacy, sharing, indexing, or agent retrieval; current source privacy governs historical reads too.

## Planned Features

These features are planned but explicit not V1. They need rediscussion and design before implementation.

- Markdown import/export and additional interchange formats; PDF export is deferred. Native `.mote` import/export, PNG export, and standalone HTML export/reimport are already implemented. HTML import accepts Mote-exported `.html`/`.htm` with a valid current V0 payload, not arbitrary HTML conversion.
- Editable sharing, individual accounts, collaborative merging, and offline synchronization beyond recoverable local working copies.
- Native bundled binary version.
- Direct user queries over the workspace index; agents can already discover and read documents when enabled for their session.

## Development and Deployment

Node.js 22.12+ and npm. `npm install`, `npm run dev -- --host 127.0.0.1` (port 5173 or next available), `npm run check`, `npm run build`, `npm run preview -- --host 127.0.0.1`.

Local app development also requires the isolated fake moted backend on port 5174; follow `README.md` → **Fake-first development** or `CLOUD.md` → **Development and checks**. Dev/preview proxy `/api` to that backend. The browser's exact origin must match `MOTED_DEV_ORIGIN`; update it if the hostname or frontend port changes. Use temporary state/data directories, never production storage, and do not expose development/fake services publicly. IndexedDB working copies are origin-specific.

`npm run test:ai` runs essential reservation, fake-backend, cloud CAS/recovery/privacy, indexing, and retrieval invariants without model calls. Build and scoped Chromium checks are described in README.md; no general regression suite yet.

Deployed at `https://mote.ylxdzsw.com` through `/var/www/mote` and `/etc/nginx/conf.d/mote.conf`; static responses use `Cache-Control: no-store`. Private workspace routes use the existing server-wide `/var/www/login.html` Nginx cookie gate. Public routes are `/s/:token` read-only shares, their scoped `GET /api/shared/:token` API, reservation-scoped `/api/agent/:token` capabilities, and static application assets/favicons; public code contains no document data. Other workspace APIs remain login-gated. Built-in and external agents share the candidate-delivery protocol; executor switches revoke prior-generation access before acknowledgment. `moted.service` owns SQLite documents, revisions, sharing, and durable AI tasks. Clients save independent local copies and sync using revision compare-and-swap (10 seconds/Ctrl+S), without merging or silent overwrites. Explicit overwrite is a normal revision-checked save, with no extra server recovery copy. Workers cannot read cloud data, backups, Nginx secrets, or sibling task directories. Server code stays in `/root/mote/server`, not the public static directory. See CLOUD.md and README for fake-first testing, input/output contracts, model configuration, and operational boundaries. Dev/preview send `Cache-Control: no-store`; `public/_headers` supplies the same policy for supporting static hosts. Other hosts must configure no-store for HTML and assets. No service worker. Browser-local document persistence is intentional, separate from HTTP caching.

## File Structure

`src/cloud/`: working-copy synchronization, workspace routing, Files/Share/recovery dialogs. `src/app/`: shell, controls, CSS. `src/document/`: V0 model, examples, IndexedDB, history, validation, file codecs/PNG export, and clipboard transformations. `src/editor/`: constrained Tiptap schemas, inline formatting, and editor interactions. `src/canvas/`: measured anchors, all floating-object kinds, spatial interactions, shared reader, zoom, and minimap. `src/theme/`: semantic styling, shared palette, and theme-derived UI colors. `src/reader/`: standalone HTML reader entry and export. `src/ai/`: reservations, task state, service client, and review UI. `server/`: moted, worker isolation, guide, preview/delivery helpers, and fake runner. See README.md for demo boundaries.

## Dev Notes

Use `.mu/MEMORY.md` as the development notes. This file is generally append-only, with later notes superseding earlier ones. Update it when key decisions or significant changes are made. Focus on discussions, decisions, and designs; avoid recording trivial file-edit details that duplicate the git log. Search it for previous discussions and decisions before making new changes to avoid accidental regressions.
