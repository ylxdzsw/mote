# Portable reservation backend

This is the private-client and operator contract. Current agent work uses the reusable, public, unversioned skills under [`public/skills`](../public/skills/) and their shared authoring, native-format, preview, and submission references. New tasks do not copy or pin a guide, skill version, or digest. Public skills/helpers/schema files contain no task data and remain accessible independently of task access; static responses retain `Cache-Control: no-store`.

The current task transport is `mote-agent-v7`. Native documents remain V1–V9; native version numbers are unrelated to task-protocol versions. Current candidate grammar is native V9. The current task stores a document-owned reservation and separate server task artifacts/proposals. Credentials authorize the active task reservation, not an executor, generation, document revision, or proposal origin. Optional own-document reads return latest cloud context; proposals may be authored from stale or no document context. Existing legacy task records and artifacts remain untouched; the current client does not import them into active task state or show a recovery archive. General Files local recovery downloads remain. No format or task-protocol version change accompanies reservation removal.

See [FORMAT.md](../FORMAT.md) for the normative native schema.

## Native Flow and Float contract

Cloud documents use the V1, V2, V3, V4, V5, V6, V7, V8, or V9 `MoteDocument` directly in storage and on the wire.
Native objects live in ordered `document.objects`; saved geometry is nested in
each object's `layout`. There is no V0 runtime adapter or extension bag;
older supported versions migrate only through `loadDocument`. V1 keeps its existing strict continuous-page schema. V2
introduced Slides, which V9 flattens to continuous content. Unknown fields and
unsupported versions are rejected.

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

Segment proposal payloads use the current closed composition grammar. The transfer envelope is `{version:1,type:'segment',content,objects,geometry,anchorTops,originTop}`; geometry/anchor measurements are transfer-only, not native document data. Main-text proposals contain complete paragraphs only. Keep Flow blocks, owned objects/captions, anchors, and layout coherent; a Flow owns its object, caption, and Flow-anchored Floats. The target rectangle is visual context, not a maximum output size.

New reservations use Object or Segment targets; existing prose-only targets retain their previous scope. New segment targets include `version:2` for exact interval ownership, including disjoint slices of one spacer and zero-length interior insertion points. Omitted target version retains the previous whole-spacer lock. This target-scope version is independent of native V9, the V1 segment candidate envelope, and `mote-agent-v7`. Explicit structural edit mappings rebase surviving targets in the same document/reservation history change. No task conversion or native migration occurs.

The task base URL returns one JSON description, including `.target` scope and segment `.geometry` transfer measurements without original content. Bookmarks identify boundaries against later document context; the portable extraction helper handles partial spacers. Separate manifest/target/instructions resources are retired. Delivery checks unresolved grammar without a document/target/session; the owner expands references and checks current-document compatibility in Preview/Accept.

Internal Notes are `authoring.notes`, an ordered array of plain-text strings. Authorized v7 reads of the optional latest task `document.json` may include them as tentative user context, but candidates cannot target or edit them. Public shares and HTML exports omit the entire `authoring` object; native `.mote` exports retain it. Built-in agents may read their own Private document; public external task access to a Private document is blocked for all methods.

## Native permanent markup (V5+)

Native V5 adds optional `markup:{width,height,strokes,labels}` only to image and HTML objects. The exact closed grammar, viewport bounds, fixed palette, and limits remain the V5 feature rules and are unchanged in V6–V9; markup has no separate ID, layout, or background. Native V1–V4 documents reject markup and migrate only at the ordinary document load boundary.

Native image/HTML markup remains valid V5+ owner content and is preserved by native validation and migration. Current agents do not author, replace, or clear this permanent object markup. For an individual-object candidate, omit `markup` so Mote retains the current same-kind object's value; a complete segment object copied from the document must carry any existing value it intends to retain. Native markup remains part of the V9 object grammar; see [FORMAT.md](../FORMAT.md).

## Reservation spatial markup

The optional Reservation property is `markup:{x,y,width,height,strokes,labels}`. `x` and `y` are finite signed document-pixel offsets from the current reserved target origin: the object's body top-left for an object target; page-left at the current first paragraph top for text; page-left at the resolved range start for segments. `width` and `height` are positive finite reference extents, not limits on the proposed output. `strokes` and `labels` use the same closed grammar, fixed palette, and limits as native `ObjectMarkup`; the wrapper has no background image or other fields.

