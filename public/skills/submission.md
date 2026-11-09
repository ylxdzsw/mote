# Mote agent submissions

Submission is scoped to one reserved task. The task brief supplies the local socket or public HTTPS base URL. Follow `manifest.protocol`: new tasks use `mote-agent-v2`; retained `mote-agent-v1` tasks keep their frozen contract below and are never converted. Task protocol version is separate from the native document version. Candidate content follows [native-format.md](native-format.md) and [authoring.md](authoring.md).

## Current protocol: `mote-agent-v2`

Read `manifest.json`, then fetch the latest own `document.json`, the original `target.json`, and the version resources it advertises. `document.json` is the latest cloud envelope `{document,revision,...metadata}` and is available for the task's own document regardless of the optional workspace-read permission. It includes Notes as tentative, user-owned context; Notes are never an edit target. Built-in agents may read their own Private document; external agents cannot access a Private document. Public-share access is separate and excludes Notes.

`target.json` remains the original reservation target. Keep the write scope fixed to it; for a segment, resolve its bookmarks against the latest document and do not infer a larger scope from changed surroundings. The optional `snapshot.png` and `target.png` remain visual references to the original input revision. The manifest's `originalReference` gives their `documentRevision` and `documentVersion`; never describe those images as current after the cloud document changes. `manifest.documentRevision` and `documentVersion`, or the `revision`/native version in the `document.json` envelope you actually read, identify current context.

`GET versions.json` returns the flat array of full immutable records:

```ts
{ id: 'V1', label?: string, candidate: Candidate, documentRevision: string, documentVersion: number }
```

Fetch an individual record with `GET versions/V1.json`. IDs are server-assigned (`V1`, `V2`, …); versions have no parent, lineage, per-version revision, alternative/removal flow, or task-wide `candidateRevision`. Multiple submissions append versions; agents cannot replace or remove individual versions. `selectedVersion` in the manifest/task brief is follow-up request context only. A prompt may combine any V1/V2 material; do not infer lineage or auto-change the owner's selected review version when another arrives.

POST JSON to `submit` using this exact v2 envelope:

```json
{
  "operationId": "00000000-0000-4000-8000-000000000001",
  "executorRevision": 0,
  "documentRevision": "00000000-0000-4000-8000-000000000002",
  "label": "Optional label",
  "candidate": {
    "content": [
      {"type":"paragraph","attrs":{"id":"target-paragraph-id","semantic":"body"},"content":[{"type":"text","text":"Revised paragraph."}]}
    ],
    "summary": "A useful description",
    "sources": []
  },
  "assets": {}
}
```

`documentRevision` must be the exact cloud revision used to author and validate the proposal. Never fetch a fresh revision at submission time just to relabel an older result. The server serializes appends and assigns the next version ID; there is no candidate-revision compare-and-swap. If only surrounding context changed and the original reserved target is unchanged, a proposal based on the earlier revision can still be submitted. The server rechecks current authorization and target validity before commit.

The `candidate` value contains exactly one target payload (`object`, `content`, or `segment`), a `summary`, and optional `sources`; follow the shared native and target rules. For HTML widgets, result-root `screenshotPath` or segment `screenshotPaths` name keys in `assets`, which map relative filenames to actual PNG data URLs. The server never reads local paths or fetches URLs. Embedded native images carry their own data URLs. Never execute widget source during submission. Labels are optional and limited to 80 characters.

The receipt includes `{taskId,executorRevision,versionId,status:"ready",documentRevision,documentVersion}` (and may include additional fields). Generate a fresh UUID `operationId` for each new payload. If a reply is lost or uncertain, retry the identical operation ID and byte-for-byte payload, including executor/document revisions, label, candidate JSON, and PNG bytes; the same operation returns the same receipt. A changed payload requires a new operation ID. A successful response is delivery; a local result file is not. If retained v2 version data reaches its 128 MiB recovery limit, submission returns 413 without changing earlier versions; start a new task rather than deleting versions.

### V2 portable helper

The shared Node.js helper detects the protocol from `manifest.json` when needed. Save the candidate value as `OUTPUT/result.json` and each referenced PNG under `OUTPUT/`. Generate and retain one operation UUID:

```sh
operation=$(node -e 'console.log(require("node:crypto").randomUUID())')
node submit.mjs "$BASE" output "$EXECUTOR_REV" "$DOCUMENT_REVISION" "$operation"
```

For an optional label, keep `-` in the v1-only candidate-ID position:

```sh
node submit.mjs "$BASE" output "$EXECUTOR_REV" "$DOCUMENT_REVISION" "$operation" - "Revised direction"
```

