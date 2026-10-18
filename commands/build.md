---
description: "Build one task end to end: tree, tests, implementation, verification, merge, retire"
argument-hint: "<TASK-KEY>"
allowed-tools: Bash, Read, Agent
---

# /padakan:build $ARGUMENTS

Unattended. Never ask the human; decide by rule or escalate.

1. **Cost:** check the task's manifest estimate with the cost gate (`core/cost.mjs`). Over budget: dispatch **report-writer**, stop this task and wait for `/padakan:decide`.
2. **Tests first:** dispatch **test-writer** with the task's criteria. It returns `TESTS= ACS= RED=`.
3. **Tree:** dispatch **tree-operator** to run `${CLAUDE_PLUGIN_ROOT}/bin/padakan plant <KEY>`, write the brief (OKF, from the task, its criteria, the manifest and the limits), `${CLAUDE_PLUGIN_ROOT}/bin/padakan brief <KEY> <brief>`, and `${CLAUDE_PLUGIN_ROOT}/bin/padakan attach <KEY>`.
4. **Wait on effects:** dispatch **tree-operator** to run `${CLAUDE_PLUGIN_ROOT}/bin/padakan poll <KEY>` until `EFFECT=done` or the tree reports `BLOCKED=`. A blocked tree is escalated, not nursed; a wedged one is recycled with `${CLAUDE_PLUGIN_ROOT}/bin/padakan recycle <KEY>`.
5. **Prove:** dispatch **test-runner** (writes `checks/tests.json` and `suite.json`), **acceptance-tester** (`checks/acceptance.json`), and **security-auditor** when the change touches auth, data scoping, secrets or input handling.
6. **Evidence:** `${CLAUDE_PLUGIN_ROOT}/bin/padakan evidence <KEY>`, then dispatch **evidence-builder** (`checks/evidence.json` and the evidence report).
7. **Decide:** dispatch **verifier**, which runs `${CLAUDE_PLUGIN_ROOT}/bin/padakan verify <KEY>`.
   - `SHIP`: `${CLAUDE_PLUGIN_ROOT}/bin/padakan merge <KEY>`, then the gated deploy.
   - `HUMAN_MERGE`: leave the PR for a human; do not merge.
   - `ESCALATE`: escalate with the verify report.
8. **Retire:** dispatch **tree-operator** to run `${CLAUDE_PLUGIN_ROOT}/bin/padakan retire <KEY>`.

Follow `${CLAUDE_PLUGIN_ROOT}/orchestrator/RULES.md`. Every sub-agent gets one brief naming the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the records folder and the paths it may write, and returns one result line.
