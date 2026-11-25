# Mote

Mote is an early-development private, AI-native cloud document workspace: semantic rich text, explicit vertical space, and Flow/Float objects share a continuous page.

This file holds durable invariants and the working agreement. Current behavior and procedures live in the linked guides; design rationale lives in memory.

## Working agreement

- Native formats start at **V1** and support V1–V9; V0 is permanently unsupported ([FORMAT.md](../FORMAT.md)). New documents and current native candidate hints use V9; task transport remains `mote-agent-v7`. Every schema or meaning change gets a new version. Versions are cheap, so never bend a change to avoid one.
- `loadDocument` migrates older versions to the current one in memory. It uses ordered, pure, ID-preserving steps, then the closed validator, and every reader uses it. Each step is labeled breaking or non-breaking. V4→V5 is non-breaking and changes only the version, adding optional permanent image/HTML markup. V5→V6 is non-breaking and changes only the version; V6 adds optional document-level `theme.justifyText`, whose omission means false. V6→V7 is non-breaking and changes only the version; V7 adds optional document-level `theme.firstLineIndent`, whose omission or false value means no indent. V7→V8 is non-breaking and changes only the version; V8 adds Separator paragraphs and optional Separator rule thickness. Loading never saves; the next ordinary save writes the upgrade. V3→V4 is breaking: explicit saved theme weights map below 550 to 400 and at least 550 to 700, preserving sparse inheritance and unrelated data. Breaking steps need owner confirmation only when active reservations exist; Upgrade removes current reservations through an ordinary cloud document save without permanently revoking their stable tokens, while Decline keeps the stored version and reservations untouched and opens a read-only preview. Unknown and newer versions get an actionable error and stay recoverable.
- Preserve cloud documents, retained AI artifacts, and existing backups. Backups are primarily collections of self-contained native `.mote` exports, manual and only at the user's discretion; never run or schedule them. Native document compatibility is the long-term recovery boundary, not SQLite schemas or agent sessions.
- Do not maintain historical database-schema migrations or cross-version database restore compatibility. Schema changes may use an explicit operator export/reimport procedure; never automatically reset, overwrite, or delete production storage. Existing SQLite snapshot tooling is a same-build operational convenience, not the portable backup contract.
- Keep HTTP caching disabled everywhere: `Cache-Control: no-store`, no service worker. IndexedDB working copies are intentional persistence, separate from HTTP caching.
- Redeploy the demo after each task (see Deployment).
- With a design change, update the affected guide and append its rationale to [MEMORY.md](MEMORY.md). Memory is chronological and later entries supersede earlier ones; leave out check logs, deployment logs, test counts, and trivial edits. When a note conflicts with code, verify against the code.
- Revisit these early-development policies before a release.

## Sources of truth

| Topic | Start here |
| --- | --- |
| Product behavior, setup, checks, exports, deployment, code structure | [README.md](../README.md) |
| Native V1–V9 schema and validation | [FORMAT.md](../FORMAT.md) |
| UI principles, patterns, and interaction review | [mote-ui skill](mote-ui.md) |
| Sync/recovery, privacy, sharing, indexing/retrieval, storage, backup/restore | [CLOUD.md](../CLOUD.md) |
| Agent workflow, native authoring, preview, submission | [public skills](../public/skills/external/SKILL.md) and `../public/skills/` |
| Task/capability API, executor grants, concurrency | [server/agent-api.md](../server/agent-api.md) |
| Prior decisions and rationale | [MEMORY.md](MEMORY.md) |

## Core invariants

### Document and rendering

