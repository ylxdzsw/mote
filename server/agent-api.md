# Portable reservation backend

This is the private-client and operator contract. Current agent work uses the reusable, public, unversioned skills under [`public/skills`](../public/skills/) and their shared authoring, native-format, preview, and submission references. New tasks do not copy or pin a guide, skill version, or digest. Public skills/helpers/schema files contain no task data and remain accessible independently of task access; static responses retain `Cache-Control: no-store`.

The current task transport is `mote-agent-v5`. Native documents remain V1–V7; native version numbers are unrelated to task-protocol versions. The current task stores a document-owned reservation and separate task artifacts/proposals. Credentials authorize the active task reservation, not an executor, generation, document revision, or proposal origin. Optional own-document reads return latest cloud context; proposals may be authored from stale or no document context. Retained legacy task records are recovery-only and are not converted.

See [FORMAT.md](../FORMAT.md) for the normative native schema.

## Native Flow and Float contract

Cloud documents use the V1, V2, V3, V4, V5, V6, or V7 `MoteDocument` directly in storage and on the wire.
Native objects live in ordered `document.objects`; saved geometry is nested in
each object's `layout`. There is no V0 runtime adapter or extension bag;
older supported versions migrate only through `loadDocument`. V1 keeps its existing strict continuous-page schema. V2
adds Slides without changing the meaning of other fields. Unknown fields and
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

## Native Slides contract

V1 rejects both `page.slideHeight` and `slideBreak` atoms. In V2, Slides are
active only when `page.slideHeight` is present and positive; V2 without it is
continuous. The first slide is implicit. Each later slide begins with a
top-level `{type:'slideBreak',attrs:{id}}` in the same flat `content` array.
Markers are not nested in objects, captions, or tables, and each slide has
content (an empty slide uses an empty paragraph). A marker-relative Float
belongs to the slide it starts and uses page-space x and nonnegative y. Floats
anchored to ordinary blocks remain in that block's slide; Flow-anchored Floats
retain their signed offsets from the Flow owner.

Enabling Slides upgrades V1 to V2 explicitly. Automatic Title/Heading breaks
and whole-block height packing are best-effort and happen only on enable;
height edits do not repartition. Disabling removes the active slide height and
breaks, leaves the document V2, and is not a round-trip guarantee. Layout and
anchors are best-effort across the toggle, so use document Undo to restore the
prior arrangement. Each slide lays out Flow, margins, repulsion, and anchors
independently. Editing expands for main flow and Flow captions but not direct
Float height. Floats may overlap or cover later slides and remain visible;
reading and exports clip each slide to its saved height. PNG is one long image,
and standalone HTML embeds the native document, including its overflowing
content. Reading/export output has no slide-editing controls or slide navigator.

Captions belong only to image, HTML, and table owners. Their exact shape is
`{content:JSONContent,width?:number}` with a doc containing one paragraph whose
attrs contain only `id`. Caption paragraphs use the shared inline marks and
fixed Caption styling. Omitted width follows the owner; an explicit positive
width in document pixels remains fixed on owner resize. Captions have no
separate object ID, layout, x/y, or placement. A caption is part of its owner's
reservation and composition.

Segment proposal payloads use the current closed composition grammar. The transfer envelope is `{version:1|2,type:'segment',content,objects,geometry,anchorTops,originTop}`; geometry/anchor measurements are transfer-only, not native document data. Version 1 carries ordinary blocks; version 2 additionally carries native slide-break atoms. Main-text proposals contain complete paragraphs only. Keep Flow blocks, owned objects/captions, anchors, and layout coherent; a Flow owns its object, caption, and Flow-anchored Floats. The target rectangle is visual context, not a maximum output size.

The full Reservation appears in `target.json`, with the UI target at `.target`. Its original content, target, geometry, and bookmarks are not server-side submission-validation or authorization contracts. Delivery checks current proposal grammar without a document/target/session; the owner checks current-document compatibility in Preview/Accept.

For Slides-aware segments, preserve internal `slideBreak` atoms in order; the leading marker may be omitted and is restored by Mote. Application preserves original boundary IDs and remaps marker-anchored Floats. An empty result clears content while retaining slide structure. Do not change `slideHeight` or unrelated slides.

Internal Notes are `authoring.notes`, an ordered array of plain-text strings. Authorized v5 reads of the optional latest `document.json` and permitted workspace reads may include them as tentative user context, but candidates cannot target or edit them. Public shares and HTML exports omit the entire `authoring` object; native `.mote` exports retain it. Built-in agents may read their own Private document; public external task access to a Private document is blocked for all methods.

## Native permanent markup (V5+)

Native V5 adds optional `markup:{width,height,strokes,labels}` only to image and HTML objects. The exact closed grammar, viewport bounds, fixed palette, and limits remain the V5 feature rules and are unchanged in V6 and V7; markup has no separate ID, layout, or background. Native V1–V4 documents reject markup and migrate only at the ordinary document load boundary.

