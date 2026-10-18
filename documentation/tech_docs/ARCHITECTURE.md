---
type: Architecture
title: Padakan architecture
description: How Padakan plans, builds, verifies and ships work autonomously, and how it earns the trust to do so without a human reviewing each change.
tags: [architecture, padakan]
timestamp: 2026-10-18T00:00:00Z
---

# Padakan: architecture

**One-liner:** a Claude Code plugin for autonomous development. Agents plan, build, verify and ship in sandboxes, and a change reaches production only when the system, not a human reviewer, has proven it safe.

**Scope:** any repository, any coding agent, any task: features, fixes and changes found by watching production.

Read next:
- `blueprint.html`: a visual walkthrough of this document and the plugin plan (open it in a browser).
- `diagrams/system-overview.svg`: the whole system in five lanes.
- `diagrams/whiteboard.svg`: the original whiteboard, redrawn.
- `PLUGIN-STRUCTURE.md`: how the plugin is laid out on disk, and every `.env` setting.

## 1. Principles

1. **Trust lives in the system, not in the agent.** The agent that writes the code is a black box we can swap. Confidence comes from what surrounds it: verification gates, deterministic diff inspection, evidence, a gated deploy and a signed audit trail.
2. **When a check does not clearly pass, a human gets the task.** Escalation is the default, never guessing.
3. **One human gate, up front.** The human approves the plan once. After that the pipelines never ask a question, except when a step would break the budget.
4. **The orchestrator decides; agents do the work.** The orchestrator decides, dispatches, merges, deploys and records. Everything that reads code, logs, diffs or screens runs in a sub-agent, so the orchestrator's context stays small.
5. **Never trust a report.** Every claim an agent makes is re-checked at its source: the commit on the remote, the test output, CI, the recorded video.
6. **Deterministic where it decides.** Whether a change may ship is decided by code and rules, never by a model's opinion.
7. **Knowledge is written in one open format.** Every document an agent writes is an Open Knowledge Format (OKF) document, so any agent or human can read what another produced (section 12).

## 2. The system in five lanes

| Lane | What happens |
|---|---|
| 1. Intake and planning | Target → PRD → plan gate (human) → tasks filed as GitHub issues (or Linear) → capability resolver → one manifest per task |
| 2. Build pipeline | One sandbox ("tree") per task → loop engine (plan, build, review, test) → verification gates → PR → evidence pack → orchestrator decision → gated deploy |
| 3. Monitor loop | Cron tick → log collector → triage model → bug-agent → report → orchestrator opens a task and plants a tree |
| 4. Cost gate | Estimate before a costly step → within budget: run → over budget: pause that tree, send a decision report, wait |
| 5. Critical-flow e2e in CI | Every feature: five documents + a spec → CI docs gate → e2e run twice per change → verdict and evidence on the PR |

## 3. Roles

