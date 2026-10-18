---
description: "Answer a cost decision report: approve, run the cheaper option, skip, raise the budget, or abort"
argument-hint: "<D-id> <approve|cheaper:<name>|skip|raise:<usd>|abort>"
allowed-tools: Bash, Read
---

# /padakan:decide $ARGUMENTS

The human's answer to a cost decision report in `<records>/decisions/`. This is the only question Padakan asks after the plan gate.

1. If no decision id was given, list the open reports (`status: open` in `<records>/decisions/D-*.md`) with their task, step, reason and recommendation, and stop.
2. Read `<records>/decisions/<id>.md` and show the human its Cost, Options and Recommendation sections, quoting the numbers as written.
3. Run, exactly once: `node "${CLAUDE_PLUGIN_ROOT}/bin/padakan" decide $ARGUMENTS`
   It validates the answer, writes the `decision` line to the cost ledger, the answer to `<id>.answer.json`, marks the report answered and appends to the audit trail (`core/audit.mjs`).
4. Report the result line as is. `ACTION=` says what happened:
   - `raised`: the capped Devin session was archived and a continuation session started with the new cap (`raiseBudget` on the tree; `SESSION=`, `MAX_ACU=`).
   - `run-step` / `regated-run`: the step passes the gate now; run it (a step that never started is planted again).
   - `run-alternative`: run the cheaper option named in the answer instead.
   - `skipped`: the optional check is waived in `state.json`; the change then needs a human merge.
   - `new-decision`: the gate still pauses (`NEXT=` names the new report); nothing was spent.
   - `escalated`: the task is escalated and its tree paused; retire it later with the retire step.
5. On `DECIDED=refused`, show the `REASON` and the allowed answers. A required step can never be skipped; `raise:<usd>` must be higher than the current cap; an answered report cannot be answered again.

Never answer a decision report on the human's behalf, and never edit the report or the ledger by hand. Validation and the answer schema: `documentation/tech_docs/IMPLEMENTATION-DEVIN-COSTGATE.md` §C.5 (`orchestrator/decisions.mjs`, `schemas/decision-answer.json`).

Follow `${CLAUDE_PLUGIN_ROOT}/orchestrator/RULES.md`. Every sub-agent gets one brief naming the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the records folder and the paths it may write, and returns one result line.
