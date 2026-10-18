---
description: "Run one monitor tick: collect production logs, triage, and turn fixable defects into tasks"
allowed-tools: Bash, Read, Agent
---

# /padakan:watch

One tick of the monitor loop (scheduled every `PADAKAN_WATCH_INTERVAL_MIN` minutes).

1. Dispatch **bug-agent** for this tick. It runs the collector and triage (`core/collect-logs.mjs`, `core/triage.mjs`, issue #17) and returns `CLUSTERS= FIXABLE= HUMAN= REPORT=`.
2. For each fixable key: check `state.json` for an open task with the same fingerprint; if none, file a task and add it with status `planned`.
3. Escalate every cluster routed to a human (security, infra, data, unknown).
4. Append the tick to the audit trail.

Follow `${CLAUDE_PLUGIN_ROOT}/orchestrator/RULES.md`. Every sub-agent gets one brief naming the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the records folder and the paths it may write, and returns one result line.