- Desktop supports editing and reading; viewports under 768px are reading-only. Zoom and scroll-past-bottom are view state, never saved geometry.
- V9 is continuous only. Its breaking migration flattens V2–V8 decks with the deterministic, unmeasured Slides-Off conversion. Drop slide markers only; retain authored content and surviving IDs. V9 requires `autospace`, `justifyText`, and `firstLineIndent`, and uses the attribute-free `box` inline mark. Sparse overrides and text-box decoration are unchanged. Format steps independently keep or permanently revoke affected latest share links; V9 revokes links to stored decks, never continuous documents.
- Typography comes from semantic paragraph classes and the document theme. V4+ theme weights are 400 or 700; pinned V1–V3 snapshots retain 1–1000. New Title, Heading, and Subheading presets explicitly use 700. Theme uses a Regular/Bold weight control with inheritance/reset. Inline formatting is limited to Bold, fixed palette colors, None/Box decoration, and Links to safe, credential-free absolute HTTP(S) URLs. Inline Bold is disabled and pressed when every selected paragraph already has a bold effective style, including inherited weights and table headers; Ctrl/⌘B is then a no-op. Inline Bold marks remain toggleable in regular paragraphs. No arbitrary inline fonts or sizes. Code is an object, never a paragraph class. Table header appearance is 600 in V1–V3 and 700 in V4+.
- V8 adds Separator as a semantic paragraph class in main text and Text objects only; it is not valid in tables or owned captions and is not an object/layout choice. Use the ordinary paragraph-class chooser. An empty Separator renders a full-width horizontal rule; rich-text label content centers between equal flank rules, and a wrapped label keeps centered alignment with short flanks. Shift+Enter is an ordinary soft break; Enter starts a Body paragraph. Converting to Body retains text. Rule color comes from the Separator class text color, independently of inline label color. `theme.paragraphs.separator` is a sparse ordinary paragraph style plus optional positive `lineThickness:{value,unit:'px'|'em'}`; omission falls back to 1px. No other paragraph class permits that field. Separator is unaffected by document-wide justification and first-line indent. V1–V7 reject the Separator semantic and `lineThickness`.
- V6 adds optional document-level `theme.justifyText`, off when omitted, with no class, paragraph, or inline overrides. Enabled, browser-native justification applies to native prose paragraphs in main text and Flow/Float text objects, including headings, lists, and captions; Separator is excluded and final lines remain start-aligned. Table column alignment stays unchanged, and Code, formulas, and HTML widgets are unaffected. Keep existing CSS `hyphens:auto`; hyphenation depends on document language and browser dictionaries, with no language detection, soft-hyphen insertion, or stored text rewrite.
- V7 adds optional document-level `theme.firstLineIndent`, off when omitted or false and independent of justification. True uses `text-indent: 2ic` for semantic Body paragraphs in main text and Flow/Float Text objects only: the first formatted line is indented, while wrapped and soft-break lines start normally. Headings, lists, Separator paragraphs, captions, tables, Code, formulas, and HTML widgets are unaffected. It has no per-class, paragraph, or inline override, is language-independent, and never rewrites content whitespace.
- Object kinds are text, table, image, drawing, Code, formula, and HTML widget, and every kind supports Flow and Float. Objects stay in ordered `objects`, with all geometry in `layout`.
- Each Flow object has exactly one top-level `flow` atom and a real normal-flow mount. Never emulate it with spacers or absolute overlays. Floats use page-space x and anchor-relative y, and they may overlap anything.
- Only images, HTML widgets, and tables have captions. A caption is an owned subobject that always sits below its owner, centered on it.
- Flow blocks, owned captions, and anchored Floats stay coherent across selection, movement, deletion, clipboard, history, validation, AI reservations, and exports. Paste refreshes IDs and remaps anchors.
- Colors come only from the 22 fixed palette slots and the saved Light/Dark mode and hues. No custom palettes or page backgrounds.
- Notes (`authoring.notes`) are user-owned. Public shares, PNG, and HTML exclude them. Agents may read them as tentative context but never edit them.
- Editing, reading, minimap, PNG, and standalone HTML share one rendering path; never add a separate approximate export renderer. Widgets run sandboxed, and PNG/minimap use saved screenshots.
- User-facing readers use window scrolling and native browser zoom, with an initial width fit rather than continuous auto-fit. The editor and offscreen capture surfaces retain their controlled viewport. Preview and public Share use the same live reader; Preview receives only a local working-copy snapshot. HTML exports the settled authored-width page without a reader runtime or native payload. Import is `.mote`-only. Native browser printing hides reader navigation and uses browser pagination, not an export-specific layout engine.

