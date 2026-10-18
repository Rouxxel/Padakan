---
type: Research
title: Devin as Padakan's sandbox provider
description: What the Devin API and Devin's cloud environment provide for Padakan's trees, how our lifecycle maps onto it, and what it does not cover.
resource: https://docs.devin.ai/api-reference/overview
tags: [devin, sandboxes, research]
timestamp: 2026-10-18T00:00:00Z
---

# Devin as Padakan's sandbox provider

Research from Devin's public docs (October 2026). Nothing here has been tried against a live Devin organization yet; items marked **verify** need a test session before we rely on them.

## Verdict

Devin covers most of what we were going to build on Daytona: a VM per task booted from a prebuilt snapshot, macOS VMs with Xcode and the iOS Simulator, a desktop with recorded end-to-end testing, MCP servers, secrets, scheduled runs and a full REST API. It also loads Claude Code plugins, so Padakan's skills and MCP servers can run inside Devin sessions.

The trade-off: in a Devin session **Devin is the agent**. We drive it through the API (prompt, messages, structured output), not through a shell or herdr, and our plugin hooks do not run in cloud sessions. Our confidence still comes from the orchestrator's own gates on the PR, CI and evidence, which is where it was meant to come from anyway.

**Recommendation:** make `devin` the default sandbox provider. Keep `local` for development, and keep `daytona` as an option for running Claude Code or another agent in a sandbox we control.

## What Devin provides

### A VM per session, from a snapshot we define
- Every session boots a fresh copy of the organization's **snapshot**: a VM with the repos cloned, tools installed and dependencies resolved. Session changes never write back to the snapshot.
- The snapshot is built from **blueprints**, YAML files that work like a Dockerfile: `initialize` (tools, runtimes, can use GitHub Actions), `maintenance` (dependencies), `knowledge` (how to lint, test, build; never executed), `post-build` (health checks that fail the build), `clone` (branch, depth, submodules, LFS).
- Blueprints exist at enterprise, organization and repository level and stack. A repository can keep its blueprint in git at `.devin/blueprint.yaml`. Builds run when a blueprint changes and about every 24 hours.
- One active snapshot per organization; all configured repos live in it.
- Builds can be driven by API: the beta `/v3beta1/organizations/{org_id}/snapshot-setup` endpoint creates a repo blueprint and triggers a build. **verify**

### Platforms: Linux, macOS, Windows
- `runs-on` in a blueprint (`default`/`linux`, `macos`, `windows`) builds one snapshot per platform. A session picks one with `platform` in the API.
- **macOS VMs** ship with Xcode 26 (and the 27 prerelease), one iOS Simulator runtime per Xcode with a preconfigured iPhone, `xcodebuild`, `xcrun simctl`, Homebrew, Node, Python, Java, Rust, `gh`, `ffmpeg` and Chrome. The docs say macOS sessions currently cost the same as Linux (launch pricing).
- This removes the gap we had: iOS simulators could not run in a Linux sandbox. The docs call iOS support "the Apple equivalent of Android emulator support"; Android emulator details still need checking. **verify**

### Computer Use and recorded testing
- Every platform has a full desktop (mouse, keyboard, screenshots, Chrome; the iOS Simulator on macOS).
- After opening a PR, Devin can enter a **testing mode**: plan one end-to-end flow, record the screen with annotations and auto-zoom, and send the video as a message attachment. Computer Use must be enabled in the organization's settings.
- Attachments are listed and downloaded through the API, so the video becomes item 1 of our evidence pack.

### Plugins, skills and MCP servers
- Devin plugins bundle skills, rules, hooks, MCP servers and subagents, at personal, organization or enterprise scope, or declared by a repository in `.devin/config.json`.
- **Devin loads Claude Code plugins:** when there is no `.devin-plugin/plugin.json`, it reads `.claude-plugin/plugin.json`, honors `.mcp.json`, and expands `${CLAUDE_PLUGIN_ROOT}`.
- In **cloud sessions**: skills, rules (`AGENTS.md`, `rules/`) and MCP servers apply. **Hooks and plugin subagents run only in the Devin CLI and Desktop**, and hooks are best effort (fail open).
- Custom MCP servers over stdio, SSE or HTTP; a marketplace with Linear, Sentry, Datadog, Vercel, Notion, databases and more.

