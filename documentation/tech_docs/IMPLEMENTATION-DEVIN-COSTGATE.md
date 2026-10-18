---
type: Implementation Plan
title: Devin sandbox provider, cost gate and decision report
description: Build plan, contracts and acceptance tests for the devin sandbox provider, the cost gate (core/cost.mjs) and the decision report, written so the implementer can build it without further questions and the team can check it was built as specified.
tags: [implementation, devin, sandboxes, cost-gate, decision-report]
timestamp: 2026-10-18T00:00:00Z
---

# Implementation plan: Devin provider, cost gate, decision report

**Audience:** the implementer. **Status:** to build. Background: [ARCHITECTURE.md](./ARCHITECTURE.md) §7 and §9, [PLUGIN-STRUCTURE.md](./PLUGIN-STRUCTURE.md) §3, §5 and §7, [DEVIN.md](../infrastructure/DEVIN.md).

This plan covers three parts and nothing else:

- **A.** `sandboxes/devin/`: the default sandbox provider, Devin API v3.
- **B.** `core/cost.mjs`: estimates, ledger, cost gate.
- **C.** Decision report: template, schema, `report-writer` agent, `/padakan:decide`.

Everything here must ship with tests. Section D lists what has to pass for each part to count as done. That list is how the team checks the work without reading every line.

## 0. Ground rules (apply to all three parts)

1. **Node 22, zero dependencies.** Use the built-in `fetch`, `node:test`, `node:fs/promises` and `node:crypto`. Do not add npm packages. JSON Schema validation goes in a small local validator, `core/schema.mjs`, which only needs to cover the subset our schemas use: `type`, `required`, `enum`, `properties`, `items`, `additionalProperties`, `minimum` and `pattern`.
2. **Secrets.** `DEVIN_API_KEY` is never logged, written to the records folder, put in a prompt, or included in an error message. Every HTTP error is passed through `redact()` before it is thrown.
3. **Single writer.** Only the orchestrator writes `state.json`, `audit/chain.jsonl`, `cost/ledger.jsonl` and `index.md`. Provider code returns data and never writes those files.
4. **Deterministic gate.** The cost gate decision is plain arithmetic on numbers. No model is called inside `core/cost.mjs`.
5. **OKF.** Every markdown file written (briefs, decision reports, records) has frontmatter with `type`, `title`, `description`, `tags` and `timestamp`.
6. **Never trust the report.** Session `status` alone never means "done". "Done" requires the effect on GitHub: a branch, a commit and a PR.

---

## A. Devin sandbox provider

### A.1 Files

```
sandboxes/
├── index.mjs                  gateway (exists in the plan); add capability flags, see A.3
├── contract.mjs               shared validation; add the capability list
└── devin/
    ├── provider.mjs           the verbs (A.3)
    ├── client.mjs             HTTP client for api.devin.ai/v3 (A.2)
    ├── state.mjs              Devin status -> Padakan tree state (A.5)
    ├── answers.mjs            rule-based replies to Devin's questions (A.7)
    ├── prompt.mjs             renders the session prompt from the brief (A.6)
    ├── schemas/report.json    structured output schema (A.6)
    ├── blueprint.yaml         template for the target repo's .devin/blueprint.yaml (A.10)
    ├── doctor.mjs             onboarding checks (A.11)
    └── README.md              setup: service user, org id, permissions, Computer Use
test/
├── helpers/mock-devin.mjs     a local node:http server that imitates the v3 endpoints below
├── devin-client.test.mjs
├── devin-provider.test.mjs
└── sandbox-contract.test.mjs  runs the shared contract against every provider
```

### A.2 HTTP client (`client.mjs`)

Base URL is `DEVIN_API_URL`, default `https://api.devin.ai/v3`. Auth header: `Authorization: Bearer ${DEVIN_API_KEY}`. All paths are under `/organizations/${DEVIN_ORG_ID}`. In the table, `{id}` is the `session_id` returned by create (prefix `devin-`). The API reference names this path slot `{devin_id}`; it is the same value.

