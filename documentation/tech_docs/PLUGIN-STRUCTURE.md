# Padakan plugin: file structure plan

Status: plan, not built. Default language: English. Derived from `ARCHITECTURE.md` plus a read-only analysis of two existing setups: the `daytonatree` skill (orchestrator behavior, sandbox lifecycle, records kept outside the repo) and the `inloop` plugin (plugin conventions, sibling state folder, venue abstraction, hooks, tests).

## 1. What we reuse, and from where

| Behavior | Source | How it lands in Padakan |
|---|---|---|
| One sandbox per task, plant → attach → brief → poll effect → verify → evidence → merge → retire | daytonatree | `/padakan:build` and `sandboxes/` |
| "Never trust the report": assert on effects (remote commit, `git status`, CI), never on narration or an agent status field | both | orchestrator `CLAUDE.md`, `scripts/oracle.mjs` |
| Retire writes a seven-section record by the building agent, pulled back before delete; delete refuses on unpushed work | daytonatree | `sandboxes/daytona/remote/BRIEF-record.md`, `retire` verb |
| The remote branch is the asset, the sandbox is scaffolding; recycle a wedged tree, never nurse it | daytonatree | `sandboxes/README.md` rules |
| Evidence recorded in the tree (Playwright video, trace, numbered frames, `notes.md` per AC), served once, pulled back; the pulled copy is the record | daytonatree | `evidence` verb → `<records>/tasks/<KEY>/evidence/` |
| Brief contract and a machine-readable report line (`CI= PR= ACS= EVIDENCE= BLOCKED=`) | daytonatree | `templates/brief.md` |
| Tree `CLAUDE.md` assembled from fenced blocks (`<!-- padakan:<name>:start/end -->`), replaced if present, stripped if the source is gone | daytonatree | `sandboxes/<p>/remote/CLAUDE-*.md` |
| Snapshot holds tooling only; secrets are seeded per tree and travel by exec, never as sandbox metadata or in a pane | both | `sandboxes/daytona/snapshot/Dockerfile`, `seed` verb |
| Attribution off and model set by config in the tree, not by asking in the brief | daytonatree | `seed` writes the tree's `settings.json` |
| Sibling state folder resolved from the main repo root (worktrees and submodules map to the same folder), one env override | inloop | `scripts/wfpath.mjs` → `<parent>/<repo>-padakan/` |
| Single writer per file; parallel workers write their own shard, folded at one point | inloop | orchestrator is the only writer of `state.json`, audit, ledger |
| Gateway plus provider modules; the provider is recorded in each handle; a fixed verb contract tested once for every provider | inloop | `sandboxes/index.mjs` + `sandboxes/<provider>/provider.mjs` |
| Exit code read from a file the remote command writes (`run.done`), not from the transport; missing file = failure | inloop | daytona provider |
| `BOOTSTRAP-OK` as the only success line of an idempotent bootstrap | inloop | `sandboxes/daytona/remote/bootstrap.sh` |
| Push refuses credential-shaped files; base64 in chunks | inloop | `push` verb |
| Headless runs never call AskUserQuestion; a real stop sets a paused status and exits; termination and caps live in code | inloop | `bin/padakan-run`, hooks |
| Flat dotted config with one `DEFAULTS` schema; exported env beats files | inloop | `scripts/config.mjs` |
| Zero dependencies, `node --test`, a mock `daytona` CLI on PATH that logs argv | inloop | `test/` |

**Not copied (inconsistencies found in the sources):** brief and evidence written to two different `work/` roots; disk default differing between `.env.example` and code; addressing an agent by the sandbox name when names are capped at 32 chars; onboarding writing playbooks to one folder while the resolver reads another; a `brand.md` nobody reads; a shared evidence volume that is documented but never written. Product-specific sign-in, connectors, preview-URL rules, milestone names and tracker wording stay out.

## 2. The orchestrator decides; agents do the work

The orchestrator keeps its context small so it can run many tasks for a long time. It does four things and nothing else:

