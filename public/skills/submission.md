# Candidate records and submission

Submission is scoped to one reserved task. The task's explicit brief supplies the local socket or public HTTPS base URL. `manifest.json` supplies the current `executorRevision`, global `candidateRevision`, and resource paths. Candidate content follows [native-format.md](native-format.md) and [authoring.md](authoring.md).

## Candidate set and revisions

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

## Submitting a candidate

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

These are the current submission rules for all supported V1 tasks, including retained tasks with an archived guide or helper. An older helper can still submit, but without a candidate ID it creates another alternative rather than replacing the previous proposal. Use the current public helper with the intended ID for a follow-up. No stored input or candidate is converted or discarded.

The `candidate` field retains the existing result contract: exactly one target payload (`object`, `content`, or `segment`), a `summary`, and optional `sources`. For HTML widgets, result-root `screenshotPath` or segment `screenshotPaths` name keys in the `assets` object. Assets contain actual PNG data URLs; the server does not read local paths or fetch URLs. Embedded native images carry their own data URLs. Never execute widget source during submission.

Revising an existing record advances that record's `revision`; every successful candidate-set mutation, including creation or removal, advances the global `candidateRevision`. The receipt includes `taskId`, `executorRevision`, global `candidateRevision`, `candidateId`, the resulting candidate `revision`, and `status:"ready"`. Keep the receipt and exact payload together for recovery.

## Portable submission helper

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

## Direct JSON submission

If submitting directly, POST the existing envelope plus optional top-level `candidateId` and `label` to the task's `submit` resource. `candidateId` revises that candidate; omission creates a new alternative. Assets map relative screenshot filenames to actual PNG data URLs. The server never opens a local path or fetches a screenshot URL. Requests are bounded to 128 MiB total and 8 MiB candidate JSON; each widget PNG is limited to 10 MiB, total widget PNGs to 40 MiB, and a segment to 32 screenshot paths.

The persisted task metadata, including all candidates and retained revisions, must fit the 128 MiB recovery limit. If a submission would exceed it, the server returns 413 without changing existing candidates. Ask the user which alternatives may be removed; never delete them automatically to make room.

## Removal, review, and acceptance

`POST candidates/C1/remove` takes `{operationId,executorRevision,candidateRevision}` and uses the same task-wide CAS. Agents may remove a candidate only when the user explicitly requests its removal; do not remove alternatives as cleanup or because another result is newer.

Agents cannot accept candidates. The owner-facing client keeps the exact selected `{candidateId,revision}` and does not automatically switch selection when another result arrives. Acceptance applies the exact result the owner saw. Accept closes the reservation locally immediately and requests permanent server-side revocation immediately; it does not wait for the document save to disable the grant. Keep the exact acceptance receipt and candidate records recoverable until that exact accepted document is cloud-acknowledged. Only after that acknowledgment may the other alternatives be cleaned up.

## Retry and access rules

Generate one new UUID `operationId` for each new payload. If a response is lost or uncertain, retry the identical operation ID, executor/global candidate revisions, candidate ID, label, candidate JSON, and PNG bytes. A local file is not delivery. On a conflict, fetch the current manifest and candidate records, inspect the exact changed candidate, and reconcile intentionally; never just change revision numbers on prepared work.

- **400/413:** correct invalid or oversized data; no candidate update occurred. A changed payload uses a new operation ID.
- **409:** stale executor/candidate revision or operation ID reused with different input. Fetch current state and reconcile.
- **423 External access paused:** the response says, `External task access is paused. Ask the owner to reopen this document in Mote, then continue with the same task URL. Your task and candidates are retained.` Stop task requests and ask the owner to reopen it; then fetch the current manifest/candidate records and resume with the same task URL. The pause does not rotate the token. Never use an agent keepalive.
- **404:** the grant or resource is permanently revoked or unavailable. Stop; do not try another token or route.

External task access is not an agent keepalive. Authenticated owner activity indicating the document is open renews a persisted 24-hour access window. Agent reads and submissions do not renew it. After 24 hours without owner-open activity, all external task resources and mutations pause; reopening the document resumes the same grant unless it was permanently revoked. Acceptance, explicit release, executor switch, task/document deletion, and Private are permanent revocations. Public-share links are separate and unaffected by this agent-access window.

External grants use only `/a/<22-character-base64url-token>` (128 random bits). The public `/api/agent/` route is retired. The one-time credential rollout invalidates earlier external links, including earlier short links: ask the owner to copy the replacement from the same reservation. Task contents, candidates, and pause windows are preserved; do not recreate the task or restart generation merely to obtain access. A short route or public skill file is not proof of an active task grant.