### API (v3, service-user token `cog_…`)
| Need | Endpoint or field |
|---|---|
| Start a tree | `POST /v3/organizations/{org_id}/sessions` with `prompt`, `repos`, `platform`, `playbook_id`, `knowledge_ids`, `secret_ids`, `session_secrets`, `tags`, `title`, `max_acu_limit`, `bypass_approval`, `resumable`, `attachment_urls`, `security_profile` |
| Typed result | `structured_output_schema` (JSON Schema draft 7, up to 64 KB) and `structured_output_required` |
| Watch it | `GET …/sessions/{devin_id}`: `status`, `status_detail`, `pull_requests`, `acus_consumed`, `structured_output`, `child_session_ids`, `url` (the live session in the web app) |
| Talk to it | `POST …/sessions/{devin_id}/messages` (resumes a suspended session); `GET …/messages` to read |
| Collect files | `GET …/sessions/{devin_id}/attachments`, then download each `url`; `POST …/attachments` to upload a brief |
| End it | `POST …/archive`, terminate, `DELETE` |
| Scheduled runs | Automations with a `schedule:recurring` trigger (iCalendar `RRULE`, UTC) and a `start_session` action (the older `/schedules` endpoints are deprecated) |
| Secrets, playbooks, knowledge | organization-scoped endpoints for each |
| Cost | `max_acu_limit` per session; `acus_consumed` on the session; enterprise ACU limits |

## How Padakan's tree lifecycle maps onto Devin

| Padakan step | With Devin |
|---|---|
| bake | Blueprints, ideally `.devin/blueprint.yaml` in the repo, built into the org snapshot; Padakan's verify kit (Playwright, MCP servers) goes in the blueprint or in the plugin |
| plant | `POST sessions` with the repo, platform (`linux` or `macos`), tags (`padakan`, task key), ACU cap, secrets, and the structured-output schema for the report line |
| attach | the session `url`; the human watches in Devin's web app, not in herdr |
| brief | the OKF brief uploaded as an attachment and referenced in the prompt |
| poll | session `status` and `pull_requests`, plus the effect on GitHub (branch, commits, CI), never the session status alone |
| verify | unchanged: our `core/` gates on the PR and CI |
| evidence | the testing-mode video from `attachments`; architecture, files and CI built by `evidence-builder` |
| merge | unchanged: the orchestrator, one at a time |
| retire | a message asking for the seven-section record as structured output or an attachment, pull it, then archive the session |
| monitor cron | our own cron, or a Devin Automation with an `RRULE` trigger |

## What Devin does not cover, and how we handle it

| Gap | Handling |
|---|---|
| Devin is always the agent; no Claude Code, no herdr inside | accepted for the `devin` provider; `daytona` stays available when we need our own agent |
| Plugin hooks do not run in cloud sessions | enforcement that matters stays outside the session: diff inspection, protected paths and the gates run in the orchestrator's `core/` |
| Devin may ask questions (it sends its test plan, asks for missing secrets) | `bypass_approval`, a brief that says never ask, secrets passed up front, and the orchestrator answering session messages by rule; anything it cannot answer is escalated |
| Cost is in ACUs | `max_acu_limit` per session, `acus_consumed` read into the cost ledger; the cost gate uses both |
| One active snapshot per organization | all task repos share it; per-task differences go in the brief |
| Recordings depend on Computer Use being enabled | an onboarding check; without it, our own Playwright recording is the fallback |
| Android emulator support not confirmed | **verify** before relying on it; otherwise the Mac host runs device probes |

## Settings this adds to `.env`