1. **Decide:** start, escalate, ship or reject a task's change; ask the cost question; open a task from a monitor report.
2. **Dispatch:** brief a sub-agent or plant a tree, one job per dispatch.
3. **Merge and deploy:** one at a time, each validated before the next.
4. **Record:** the only writer of `state.json`, the audit chain, the ledgers and `index.md`.

Everything else is delegated. Reading code, logs, diffs, transcripts, herdr screens or evidence happens inside an agent, never in the orchestrator's context. Every agent:
- gets one brief and returns **one short result line plus a path** (for example `VERDICT=PASS REPORT=<records>/tasks/PAD-12/checks/verify.md`);
- writes its full output only to its own file under `<records>/tasks/<KEY>/` (one writer per file);
- never calls another agent.

The orchestrator reads result lines and the JSON that `core/` scripts emit. It opens a full report only when a result line is ambiguous, and treats an ambiguous line as a failed check.

| Job | Done by | Returns |
|---|---|---|
| Write the PRD, stories, task plan | `planner` | `PLAN=<path> TASKS=<n>` |
| Pick tools per task | `capability-resolver` | `MANIFEST=<path> COST=<estimate>` |
| Write the tests that prove a task's acceptance criteria | `test-writer` | `TESTS=<paths> ACS=<n>` |
| Plant, attach, brief and poll a tree; read herdr screens | `tree-operator` | `TREE=<id> STATE=<…> CI= PR= ACS= EVIDENCE= BLOCKED=` |
| Build the task (inside the tree) | `builder` (the black box) | the report line above, via the tree |
| Re-check every claim at its source, run `core/` checks | `verifier` | `VERDICT=PASS\|FAIL CHECKS=<path>` |
| Collect video, change architecture, files, CI; render the report | `evidence-builder` | `PACK=<path> ITEMS=4/4` |
| Pull the seven-section record and retire the tree | `tree-operator` | `RECORD=<path> SECTIONS=7 DESTROYED=yes` |
| Monitor tick: collect, triage, root cause | `bug-agent` (with `core/triage.mjs`) | `CLUSTERS=<n> FIXABLE=<keys> REPORT=<path>` |
| Write a cost decision report | `report-writer` | `DECISION=<path>` |
| Security and code review of a diff | `security-auditor` · `test-runner` | `VERDICT=… FINDINGS=<path>` |
| Design work from `brand.md` | `ux-designer` · `design-implementer` | `DESIGN=<path>` |

## 3. Plugin tree

Three layers, each in its own folder:
- `orchestrator/` holds the lifecycle scripts, one per step. The orchestrator's agents (mostly `tree-operator` and `verifier`) run them, so their output never lands in the orchestrator's context. A human can run them from a terminal too.
- `sandboxes/` holds one folder per provider. The orchestrator scripts never call a provider directly; they go through the gateway.
- `core/` is the trust core: deterministic checks that decide whether a change may ship. No model in that path.

