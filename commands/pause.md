---
description: "The kill switch: pause one task's tree, or every tree"
argument-hint: "[TASK-KEY|all]"
allowed-tools: Bash
---

# /padakan:pause $ARGUMENTS

The human's right to stop the line at any time.

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/padakan pause $ARGUMENTS` (a task key, or `all`). It pauses each tree whose provider supports `pause`, marks the tasks `paused` in `state.json` so no step runs for them, and appends each pause to the audit trail.
2. Show its result line.
3. Report what was paused and how to resume (`/padakan:build <KEY>`).
