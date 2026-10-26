# Mote

## Working agreement

Mote is an early-development private, AI-native cloud document workspace: semantic rich text, explicit vertical space, and Flow/Float objects share one continuous page.

- Change the current **V0** format directly; no compatibility or migration layer is promised. Unsupported saved content offers a **confirmed, revision-checked reset to example**, including replacement of the cloud save. Declining preserves data. Network/storage failures never trigger reset; public readers cannot reset.
- Preserve cloud documents and unresolved AI state. Never rewrite production documents to accommodate a schema change. Backups are manual, only at the user's discretion; do not run or schedule deployment backups.
- Keep HTTP caching disabled everywhere: `Cache-Control: no-store`, no service worker. IndexedDB working copies are intentional persistence, separate from HTTP caching.
- Redeploy the demo after each task. Follow the deployment steps below. Revisit these early-development policies before a release.

## Read the relevant source of truth

| Topic | Start here |
| --- | --- |
| Product behavior, local setup, checks, exports, deployment | [README.md](../README.md) |
| UI design principles, visual patterns, and interaction review | [mote-ui skill](mote-ui.md) |
| Sync/recovery, privacy, sharing, indexing/retrieval, storage | [CLOUD.md](../CLOUD.md) |
| Agent input/output, supported native content, preview/delivery | [server/guide.md](../server/guide.md) |
| Task/capability API, executor grants, concurrency | [server/agent-api.md](../server/agent-api.md) |
| Prior decisions and their rationale | [MEMORY.md](MEMORY.md) (search the topic; later decisions supersede earlier ones) |

These instructions hold durable invariants; detailed user interactions and operational procedures belong in the linked docs. Verify current behavior against code when a historical note conflicts. Update the affected guide with a design change and append its rationale to memory. Keep memory chronological; do not treat past test counts, deployment logs, or temporary artifact paths as current requirements. Avoid copying routine check logs or trivial file edits into memory.

## Document and rendering invariants

- Desktop supports editing and reading; viewports **under 768px are reading-only**. Default width is **960px**, with **32px left/right** and **48px top/bottom** margins. Zoom and editing scroll-past-bottom are view state, not saved geometry.
- Paragraph typography comes from semantic classes and the document theme. Inline formatting composes Bold, fixed palette colors, None/Box decoration, and a native Link mark with a safe, credential-free absolute HTTP(S) href; no relative paths, controls, `mailto:`, or `tel:`. No arbitrary inline fonts/sizes. Underline-decoration marks are unsupported in V0, without migration. Links apply to main text, text boxes, table cells, and captions, never Code or Drawing. Table cells and captions have fixed semantic styling. Code is a plain-source object with its own syntax scheme, never a paragraph class.
- Supported object kinds are text, table, image, drawing, Code, formula (`katex`), and HTML widget (`html`). Every kind supports **Flow / Float**. Line, rectangle, ellipse, and standalone Label kinds are removed.
- Objects stay in `floating`. Every Flow has exactly one top-level `flow` atom with distinct block ID and `objectId`; its `anchorId` is the atom ID and `y = 0`. Flow uses a real normal-flow mount, column-relative horizontal placement, and optional persistent centering. Never emulate it with spacers or absolute overlays.
- Floats use page-space x and nonnegative anchor-relative y, except Flow-anchored Floats use signed offsets from the owner's measured top-left on both axes. Main text uses only the interval to a Float's left. Floats may overlap other Floats and Flow objects; there is no Overlap/Repel mode.
- Document `theme.flow` supplies paragraph-like Before/After spacing. Signed per-object `margins` adjust the body-and-caption layout footprint for both Flow and Float, independently of content size. Layout uses that footprint; hit testing, resizing, and annotation anchors use actual content/body bounds. Visible extents must survive negative margins. Individual AI tasks preserve user-owned margins; section reservations lock them.
- **Captions belong only to images, HTML widgets, and tables.** The shape is `caption: { content, width? }`, with a doc containing one rich paragraph whose attrs contain only its ID. They always sit below, centered on the owner. Omitted width follows the owner; explicit width may overhang within the page. Captions have separate selection/editing/width controls but no floating ID, placement, free position, or detach operation. Caption-only deletion/cut preserves the owner. Composition bounds and Flow height include captions.
- Flow blocks, owned captions, and anchored Floats must remain coherent across selection, movement, deletion, clipboard, history, validation, AI reservations, and exports. Copy/paste refreshes block/object/rich-text IDs and remaps anchors while retaining fixed palette references.
- Native text and objects share 22 fixed palette slots: eight Strong/Soft pairs (Primary, Secondary, Red, Amber, Green, Cyan, Blue, Violet) and six adaptive grays. Each document saves Light/Dark mode and two hues; mode controls the page and UI, Primary controls UI accents, and Secondary is for content. There are no custom palettes or page backgrounds. Text boxes are borderless by default or decorated with a Left or All-sides border that picks one color pair (eight families or the single Gray 4/5 pair): Strong border, Soft background, no generated headings/icons or text-color overrides; omitted padding is 0.75em when decorated. Code syntax colors follow the saved mode but not the hues; embedded images and widget source remain independent.
- Drawings store editable strokes and typed labels. Resizing scales positions but preserves document-pixel stroke widths and label font sizes. A requested AI drawing revision may convert to another supported object kind.
- Editing, public reading, minimap, PNG, and standalone HTML share rendering concepts. Widget execution is sandboxed; PNG/minimap use saved screenshots. Do not introduce a separate approximate export renderer.
- Internal **Notes** are user-owned plain-text scratchpads, saved in native documents/recovery but excluded from public shares, PNG, and HTML (including its reimport payload). Authorized agents may read them as tentative context, never edit them or treat plans as published content.