| Function | Method and path | Used by |
|---|---|---|
| `self()` | `GET /self` (no org prefix) | doctor |
| `createSession(body)` | `POST /sessions` | `create` |
| `getSession(id)` | `GET /sessions/{id}` | `status`, `poll`, `spend` |
| `listSessions({tags})` | `GET /sessions` | `ls`, orphan cleanup |
| `listMessages(id, cursor)` | `GET /sessions/{id}/messages` | `poll` (answering questions) |
| `sendMessage(id, text)` | `POST /sessions/{id}/messages` (resumes a suspended session) | `brief` follow-ups, `retire`, `resume` |
| `listAttachments(id)` | `GET /sessions/{id}/attachments` | `evidence`, `retire` |
| `uploadAttachment(file)` | `POST /attachments` (org-level, multipart/form-data; there is no session-level upload) | `brief` |
| `download(url, dest)` | `GET <attachment url>` | `evidence` |
| `archiveSession(id)` | `POST /sessions/{id}/archive` (puts it to sleep) | `pause`, `raiseBudget` |
| `terminateSession(id)` | `DELETE /sessions/{id}` (cannot be resumed) | `destroy` |
| `appendTags(id, tags)` | `POST /sessions/{id}/tags` | bookkeeping |

Behaviour:
- Timeout of 30 s per request, using `AbortSignal.timeout`.
- Retry `429` and `5xx` up to 4 times with exponential backoff and jitter (1 s, 2 s, 4 s, 8 s). Honour `Retry-After` if it is present. Never retry `4xx` other than `429`.
- Errors are thrown as `DevinError { status, title, detail, path }`. The API returns `ProblemDetail` JSON with `title`, `status` and `detail`; parse it.
- `400` on `platform` lists the valid platforms in its body. Surface that body as is, because it is the most useful error the user can get.

### A.3 Provider verbs and the adapted contract

Devin is API-only: there is no shell, no file push and no herdr. The current shared contract (PLUGIN-STRUCTURE §7) assumes shell access, so it gets **capability flags**. Each provider exports `capabilities`, and the contract test skips verbs a provider does not declare.

```js
export const name = 'devin';
export const capabilities = ['create', 'brief', 'status', 'poll', 'message', 'pause', 'resume',
  'raiseBudget', 'evidence', 'retire', 'destroy', 'url', 'spend'];
// not supported: bootstrap, seed, exec, push, pull, attach-to-pane
```

Calling a verb that is not declared throws `UnsupportedVerb`. It must not fail silently.

| Verb | Devin implementation | Returns |
|---|---|---|
| `create(id, {repo, branch, base, task, manifest, budget})` | Claim the handle file first; delete it if creation fails. Call `cost.gate()` (part B) with the session estimate **before** calling the API. If allowed, call `createSession` with the body in A.4. | handle (A.8) |
| `brief(id, briefPath)` | Upload the OKF brief with `uploadAttachment` and add its URL to `attachment_urls` at create time. `create` and `brief` are therefore combined: `brief` is called by `create`, and calling it alone on a running session sends the brief as a message. | `{ok}` |
| `status(id)` | `getSession`, then map with `state.mjs` | `ready \| working \| waiting \| paused \| done \| failed \| gone` |
| `poll(id)` | One poll tick (A.5): read the session, answer questions (A.7), read the effect on GitHub, update spend. | `{state, report, prs, acus, effect}` |
| `message(id, text)` | `sendMessage` | `{ok}` |
| `pause(id)` | `archiveSession`. Used only by the cost gate. | `{state:'paused'}` |
| `resume(id, text)` | `sendMessage` (resumes automatically) | `{state}` |
| `raiseBudget(id, {cap_acu, decision})` | Continue a capped tree under a higher cap that the human approved (B.6). The API cannot change `max_acu_limit` on a live session, so: (1) `archiveSession` on the capped session if it is not already asleep; (2) `createSession` with the same repo, branch, tags and schema, `max_acu_limit = cap_acu`, and a continuation prompt (A.6); (3) return the new `session_id`. The old one goes into `previous_session_ids`. Refuse if there is no `decision` id: a raise always comes from an answered decision report. | new handle fields |
| `url(id)` | the session `url` (where the human watches) | string |
| `evidence(id, key)` | Find the recording attachment (A.9), download it into `<records>/tasks/<KEY>/evidence/devin/`, and assert the file exists and is larger than 0 bytes. | `{video, files[]}` |
| `retire(id, key)` | Send the retire message (A.6), poll until `structured_output.record` has all 7 sections or 15 min pass, write `record.md`, then `archiveSession`. | `{record, sections}` |
| `destroy(id, {force})` | Refuse unless the PR's head SHA exists on the remote, or `force` is set. Then `terminateSession` and delete the handle. | `{destroyed}` |
| `spend(id)` | `getSession().acus_consumed` | `{acus}` |

### A.4 Create-session body