```
Padakan/                                  repo root = the plugin
├── .claude-plugin/
│   ├── plugin.json                       name, description, version, author (paths by convention)
│   └── marketplace.json                  local marketplace, source "./"
├── CLAUDE.md                             for contributors building the plugin (Claude Code does not
│                                         load a plugin's CLAUDE.md for its users)
├── package.json                          npm test → node --test; no dependencies
├── .env.example                          EVERY setting, documented; never holds values
├── .gitignore                            .env, .env.*, secrets/, *credentials*.json
├── commands/                             thin: each one follows a script in orchestrator/
│   ├── onboard.md                        writes the project .env, checks every setting, runs doctor
│   ├── plan.md                           the one human gate: PRD, stories, tasks, manifests, brand
│   ├── build.md                          one task end to end, from tree to deploy
│   ├── watch.md                          one cron tick of the monitor loop
│   ├── decide.md                         answer a cost-gate decision report
│   ├── feature.md                        scaffold the five feature docs + spec
│   ├── evidence.md                       build and verify a task's evidence pack
│   ├── status.md · replay.md             read-only
│   └── pause.md · rollback.md            kill switch
├── agents/                               dispatched only by the orchestrator; none has Task
│   ├── planner.md · capability-resolver.md · test-writer.md
│   ├── tree-operator.md                  runs orchestrator/ scripts for one tree; reads herdr screens
│   ├── verifier.md                       re-checks claims at their source; runs core/ checks
│   ├── builder.md                        adapter around the black box that implements a task
│   ├── bug-agent.md
│   ├── test-runner.md · acceptance-tester.md · security-auditor.md
│   ├── evidence-builder.md · report-writer.md
│   └── ux-designer.md · design-implementer.md
├── skills/
│   ├── okf/                              how to write an OKF document (frontmatter, links, index.md)
│   ├── no-questions/ · cost-gate/ · escalation/ · entire-context/
│   ├── feature-docs/ · e2e-playbook/ · evidence-pack/ · triage-categories/
│   └── verify-web/ · verify-ios/ · verify-android/ · verify-backend/
├── hooks/hooks.json                      SessionStart, PreToolUse (block questions except the cost
│                                         gate; protected paths; secrets), PostToolUse (audit), Stop
├── orchestrator/                         the orchestrator's own scripts, one per step
│   ├── RULES.md                          the orchestrator's rules (OKF), injected by the SessionStart
│   │                                     hook: decide, dispatch, merge, deploy, record; delegate the
│   │                                     rest; no questions except cost; never trust a report
│   ├── README.md                         the lifecycle, which script does which step
│   ├── lib/                              env.mjs (settings), records.mjs (records folder), state.mjs
│   │                                     (state.json), github.mjs (remote and PR effects), context.mjs
│   ├── steps.mjs                         the lifecycle steps, one function each: init, plant, attach,
│   │                                     brief, poll, verify, evidence, merge, retire, recycle, status, ls,
│   │                                     gate, pause, resolve, tick
│   ├── doctor.mjs                        environment checks, one CHECK line each, then DOCTOR=
│   └── (tick is a step in steps.mjs: collect, triage, dedupe, open tasks)
├── bin/
│   ├── padakan                           one entry point: `padakan <step> ...` → orchestrator/<step>.mjs
│   └── padakan-run                       headless outer loop (fresh pass each time, caps in bash)
├── sandboxes/                            ONE folder per provider, selected in .env
│   ├── README.md                         the verb contract and the lifecycle rules
│   ├── index.mjs                         gateway: loads PADAKAN_SANDBOX_PROVIDER, writes handles
│   ├── contract.mjs                      shared validation (ids, handles, secret filters)
│   ├── local/
│   │   └── provider.mjs                  git worktree; for development and the Mac device host
│   ├── devin/                            DEFAULT provider (API only: no shell, no herdr)
│   │   ├── provider.mjs                  verbs + `capabilities` list (see §7)
│   │   ├── client.mjs                    HTTP client for https://api.devin.ai/v3: sessions (create, get,
│   │   │                                 list, messages, attachments list, archive, terminate, tags),
│   │   │                                 org-level attachment upload, /self; retries 429/5xx, parses
│   │   │                                 ProblemDetail, never logs the key
│   │   ├── state.mjs                     Devin status + status_detail → tree state
│   │   ├── answers.mjs                   rule-based replies when a session waits for the user
│   │   ├── prompt.mjs                    session prompt rendered from the brief
│   │   ├── schemas/report.json           structured output (draft 7, no $ref): the CI= PR= ACS=
│   │   │                                 EVIDENCE= BLOCKED= report, plus the seven-section record
│   │   ├── blueprint.yaml                template for the repo's .devin/blueprint.yaml (verify kit, knowledge)
│   │   ├── doctor.mjs                    /self, UseDevinSessions permission, platform, ACU price set
│   │   └── README.md                     service user, org id, platforms, ACU limits, Computer Use
│   └── daytona/
│       ├── provider.mjs                  create, bootstrap, seed, exec, push, pull, url, status,
│       │                                 attach, evidence, retire, destroy
│       ├── doctor.mjs                    claude, gh push, an MCP tool call, disk, Entire, herdr version
│       ├── snapshot/Dockerfile           Ubuntu, Node 22, gh, git, Claude Code, herdr, Entire CLI +
│       │                                 Entire Graph, Playwright + MCP; no secrets
│       ├── remote/
│       │   ├── bootstrap.sh              idempotent; last line BOOTSTRAP-OK
│       │   ├── claude-token.sh           main / fallback token switch inside the tree
│       │   ├── CLAUDE-evidence.md        recording rules
│       │   ├── CLAUDE-disk.md            disk ceiling, push early, never wipe /tmp
│       │   ├── CLAUDE-entire.md          ask Entire before guessing
│       │   ├── CLAUDE-prbody.md          PR body rules, no attribution
│       │   └── BRIEF-record.md           the seven-section retire record
│       └── README.md                     setup and auth-breakage table
├── core/                                 trust core; deterministic; unit-tested
│   ├── gates.mjs                         proven twice, no regressions, documents valid
│   ├── diffcheck.mjs                     size, protected paths, secrets, dependencies (rules, never an LLM)
│   ├── deploy.mjs                        flag, canary, SLO watch, auto-rollback
│   ├── audit.mjs                         hash-chained, signed; replay
│   ├── cost.mjs                          estimates, ledger, gate
│   ├── ledger.mjs                        known-defect ledger
│   ├── entire.mjs                        search, explain, graph query / impact / diff → JSON
│   ├── models.mjs                        OpenAI-compatible client (Nebius Token Factory)
│   ├── resolver.mjs · triage.mjs         schema-validated model output
│   ├── collect-logs.mjs                  docker + app logs → fingerprinted clusters
│   ├── report.mjs                        render evidence-report.html from the pack
│   ├── docs-gate.mjs                     CI gate for the five feature docs
│   ├── okf.mjs                           OKF validator: type present, ISO timestamp, links resolve
│   └── harness/                          claude.mjs · devin.mjs · openai-compat.mjs
├── schemas/                              task, manifest, decision-report, decision-answer, audit-entry,
│                                         triage-result, verdict, sandbox-handle
├── registry/                             capabilities.json, categories.yml, prices.yml (catalog data, not settings)
├── templates/                            evidence-report.md/.html, brand.md, brief.md,
│                                         decision-report.md, record.md, feature/
├── ci/                                   docs gate, e2e twice per change, cron
├── documentation/                        the team's documentation tree (exists in the repo)
│   ├── tech_docs/                        ARCHITECTURE.md, PLUGIN-STRUCTURE.md, diagrams/
│   ├── infrastructure/                   TOOLS.md: every API, framework and tool used
│   └── repo_requirements.md              what the jury needs from the repo
├── README.md                             what it is, setup and install, links into documentation/
└── test/                                 node --test; helpers with mock daytona and herdr CLIs and a
                                          mock Devin v3 HTTP server
```