Current `mote-agent-v5` proposal delivery uses the current native V7 candidate grammar. For an individual-object candidate, omitting `markup` preserves the current same-kind object's markup at application; a complete supplied markup replaces it. Valid positive viewport dimensions with empty `strokes` and `labels` explicitly clear it; `null` and `{}` are invalid. Complete segment proposals carry any markup they intend to retain. Owner Preview/Accept applies these rules against the actual current document; no task-specific pinned markup schema or backend snapshot normalization is used. See [FORMAT.md](../FORMAT.md) for the exact native grammar.

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

## Private task API (`mote-agent-v5`)

Native document formats remain V1–V7; native versioning is independent of task protocol `mote-agent-v5`. No protocol adapter, task-history conversion, or automatic continuation of retired protocols is required. Retained legacy task records are recovery-only.

### Cloud editing state and task artifacts

Current editing state is `{document,reservations}`. Authenticated document create/save APIs return and accept the native document plus a separate reservation list. A content edit and reservation change commit atomically under one document revision CAS. Reservation data never enters the native `MoteDocument`, `.mote` exports, PNG/HTML publication, or task token data. Reservations have user-owned `workspaceRead` and optional `expiresAt` properties and participate in local undo/redo.

A reservation UUID is its `taskId`; the server creates a separate random 128-bit task token for its public capability. The token is not an editable reservation field or part of native/export JSON. It remains stable through document saves, Accept/Discard, Undo, and Private on/off. Current tasks do not use permanent revocation tombstones, executor revisions, generation-auth revisions, or owner-inactivity windows.

Task execution, proposal versions, operation receipts, transcripts, and Mu continuation files are separate durable task artifacts. An owner `GET /api/ai/tasks/:id` lazily ensures a waiting task only after the reservation has been cloud-committed. A reservation-only draft must be published through ordinary document sync; it is retained even if the native document is blank. Accept and Discard do not delete task artifacts or proposals, and there is no automatic task cleanup/expiration.

Reserve, properties, Accept, and Discard are ordinary local undoable document/reservation edits. Accept applies the selected cached proposal and marks its reservation released in one history change; Discard releases it without changing content, including a new-object placeholder. Neither performs cloud preflight, task-service mutation, or immediate sync. Reservation edits request an opportunistic 650ms debounce to the ordinary document sync path. Autosave, retry operation IDs, and revision CAS are otherwise unchanged; the cloud's last committed `{document,reservations}` remains authoritative. Undo restores the prior state and same task ID/token without restarting generation. Final native validation and ordinary document CAS protect persistence. Cached proposals remain previewable/acceptable during service failure; failed final saves use normal explicit conflict/recovery behavior.

### Owner routes

Authenticated `/api/ai/tasks` routes retain their exact-Origin check for mutations.

- **GET `/api/ai/tasks/:id`** ensures and returns task status, cached versions, and available capability information for the committed active reservation.
- **POST `/api/ai/tasks/:id/revise`** accepts `{prompt,operationId,model?,selectedVersion?}` and starts a built-in run. `operationId` makes retries of the same request safe. There is no executor revision or generation authorization argument.
- **POST `/api/ai/tasks/:id/stop`** stops built-in execution only. It does not release the reservation, invalidate the task token, or block an external submission already using that reservation.
- Mutations at `/executor`, `/workspace-read`, and `/release` are obsolete and return 404. Current permission changes, release, and restoration are ordinary reservation edits in the document CAS.

The former `GET /api/documents/:id/assistant` returns stored task records only as read-only recovery for older data; its mutation route is unavailable and it does not control current tasks. No legacy task is converted into a current reservation or proposal history.

### Agent resources and proposals

External resources use only `/a/<22-character-base64url-token>` (128 random bits), without workspace cookie or Origin. Built-in agents use the same scoped resources through the supplied task-local Unix socket. Public `/api/agent/` remains retired; its built-in task-local socket path is not a public endpoint. The socket exposes only the scoped agent handler, not the private workspace API. All responses are no-store; capability responses also use no-referrer/noindex behavior and token-bearing URLs must not enter logs.

- `GET manifest.json` identifies `protocol:'mote-agent-v5'`, `taskId`, the public proposal `schemaUrl`, and task resource URLs. The task token is separate from task ID. Any native `documentFormatVersion:7` in the public proposal schema is advisory metadata, not request data or proof that a document was read.
- `GET target.json` returns the complete Reservation. Its `.target`, original content, and geometry are UI/authoring references, not a server-side proposal contract.
- `GET document.json` is optional and returns the latest authorized cloud document at access time, with its ordinary revision metadata. It is not pinned to a task, and there are no historical agent reads. The own document is independent of `workspaceRead`; permitted Notes are tentative context, never a write target.
- `GET versions.json` and `GET versions/V1.json` return the flat append-only `{id:'V1',label?,candidate}` sequence. Versions have no `origin`, agent, parent, lineage, source document revision/version, or per-version revision. Concurrent built-in and external submissions append to the same sequence.
- `POST submit` accepts `{operationId,candidate,assets?,label?}`. It accepts no document revision, executor, execution generation, source/origin, or target validation field. The receipt is exactly `{taskId,versionId,status:'ready'}`. An identical operation retry returns its receipt; reusing an operation ID with different input is a conflict. Submission is not application and never edits the document.

