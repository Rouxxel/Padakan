---
type: Guide
title: Devin sandbox provider
description: How to set up and run Padakan's default sandbox provider, one Devin session per tree, driven only through the Devin API v3.
tags: [sandboxes, devin, setup]
timestamp: 2026-10-18T00:00:00Z
resource: https://docs.devin.ai/api-reference/overview
---

# Devin sandbox provider

Every Padakan tree is one Devin session in a fresh VM booted from the organization's snapshot. Devin is the agent: Padakan drives it only through the API (prompt, messages, structured output, attachments). There is no shell, no file push and no herdr inside, so the shell verbs (`bootstrap`, `seed`, `exec`, `push`, `pull`, `attach`) are not supported and throw `UnsupportedVerb`.

Design and acceptance tests: [IMPLEMENTATION-DEVIN-COSTGATE.md](../../documentation/tech_docs/IMPLEMENTATION-DEVIN-COSTGATE.md). API research and the differences found against the API reference: [DEVIN.md](../../documentation/infrastructure/DEVIN.md).

## Setup

1. **Service user.** In Devin, create a service user for the organization with the **UseDevinSessions** permission. Its token starts with `cog_`.
2. **Settings** in `<records>/.env` (never in the repo; see `.env.example` for all of them):

   | Setting | Value |
   |---|---|
   | `PADAKAN_SANDBOX_PROVIDER` | `devin` (the default) |
   | `DEVIN_API_KEY` | the service-user token (`cog_…`) |
   | `DEVIN_ORG_ID` | the org id (`org-…`, shown in Settings > Devin API) |
   | `PADAKAN_DEVIN_USD_PER_ACU` | your real ACU price. **Required**: the cost gate pauses rather than guess |
   | `DEVIN_MAX_ACU` | optional hard ceiling for any session's `max_acu_limit` |
   | `DEVIN_PLATFORM` | `linux` (default), `macos`, `windows`, or an Outpost pool name |
   | `DEVIN_MODE` · `DEVIN_PLAYBOOK_ID` | optional |
   | `PADAKAN_BUDGET_RUN_USD` · `_TASK_USD` · `_STEP_USD` | budget caps; the session cap is computed from what is left |

3. **Computer Use** must be enabled in the org settings for Devin to record its end-to-end test video (evidence item 1).
4. **Blueprint.** Copy [blueprint.yaml](./blueprint.yaml) to the target repository as `.devin/blueprint.yaml`, replace the `<...>` commands, and commit it (a human step at the plan gate). Devin builds the snapshot from it.
5. **Check:** `node bin/padakan doctor`. The `devin.*` lines check the token (`GET /self`), the permission (`GET /sessions`), the platform, the ACU price and remind you about Computer Use.

## How a tree runs

| Step | What the provider does |
|---|---|
| `create` | runs the cost gate and computes `max_acu_limit` from the budget left (nothing is spent if it pauses), uploads the brief, starts the session with the structured-output schema `schemas/report.json` |
| `poll` | maps the session status to a tree state, answers Devin's questions by rule (`answers.mjs`), returns spend and the 80 % warning as ledger lines, and counts the session done only when its report validates, a PR exists and the PR head is on GitHub |
| `pause` / `resume` | archive (the session sleeps) / a message (it wakes up) |
| `raiseBudget` | after a human `raise` or `approve` on a decision report: archives the capped session and starts one continuation session on the same branch and PR with the new cap (the API cannot change a live session's cap) |
| `evidence` | downloads the session's attachments into `<records>/tasks/<KEY>/evidence/devin/` with a sha256 `manifest.json`; the newest video is evidence item 1 |
| `retire` | asks for the seven-section record, writes `record.md` (OKF), archives the session |
| `destroy` | refuses unless the PR head is on GitHub (or `force`), then terminates the session |

Watch a tree live at its session URL (`padakan attach <KEY>` prints it).

## When something breaks

| Symptom | Cause and fix |
|---|---|
| `DECISION=…` instead of a session | the cost gate paused: answer the report with `/padakan:decide` |
| doctor `devin.api-key fail … 401` | wrong or revoked token |
| doctor `devin.sessions fail … 403` | the service user lacks UseDevinSessions |
| create fails with `400` listing platforms | `DEVIN_PLATFORM` is not a platform or pool of this org; pick one from the list |
| tree `paused`, reason `session-cap-hit` | the session reached `max_acu_limit`; a decision report is opened |
| tree `failed`, reason `account:out_of_credits` (or quota, payment) | an account problem; Padakan escalates and never retries |
| `evidence` returns no video | Computer Use is off, or Devin did not run testing mode; the fallback is our own Playwright recording |

## Tests

`test/devin-client.test.mjs`, `test/devin-logic.test.mjs`, `test/devin-provider.test.mjs` and `test/devin-doctor.test.mjs` run against `test/helpers/mock-devin.mjs`, never the real API. The live checks still to run once against a real org are listed in IMPLEMENTATION-DEVIN-COSTGATE.md D.4.