## 4. Records folder outside the repo

Resolved only by `orchestrator/lib/records.mjs` from the main repo root, so every worktree and sandbox maps to the same place. The name defaults to `<repo>-padakan` and is set in `.env` (`PADAKAN_RECORDS_NAME`, with `{repo}` as a placeholder); `PADAKAN_RECORDS_DIR` overrides the whole path. The orchestrator is the only writer of the shared files (`state.json`, audit, ledgers, index); each agent writes only its own file under `tasks/<KEY>/`. Sandboxes never write here directly: an agent pulls what they produce.

Settings live in `.env` files. The records folder holds documents and records, not settings.

```
<parent>/
├── <repo>/
└── <repo>-padakan/
    ├── .env                              per-project settings and credentials (chmod 600)
    ├── brand.md                          approved at the plan gate
    ├── plan/                             PRD, stories, task plan, approved manifests
    ├── state.json                        resume source of truth
    ├── tasks/<KEY>/
    │   ├── task.md · manifest.json · brief.md
    │   ├── diff.patch · checks/ · deploy.json · entire.json
    │   ├── evidence/                     browser/ (video, trace, frames), notes.md,
    │   │                                 evidence-report.md, evidence-report.html
    │   ├── record.md                     seven-section record written by the building agent
    │   └── logs/<agent>.md               each sub-agent's trace (a self-report)
    ├── sandboxes/<id>.json               one handle per live sandbox (provider, remote id, status)
    ├── decisions/                        cost-gate reports and answers
    ├── audit/chain.jsonl                 append-only, hash-chained
    ├── cost/ledger.jsonl
    ├── monitor/<tick>/                   clusters, triage, bug-agent reports
    ├── ledger/known-failures.json
    ├── index.md                          OKF index: one row per task (key, verdict, record, written)
    └── log.md                            OKF log: chronological, human-readable history
```

