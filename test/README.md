---
type: Guide
title: Padakan tests
description: How the test suite is organised and where a new test goes. The layout mirrors the source tree.
tags: [tests, guide]
timestamp: 2026-10-18T00:00:00Z
---

# Tests

`npm test` runs every `*.test.mjs` under this folder with `node --test`. No dependencies, no network: external APIs are mocked in `helpers/`.

The layout mirrors the source tree, so a test lives next to the name of the code it tests:

```
test/
├── helpers/                 shared helpers and mocks (never contain tests)
│   ├── index.mjs            temp dirs, real git repos, runNode(), ROOT
│   ├── sandbox.mjs          a project with a bare remote and records; an in-memory fake provider
│   ├── mock-devin.mjs       a local HTTP server that imitates the Devin v3 API
│   └── mock-daytona.mjs     a stand-in for the daytona CLI: each sandbox is a temp HOME, exec runs /bin/sh
├── core/                    one file per module in core/ (okf, audit, diffcheck, gates, cost, …)
├── orchestrator/            env, records, decisions, and lifecycle (the steps in orchestrator/steps.mjs)
├── hooks/                   the Claude Code hooks, run as Claude Code runs them
├── plugin/                  manifest, agents, skills, commands
└── sandboxes/
    ├── contract.test.mjs    the gateway's guarantees and the contract every provider must meet
    ├── local/               the local provider (git worktrees)
    ├── devin/               the Devin provider: API client, state mapping and answers, provider verbs
    └── daytona/             the Daytona provider: real remote scripts run against mock-daytona.mjs
```

## Where a new test goes

| You changed | Put the test in |
|---|---|
| `core/<module>.mjs` | `test/core/<module>.test.mjs` |
| `orchestrator/…` | `test/orchestrator/` (a new step goes in `lifecycle.test.mjs` or its own file) |
| `sandboxes/<provider>/…` | `test/sandboxes/<provider>/`, with the provider's API mocked in `test/helpers/` |
| the gateway or the contract | `test/sandboxes/contract.test.mjs` |
| `hooks/…` | `test/hooks/` |
| `agents/`, `skills/`, `commands/`, the manifest | `test/plugin/` |

Imports are relative to the test's folder: the repository root is `../..` from `test/core/` and `../../..` from `test/sandboxes/devin/`.