```json
{
  "prompt": "<rendered by prompt.mjs, A.6>",
  "title": "PAD-12 · Export the dashboard as CSV",
  "repos": ["<owner>/<repo>"],
  "platform": "<DEVIN_PLATFORM, or manifest.platform when the resolver set one>",
  "tags": ["padakan", "task:PAD-12", "run:<run id>"],
  "max_acu_limit": "<integer from cost.sessionCap(), B.5>",
  "bypass_approval": true,
  "resumable": true,
  "playbook_id": "<DEVIN_PLAYBOOK_ID if set>",
  "secret_ids": ["<ids listed in the manifest>"],
  "attachment_urls": ["<uploaded brief url>"],
  "structured_output_schema": "<contents of schemas/report.json>",
  "structured_output_required": true,
  "devin_mode": "<DEVIN_MODE if set, otherwise omitted>"
}
```

- `resumable: true` is required, because pause and resume depend on it.
- Pass secrets with `secret_ids` (secrets stored in the Devin org), never inline. `session_secrets` is allowed only for per-run values the orchestrator generated, such as a fresh test identity.
- **Parallelism:** the orchestrator runs at most `PADAKAN_MAX_TREES` sessions at once. Enforce it in `sandboxes/index.mjs` by counting live handles, not inside the provider.

### A.5 Status mapping (`state.mjs`) and the poll tick

Devin `status` is one of `new`, `claimed`, `running`, `exit`, `error`, `suspended` or `resuming`. `status_detail` refines it.

| Devin `status` / `status_detail` | Padakan state | Orchestrator action |
|---|---|---|
| `new`, `claimed`, `resuming` | `ready` | keep polling |
| `running` / `working` | `working` | keep polling; check spend (B.6) |
| `running` / `waiting_for_user` | `waiting` | answer by rule (A.7) |
| `running` / `waiting_for_approval` | `waiting` | should not happen with `bypass_approval`; reply "approved, proceed" once, then escalate |
| `running` / `finished` | `done?` | **verify the effect** (below) before counting it as done |
| `exit` | `done?` | same as above |
| `suspended` / `usage_limit_exceeded`, `user_usage_limit_exceeded`, `org_usage_limit_exceeded` | `paused` | **cost gate trigger** (B.6) |
| `suspended` / `out_of_credits`, `out_of_quota`, `no_quota_allocation`, `payment_declined`, `contract_expired`, `total_session_limit_exceeded` | `failed` | escalate as an account problem; do not retry |
| `suspended` / `inactivity` | `waiting` | send a nudge once; after a second inactivity, escalate |
| `suspended` / `user_request` | `paused` | Padakan paused it (or a human did); leave it |
| `error`, or `suspended` / `error` | `failed` | recycle once (a new session from the remote branch), then escalate |

**Poll tick** (every `DEVIN_POLL_SECONDS`, default `30`):
1. Call `getSession`. Record `status`, `status_detail`, `acus_consumed`, `pull_requests` and `structured_output`.
2. If `waiting`, run A.7.
3. Run the cost check (B.6) with the new `acus_consumed`.
4. Check the **effect**: for every `pull_requests[].pr_url`, run `gh pr view --json headRefOid,state,statusCheckRollup` and confirm the head commit exists on the remote.
5. Count the state as `done` only when all three hold: the structured output validates against `report.json`, a PR exists, and its head commit is on the remote. Any of them missing after 10 min in `done?` counts as a failed check.

### A.6 Prompt, structured output and the retire message

`prompt.mjs` builds the prompt from the brief:

```
You are working on task <KEY> in <owner>/<repo>. The full brief is attached (<brief file name>).
Rules:
- Never ask questions. If something is unclear, choose the conservative option, write the choice in
  the PR description, and continue. If you truly cannot continue, finish with blocked set.
- Work on branch padakan/<KEY>. Open exactly one PR against <base>. No AI attribution in commits.
- Do not touch: <PADAKAN_PROTECTED_PATHS>. Do not add or change dependencies unless the brief allows it.
- After opening the PR, test the change end to end with a screen recording (testing mode) following
  the acceptance criteria in the brief, and attach the recording.
- Finish by calling structured output with the report described in the schema.
```