`GET` of the task base URL includes the latest cloud-saved reservation `.markup` when present. It is a transparent reservation annotation, distinct from native object markup and from candidate content. Text/segment surfaces normally start at page-left (`x:0`); signed offsets can include owned content above the range. Resolve current IDs/bookmarks and measure the current document rather than treating the reservation-time `target.area` as a live origin. Marks keep their document-pixel sizes; they are not scaled to fit changed target geometry. A later base-URL read returns the latest saved markup. Reading it does not start or restart execution. It follows ordinary reservation sync/CAS and lifecycle; there is no separate markup snapshot, background image, or proposal/version history.

## Native fixed palette contract

`theme.appearance` contains `mode:'light'|'dark'`, `primaryHue`, and
`secondaryHue`; both hues are finite degrees in `[0,360)`. Theme lengths use
`{value,unit:'px'|'em'}`; line height can also use
`{value,unit:'ratio'}`. `em` resolves against `theme.defaults.size`, while a
ratio multiplies the resolved style font size. Full defaults and sparse
`paragraphs`/`objects` overrides are described in FORMAT.md. Missing styles
inherit defaults; there is no special implicit Subheading fallback. New
creation seeds its Subheading style.

V6+ permits optional document-level `theme.justifyText:boolean`; omission means
false and V1–V5 reject the field. It has no class, paragraph, or inline
override. When true, native prose paragraphs in main text and Text objects
(Flow or Float), including headings, lists, and captions, use browser-native
`text-align: justify` with start-aligned final lines. Table column alignment remains
unchanged; Code, formulas, and HTML widget contents are unaffected. Existing
CSS `hyphens:auto` remains enabled; automatic hyphenation depends on document
language and browser dictionaries, with no language detection, inserted soft
hyphens, or stored text rewriting.

V7 permits optional document-level `theme.firstLineIndent:boolean`; omission or
false means no indent, and V1–V6 reject the field. It is independent of
`justifyText` and has no class, paragraph, or inline override. When true, use
`text-indent: 2ic` only for semantic Body paragraphs in main text and Flow/Float
Text objects. Only the first formatted line is indented; wrapped and soft-break
lines start normally. Headings, lists, captions, tables, Code, formulas, and
HTML widget contents are unaffected. This is language-independent and does not
rewrite content whitespace.

Native V8 permits the `separator` paragraph semantic only in main text and
Text-object content; V1–V7 reject it. It is not valid in table cells or owned
captions and is not an object or layout choice. `theme.paragraphs.separator`
uses ordinary sparse text-style fields plus optional positive
`lineThickness:{value,unit:'px'|'em'}`; only this style accepts the field, and
omission resolves to `1px`. An empty Separator renders as a full-width rule;
rich-text labels center between equal flank rules, with wrapped labels remaining
centered and short flanks. Rule color follows the class text color, independently
of inline label color. Separator is unaffected by document-wide justification
and first-line indent.

The fixed color references are `primary`, `secondary`, `red`, `amber`,
`green`, `pink`, `blue`, and `violet`, each also supporting `:soft`, plus
single-tone `gray1` through `gray6`. Every slot adapts to mode; Primary and
Secondary follow the theme hues. The page background follows the mode. Drawing
`background` is `"gray6"` or `null`. Text-box `decoration.color` is a pair:
a family ID or `gray4` (Gray 4 / Gray 5).

Inline rich text accepts only `bold`, fixed-palette `color`, `box`,
and safe absolute HTTP(S) `link` marks. Link hrefs have no credentials or
control characters and cannot be relative, `mailto:`, or `tel:`. Marks have
exact attributes and cannot be duplicated. `theme.palette`, arbitrary raw
colors, and custom color definitions are not part of any supported native version. Clipboard/candidate
payloads carry no palette definitions; fixed references adopt destination mode
and hues.

## Native theme font weights

V1–V3 native documents and snapshots retain finite theme weights from 1
through 1000. V4+ accepts only 400 (Regular) or 700 (Bold) for
`theme.defaults.weight`, sparse paragraph weight overrides, and table/Code
object weight overrides. New Title, Heading, and Subheading presets explicitly
use 700. Sparse older overrides remain sparse; the V3→V4 migration quantizes
only explicit saved weights (below 550 to 400, at least 550 to 700) and does
not add Heading overrides. Table header rows render at weight 600 for V1–V3
and 700 for V4+. See [FORMAT.md](../FORMAT.md) for the full migration contract.