## Interaction design

For UI design, implementation, or review, load the **mote-ui** skill. It explains the principles and reusable patterns behind these current decisions; stylistic guidance leaves room for deliberate design improvements.

- Keep the stable right **Context / Assistant** lane (288px desktop, 268px compact), a fixed Text strip only for eligible native rich text, and the minimap on the left with bookmarks expanding toward the page. Settings opens Document/Workspace/Browser in one dialog without resizing the canvas.
- The 50px title bar has no logo. The title opens the search-first Files switcher in editing and reading. The plain sync indicator is clickable with a pointer cursor and “Click to sync” tooltip. Editing always exposes flat Share, Settings, and confirmed Reset icons; no collapsing header menu. Share has Link/Export tabs; Link controls at most one latest-version URL per document, initially disabled. Opening never creates a link; enabling syncs first. Confirmed Disable permanently revokes; re-enabling and confirmed Replace create fresh URLs. Private disables Link, not local export. Read/Edit share one fixed position. Assistant access stays in its panel tab.
- Creation uses header **Add** or a single-right-click launchpad. Paragraph is first; all tools, including Code/Formula/HTML widget, appear directly in the same grid. Right-click on canvas/objects opens creation only; object actions stay in Context. Selected text, links, inputs, source editors, widgets, and reading retain native/editor-specific menus. Alt is for space/object manipulation.
- The Text strip has Bold, color, Box, and Link; no Underline or Clear formatting action. Link replaces Underline, toggles existing links off, and edits the absolute HTTP(S) URL in a row below the strip. Choosing Link for unlinked text focuses the row; a caret inside a link reveals it without stealing focus; Ctrl/⌘K focuses it. Enter/blur commits, Escape cancels, and an empty value removes the mark. A link inserted at an empty caret labels itself with its URL. Link color is inherited and it is always underlined; Bold, Box, and color compose with it. Typing URLs does not auto-link. Ordinary paste may detect explicit HTTP(S) URLs and preserves safe rich links; Ctrl/⌘Shift+V strips incoming links and skips detection, except paste inside an existing link inherits its destination. Ctrl/⌘-click opens in a new tab while editing; ordinary reading clicks open in a new tab. No link popovers.
- Context places a shared **Flow / Float** segmented control before type-specific object properties. Captions have their own inspector. Selecting once enables subsequent content editing; object/section actions remain undoable without routine confirmation.
- Files is a search-first switcher with keyboard row navigation, New/From example, Import, per-row Share/Rename/Delete, and footer Local recovery. Share reuses the Link/Export dialog without opening the target document, including in reading/mobile. Exports use the active document’s working copy or an unopened document’s freshly fetched cloud snapshot; enabling a link syncs only the target’s active working copy, if present. Delete is explicitly confirmed and revision-checked. Workspace model/index settings belong in Settings, not Files.
- Context/Assistant is a persistent session-local tab choice. Canvas selection updates the chosen panel, never switches it; Assistant follows reserved content to its task and offers **Reserve for Assistant** for unreserved content. Reservation creation lives only in Assistant, not Context. Opening Assistant preserves canvas selection, including gutter sections. Settings clears selection but preserves the chosen tab; Read/Edit and releasing the last task preserve it too. Explicit task-opening and AI-creation actions may open Assistant. Keep one task heading with locate, visible executor/read-permission controls, and full task JSON download for recovery.

## Cloud and agent boundaries

Read **`CLOUD.md` → Document Private policy** before changing privacy, sharing, indexing, or retrieval.