The CLI shape is `node submit.mjs BASE OUTPUT EXECUTOR_REV DOCUMENT_REVISION_OR_V1_CANDIDATE_REVISION OP_UUID [V1_CANDIDATE_ID|-] [LABEL]`. For external tasks, `BASE` is the supplied HTTPS task URL. For builtin tasks, use the task-brief base and set `MOTED_AGENT_SOCKET` to the supplied socket. Keep the exact document revision read with the prepared result; do not replace it with a fresh one. A retry reuses the same UUID and payload.

V2 acceptance is owner-only and applies the exact selected version. Accept/release revokes the grant immediately; the acceptance receipt and version remain recoverable until the exact accepted document is cloud-acknowledged. After the accepted document and assistant-state removal are acknowledged, the resolved task and its versions may be cleaned up. Explicit discard also ends the task; unresolved versions are not automatically expired. Agents cannot accept their own submissions.

## Legacy protocol: `mote-agent-v1` (frozen)

The following candidate IDs, histories, alternatives, per-candidate revisions, global CAS, and removal instructions apply only to retained v1 tasks. Their immutable task document/target snapshots, archived task guides, submissions, and existing history remain unchanged. Do not convert a v1 task to v2 or apply the v2 envelope to it.

### V1 candidate set and revisions

`GET candidates.json` returns the task's candidate records. Each full record has this shape:

```ts
{
  id: 'C1',
  label?: string,
  revision: number,
  candidate: Candidate,
  history?: Array<{ revision: number; label?: string; candidate: Candidate }>
}
```

`label` and `history` may be omitted. Candidate IDs are stable (`C1`, `C2`, …) and are never reused. `revision` identifies a particular version of that candidate. `candidateRevision` is a separate task-wide compare-and-swap revision for the candidate set; use the exact current value for every mutation.

Fetch a candidate's current or historical version with `GET candidates/C1.json?revision=N`. A follow-up must name the exact candidate ID and revision it is based on. Do not assume there is only one candidate, and do not silently switch to a newer result another agent submitted.

### V1 submitting a candidate

POST JSON to the task's `submit` resource using the existing delivery envelope plus optional top-level `candidateId` and `label` fields:

```json
{
  "operationId": "00000000-0000-4000-8000-000000000001",
  "executorRevision": 0,
  "candidateRevision": 2,
  "candidateId": "C1",
  "label": "Revised direction",
  "candidate": {
    "content": [
      {"type":"paragraph","attrs":{"id":"target-paragraph-id","semantic":"body"},"content":[{"type":"text","text":"Revised paragraph."}]}
    ],
    "summary": "A useful description",
    "sources": []
  }
}
```

The example's `candidateId` means revise that candidate. Omit `candidateId` to create a new alternative; alternatives are separate records, not overwritten history. A `label` is optional and limited to 80 characters. Do not create alternatives just to keep prior drafts; revise the selected record unless the user asks for alternatives.

These rules apply only to retained `mote-agent-v1` tasks with native `documentVersion` V1–V5, including tasks with an archived guide or helper. An older helper can still submit, but without a candidate ID it creates another alternative rather than replacing the previous proposal. Use the task's v1 helper with the intended ID for a follow-up. No stored input or candidate is converted or discarded.

The `candidate` field retains the existing result contract: exactly one target payload (`object`, `content`, or `segment`), a `summary`, and optional `sources`. Version-1 segment candidates contain ordinary blocks and objects. Version-2 segments additionally carry `slideBreak` atoms and are accepted only in Slides documents; preserve every internal boundary in the reserved range. The leading boundary may be omitted and is restored by Mote. Boundary IDs and slide-top Float anchors remain coherent at application; empty output clears content without deleting slides. Whole-slide clipboard data is a separate, non-agent payload type. Do not change slide height or unrelated slide structure. For HTML widgets, result-root `screenshotPath` or segment `screenshotPaths` name keys in the `assets` object. Assets contain actual PNG data URLs; the server does not read local paths or fetch URLs. Embedded native images carry their own data URLs. Never execute widget source during submission.

Revising an existing record advances that record's `revision`; every successful candidate-set mutation, including creation or removal, advances the global `candidateRevision`. The receipt includes `taskId`, `executorRevision`, global `candidateRevision`, `candidateId`, the resulting candidate `revision`, and `status:"ready"`. Keep the receipt and exact payload together for recovery.

### V1 portable submission helper

The public helper is `/skills/helpers/submit.mjs`; download it to the working directory or use the task-brief copy. Save the candidate result value as `OUTPUT/result.json` and put each referenced PNG at its relative path under `OUTPUT/`. The helper uploads the actual bytes and prints the validated receipt; it does not execute HTML. Generate one operation UUID for each new payload:

```sh
operation=$(node -e 'console.log(require("node:crypto").randomUUID())')
node submit.mjs "$BASE" output "$EXECUTOR_REV" "$CANDIDATE_REV" "$operation"
```

The next command is an alternative example, not an additional use of the same operation ID. Generate a new UUID for every new payload; reuse an ID only for a byte-for-byte retry of that payload. To revise `C1` (and optionally set its label), append the ID and label:

```sh
node submit.mjs "$BASE" output "$EXECUTOR_REV" "$CANDIDATE_REV" "$operation" C1 "Revised direction"
```

To create a labeled alternative instead, use `-` in the candidate-ID position and generate a new operation UUID for that new payload:

```sh
operation_alt=$(node -e 'console.log(require("node:crypto").randomUUID())')
node submit.mjs "$BASE" output "$EXECUTOR_REV" "$CANDIDATE_REV" "$operation_alt" - "Alternative direction"
```

The exact CLI is `node submit.mjs BASE OUTPUT EXECUTOR_REV CANDIDATE_REV OP_UUID [CANDIDATE_ID|-] [LABEL]`. For an external task, set `BASE="$AGENT_URL"` after reading its brief. For built-in transport, set `BASE` to the task-brief base and `MOTED_AGENT_SOCKET` to the supplied task-local socket. Do not substitute paths or revisions; the task brief/manifest supplies them.

### V1 direct JSON submission

If submitting directly, POST the existing envelope plus optional top-level `candidateId` and `label` to the task's `submit` resource. `candidateId` revises that candidate; omission creates a new alternative. Assets map relative screenshot filenames to actual PNG data URLs. The server never opens a local path or fetches a screenshot URL. Requests are bounded to 128 MiB total and 8 MiB candidate JSON; each widget PNG is limited to 10 MiB, total widget PNGs to 40 MiB, and a segment to 32 screenshot paths.

The persisted task metadata, including all candidates and retained revisions, must fit the 128 MiB recovery limit. If a submission would exceed it, the server returns 413 without changing existing candidates. Ask the user which alternatives may be removed; never delete them automatically to make room.

### V1 removal, review, and acceptance

`POST candidates/C1/remove` takes `{operationId,executorRevision,candidateRevision}` and uses the same task-wide CAS. Agents may remove a candidate only when the user explicitly requests its removal; do not remove alternatives as cleanup or because another result is newer.

Agents cannot accept candidates. The owner-facing client keeps the exact selected `{candidateId,revision}` and does not automatically switch selection when another result arrives. Acceptance applies the exact result the owner saw. Accept closes the reservation locally immediately and requests permanent server-side revocation immediately; it does not wait for the document save to disable the grant. Keep the exact acceptance receipt and candidate records recoverable until that exact accepted document is cloud-acknowledged. Only after that acknowledgment may the other alternatives be cleaned up.

### V1 retry rules

Generate one new UUID `operationId` for each new payload. If a response is lost or uncertain, retry the identical operation ID, executor/global candidate revisions, candidate ID, label, candidate JSON, and PNG bytes. A local file is not delivery. On a conflict, fetch the current manifest and candidate records, inspect the exact changed candidate, and reconcile intentionally; never just change revision numbers on prepared work.

- **400/413:** correct invalid or oversized data; no candidate update occurred. A changed payload uses a new operation ID.
- **409:** stale executor/candidate revision or operation ID reused with different input. Fetch current state and reconcile.
- **423 External access paused:** the response says, `External task access is paused. Ask the owner to reopen this document in Mote, then continue with the same task URL. Your task and candidates are retained.` Stop task requests and ask the owner to reopen it; then fetch the current manifest/candidate records and resume with the same task URL. The pause does not rotate the token. Never use an agent keepalive.
- **404:** the grant or resource is permanently revoked or unavailable. Stop; do not try another token or route.

These access-window rules also apply to v2 external grants. External task access is not an agent keepalive. Authenticated owner activity indicating the document is open renews a persisted 24-hour access window. Agent reads and submissions do not renew it. After 24 hours without owner-open activity, all external task resources and mutations pause; reopening the document resumes the same grant unless it was permanently revoked. Acceptance, explicit release, executor switch, task/document deletion, and Private are permanent revocations. Public-share links are separate and unaffected by this agent-access window.

Both protocols' external grants use only `/a/<22-character-base64url-token>` (128 random bits). The public `/api/agent/` route is retired. The one-time credential rollout invalidates earlier external links, including earlier short links: ask the owner to copy the replacement from the same reservation. Task contents, candidates, and pause windows are preserved; do not recreate the task or restart generation merely to obtain access. A short route or public skill file is not proof of an active task grant.