## 5. Configuration: everything in `.env`

Every setting is an environment variable, documented in `.env.example`. There is no separate config file. Load order, first value wins:

1. exported environment (a one-off override)
2. `<records>/.env` (this project; survives plugin updates)
3. plugin `.env` (machine-wide defaults; gitignored)

A marketplace update replaces the plugin folder, so values kept only in the plugin `.env` can be wiped; `/padakan:onboard` writes project values to the records `.env`. `orchestrator/lib/env.mjs` validates every variable against one defaults table and fails loudly on an unknown or malformed key.

| Group | Variable | Default | Meaning |
|---|---|---|---|
| General | `PADAKAN_LANGUAGE` | `en` | language of briefs, reports and specs |
| | `PADAKAN_RECORDS_NAME` | `{repo}-padakan` | name of the sibling records folder |
| | `PADAKAN_RECORDS_DIR` | | absolute path; overrides the name |
| | `PADAKAN_TRACKER` | `linear` | where issues go |
| | `LINEAR_API_KEY` | | orchestrator only; trees never get it |
| Terminal and driver | `PADAKAN_TERMINAL` | `herdr` | where trees are watched |
| | `PADAKAN_DRIVER` | `herdr` | how a tree agent is driven: `herdr` · `headless` (CI) |
| | `HERDR_SESSION_PREFIX` | `padakan` | herdr workspace naming |
| Sandboxes | `PADAKAN_SANDBOX_PROVIDER` | `devin` | `devin` · `daytona` · `local` |
| | `PADAKAN_MAX_TREES` | `3` | trees running at once |
| | `DAYTONA_API_KEY` · `DAYTONA_API_URL` · `DAYTONA_TARGET` | · · `eu` | |
| | `DAYTONA_SNAPSHOT` | `padakan-base` | baked from `sandboxes/daytona/snapshot/` |
| | `DAYTONA_CPU` · `DAYTONA_MEMORY` · `DAYTONA_DISK` | `2` · `4` · `10` | fixed at bake time |
| | `DAYTONA_AUTO_STOP` · `DAYTONA_AUTO_DELETE` | `15` · `1440` | minutes |
| Agents and models | `PADAKAN_HARNESS` | `claude` | tree agent: `claude` · `devin` · `openai-compat` |
| | `PADAKAN_TREE_MODEL` | `claude-sonnet-5-5` | model the tree agent runs |
| | `CLAUDE_CODE_OAUTH_TOKEN` · `CLAUDE_CODE_OAUTH_FALLBACK_TOKEN` | | tree login (`claude setup-token`) |
| | `NEBIUS_API_KEY` · `NEBIUS_BASE_URL` | · `https://api.tokenfactory.nebius.com/v1/` | OpenAI-compatible models |
| | `PADAKAN_TRIAGE_MODEL` · `PADAKAN_RESOLVER_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | decision models (structured output) |
| | `PADAKAN_BUILDER_MODEL` | | model for the `openai-compat` harness |
| | `DEVIN_API_URL` | `https://api.devin.ai/v3` | Devin API base URL |
| | `DEVIN_API_KEY` · `DEVIN_ORG_ID` | | `devin` provider: service user token (`cog_…`, needs `UseDevinSessions`) and org id |
| | `DEVIN_MAX_ACU` | | hard ceiling for any session's `max_acu_limit`, whatever the budget allows; the cost gate sets the actual value per session |
| | `DEVIN_PLATFORM` | `linux` | `linux` · `macos` · `windows`, or an Outpost pool name; the resolver can override per task |
| | `DEVIN_MODE` | | optional `devin_mode` (`normal` · `fast` · `lite` · `ultra` · `fusion`); empty uses the org default; affects cost |
| | `DEVIN_BYPASS_APPROVAL` | `true` | no approval prompts inside sessions |
| | `DEVIN_PLAYBOOK_ID` | | optional playbook with Padakan's standing instructions |
| | `DEVIN_POLL_SECONDS` | `30` | how often a session is polled |
| | `DEVIN_CONTINUATION_MIN_ACU` | `2` | smallest raise worth a continuation session (`raiseBudget`) |
| Git | `GH_TOKEN_SOURCE` · `GH_PAT` | `host` · | GitHub token for trees |
| | `GIT_AUTHOR_NAME` · `GIT_AUTHOR_EMAIL` | required | commit identity, no AI attribution |
| Context | `ENTIRE_ENABLED` | `false` | optional; agents use Entire Graph (local) and session capture |
| | `ENTIRE_SEARCH` | `off` | `on` once the human connects the repo to Entire at the plan gate |
| | `ENTIRE_REPO` | | `owner/repo` as published on Entire |
| Gates | `PADAKAN_PROTECTED_PATHS` | `.github/,infra/,**/*.lock` | diff inspection refuses these |
| | `PADAKAN_MAX_DIFF_LINES` · `PADAKAN_MAX_DIFF_FILES` | `60` · `3` | "small and localized" |
| Cost | `PADAKAN_BUDGET_RUN_USD` · `PADAKAN_BUDGET_TASK_USD` · `PADAKAN_BUDGET_STEP_USD` | | caps; over a cap the tree pauses and a decision report is sent |
| | `PADAKAN_DEVIN_USD_PER_ACU` | | **required** with the `devin` provider: the team's real ACU price; the gate pauses rather than guess |
| Monitor | `PADAKAN_WATCH_INTERVAL_MIN` | `15` | cron tick |
| | `PADAKAN_LOG_SOURCES` | `docker` | `docker` · file paths · URL |
| Deploy | `PADAKAN_DEPLOY_TARGET` | `simulated` | `simulated` · `railway` · `vercel` |
| | `PADAKAN_CANARY_PERCENT` · `PADAKAN_SLO_ERROR_RATE` | `10` · `0.01` | canary and rollback threshold |