- Tabs own independent local working copies, not exclusive document locks. Cloud sync uses revision compare-and-swap every 10 seconds and on Ctrl/⌘S; preserve operation IDs across uncertain replies. No merging or silent overwrite. Explicit overwrite is a normal revision-checked save, without an extra recovery copy.
- Public-share state has a separate server-owned revision and atomic CAS/retry-safe mutations, outside document undo and export settings. AI capabilities and immutable task-input revisions are unchanged by public-link management.
- Network failures preserve local edits and pending AI work. Validated reconnection resumes sync/status/transcripts; it must never automatically resubmit generation. Model failure must not block manual document work.
- Private blocks public sharing, external handoff, and all other-document agent access to content **and derived indexes**. Its own built-in agent and trusted indexer remain allowed. Current source privacy governs historical reads too. Disabling Private never revives revoked links.
- Auto-indexing is opt-in; workspace retrieval is a separate, server-confirmed per-session permission, reset on executor changes. Agents search the permission-filtered index, then read relevant native sources before reference/reuse. Retrieval never expands the reserved write target.
- Built-in and external agents use the same validated candidate protocol and immutable full-document input. Executor switches revoke prior-generation credentials before acknowledgment. Acceptance is local and undoable; retain the candidate until the exact accepted document is cloud-acknowledged.
- Individual reserved objects may move; body dimensions lock at preparation/submission. Caption width remains user-owned for individual tasks; caption content/removal stays reserved. Section reservations lock the whole composition. Candidate omission preserves an owned caption; explicit empty content clears it.

## Development and verification

Use Node.js 22.12+ and npm. Follow **README → Run / Fake-first development**. Bind dev and preview explicitly to `127.0.0.1`; npm script defaults alone are not loopback-only. The isolated fake backend runs on port 5174; its `MOTED_DEV_ORIGIN` must match the browser's exact hostname and port, including preview. Use fresh temporary state/data directories, never production storage, and never expose fake services publicly.

- `npm run check`: TypeScript.
- `npm run build`: TypeScript plus app and standalone reader production bundles.
- `npm run test:ai`: essential model/clipboard, reservations, network recovery, fake backend, cloud CAS/privacy, indexing, and retrieval invariants without model calls.
- Use scoped Chromium checks for changed UI and affected reader/export paths; cover compact editing and fresh mobile reading. Test essential invariants, not implementation details; do not add a general regression suite by default. CI builds/tests on Node 22 and 24; it does not deploy or run browsers.

## Deployment

Demo: `https://mote.ylxdzsw.com`. Static root: `/var/www/mote`. Nginx config: `/etc/nginx/conf.d/mote.conf`; repository example: `deploy/mote.nginx.conf`.

1. Build and complete checks appropriate to the change. Publish assets from `dist/` before `index.html`, with Nginx-readable file permissions (normally 0644, e.g. `install -m 644`). Do not preserve restrictive source permissions. Server code stays in `/root/mote/server`, outside the public root.
2. Validate/reload Nginx (`nginx -t && systemctl reload nginx`). For backend changes, check active tasks/workers before restarting `moted.service`; static-only changes do not require a backend restart.
3. Verify live HTML and referenced assets match the build and retain `Cache-Control: no-store`; private APIs must remain login-gated. Preserve `/var/lib/mote`, `/var/lib/mote-ai`, and `/var/backups/mote`. Do not reset/import/edit production documents as a deployment check.

The existing server-wide `/var/www/login.html` cookie gate protects private routes. Public routes are `/s/:token`, scoped `GET /api/shared/:token`, reservation capabilities `/api/agent/:token`, and static assets/favicons. Public code contains no document data. `moted.service` owns SQLite, sharing, tasks, and indexing. Workers cannot read cloud data, backups, Nginx secrets, or sibling task directories. See `CLOUD.md` for the operational boundary and manual backup/restore procedures.

## Code map

- `src/cloud/`: working-copy sync, transport recovery, workspace routing, Files/Share/Settings/recovery dialogs.
- `src/app/`: shell, inspectors, settings, Notes/drawing/widget editors, CSS.
- `src/document/`: V0 model/validation, Flow/caption/clipboard transformations, examples, history, local storage, file codecs/PNG export.
- `src/editor/`: constrained Tiptap schemas, inline formatting, editor interactions.
- `src/canvas/`: measured anchors, Flow mounts, Float layer, captions, spatial interactions, shared reader, zoom/minimap.
- `src/theme/`, `src/reader/`: semantic palette/theme styling; standalone reader/export entry.
- `src/ai/`: reservations, task state, protocol client, review UI.
- `server/`: moted, cloud store, isolation, indexing/retrieval, guide/protocol, preview/delivery helpers, fake runner.

## Deferred, not current scope

Rediscuss before implementing: Markdown/additional interchange formats and PDF export; editable sharing, individual accounts, collaborative merging, and broader offline synchronization; native bundled binary; direct user queries over the workspace index. Current interchange is native `.mote`, PNG export, and standalone HTML export/reimport. HTML import accepts current-V0 Mote exports only, not arbitrary HTML conversion.
