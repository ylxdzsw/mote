# Mote agent submissions

Submission is scoped to one current reservation. The task brief supplies either a local Unix socket/base URL or a public HTTPS task URL. Require `manifest.protocol` to be `mote-agent-v5`. Retained legacy task records are recovery-only; stop and ask the owner for a fresh reservation rather than converting histories or trying a legacy endpoint. Task protocol v5 is distinct from native document versions V1–V5. Candidate content follows [native-format.md](native-format.md) and [authoring.md](authoring.md).

## Resources and context

Fetch `manifest.json`, `target.json`, and any useful version records. `target.json` returns the complete Reservation; the selected target is at `.target`. Its original content, target, and geometry are authoring/review references, not the server's submission contract. Current v5 resources do not advertise pinned rendered snapshots or a manifest `originalReference`; reservation references do not prove which document revision an agent read or bind a proposal.

`document.json` is an optional read of the latest authorized cloud envelope `{document,revision,...metadata}` at access time, not a token-bound snapshot. It may change between reads and is not required for submission. It can include Notes as tentative, user-owned context; Notes are never an edit target. Built-in agents may read their own Private document. External access to any Private source is blocked. Public-share access is separate and excludes Notes. There are no historical agent reads: a `revision` query parameter on the current agent route is ignored. Optional workspace reads are controlled by the Reservation's `workspaceRead`; that property gates cross-document discovery/source reads only, not the task's own `document.json`.

The workspace index returns current stored descriptions, which may be stale; reading it does not force fresh indexing. Use descriptions only as discovery hints. `workspace-document.json?id=DOCUMENT_ID` returns the latest authorized cloud document. Current Private/deletion policy applies at each request opening.

## Current protocol: `mote-agent-v5`

`GET versions.json` returns flat immutable records:

```ts
{ id: 'V1', label?: string, candidate: Candidate }
```

Fetch an individual record with `GET versions/V1.json`. IDs are server-assigned (`V1`, `V2`, …); every successful new submission appends to one sequence shared by built-in and external agents. Versions have no parent, lineage, per-version revision, source document revision/version, agent, or `origin` field. There is no alternative replacement/removal API. A selected version in the task brief is optional request context, not lineage or the owner's review selection.

POST JSON to `submit` using the current envelope (`assets` and `label` are optional):

```json
{
  "operationId": "00000000-0000-4000-8000-000000000001",
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

The `candidate` value contains exactly one target payload (`object`, `content`, or `segment`), a `summary`, and optional `sources`; follow [native-format.md](native-format.md). For HTML widgets, result-root `screenshotPath` or segment `screenshotPaths` name keys in `assets`, which map relative filenames to actual PNG data URLs. The server never reads local paths or fetches URLs. Embedded native images carry their own data URLs. Never execute widget source during submission. Labels are optional and limited to 80 characters.

The receipt is exactly `{taskId,versionId,status:"ready"}`. Do not send `documentRevision`, `documentVersion`, `executor`, executor/generation revisions, source, or origin metadata. Extra submission fields are rejected. The server validates current proposal grammar and native V5 candidate payloads statelessly, without fetching or comparing a document or target. `public/skills/proposal-schema.json` is the schema reference. Its `documentFormat:"mote"` and `documentFormatVersion:5` are advisory schema hints only; they are not candidate fields, are not echoed, and do not prove that a document was read. A malformed proposal response includes the schema URL and JSON path where available.

Stateless delivery validation does not decide whether a proposal fits the reservation. Owner Preview/Accept validates it against the actual current document and scope; the ordinary document save validates the complete native document and uses revision CAS. Submissions never edit the document or apply automatically. Stale or absent document context is valid; original target geometry is not a submission authorization rule.

Generate one UUID `operationId` for each new prepared payload. If a reply is lost or uncertain, retry the same operation ID and identical JSON/asset bytes, label, and task base. An identical retry returns the prior receipt; reusing the ID with different input is a conflict. A changed payload requires a new ID. Only a validated successful receipt acknowledges delivery; a local result file does not. Retained version/task artifacts have no automatic expiry or cleanup after Accept/Discard.

For direct JSON POSTs, keep the operation ID with the exact prepared body and base URL yourself. Candidate JSON is bounded to 8 MiB; uploaded image bytes and total task body have their existing limits. HTML screenshot assets must be real PNGs with dimensions matching the candidate object's rounded body size. Candidate validation never executes HTML or fetches asset URLs.

## Portable helper

Save the candidate value as `OUTPUT/result.json` and each referenced PNG under `OUTPUT/`. Invoke:

```sh
node submit.mjs "$BASE" output
node submit.mjs "$BASE" output "Revised direction"
```

These are alternative examples; the second adds an optional label. The CLI is `node submit.mjs BASE OUTPUT [LABEL]`. For external tasks, `BASE` is the supplied HTTPS URL. For built-in tasks, use the task-brief base and set `MOTED_AGENT_SOCKET` to the supplied socket. No revision, executor, or operation-ID arguments are needed.

The helper reads the manifest and validates its v5 protocol/task identity and the returned task/version receipt. It does not check document freshness or target applicability. Before sending, it durably creates a private `.mote-submit-<fingerprint>.uuid` sidecar in the output directory. The identity covers the base URL and exact serialized payload, including assets and label. Repeated calls, including concurrent invocations, reuse the same operation UUID for that prepared payload. Changed content, assets, label, or base URL gets a new identity. Keep sidecars with prepared output; never delete one to retry an uncertain submission. To intentionally submit otherwise identical content as a distinct version, change its optional label.

## Owner review and local recovery

Only the owner can apply a proposal. Preview and Accept use the cached selected proposal and actual current document/reservation; they do not make a cloud preflight or task-service request. Accept replaces the target and releases its reservation in one local undoable history change. Discard releases the reservation without changing document content. Both remain available during network/service failure when the proposal is cached. Reservation edits request an opportunistic 650ms debounce to ordinary document sync; final persistence still uses document revision CAS. A conflict preserves local work. Undo restores the previous document/reservation and same task ID/token; it does not regenerate or delete proposal history.

## Failures and access

- **400:** correct invalid proposal data. Errors include the proposal schema URL/path where available. Do not add document/source revision fields.
- **413:** correct oversized data; prior versions remain unchanged.
- **409:** the same operation ID was reused with different input. Keep the original payload/identity for an uncertain retry; use a new ID only for a changed payload.
- **403:** the public document/task endpoint is blocked while the document is Private. Ask the owner to disable Private; the same token becomes usable again if its reservation is still active and unexpired.
- **410:** the reservation is released or its optional `expiresAt` has passed. Ask the owner to restore/extend the reservation.
- **404:** the token or resource is unknown/unavailable, including retired task resources. Stop and ask the owner for a current reservation.

Every public task-resource GET checks the current reservation and permissions when the request opens. Each submission checks active/expiry once at request opening; an already authorized late submission may finish harmlessly after a later release/expiry. There is no 24-hour owner-inactivity pause, HTTP 423 lifecycle, agent keepalive, executor switch, or token rotation. Accept/Discard do not permanently revoke the current token. Private blocks all public `/a/` methods while enabled but does not destroy the token. Public Share links are separate and follow their unchanged permanent-revocation policy.

The public task token is a stable 128-bit bearer capability at `/a/<22-character-base64url-token>`, distinct from the task ID. The public `/api/agent/` route is retired; built-in work uses its supplied task-local socket. Keep tokens out of documents, screenshots, citations, and logs. Public skills/helpers/schema files are static no-store resources containing no task data and are not task grants.
