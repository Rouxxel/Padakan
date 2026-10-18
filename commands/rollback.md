---
description: "Roll back a task's deployed change"
argument-hint: "<TASK-KEY>"
allowed-tools: Bash, Read
---

# /padakan:rollback $ARGUMENTS

The human's right to undo at any time.

1. Find the task's deploy record in `<records>/tasks/<KEY>/deploy.json`.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/padakan rollback <KEY>`: the deploy adapter (`core/deploy.mjs`) turns the flag off and restores the previous release; the task is escalated and the rollback is audited.
3. Show its result line.