## Private task API (`mote-agent-v7`)

Native document formats remain V1–V9; native versioning is independent of task protocol `mote-agent-v7`. No protocol adapter, task-history conversion, or automatic continuation of retired protocols is required. Legacy task records remain stored and untouched, but the current client does not import them into active Assistant state or expose a recovery archive; general Files local recovery downloads remain separate.

### Cloud editing state and task artifacts

Current editing state is `{document,reservations}`. Authenticated document create/save APIs return and accept the native document plus a separate reservation list. A content edit and reservation change commit atomically under one document revision CAS. Reservation data never enters the native `MoteDocument`, `.mote` exports, PNG/HTML publication, or task token data. Reservations have optional `expiresAt` and optional validated spatial `markup` properties and participate in local undo/redo.

A reservation UUID is its `taskId`; the server creates a separate random 128-bit task token for its public capability. The token is not an editable reservation field or part of native/export JSON. It remains stable through document saves, reservation removal/restoration, and Private on/off. Current tasks do not use permanent revocation tombstones, executor revisions, generation-auth revisions, or owner-inactivity windows. Current release is reservation omission, not permanent token revocation: outside the Private/deleted-document access gates, a committed omission follows the existing task-capability 404 path; restoring the reservation and saving it makes the same token usable again.

Task execution, proposal versions, operation receipts, transcripts, and Mu continuation files are separate durable server task artifacts. An owner `GET /api/ai/tasks/:id` lazily ensures a waiting task only after the reservation has been cloud-committed. A reservation-only draft must be published through ordinary document sync; it is retained even if the native document is blank. Accept and Discard do not delete server task artifacts or proposals, and the service has no automatic task cleanup/expiration. This says nothing about the separate browser-local cache.

Reserve, properties, Accept, Discard, and deleting a reserved target are ordinary local undoable document/reservation edits. Accept applies the selected cached proposal; Accept, Discard, and deletion remove the reservation from the current array in one history change. Current releases do not persist a `released:true` marker. These edits make no cloud preflight, task-service mutation, or immediate sync; reservation edits request an opportunistic 650ms debounce to the ordinary document sync path. Autosave, retry operation IDs, and revision CAS are otherwise unchanged; the cloud's last committed `{document,reservations}` remains authoritative. Undo/redo restores prior history snapshots with the same task ID/token without restarting generation. Older explicit released entries are stripped by the history initializer and omitted on the next ordinary save. Final native validation and ordinary document CAS protect persistence. Cached proposals remain previewable/acceptable during service failure while referenced by current state or history; failed final saves use normal explicit conflict/recovery behavior.

The browser-local task view/proposal/draft cache is scoped to one working copy. It is retained while an ID appears in current reservations or any past/future history snapshot; history holds at most 100 undo entries. After local working-copy persistence succeeds, unreferenced cache entries are pruned. Dropping a redo branch or evicting an old undo entry can remove the final reference. Unmount and reload trim to current reservations, since undo history is not persisted; failed local saves do not prune. This is not server artifact or token garbage collection, because another independent/offline tab may still reference the task. Server artifacts remain retained, so no complete disk cleanup is implied.

### Owner routes

Authenticated `/api/ai/tasks` routes retain their exact-Origin check for mutations.

- **GET `/api/ai/tasks/:id`** ensures and returns task status, cached versions, and available capability information for the committed active reservation.
- **POST `/api/ai/tasks/:id/revise`** accepts `{prompt,operationId,model?,selectedVersion?}` and starts a built-in run. `operationId` makes retries of the same request safe. There is no executor revision or generation authorization argument.
- **POST `/api/ai/tasks/:id/stop`** stops built-in execution only. It does not release the reservation, invalidate the task token, or block an external submission already using that reservation.
- Mutations at `/executor`, `/workspace-read`, and `/release` are obsolete and return 404. Expiration changes, release, and restoration are ordinary reservation edits in the document CAS.