The numbers above are placeholders to settle when each module is built.

## 6. Entire is optional

- `ENTIRE_ENABLED=false`: agents work from the code and git history only.
- `ENTIRE_ENABLED=true`: `entire enable` runs in the repo, sessions become checkpoints linked to commits, and every tree gets Entire Graph (local, no network) for code questions.
- **Search needs the repo connected to Entire.** At the plan gate, if Entire is enabled and the repo is not connected, the orchestrator asks the human once whether to connect it. Yes: the human connects it, and onboarding sets `ENTIRE_SEARCH=on` and `ENTIRE_REPO`. No: `ENTIRE_SEARCH=off`, and agents skip search (developer intent from past sessions) but still use the graph. The question is never asked again after the plan gate.

## 7. Sandbox provider contract

`sandboxes/index.mjs` loads `sandboxes/${PADAKAN_SANDBOX_PROVIDER}/provider.mjs`. Every provider exports `name`, a `capabilities` array listing the verbs it supports, and those verbs as async functions. `test/sandbox-contract.test.mjs` runs the same suite against each provider, for the verbs that provider declares. Calling an undeclared verb throws `UnsupportedVerb`; it never fails silently. The gateway also enforces `PADAKAN_MAX_TREES` by counting live handles.

Devin is API-only, so it does not declare the shell verbs (`bootstrap`, `seed`, `exec`, `push`, `pull`). It adds `message`, `pause`, `resume`, `spend` and `raiseBudget`.