Delivery validation is stateless: it checks the current proposal grammar, native V7 candidate payload grammar, and uploaded assets without a document, reservation target, source version, agent origin, or session. It does not validate reservation applicability or imply that the agent read a document. The public `/skills/proposal-schema.json` is the current schema reference; its `documentFormat:'mote'` and `documentFormatVersion:7` are advisory hints and are neither echoed nor submission proof. Invalid schema responses include `schemaUrl` and `path` where available. Owner Preview/Accept validates a cached proposal against the actual current native document and reservation scope. The final ordinary document save performs native document validation and revision CAS. Candidate schema validation, owner applicability, and cloud persistence are separate checks.

HTML `screenshotPath`/`screenshotPaths` name files in the supplied assets map. Assets are actual PNG data URLs; the server does not read local paths or fetch URLs. Embedded images carry their own data. Widget source is never executed during submission. `BASE OUTPUT [LABEL]` is the portable helper interface. The helper owns durable operation IDs for the base URL and exact prepared candidate/assets/label, using private sidecar files in the output directory; it sends no executor or source-revision metadata. Keep sidecars with prepared work and repeat the same command after an uncertain response. When submitting JSON directly, retain one operation ID and identical body/assets for every retry.

### Current-context and workspace reads

`GET document.json` may return different latest cloud revisions on separate requests. It is optional and not a submission prerequisite. Built-in runs also receive a run-local copy of the latest saved document as advisory context. Neither copy binds a proposal. Reading own-document content does not require `workspaceRead`.

`workspaceRead` is one Reservation property shared by all agents on the task. It gates only `workspace-index.md` and `workspace-document.json` cross-document reads; there is no separate per-executor permission revision or automatic reset. The workspace index returns current stored descriptions, which may be stale; reading it does not force fresh indexing. `workspace-document.json?id=DOCUMENT_ID` returns the latest cloud source. A requested `revision` query is ignored by the current agent route; historical pinned reads are not supported. The source's current deletion/Private policy applies at request opening. Index descriptions are discovery hints, not evidence, and retrieval never expands the reserved region or permits automatic acceptance.

### Access lifecycle and Private

Each agent resource GET checks the saved reservation and relevant permission when the request opens. Each submission checks active/released state and optional `expiresAt` once at request opening. An already authorized in-flight submission may finish harmlessly after a later release or expiry. An absent `expiresAt` has no time limit; there is no owner-inactivity pause, keepalive, HTTP 423 lifecycle, or token refresh. Unknown token/resource remains unavailable (404); a released or expired reservation returns 410; public access to a Private document is forbidden (403) for every `/a/` method.

Private blocks the complete public `/a/` endpoint while enabled, including reads and submissions, but does not rotate or destroy the task token. Disabling Private restores the same active, unexpired reservation link. The trusted built-in socket may access its own Private document; built-in agents cannot read another Private document, and external agents cannot read a Private source, including the source of their own task. `workspaceRead` cannot override Private. Public Share links are separate: turning Private on permanently revokes the current latest-only Share link, and turning Private off does not restore it.

A task capability cannot save the document, change reservation properties, or accept a proposal. Only the owner applies or releases through local document edits and ordinary sync. Downloaded context cannot be recalled. Current reservation release/undo does not write a permanent task revocation tombstone; document deletion makes its reservation unavailable through the normal deleted-document boundary. Legacy stored task records remain recovery-only.

### Built-in execution and recovery

Built-in agents use a task-local Unix socket and the same agent resources, validator, and append-only proposal list as external agents. Each built-in run receives a latest-at-run-start document file as optional context; socket `document.json` reads remain latest at access time. A local Built-in/External tab switch is presentation only, does not stop or start work, and does not change task authorization. An external agent can submit while a built-in run is running or stopped. Stop controls execution/resource use only; it is not an access boundary.

Generation does not restart automatically after reconnect or service restart. Network/model failure preserves local edits and cached proposals; manual editing and cached Preview/Accept remain available. Worker cleanup is resource management, not generation authorization. `workspaceRead`, reservation expiry, and Private are checked at each new resource opening. Public Share state and its existing server-owned revision/CAS/revocation policy are unchanged and independent of task tokens.

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

The current submission helper CLI is `node submit.mjs BASE OUTPUT [LABEL]`; `MOTED_AGENT_SOCKET` supplies the task-local socket for built-in work. It validates `manifest.protocol` and the current receipt `{taskId,versionId,status:'ready'}`, without document-freshness checks. `server/check-result.mjs` remains a local validation convenience and does not submit. An unrelated response, redirect, or local result file is not delivery; an uncertain reply requires retrying the same prepared payload/operation identity, never automatic generation.