### Interaction

Load the mote-ui skill for any UI work. README → Editing and reading / AI assistant describe the exact current behavior. Durable structure:

- A stable combined right Context/Assistant lane, a fixed Text strip only for eligible unreserved rich text, and the minimap on the left. The Bold control reflects effective bold state and is unavailable when all selected paragraphs are already bold.
- Creation happens through Add or the right-click launchpad. Object actions live in Context, and Alt is for space/object manipulation.
- The right lane follows canvas selection, without Context/Assistant tabs. Unreserved content offers Reserve after its properties; reserved content keeps only still-editable properties above Assistant. Selection never reserves or generates implicitly.

### Cloud and agents

Read **CLOUD.md → Document Private policy** before changing privacy, sharing, indexing, or retrieval.

- Each tab owns an independent working copy. Sync is a revision compare-and-swap that keeps operation IDs across uncertain replies. No merging and no silent overwrite.
- Public-share state has its own server-owned revision and atomic CAS, outside document undo. Each document has at most one latest-version link, and opening Share never creates one.
- Network failures preserve local edits and pending AI work. Reconnection never resubmits generation, and model failures never block manual work.
- Private permanently revokes the active public Share link and blocks every public task `/a/` method while enabled, but does not destroy the stable task token; disabling Private reactivates the same token when its reservation remains active. Built-in access to its own Private document remains allowed; cross-document Private access is denied.
- Auto-indexing is opt-in. `workspaceRead` is a task-owned, undoable Reservation property shared by agents on the task; it gates cross-document reads and never expands the reserved write target.
- Current AI editing state is `{document,reservations}` under one document revision CAS; reservations are separate from native JSON/exports. Reserve, properties (`workspaceRead`,`expiresAt`), Accept, Discard, and deleting a reserved target are ordinary local undoable edits. Accept applies cached content; Accept, Discard, and deletion remove the reservation from the current array rather than writing `released:true`. Agent-related reservation edits request an opportunistic 650ms debounce to ordinary sync; autosave/retry/CAS remain authoritative. Undo/redo restores the same reservation/task ID/token and never regenerates. Reservation-only drafts are retained/published. Per working copy, local view/proposal/draft cache is retained while its task ID appears in current, past, or future snapshots (100 undo entries); after local save, dropping a redo branch or evicting history prunes unreferenced cache. Unmount/reload trim to current reservations because history is not persisted, and failed local saves do not prune. This is browser-local only: it does not delete server artifacts or revoke tokens, and another independent/offline tab may still reference the task. There is no retained-task/recovery archive UI; Files Local recovery/download remains. Missing committed reservations return the existing task-capability 404; restoring a reservation and syncing it reuses the same token. No native-format or task-protocol version change.
- Support only `mote-agent-v7`, separate from native V1–V9: flat atomic append-only proposals `{id,label?,candidate}`, no origin/agent field; receipts `{taskId,versionId,status:"ready"}`. New candidate grammar uses native V9. Validation at submission is stateless/current-schema, independent of document/target/session; Preview/Accept checks the live document and scope, and final document save validates/CASes. The task base URL returns one JSON description with request, exact `.target`, permissions, segment measurements, and resource/helper/schema links; manifest/target/instructions endpoints are retired, and copied originals are not agent inputs. Segment `objects` may contain reserved object-ID strings: server delivery preserves them, browser Preview/Accept checks reservation ownership/existence and deep-copies current working objects literally before ordinary full validation/application. No merge, coordinate repair, snapshot fallback, or special ID retention; native documents remain complete objects. The shared extraction helper supports copy-edit-submit, including partial spacers. Optional `document.json` is latest cloud at access; workspace index shows the current stored description, and workspace-document reads latest only. No historical agent reads.
- Built-in/External tabs are local UI only; agents may run concurrently and share the sequence. Stop affects built-in execution only. Task tokens are stable server-owned random credentials, separate from task IDs; no executor revisions, generation auth, permanent current-task revocation tombstones, owner-inactivity pause, or automatic server-side cleanup on Accept/Discard. Optional expiry and Private are checked at request opening; public `/a/` is blocked for all methods while Private, but the same token works again after Private is disabled if the reservation is active. Removing a reservation from committed state gives the capability's existing 404 path; restoring it and syncing restores access with the same token. The trusted built-in socket may read its own Private document; cross-document Private access remains denied. Public Share revocation remains separate and permanent. Obsolete `/executor`, `/workspace-read`, and `/release` mutations return 404. Old `/assistant` records remain untouched and read-only, are not imported into current task state, and have no Assistant archive UI; general Files local recovery downloads remain.
- The submission helper owns durable retry IDs keyed by base URL/output/payload/optional label and uses `BASE OUTPUT [LABEL]`; no executor/source metadata. Retired protocols/artifacts remain stored without adapters, conversion, or automatic continuation, and are not imported into current task state. This is separate from native V1–V9 compatibility.
- Reservation geometry: individual tasks lock body dimensions and leave caption width user-owned, while section reservations lock the whole composition. New reservations have only Object and Segment kinds; caret/main-text selections create segments and multi-object selections cannot reserve. Existing prose-only tasks retain their scope. Segment target `version:2` owns exact intervals, allowing independent slices of one spacer and insertion at either outer boundary. Explicit structural mappings rebase surviving reservation targets atomically with history; omitted target version retains legacy whole-spacer locks. Reserved segments are indivisible selection units with full-width exact bands; gutter-interior clicks select the task and outside endpoints expand to whole units.
- Spatial instructions are optional reservation-owned markup: editable strokes/labels and target-relative document-pixel coordinates, no captured background. Ordinary undo/sync and latest task-link reads apply. Marks never become accepted/native content or appear in reading/export/minimaps. Permanent image/HTML markup authoring is retired; existing native marks remain preserved/rendered and may be cleared.