| Verb | Contract | `daytona` | `local` | `devin` (Devin API v3) |
|---|---|---|---|---|
| `create(id, {repo, branch, base, …})` | claim handle first, delete it on failure; pin base to a full SHA; refuse if local commits are unpushed; the cost gate runs before anything is spent | ✓ | ✓ | upload brief (`POST /attachments`), then `POST /sessions` with `max_acu_limit` from the cost gate, `resumable: true`, `bypass_approval`, `structured_output_schema`, tags `padakan` · `task:<KEY>`; store `session_id` and `url` |
| `bootstrap(id)` | idempotent; success only on a final `BOOTSTRAP-OK` | ✓ | | not supported (the org snapshot from blueprints does this) |
| `seed(id)` | secrets per tree by exec; tree `settings.json` (model, attribution off); assemble tree `CLAUDE.md` blocks | ✓ | ✓ | not supported (secrets via `secret_ids` at create; rules via playbook or the repo's `AGENTS.md`) |
| `exec(id, cmd)` | one string; exit code from the remote `run.done` file | ✓ | ✓ | not supported |
| `push` · `pull` | refuse credential-shaped files; chunked base64 | ✓ | ✓ | not supported (files travel as attachments) |
| `brief(id, path)` | deliver the OKF brief | ✓ | ✓ | at create: `attachment_urls`; later: `POST /sessions/{id}/messages` |
| `attach(id)` | start the agent and return where to watch it | herdr pane | herdr pane | the session `url` (Devin web app) |
| `url(id, port)` | preview URL | ✓ | ✓ | session `url` |
| `status(id)` | tree state: ready · working · waiting · paused · done · failed · gone | ✓ | ✓ | `GET /sessions/{id}`; `status` + `status_detail` mapped by `state.mjs`; "done" only once the PR's head commit is on the remote |
| `message(id, text)` | send a follow-up or a rule-based answer | | | `POST /sessions/{id}/messages` (resumes a sleeping session) |
| `pause(id)` | stop spending, keep the work | stop sandbox | | `POST /sessions/{id}/archive` (sleeps; reversible) |
| `resume(id, text)` | continue a paused tree | start sandbox | | `POST /sessions/{id}/messages` |
| `spend(id)` | units consumed so far, for the cost ledger | | | `acus_consumed` from `GET /sessions/{id}` |
| `raiseBudget(id, {cap})` | continue a capped tree under a higher cap approved at the cost gate | raise limits if the provider allows | n/a | the API cannot change `max_acu_limit` on a live session, so: archive the capped session, create a **continuation session** on the same branch with the new cap and a "continue from the remote branch" brief, and link the old `session_id` in the handle (`previous_session_ids`); spend is summed across both |
| `evidence(id, key)` | collect the bundle into `<records>/tasks/<KEY>/evidence/` | serve and pull | copy | `GET /sessions/{id}/attachments`, download the newest video; none → `{video:null}` (a failed item unless our own recording covers it) |
| `retire(id, key)` | get the seven-section record, pull it, then end the tree | brief, poll, pull, `destroy` | ✓ | message asking for `record` in the structured output; write `record.md`; then archive |
| `destroy(id, {force})` | refuse when unpushed work exists unless forced | ✓ | ✓ | refuse unless the PR head is on the remote; then `DELETE /sessions/{id}` (terminate, cannot be resumed) |

Note on ids: the Devin API returns the id as `session_id` (prefix `devin-`), and its URL paths name the same slot `{devin_id}`. Details and the other differences from the first research: `documentation/infrastructure/DEVIN.md`, "Differences found against the live API reference".

## 8. Settled and open

Settled:
- Devin is the default sandbox provider (see `documentation/infrastructure/DEVIN.md`); Daytona and local stay as options. herdr is the terminal for the orchestrator and for non-Devin trees; headless only for CI.
- The orchestrator only decides, dispatches, merges, deploys and records; all other work is delegated to agents.
- Lifecycle scripts live in `orchestrator/`, run by agents.
- Every setting is in `.env`, including the records folder name (default `<repo>-padakan`).
- Entire is optional; search is offered once at the plan gate.
- English by default. No demo repo until the plugin is defined.
- Devin is a sandbox provider (parallel cloud sessions); Nemotron on Nebius is the default decision model.
- Documentation lives in the team's `documentation/` tree, not in a separate `docs/`.
- Every document an agent writes is an OKF document (markdown + YAML frontmatter, `type` required; `title`, `description`, `tags`, `timestamp` always written). The records folder is an OKF bundle with `index.md` and `log.md`. `core/okf.mjs` enforces it.

Open:
1. Scripts in Node (`.mjs`, testable with mock CLIs, as in inloop) rather than bash (as in daytonatree). Plan: Node.