The former `GET /api/documents/:id/assistant` returns stored task records read-only for older data; its mutation route is unavailable and it does not control current tasks. The current client does not import these records into active Assistant state or expose a retained-task/recovery archive, and legacy storage is left untouched. General Files local recovery downloads remain independent. No legacy task is converted into a current reservation or proposal history.

### Agent resources and proposals

External resources use only `/a/<22-character-base64url-token>` (128 random bits), without workspace cookie or Origin. Built-in agents use the same scoped resources through the supplied task-local Unix socket. Public `/api/agent/` remains retired; its built-in task-local socket path is not a public endpoint. The socket exposes only the scoped agent handler, not the private workspace API. All responses are no-store; capability responses also use no-referrer/noindex behavior and token-bearing URLs must not enter logs.

- `GET` of the task base URL returns the canonical JSON description: `protocol:'mote-agent-v7'`, `taskId`, request/feedback, exact `.target`, segment `.geometry` measurements, optional latest saved reservation `.markup`, expiry and document metadata, skill/helpers/schema locations, resource URLs and selected-version context. It excludes copied originals and snapshots. Re-reading this URL returns the current saved markup but does not start or restart execution. `manifest.json`, `target.json`, and `instructions.md` return 404. The task token is separate from task ID. Native `documentFormatVersion:9` in the proposal schema is advisory metadata, not request data or proof of a read.
- `GET document.json` is optional and returns the latest authorized cloud document at access time, with its ordinary revision metadata. It is not pinned to a task, and there are no historical agent reads. It is always the task’s own document; Notes are tentative context, never a write target.
- `GET versions.json` and `GET versions/V1.json` return the flat append-only `{id:'V1',label?,candidate}` sequence. Versions have no `origin`, agent, parent, lineage, source document revision/version, or per-version revision. Concurrent built-in and external submissions append to the same sequence.
- `POST submit` accepts `{operationId,candidate,assets?,label?}`. It accepts no document revision, executor, execution generation, source/origin, or target validation field. The receipt is exactly `{taskId,versionId,status:'ready'}`. An identical operation retry returns its receipt; reusing an operation ID with different input is a conflict. Submission is not application and never edits the document.

Delivery validation is stateless: it checks unresolved proposal grammar, explicit native V9 payloads, decidable cross-references, and uploaded assets without a document, reservation target, source version, agent origin, or session. A segment's `objects` array may contain bare safe object IDs alongside complete objects. IDs are stored unchanged; screenshot mappings may reference only explicit HTML objects. Owner Preview/Accept requires each ID to be owned by the reservation and present in the working document, replaces it with an exact deep copy, and runs complete candidate validation/application. No merging, coordinate correction, automatic retention, fallback, or special ID handling occurs. Duplicate IDs/broken references fail normal validation after expansion. Native documents and clipboard payloads remain strict complete compositions. It does not validate reservation applicability or imply that the agent read a document. The public `/skills/proposal-schema.json` is the current schema reference; its `documentFormat:'mote'` and `documentFormatVersion:9` are advisory hints and are neither echoed nor submission proof. Invalid schema responses include `schemaUrl` and `path` where available. Owner Preview/Accept validates a cached proposal against the actual current native document and reservation scope. The final ordinary document save performs native document validation and revision CAS. Candidate schema validation, owner applicability, and cloud persistence are separate checks.

HTML `screenshotPath`/`screenshotPaths` name files in the supplied assets map. Assets are actual PNG data URLs; the server does not read local paths or fetch URLs. Embedded images carry their own data. Widget source is never executed during submission. `BASE OUTPUT [LABEL]` is the portable helper interface. The helper owns durable operation IDs for the base URL and exact prepared candidate/assets/label, using private sidecar files in the output directory; it sends no executor or source-revision metadata. Keep sidecars with prepared work and repeat the same command after an uncertain response. When submitting JSON directly, retain one operation ID and identical body/assets for every retry.

### Task document context

`GET document.json` may return different latest saved revisions on separate requests. It is optional and not a submission prerequisite. Built-in runs also receive a run-local copy of the latest saved document as advisory context. Neither copy binds a proposal.

No task can list or fetch other workspace documents. The retired `workspace-index.md` and `workspace-document.json` resources return 404 for authorized requests. Legacy `workspaceRead` values on saved reservations and pending document saves grant nothing; they do not invalidate or convert the reservation.

### Access lifecycle and Private