## Development

Use Node.js 22.12+ and npm, and follow README → Fake-first development. Bind dev and preview to `127.0.0.1`. The fake backend runs on port 5174, and its `MOTED_DEV_ORIGIN` must match the exact browser origin. Use fresh temporary state/data directories, never production storage, and never expose fake services publicly.

- `npm run check`: TypeScript.
- `npm run build`: TypeScript plus app and agent-preview builds.
- `npm run test:ai`: essential model, clipboard, migration, reservation, recovery, cloud, privacy, and indexing invariants without model calls.
- For changed UI, run scoped Chromium checks: compact editing, fresh mobile reading, and affected reader/export paths. Test essential invariants only; there is no general regression suite.

## Deployment

Demo: `https://mote.ylxdzsw.com`. Static root: `/var/www/mote`. Nginx: `/etc/nginx/conf.d/mote.conf` (example in `deploy/mote.nginx.conf`). Follow README → Deployment:

1. Build and run the checks the change needs. Publish `dist/` assets before `index.html`, with Nginx-readable permissions (`install -m 644`). Server code stays in `/root/mote/server`.
2. Run `nginx -t && systemctl reload nginx`. Restart `moted.service` only for backend changes, after checking active tasks and workers.
3. Confirm the live HTML and assets match the build and send `Cache-Control: no-store`, and that private APIs stay login-gated.

Preserve `/var/lib/mote`, `/var/lib/mote-ai`, and `/var/backups/mote`. Never reset, import, or edit production documents as a deployment check. CLOUD.md → Storage and service covers the access boundary.

## Deferred scope

Discuss these before implementing: PPTX/PDF/Markdown or other interchange formats, editable sharing, individual accounts, collaborative merging, broader offline sync, and a native bundled binary. Direct user queries over the workspace index are also deferred. Current interchange is V1–V9 `.mote` import/export, plus PNG and standalone HTML export.
