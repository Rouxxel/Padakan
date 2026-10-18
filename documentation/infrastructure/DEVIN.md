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