`schemas/report.json` holds the machine-readable form of the `CI= PR= ACS= EVIDENCE= BLOCKED=` line:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["task", "pr_url", "branch", "acs", "evidence", "blocked"],
  "additionalProperties": false,
  "properties": {
    "task":     { "type": "string", "pattern": "^[A-Z]+-[0-9]+$" },
    "pr_url":   { "type": "string" },
    "branch":   { "type": "string" },
    "head_sha": { "type": "string" },
    "ci":       { "type": "string", "enum": ["pass", "fail", "pending", "none"] },
    "acs": {
      "type": "array",
      "items": {
        "type": "object", "required": ["id", "verdict"],
        "properties": {
          "id": { "type": "string", "pattern": "^AC[0-9]+$" },
          "verdict": { "type": "string", "enum": ["pass", "fail", "not_exercised"] },
          "note": { "type": "string" }
        }
      }
    },
    "evidence": { "type": "array", "items": { "type": "string" } },
    "blocked":  { "type": ["string", "null"] },
    "record": {
      "type": "object",
      "required": ["what_changed", "files", "architecture", "seams", "next_step", "misreadings", "open"],
      "properties": {
        "what_changed": { "type": "string" }, "files": { "type": "string" },
        "architecture": { "type": "string" }, "seams": { "type": "string" },
        "next_step": { "type": "string" }, "misreadings": { "type": "string" },
        "open": { "type": "string" }
      }
    }
  }
}
```

**Continuation prompt** (used by `raiseBudget`), prepended to the normal prompt:

```
This continues task <KEY>. A previous session stopped at its budget cap. Do not start over:
check out branch padakan/<KEY> from the remote, read the open PR <pr_url> and its description,
and continue from there. Push to the same branch and update the same PR.
```

`record` is optional during the build and required at retire. The **retire message** asks Devin to fill `record` (the seven sections) and call structured output again. The orchestrator converts it to OKF `record.md`.

Everything in the structured output is a **claim**. `verifier` re-checks each part: the PR on GitHub, CI from `gh`, ACs against the evidence.

### A.7 Answering Devin by rule (`answers.mjs`)

Devin can still ask a question despite the prompt. On `waiting_for_user`, read the newest messages since the last cursor and match them against rules, in order:

| Pattern (case-insensitive) | Reply |
|---|---|
| asks to confirm a plan, test plan or approach | "Approved. Proceed without asking again." |
| asks for a secret, credential or login | if the manifest lists it: "It is available as secret `<name>`." Otherwise escalate (`BLOCKED=missing-secret`) |
| asks which option to choose | "Choose the most conservative option, note it in the PR, continue." |
| anything else | the same conservative reply, **once**. A second question in the same session escalates. |

Every question and reply is returned to the orchestrator so it goes into the audit trail. The provider never escalates by itself; it returns `{escalate: reason}` and lets the orchestrator decide.

### A.8 Handle (`<records>/sandboxes/<id>.json`)

```json
{
  "id": "pad-12-a1b2", "provider": "devin", "task": "PAD-12",
  "session_id": "devin-…", "url": "https://app.devin.ai/sessions/devin-…",
  "repo": "owner/repo", "branch": "padakan/PAD-12", "base_sha": "<full sha>",
  "platform": "linux", "max_acu_limit": 20,
  "created_at": "<ISO>", "state": "working", "acus_last": 7.5,
  "previous_session_ids": [], "acus_previous": 0,
  "questions_answered": 1, "message_cursor": "<cursor>"
}
```

After a `raiseBudget`, the task's total spend is `acus_previous + acus_last`. `acus_previous` is the final `acus_consumed` of every session in `previous_session_ids`.

The handle is written by the orchestrator from the provider's return value. The provider never writes it. Its schema is `schemas/sandbox-handle.json`, which gains the optional fields `session_id`, `url` and `max_acu_limit`.

### A.9 Evidence from Devin

- After the PR, Devin's testing mode sends a screen recording as an attachment. In `listAttachments`, pick attachments whose name ends in `.mp4`, `.webm` or `.mov`. If there are several, take the newest.
- No recording, or Computer Use not enabled: return `{video: null}`. `evidence-builder` then falls back to our own Playwright recording, or marks evidence item 1 missing, which is a failed check. Never pass without a video.
- Downloaded files keep their original names under `evidence/devin/`, plus a `manifest.json` with each file's sha256.

### A.10 Blueprint template (`blueprint.yaml`)

A starting `.devin/blueprint.yaml` that onboarding offers to commit to the target repo. Sections:
- `initialize`: Node 22, Playwright with browsers, `gh`.
- `maintenance`: install the repo's dependencies.
- `knowledge`: how to run lint, unit tests and e2e.
- `post-build`: a smoke check that tests run.

The blueprint carries **no secrets**. Committing it to the target repo is a human action at the plan gate.

### A.11 Doctor (`doctor.mjs`), run by `/padakan:onboard`

Each check prints `OK` or a one-line fix:
1. `DEVIN_API_KEY` is set and starts with `cog_`; `GET /self` returns 200.
2. `DEVIN_ORG_ID` is set, and a call to `GET /sessions` returns 200, which proves the `UseDevinSessions` permission. **Pending, for the implementer:** the query parameters of this endpoint (page size, tag filter) are not confirmed in our research. Check them against the "List Sessions" API page or the first live call, keep the request as small as the API allows, and record the result in `DEVIN.md`.
3. `DEVIN_PLATFORM` is accepted (a `400` on create lists the valid ones; doctor can probe with a dry config check instead of a session if that turns out to be possible).
4. Recordings: warn, but do not fail, that Computer Use must be enabled in org settings.
5. `PADAKAN_DEVIN_USD_PER_ACU` is set (needed by part B).

### A.12 Settings added to `.env.example`

| Variable | Default | Meaning |
|---|---|---|
| `DEVIN_API_URL` | `https://api.devin.ai/v3` | base URL |
| `DEVIN_API_KEY` · `DEVIN_ORG_ID` | | service-user token and org id |
| `DEVIN_PLATFORM` | `linux` | `linux` · `macos` · `windows`; the resolver may override per task |
| `DEVIN_MODE` | | optional `devin_mode`; empty uses the org default |
| `DEVIN_MAX_ACU` | | hard ceiling per session, whatever the budget says |
| `DEVIN_BYPASS_APPROVAL` | `true` | |
| `DEVIN_PLAYBOOK_ID` | | optional |
| `DEVIN_POLL_SECONDS` | `30` | poll interval |
| `DEVIN_CONTINUATION_MIN_ACU` | `2` | smallest raise worth starting a continuation session for; a smaller approved raise is rounded up to this (part of the decision report's numbers) |
| `PADAKAN_DEVIN_USD_PER_ACU` | | **required** for the cost gate; the team's real ACU price |

---

## B. Cost gate (`core/cost.mjs`)

### B.1 What it does

It answers one question before every costly step: is there budget for this? It also keeps an append-only ledger of what was spent. It does not talk to Devin, models or humans. Callers give it numbers, and it returns a decision.

### B.2 Units and prices

- The budget is in **USD**, using `PADAKAN_BUDGET_RUN_USD`, `PADAKAN_BUDGET_TASK_USD` and `PADAKAN_BUDGET_STEP_USD`.
- Native units are converted with a price table in `registry/prices.yml` (catalog data). For values that change per team, `.env` overrides the table:

| Unit | Source of price |
|---|---|
| Devin ACU | `PADAKAN_DEVIN_USD_PER_ACU` (required, no default; never guess a price) |
| Nebius tokens (per model, in/out per 1M) | `registry/prices.yml` |
| CI minutes, device minutes | `registry/prices.yml` (may be 0) |

### B.3 Estimates

The capability resolver writes estimates into each manifest item as a **range**:

```json
{ "step": "devin-session", "unit": "acu", "low": 4, "likely": 8, "high": 15, "required": true }
```

`required: true` marks steps that can never be skipped for cost: the build session, the task's tests, the regression suite and diff inspection. Optional examples: the device probe, the video recording, a browser matrix, a second e2e run on staging. The gate compares budgets against **`high`**, the worst case. `likely` is only shown in reports.

### B.4 API

```js
estimate(item, prices)             // -> { low_usd, likely_usd, high_usd }
budgetLeft(ledger, budgets, scope) // scope: { run, task } -> { run_usd, task_usd }
gate({ item, ledger, budgets, prices, scope })
  // -> { decision: 'run' | 'pause', reason, estimate, left, cheapest_cap_usd }
record(entry)                      // returns the JSONL line; the orchestrator appends it
sessionCap({ item, ledger, budgets, prices, scope, hardMax })
  // -> integer max_acu_limit for a Devin session (B.5)
```

`gate` rules, in order:
1. If `high_usd > PADAKAN_BUDGET_STEP_USD`, return `pause` with reason `step-cap`.
2. If `high_usd > task_left`, return `pause` with reason `task-cap`.
3. If `high_usd > run_left`, return `pause` with reason `run-cap`.
4. Otherwise return `run`.

An unset budget means no cap at that level. A missing price for a unit means `pause` with reason `no-price`, because the gate never assumes something is free.

### B.5 Devin session cap

`max_acu_limit` makes Devin stop by itself at the budget, so overspend cannot happen even if Padakan crashes.

```
cap_usd = min(step_cap, task_left, run_left)
max_acu_limit = floor(min(cap_usd / USD_PER_ACU, DEVIN_MAX_ACU or Infinity))
```

If `max_acu_limit < item.low`, the session cannot finish even in the best case, so do not create it. Return `pause` with reason `cap-below-low`, which leads to a decision report.

### B.6 During a session

- Every poll tick writes the change in `acus_consumed` to the ledger, as `kind: "spend"`.
- At **80 %** of `max_acu_limit`, write a `warn` ledger entry. There is no human prompt.
- When Devin suspends with `usage_limit_exceeded` (or the user or org variants), the cap was hit. Mark the tree `paused`, spend nothing more, and have `report-writer` produce a decision report (part C) with reason `session-cap-hit`. Other trees keep running.
- **Raise the budget** is a provider capability, `raiseBudget` (A.3). The v3 API sets `max_acu_limit` only at create and has no endpoint to update a session. So a raise always archives the capped session and starts a continuation session on the same branch and PR, with the new cap. The flow:
  1. The human answers `raise:<usd>` (or `approve`) on the decision report (C.2).
  2. The orchestrator writes the new budget to `<records>/.env` and calls `cost.gate()` again. The step's estimate is now the **remaining** work: `high` minus what was already spent, but never below `DEVIN_CONTINUATION_MIN_ACU`.
  3. If the gate returns `run`, call `cost.sessionCap()` for the new `max_acu_limit`, then `provider.raiseBudget(id, {cap_acu, decision})`.
  4. The ledger gets a `decision` line (the raise) and later `spend` lines tagged with the new `session_id`. The task total sums across all sessions (A.8).
  5. If the gate still returns `pause` (for example the run cap is also hit), a new decision report is written. There are no loops without a human answer.
- A provider without `raiseBudget` (for example `local`) never sees a raise. `raise:<usd>` then only updates the budget, and the paused step is run again from `create`.

### B.7 Ledger (`<records>/cost/ledger.jsonl`)

One JSON object per line. Append only. Written only by the orchestrator.

```json
{"ts":"<ISO>","run":"r-20261018-1","task":"PAD-12","step":"devin-session","kind":"estimate","unit":"acu","low":4,"likely":8,"high":15,"usd_high":"<n>"}
{"ts":"<ISO>","run":"r-20261018-1","task":"PAD-12","step":"devin-session","kind":"gate","decision":"run","left_task_usd":"<n>"}
{"ts":"<ISO>","run":"r-20261018-1","task":"PAD-12","step":"devin-session","kind":"spend","unit":"acu","qty":2.5,"usd":"<n>","source":"acus_consumed"}
{"ts":"<ISO>","run":"r-20261018-1","task":"PAD-12","step":"device-probe","kind":"gate","decision":"pause","reason":"task-cap","decision_report":"decisions/D-0003.md"}
```

`kind` is one of `estimate`, `gate`, `spend`, `warn` or `decision`. Each line also gets an audit chain entry, written by the orchestrator through `core/audit.mjs`.

### B.8 Never waived

`gate` never returns `skip`. Only a human can choose skip, in part C. If a `required` step pauses, the decision report must **not** offer "skip". It offers only approve, raise the budget, or abort. A skipped optional step sets `auto_ship=false` on the task, so the change goes to a human to merge.

---

## C. Decision report

### C.1 Files

```
templates/decision-report.md       OKF template (C.3)
schemas/decision-report.json       front-matter schema
schemas/decision-answer.json       the human's answer
agents/report-writer.md            sub-agent that fills the template from the gate output
commands/decide.md                 /padakan:decide <D-id> <approve|cheaper:<option>|skip|raise:<usd>|abort>
skills/cost-gate/SKILL.md          when and how to read the gate's output
```

### C.2 Flow

```
gate → pause → orchestrator dispatches report-writer (gate JSON + manifest item + ledger summary)
     → report-writer writes <records>/decisions/D-<nnnn>.md, returns DECISION=<path>
     → orchestrator: tree state = paused, audit entry, log.md line, optional Linear comment on the task issue
     → human runs /padakan:decide D-<nnnn> <answer>
     → orchestrator validates the answer, writes decisions/D-<nnnn>.answer.json, audit entry, acts:
         approve        → run the step once with a one-off allowance equal to high_usd (ledger kind "decision")
         cheaper:<opt>  → run the chosen option instead (it is gated again)
         skip           → optional steps only; mark auto_ship=false, continue
         raise:<usd>    → write the new budget to <records>/.env, gate again; if the paused step is a
                          capped Devin session, call provider.raiseBudget (continuation session, B.6)
         abort          → retire the tree, escalate the task
     → no answer: the tree stays paused indefinitely; nothing is spent; other trees continue
```

### C.3 Template (`templates/decision-report.md`)

```markdown
---
type: Decision Report
title: D-0003 · PAD-12 · device probe over task budget
description: <one sentence: what is paused and what is being asked>
id: D-0003
task: PAD-12
step: device-probe
reason: task-cap | step-cap | run-cap | session-cap-hit | cap-below-low | no-price
required: false
status: open | answered
timestamp: <ISO>
---

# D-0003 · <step> for <task> is over budget

## What
The step and the task it belongs to.

## Why it matters
The claim this step proves and the risk it covers.

## Cost
| | Low | Likely | High |
|---|---|---|---|
| This step | $ | $ | $ |

Budget left: task $<n> of $<n> · run $<n> of $<n>. Spent so far on this task: $<n> (link to ledger lines).

## Options
| Option | Cost (high) | What it leaves uncovered |
|---|---|---|
| approve | $ | nothing |
| cheaper: <name> | $ | <gap> |
| skip *(optional steps only)* | $0 | <what stays unverified>; change will not auto-ship |
| raise budget | | |
| abort | $0 | task escalated to a human |

## If skipped
What stays unverified, in one paragraph.

## Recommendation
One option and why, in two sentences.

## Answer
`/padakan:decide D-0003 <approve | cheaper:<name> | skip | raise:<usd> | abort>`
```

### C.4 Rules for `report-writer`

- It uses only numbers it receives from the gate JSON and the ledger. It never estimates by itself.
- If `required: true`, it leaves out the **skip** row.
- "Cheaper" options come only from alternatives listed in the manifest item (`alternatives[]`, each with its own estimate and `uncovered` text). It never makes options up.
- It returns exactly `DECISION=<path>`. Any other output counts as a failed dispatch.
- The orchestrator runs `core/okf.mjs` on the file before showing it.

### C.5 Answer validation (`commands/decide.md` → `orchestrator/decide.mjs`)

- `D-id` must exist with `status: open`. Otherwise refuse with a clear message.
- `skip` on a `required: true` decision is refused.
- `raise:<usd>` must be a positive number. It writes `PADAKAN_BUDGET_TASK_USD` (or the cap named in `reason`) to `<records>/.env`.
- After acting, set `status: answered` in the report frontmatter and write the answer JSON:

```json
{ "id": "D-0003", "answer": "cheaper", "option": "web-only-probe", "by": "<git user>", "ts": "<ISO>" }
```

---

## D. Definition of done (what the team checks)

The implementer delivers each part with these tests passing under `node --test`. Every test runs against `test/helpers/mock-devin.mjs`, never the real API, except the live checks in D.4.

### D.1 Devin provider

| # | Test |
|---|---|
| P1 | `createSession` sends every field in A.4; the body contains no secret values; `max_acu_limit` equals `sessionCap()` |
| P2 | client retries `429` and `503`, honours `Retry-After`, and gives up after 4 tries; it does not retry `400`, `401`, `403` or `404` |
| P3 | `DEVIN_API_KEY` never appears in any thrown error, log line or file under the records folder (grep the temp records folder in the test) |
| P4 | every row of the A.5 table maps to the right Padakan state (table-driven test) |
| P5 | `finished` without a PR, or with a PR whose head is not on the remote (mocked `gh`), is **not** `done` |
| P6 | structured output that fails `report.json` is a failed check |
| P7 | `waiting_for_user` with a plan-confirmation message gets the approval reply; a second unknown question returns `{escalate}` |
| P8 | `usage_limit_exceeded` returns `paused` with reason `session-cap-hit` |
| P9 | `evidence` downloads the newest video attachment and writes `manifest.json` with sha256; no video gives `{video:null}` |
| P10 | `retire` writes an OKF `record.md` with 7 sections and archives the session; with fewer than 7 sections after the timeout it fails |
| P11 | `destroy` refuses when the PR head is not on the remote, unless `force` |
| P12 | calling `exec`, `push` or `seed` on the devin provider throws `UnsupportedVerb` |
| P13 | the shared contract test passes for `devin` (declared verbs only) and still passes for `local` |
| P14 | `sandboxes/index.mjs` refuses to create more than `PADAKAN_MAX_TREES` live sessions |
| P15 | `raiseBudget` archives the capped session, creates exactly one new session with the same repo, branch and tags, the new `max_acu_limit` and the continuation prompt, and returns handle fields with the old id in `previous_session_ids`; without a `decision` id it refuses |
| P16 | after a raise, `spend` reports `acus_previous + acus_last`, and the cost gate uses that total |

### D.2 Cost gate

| # | Test |
|---|---|
| C1 | each of the four `gate` rules, plus the unset-budget and `no-price` cases (table-driven) |
| C2 | `gate` compares against `high`, never `likely` |
| C3 | `sessionCap` respects step, task, run and `DEVIN_MAX_ACU`, and returns `cap-below-low` when the cap is below `low` |
| C4 | ledger lines round-trip: `budgetLeft` computed from a written ledger matches the expected numbers |
| C5 | `gate` never returns `skip`; a `required` item cannot be waived |
| C6 | the 80 % warn entry is written exactly once per session |
| C7 | `core/cost.mjs` imports nothing from `core/models.mjs` or any network module (static import check) |

### D.3 Decision report

| # | Test |
|---|---|
| R1 | a paused gate produces `decisions/D-<nnnn>.md` that passes `core/okf.mjs` and `schemas/decision-report.json` |
| R2 | a required step's report has no skip option; `/padakan:decide … skip` on it is refused |
| R3 | each answer (approve, cheaper, skip, raise, abort) has the effect listed in C.2, a ledger `decision` line and an audit entry |
| R4 | answering an already answered or missing `D-id` is refused |
| R5 | with no answer, the paused tree spends nothing over several poll ticks while another tree keeps running |
| R6 | `raise:<usd>` writes the new cap to `<records>/.env`, not the plugin `.env` |
| R7 | `raise:<usd>` on a `session-cap-hit` decision re-gates on the remaining estimate and, on `run`, calls `raiseBudget` once; if the re-gate pauses, a new decision report is written and no session is created |

### D.4 Live checks (one real Devin org, run by hand once, results noted in `DEVIN.md`)

1. Create a session with `structured_output_schema` and confirm `structured_output` arrives on `GET`.
2. Set `max_acu_limit` low and confirm which `status_detail` appears when it is hit (expected `usage_limit_exceeded`).
3. Run `raiseBudget` once for real: confirm the continuation session picks up the existing branch and PR instead of starting over (B.6). The API reference has no endpoint to update `max_acu_limit` on a live session; if one appears later, `raiseBudget` can use it instead.
4. Confirm testing mode attaches a video and what its filename and extension look like.
5. Confirm `archive` and then `sendMessage` resumes the session with its VM state.
6. Run two sessions in parallel against two tasks, which shows the "parallel Devin sessions" side challenge.
7. Android: an emulator session now has its own docs page (`onboard-devin/environment/android-emulation`). Try it once and update ARCHITECTURE §5.
8. **Pending, the implementer decides:** confirm the query parameters of `GET /sessions` used by the doctor (A.11, check 2) and the body field of `POST /sessions/{id}/messages`. Record both in `DEVIN.md`.

---

## E. Build order

1. `core/schema.mjs`, `core/cost.mjs` and its tests (C1 to C7). These have no external dependencies, so they are the fastest to prove.
2. `sandboxes/devin/client.mjs` and `test/helpers/mock-devin.mjs` (P1 to P3).
3. `state.mjs`, `answers.mjs`, `prompt.mjs` and `schemas/report.json` (P4 to P8).
4. `provider.mjs` verbs, the capability flags in the gateway, and the contract test (P9 to P14).
5. Decision report template, schemas, `report-writer`, `/padakan:decide` (R1 to R6).
6. `doctor.mjs`, `.env.example` rows, `README.md`.
7. Live checks (D.4), then update `DEVIN.md` with the results.

## F. Documentation to update when this lands

- `PLUGIN-STRUCTURE.md` §3, §5 and §7: **already synced** with this plan and the API reference (capability flags, Devin verbs including `raiseBudget`, Devin files, settings). Add `DEVIN_CONTINUATION_MIN_ACU` to §5 once its default is settled.
- `ARCHITECTURE.md` §9: describe `max_acu_limit` as a hard stop and the `session-cap-hit` path.
- `DEVIN.md`: the differences from the API reference are **already listed** in its "Differences found against the live API reference" section. After D.4, add the live results there, without rewriting the original sections.
- `README.md`: the "watched live in herdr" line becomes "watched live in the Devin web app (or herdr for non-Devin trees)".
