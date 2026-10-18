---
description: "Roll back a task's deployed change"
argument-hint: "<TASK-KEY>"
allowed-tools: Bash, Read
---

# /padakan:rollback $ARGUMENTS

The human's right to undo at any time.

1. Find the task's deploy record in `<records>/tasks/<KEY>/deploy.json`.
2. Roll back through the deploy adapter (`core/deploy.mjs`, issue #19): turn the flag off and restore the previous release.
3. Append the rollback to the audit trail and escalate the task with the reason.
