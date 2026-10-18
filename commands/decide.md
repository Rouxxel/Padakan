---
description: "Answer a cost decision report: approve, run the cheaper option, skip, raise the budget, or abort"
argument-hint: "<D-id> <approve|cheaper|skip|raise <usd>|abort>"
allowed-tools: Bash, Read, Write
---

# /padakan:decide $ARGUMENTS

The human's answer to a cost decision report in `<records>/decisions/`.

1. Read the decision report named in `$ARGUMENTS`. Refuse an answer that the report does not offer (for example skipping a required check).
2. Record the answer in the report's Answer section and in the cost ledger (a `decision` line from `core/cost.mjs`), and append it to the audit trail (`core/audit.mjs`).
3. Resume the paused tree accordingly: run the step, run the cheaper option, mark the optional check as skipped in `state.json` (it then needs a human merge), raise the cap (`raiseBudget` on the tree), or abort and escalate.

Validation and the answer schema: `documentation/tech_docs/IMPLEMENTATION-DEVIN-COSTGATE.md` §C.5.

Follow `${CLAUDE_PLUGIN_ROOT}/orchestrator/RULES.md`. Every sub-agent gets one brief naming the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the records folder and the paths it may write, and returns one result line.