**Orchestrator** (the main Claude Code session, rules in the plugin's `CLAUDE.md`):
1. Decide: start, escalate, ship or reject a task's change; ask the cost question; open a task from a monitor report.
2. Dispatch: brief a sub-agent or plant a tree, one job per dispatch.
3. Merge and deploy: one at a time, each validated before the next.
4. Record: the only writer of `state.json`, the audit chain, the ledgers and the index in the records folder.

**Sub-agents** each get one brief, write their full output to their own file, and return one short line plus a path (for example `VERDICT=PASS REPORT=<records>/tasks/PAD-12/checks/verify.md`). No agent calls another. An ambiguous result line counts as a failed check.

| Agent | Job |
|---|---|
| `planner` | PRD, user stories, task plan |
| `capability-resolver` | the manifest for each task (skills, MCPs, CLIs, models, verify kit) and its cost estimate |
| `test-writer` | the tests that prove a task's acceptance criteria; for a defect, a test that reproduces it first |
| `tree-operator` | plants, attaches, briefs and polls a tree; reads herdr screens; pulls the record and retires the tree |
| `builder` | the black box inside the tree: implements the task |
| `verifier` | re-checks every claim at its source; runs the `core/` checks |
| `evidence-builder` | the four-item evidence pack and the evidence report |
| `bug-agent` | root cause and "fixable by an agent?" for a monitor cluster |
| `report-writer` | the cost decision report |
| `test-runner` · `acceptance-tester` · `security-auditor` | suites, live probes, security review |
| `ux-designer` · `design-implementer` | UI work from `brand.md` |

## 4. Plan gate: the only human step

The human and the orchestrator agree, once:
1. the **PRD** (architecture, tech stack, security);
2. the **task plan** and its **user stories**, each with acceptance criteria;
3. the **budget** (caps per run, task and step, written to `.env`);
4. the **brand file** `brand.md` (logo, palette, typography, voice), which the designer agents and the report generator read;
5. if Entire is enabled and the repo is not connected: **connect the repo to Entire** for search? Yes sets `ENTIRE_SEARCH=on`; no leaves search off. Asked once.

After this gate, the human is asked again only by the cost gate (section 9).

## 5. Capability registry and resolver

The **registry** (`registry/capabilities.json` in the plugin) lists everything an agent can be given. The **capability resolver** is a decision model with schema-validated output: for each task it reads the PRD's tech stack and the task and returns a manifest. A tree starts with only what its manifest names, so its agent can validate its own work.

**The resolver decides; the human does not.** Choosing tools is a model's job: the manifests are produced automatically after the plan is approved and are shown to the human only for information. The resolver runs on Nemotron through Nebius by default; any OpenAI-compatible endpoint works, including a local model server (issue #16). Its output is schema-validated, and an invalid manifest is a failed check, not a question.

| Target | MCP servers | CLI tools | Notes |
|---|---|---|---|
| Web | Playwright MCP, Chrome DevTools MCP | vitest / jest, lighthouse | video, trace, logs feed the evidence pack |
| iOS | MobileBuildMCP (getsentry) | xcodebuild, xcrun simctl | needs a macOS host with Xcode 16+ |
| Android | AndroidBuildMCP or adb-mcp | adb, gradle, emulator | needs the Android SDK, JDK 17+ and KVM |
| Backend / API | none required | curl, docker logs, docker compose, pytest / jest | container logs also feed the monitor loop |
| Always available | GitHub Issues (or Linear) | git, gh, Entire (optional) | skills: TDD, code review, security, debugging, docs |

iOS and macOS work runs on Devin's macOS VMs (Xcode, iOS Simulator, a recorded desktop), chosen per task with the session `platform`. Android emulator support on Devin still needs checking; until then the Mac host (`local` provider) runs Android device probes. Details: `documentation/infrastructure/DEVIN.md`.

## 6. Build pipeline

```
task → TREE (loop engine: plan → build → review → test) → VERIFICATION GATES → PR + EVIDENCE → MERGE → GATED DEPLOY
                         ↑ fail: back to plan                ↓ unclear                              ↓ SLO slips
                                                          escalate                       auto-rollback → escalate
                                   every step → AUDIT TRAIL
```

**In the tree:** the `builder` works the task through the loop engine. Plans are saved, code style is followed, review sub-agents look at the diff, tests run. A failure loops back to plan. Any harness works (Claude Code, Devin, an OpenAI-compatible model on Nebius); this loop is not part of the trust story.

**Verification gates** (may this change ship?), all must pass:
- **Proven twice:** the task's tests pass in the suite, and its acceptance criteria are proven live against the running app with the verify kit. `unproven` is never a pass.
- **No regressions:** the full suite stays green, and the critical-flow e2e suite is not `FAIL`, `BROKEN` or `STOPPED`.
- **Diff inspection:** within the size and file caps from `.env` (plus blast radius from Entire Graph `impact` when enabled), no protected paths, no secrets, no unapproved dependency changes. Deterministic rules; an LLM reviewer may only advise.
- **Documents valid:** every document the agents wrote passes the OKF check, and a new feature has its five documents (section 11).

**Gated deploy:** behind a feature flag, then a canary, with automatic rollback when an SLO slips. A rollback files an escalation.

**Audit trail:** every step is an append-only, hash-chained, signed entry: task, manifest, diff, checks, evidence, deploy result, Entire checkpoint id. A human can replay any decision.

## 7. Sandboxes and trees

One tree per task: a sandbox with one repo, one branch, its own agent and a desktop browser. The provider is chosen in `.env` (`PADAKAN_SANDBOX_PROVIDER`).

| Provider | Use |
|---|---|
| `devin` (default) | a Devin session per task, in a fresh VM booted from the organization's snapshot (built from blueprints, `.devin/blueprint.yaml`). Linux, macOS (Xcode, iOS Simulator) or Windows per task. Devin is the agent: Padakan drives it through the API (prompt, messages, structured output, attachments), and it records its own end-to-end test video. Several sessions run in parallel |
| `daytona` | a Linux container we control, from a baked snapshot (Claude Code, herdr, Entire CLI and Graph, Playwright, gh); for running our own agent instead of Devin |
| `local` | git worktree on the orchestrator's machine; the Mac device host for iOS and Android |

Lifecycle, run by `tree-operator` through the `orchestrator/` scripts: **plant → attach → brief → poll the effect → verify → evidence → merge → retire.**
- **Watching a tree:** a Devin session is watched live in Devin's web app (the session URL). Trees on `daytona` or `local` run in a herdr pane; herdr also stays the orchestrator's own terminal.
- Briefs end with a machine-readable report line: `CI= PR= ACS= EVIDENCE= BLOCKED=`.
- Poll the effect (commit on the remote, `git status`, CI), never the agent's status field.
- Retire: the building agent writes a seven-section record (what changed, files, architecture, seams, next step, what a reader will get wrong, what is still open), which is pulled back before the sandbox is deleted. Delete refuses when work is unpushed.
- The remote branch is the asset; the sandbox is scaffolding. A wedged tree is recycled, not nursed.
- Secrets reach a tree by exec, never in a prompt, a pane or sandbox metadata. Tree agents get no tracker access: they report, the orchestrator files.

## 8. Evidence pack

Every PR carries four items, built by `evidence-builder` and re-checked by `verifier`:

| # | Item | Produced by | Verified by |
|---|---|---|---|
| 1 | **Video** of the change working | recorded in the tree with the verify kit | opened; follows the acceptance criteria's steps |
| 2 | **Architecture of the change** | the building agent | compared with the real diff and call graph |
| 3 | **Files touched or edited** | git, mechanically | recomputed |
| 4 | **Tests and CI** | the task's tests, the suite and the e2e run | re-read from CI |

A missing or unverifiable item is a failed check. Templates: `templates/evidence-report.md` (the record) and `templates/evidence-report.html` (how it looks).

## 9. No questions, except cost

**No-questions rule:** agents run headless and non-interactive. Any uncertainty is decided by rule or escalated as a ticket (asynchronous, nothing waits on it). An agent with a question about a feature asks Entire first (past sessions for intent, the graph for code) when it is enabled, then takes the conservative choice and records it, or reports `BLOCKED=<reason>`.

**Cost gate:** each manifest item carries a cost estimate. Before a costly step the orchestrator compares it with the budget left.
- Within budget: run, log the spend.
- Over budget: pause that tree only, spend nothing, send a **decision report** (what, why, cost range and budget left, cheaper options and what each leaves uncovered, what stays unverified if skipped, recommendation). The human approves, picks the cheaper option, skips, raises the budget or aborts. No answer: stays paused.
- Never waived for cost: the task's tests, the regression suite and diff inspection. A skipped optional check blocks auto-deploy; that change goes to a human to merge.

## 10. Monitor loop

The orchestrator owns a cron job (`PADAKAN_WATCH_INTERVAL_MIN`). Each tick, `bug-agent` runs the collector and triage and returns a report:

```
cron tick → collect (docker + app logs; dedupe, fingerprint, cluster)
          → triage model (category + severity, schema-validated)
          → bug-agent (root cause, fixable?)
          → orchestrator: new task + plant a tree | escalate | ignore
```

| Category | Route |
|---|---|
| Code defect | becomes a task, may be fixed by an agent |
| Performance / SLO | becomes a task, usually escalated |
| Infra / config | human |
| Security | human at once, never automatic |
| External dependency | watch and retry, no change |
| Data issue | human |
| Noise / expected | drop |
| Unknown / low confidence | human (the default) |

A task opened by the monitor loop goes through the same build pipeline and gates as any other. Recurring errors are deduplicated against open tasks by fingerprint.

## 11. Critical-flow e2e suite in CI

For critical features only (sign-in, dashboard, checkout and similar). Every new feature ships five documents in `features/<area>/<slug>/` plus a spec:

| File | Owns |
|---|---|
| `feature.md` | what it is, who it serves, what breaks without it |
| `stories.md` | `US1`…`USn`, a real role and one outcome each |
| `workflow.md` | the architecture and how to confirm each effect |
| `playbook.md` | steps and criteria `AC1`…`ACn` |
| `setup.md` | what it needs and what it costs |
| `tests/<slug>.spec.ts` | the playbook as Playwright: one test, one soft assertion per criterion, labeled `ACn` |

- Judged on captured traffic and re-read state, never on what the page paints. Fresh identities every run; never production.
- **CI docs gate** fails a PR when a document is missing, a story has no criterion, a criterion has no assertion, `workflow.md` has no diagram, or the spec does not typecheck.
- Runs **twice per change**: on the PR preview before the merge, on staging after it.
- Verdicts: `PASS`, `KNOWN`, `FAIL`, `BROKEN`, `STOPPED`, `NOT RUN`. "Not exercised" is never a pass. A known-defect ledger turns a listed failure into `KNOWN`; a listed criterion that starts passing turns the run red ("fix detected").
- Evidence per feature: merged seekable video, trace, numbered screenshots, a self-contained `report.html`, and `summary.md` for the PR comment.

## 12. Knowledge format: OKF by default

Every document an agent writes follows the **Open Knowledge Format (OKF v0.1)**: markdown with YAML frontmatter, one concept per file, the file path as its identity, and plain markdown links between concepts. This applies to briefs, records, evidence reports, decision reports, triage reports, the five feature documents, the PRD, stories and `brand.md`.

```markdown
---
type: Evidence Report            # the only required field
title: PAD-12 · Export the dashboard as CSV
description: Added CSV export to the dashboard; PASS, auto-ship.
resource: https://github.com/<owner>/<repo>/pull/12
tags: [dashboard, evidence]
timestamp: 2026-10-18T14:22:00Z
---
# Verdict
...links to [the record](./record.md) and [the brief](./brief.md)...
```

- **Required:** `type`. **Always written by Padakan agents:** `title`, `description`, `tags`, `timestamp`, plus `resource` when the concept has a URL (a PR, an issue, a run). Padakan-specific fields (for example `task`, `agent`, `verdict`) are allowed; OKF leaves extra fields to the producer.
- **Bundles:** the records folder and each `features/<area>/<slug>/` folder are OKF bundles. Every folder an agent writes into carries an `index.md` (what is here, for progressive disclosure) and the records folder carries a `log.md` (chronological, human-readable history; the signed machine history stays in `audit/chain.jsonl`).
- **Machine data stays machine data.** JSON and JSONL that scripts read (handles, ledgers, the audit chain, check results) keep their formats; the `index.md` of their folder describes them.
- **Enforced, not asked for:** `core/okf.mjs` validates frontmatter (a `type` is present, `timestamp` is ISO 8601, links resolve inside the bundle). The `verifier` runs it on everything an agent wrote, and the CI docs gate runs it on the feature documents. An invalid document is a failed check.

Reference: https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing

## 13. Records folder

Next to the repo, named in `.env` (`PADAKAN_RECORDS_NAME`, default `{repo}-padakan`). Never committed to the repo. The orchestrator writes the shared files; each agent writes only its own.

```
<parent>/<repo>-padakan/                           (an OKF bundle)
├── .env · brand.md · plan/ · state.json · index.md · log.md
├── tasks/<KEY>/   task, manifest, brief, diff, checks/, evidence/, record.md,
│                  deploy.json, entire.json, logs/<agent>.md
├── sandboxes/<id>.json · decisions/ · monitor/<tick>/
├── audit/chain.jsonl · cost/ledger.jsonl · ledger/known-failures.json
```

## 14. Configuration

Every setting is an environment variable documented in the plugin's `.env.example`. Load order, first wins: exported environment → `<records>/.env` → plugin `.env`. Full table: `PLUGIN-STRUCTURE.md` §5.

## 15. Technology

| Technology | Where it is used |
|---|---|
| **Nebius Token Factory** (OpenAI-compatible) | triage model, capability resolver, and the `openai-compat` builder harness |
| **NVIDIA Nemotron** (on Token Factory) | default for the decision models: function calling and structured output suit schema-validated triage and resolver output |
| **Devin** | default sandbox provider: one session per task in a VM from our snapshot (Linux, macOS, Windows), recorded testing, structured output |
| **Daytona** | alternative sandbox provider when we run our own agent |
| **Entire** | optional: sessions as checkpoints linked to commits, local code graph, search over past sessions |
| **herdr** | terminal where every tree agent runs and can be watched |
| **Open Knowledge Format** | the format of every document agents write |

Details and links: `documentation/infrastructure/TOOLS.md`.

## 16. Future work

- A runtime sandbox around the agent itself (scoped file access, no secret access, network allowlist). Today the output is validated; a rogue runtime would slip past.
- Device probes in the cloud (macOS sandboxes, or Linux VM sandboxes with KVM for Android).

## 17. Open decisions

1. Scripts in Node `.mjs` (testable with mock CLIs) rather than bash. Plan: Node.
2. Which Nemotron and other models per role, once measured.
3. Deploy target for real runs (simulated canary until then).
4. Audit signing: hash chain plus a per-entry signature, or an external transparency service.