| Variable | Default | Meaning |
|---|---|---|
| `PADAKAN_SANDBOX_PROVIDER` | `devin` | default provider |
| `DEVIN_API_KEY` · `DEVIN_ORG_ID` | | service-user token (`cog_…`) and org id |
| `DEVIN_PLATFORM` | `linux` | `linux` · `macos` · `windows`; the resolver can override per task |
| `DEVIN_MAX_ACU` | | per-session ACU cap |
| `DEVIN_BYPASS_APPROVAL` | `true` | no approval prompts inside sessions |
| `DEVIN_PLAYBOOK_ID` | | optional playbook carrying Padakan's standing instructions |

## Differences found against the live API reference (2026-10-18)

The sections above are kept as first written. A later check against the v3 API reference (OpenAPI pages for each endpoint) found these differences. Where they disagree, **the API reference wins**, and `tech_docs/PLUGIN-STRUCTURE.md` and `tech_docs/IMPLEMENTATION-DEVIN-COSTGATE.md` follow it.

| # | Topic | What this document says above | What the API reference says | Impact on Padakan |
|---|---|---|---|---|
| 1 | Session id | Paths use `{devin_id}`; the id field is not named | The create and get responses return **`session_id`** (prefix `devin-`). The path parameter is *named* `devin_id`, but its value is that `session_id` | Store `session_id` in the handle and put it in the `{devin_id}` path slot |
| 2 | Uploading a brief | `POST …/sessions/{devin_id}/attachments` to upload | Uploading is **org-level**: `POST /v3/organizations/{org_id}/attachments` (multipart/form-data). The session-level `…/sessions/{devin_id}/attachments` is **GET only** (list) | Upload the brief first, then pass its URL in `attachment_urls` when creating the session |
| 3 | Ending a session | "`POST …/archive`, terminate, `DELETE`" (reads as three actions) | There are **two**. **Archive** (`POST …/sessions/{devin_id}/archive`) sets `is_archived: true` and puts the session to sleep; a message resumes it, and `POST …/unarchive` reverses it. **Terminate** (`DELETE …/sessions/{devin_id}`, optional `?archive=true`) is final and cannot be resumed | `pause` = archive; `destroy` = terminate |
| 4 | Session states | Mentions `status` and `status_detail` without values | `status`: `new`, `claimed`, `running`, `exit`, `error`, `suspended`, `resuming`. `status_detail` when running: `working`, `waiting_for_user`, `waiting_for_approval`, `finished`. When suspended: `inactivity`, `user_request`, `usage_limit_exceeded`, `out_of_credits`, `out_of_quota`, `no_quota_allocation`, `payment_declined`, `org_usage_limit_exceeded`, `user_usage_limit_exceeded`, `total_session_limit_exceeded`, `contract_expired`, `error` | The provider maps every value to a tree state (implementation plan A.5). `usage_limit_exceeded` is how the cost gate learns a session cap was hit |
| 5 | Raising a session's ACU cap | `max_acu_limit` per session; nothing on changing it | `max_acu_limit` is set only on **create**. No endpoint updates a running session (there is no PATCH on sessions) | "Raise the budget" cannot edit the session. Padakan adds a `raiseBudget` capability that archives the capped session and starts a **continuation session** on the same branch with the new cap (implementation plan B.6) |
| 6 | Create fields | Lists `prompt`, `repos`, `platform`, `playbook_id`, `knowledge_ids`, `secret_ids`, `session_secrets`, `tags`, `title`, `max_acu_limit`, `bypass_approval`, `resumable`, `attachment_urls`, `security_profile` | Also has `devin_mode` (`normal`, `fast`, `lite`, `ultra`, `fusion`, and others; `fast` is about 2x faster and 4x more expensive), `child_playbook_id`, `session_links` and `create_as_user_id`. `resumable` defaults to `true`. Only `prompt` is required | `devin_mode` affects cost, so it is a setting (`DEVIN_MODE`) and part of the estimate. `resumable` must stay `true` for pause and resume |
| 7 | `platform` | `linux` · `macos` · `windows` | Also accepts an **Outpost** pool name (self-hosted machines). An unknown value returns `400` with a body listing the valid platforms and pools | Show that `400` body to the user as is during onboarding |
| 8 | Structured output | `structured_output_schema` and `structured_output_required` | `structured_output_required` **defaults to `true`**: the agent must call `provide_structured_output` with `is_final=true` before its turn ends. The schema must be self-contained (no external `$ref`) | Keep `report.json` free of `$ref` |
| 9 | Android | "Android emulator support not confirmed" (**verify**) | The docs now have an Android emulator page (`onboard-devin/environment/android-emulation`): full emulator in the session, blueprint setup, `adb`, Computer Use and recordings | Still needs one live test; if it works, the Mac-host fallback for Android can go |
| 10 | Permissions | Service-user token `cog_…` | Creating sessions needs the **`UseDevinSessions`** (`org.devins.use`) permission at org level; `create_as_user_id` also needs `ImpersonateOrgSessions` | Onboarding doctor checks the permission |
| 11 | Base URL and auth check | Not stated | Base URL `https://api.devin.ai/v3`; `GET /v3/self` returns the principal (`service_user_id`, `org_id`) | Doctor's first check |
| 12 | Errors | Not stated | Errors are `ProblemDetail` JSON (`title`, `status`, `detail`); responses include `401`, `403`, `404`, `409`, `422` and `429` | The client parses `ProblemDetail` and retries only `429` and `5xx` |
| 13 | Blueprint `post-build` | Lists `post-build` (health checks that fail the build) among the blueprint sections; the implementation plan (A.10) puts a smoke check there in the repo blueprint | `post-build` is **organization and enterprise level only**. A repository-level blueprint has `initialize`, `maintenance`, `knowledge`, `runs-on`, `shell` and `clone` | `sandboxes/devin/blueprint.yaml` puts the smoke check in `knowledge` (an instruction to run the tests first and report `blocked` if a clean checkout fails); the repo's CI stays the real gate |