Each agent resource GET checks the saved reservation and relevant permission when the request opens. Each submission checks active/released state and optional `expiresAt` once at request opening. An already authorized in-flight submission may finish harmlessly after a later reservation removal or expiry. An absent `expiresAt` has no time limit; there is no owner-inactivity pause, keepalive, HTTP 423 lifecycle, or token refresh. A missing reservation follows the existing not-found (404) path; an expired active reservation is rejected at request opening, and older explicit `released:true` records retain their legacy 410 rejection behavior. A missing/deleted document is blocked by its ordinary document boundary. Public access to a Private document is forbidden (403) for every `/a/` method.

Private blocks the complete public `/a/` endpoint while enabled, including reads and submissions, but does not rotate or destroy the task token. Disabling Private restores the same active, unexpired reservation link. The trusted built-in socket may access its own Private document. Public Share links are separate: turning Private on permanently revokes the current latest-only Share link, and turning Private off does not restore it.

A task capability cannot save the document, change reservation properties, or accept a proposal. Only the owner applies or releases through local document edits and ordinary sync. Downloaded context cannot be recalled. Current reservation removal/undo does not write a permanent task revocation tombstone; document deletion makes its reservation unavailable through the normal deleted-document boundary. Legacy stored task records remain untouched and read-only, not imported into current task state.

### Built-in execution and recovery

Built-in agents use a task-local Unix socket and the same agent resources, validator, and append-only proposal list as external agents. Each built-in run receives a latest-at-run-start document file as optional context; socket `document.json` reads remain latest at access time. A local Built-in/External tab switch is presentation only, does not stop or start work, and does not change task authorization. An external agent can submit while a built-in run is running or stopped. Stop controls execution/resource use only; it is not an access boundary.

Generation does not restart automatically after reconnect or service restart. Network/model failure preserves local edits and cached proposals while the task remains referenced by current state or history; manual editing and cached Preview/Accept remain available. Worker cleanup is resource management, not generation authorization. Reservation expiry and public-task privacy are checked at each new resource opening. Public Share state and its existing server-owned revision/CAS/revocation policy are unchanged and independent of task tokens.

## Operator boundary and checks

Native `.mote` documents are the long-term compatibility and backup boundary. SQLite schemas and agent sessions have no cross-version compatibility promise; historical database migrations need not be maintained. Recover an old SQLite snapshot with its matching build in isolation, export documents, then import those exports into the current workspace. Never automatically reset production storage. See [CLOUD → Manual backup](../CLOUD.md#manual-backup).

The production service remains on its authenticated general Unix socket. Nginx may proxy **only** `/a/` publicly (with access logging off) in addition to existing read-only Share routes. Keep `/api/ai` and `/api/documents` login-gated; the public `/api/agent/` route remains retired. Never expose the general TCP listener publicly. Configure a 128 MiB body limit and no caching for agent and public skill/schema responses. Public skills contain no task data.

Built-in workers use the administrator-configured Mu runtime/provider, the non-root worker account, and the systemd sandbox. Provider Unix sockets use administrator-configured task-local relays, not caller-supplied URLs. The fake backend remains loopback-only and uses isolated temporary data/state.

Essential offline checks, without real model calls:

```sh
npm run test:ai
```

For just the task lifecycle and cloud-store subset:

```sh
node --experimental-sqlite --test server/moted.test.mjs server/cloud.test.mjs
```

The extraction helper CLI is `node extract.mjs TASK.json DOCUMENT.json RESULT.json`. It copies object/text targets and composes segment targets using bookmarks, owned IDs, and task transfer measurements. It emits ID shorthand for unchanged objects and complete adjusted Floats for cropped-spacer anchors, writes a new result without overwriting, and never submits. Shared helper copies in `server/` and `public/skills/helpers/` remain identical.

The current submission helper CLI is `node submit.mjs BASE OUTPUT [LABEL]`; `MOTED_AGENT_SOCKET` supplies the task-local socket for built-in work. It reads the task description at the base URL and validates its `protocol` and the current receipt `{taskId,versionId,status:'ready'}`, without document-freshness checks. `server/check-result.mjs` remains a local validation convenience and does not submit. An unrelated response, redirect, or local result file is not delivery; an uncertain reply requires retrying the same prepared payload/operation identity, never automatic generation.
