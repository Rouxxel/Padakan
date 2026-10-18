---
description: "Build and verify a task's evidence pack"
argument-hint: "<TASK-KEY>"
allowed-tools: Bash, Read, Agent
---

# /padakan:evidence $ARGUMENTS

1. `${CLAUDE_PLUGIN_ROOT}/bin/padakan evidence <KEY>` to pull what the tree recorded.
2. Dispatch **evidence-builder** to assemble the four items and render the evidence report.
3. Report `PACK= ITEMS= MISSING=` from its result line.

Follow `${CLAUDE_PLUGIN_ROOT}/orchestrator/RULES.md`. Every sub-agent gets one brief naming the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the records folder and the paths it may write, and returns one result line.