Still unconfirmed, waiting on the implementer's first live session:
- Query parameters for `GET …/sessions` (for example a page limit or tag filter). The doctor check that lists sessions depends on them.
- The exact body field of `POST …/messages`.
- Filename and extension of the testing-mode recording attachment.

What the API reference says about the first two (read while building `sandboxes/devin/client.mjs`; still to be confirmed live):
- `GET …/sessions` has cursor pagination (`first`, `after`) and filters such as `tags`, `is_archived`, `session_ids` and `repo_names`. It returns `{ items, total, has_next_page, end_cursor }`. The client sends array filters as repeated query parameters (`tags=a&tags=b`); the live call must confirm that encoding.
- `POST …/messages` takes `{ "message": "<text>" }`, optionally with `attachment_urls`. `GET …/messages` is paginated the same way, and items carry `event_id`, `message`, `source`, `origin` and `created_at`.
- `POST …/attachments` takes multipart/form-data with one field, `file`, and returns `{ attachment_id, name, url }`.
- `POST …/sessions/{devin_id}/tags`: the body shape (`{ "tags": [...] }` in the client) is not confirmed.

## Sources

- API overview: https://docs.devin.ai/api-reference/overview
- Create session: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
- Common flows (polling, attachments, automations): https://docs.devin.ai/api-reference/common-flows
- API release notes: https://docs.devin.ai/api-reference/release-notes
- Environment and snapshots: https://docs.devin.ai/onboard-devin/environment
- Blueprints and reference: https://docs.devin.ai/onboard-devin/environment/blueprints · https://docs.devin.ai/onboard-devin/environment/blueprint-reference
- macOS support: https://docs.devin.ai/onboard-devin/environment/macos-support
- Computer Use: https://docs.devin.ai/work-with-devin/computer-use
- Testing and recordings: https://docs.devin.ai/work-with-devin/testing-and-recordings
- MCP servers: https://docs.devin.ai/work-with-devin/mcp
- Plugins: https://docs.devin.ai/product-guides/plugins · https://docs.devin.ai/cli/extensibility/plugins/overview
- Get session: https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session
- Archive session: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-archive
- Terminate session: https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions
- Upload an attachment: https://docs.devin.ai/api-reference/v3/attachments/post-organizations-attachments
- Android emulator support: https://docs.devin.ai/onboard-devin/environment/android-emulation
