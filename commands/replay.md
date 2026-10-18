---
description: "Replay the signed audit trail for a task"
argument-hint: "<TASK-KEY>"
allowed-tools: Bash
---

# /padakan:replay $ARGUMENTS

Read-only.

1. `node ${CLAUDE_PLUGIN_ROOT}/core/audit.mjs verify <records>`. If the chain is broken, say so first.
2. `node ${CLAUDE_PLUGIN_ROOT}/core/audit.mjs replay <records> <KEY>` and show the entries in order.
