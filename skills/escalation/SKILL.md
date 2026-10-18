---
name: escalation
description: "When and how to escalate to a human: the default whenever a check does not clearly pass. Load when a gate is unclear or work is blocked."
---

# Escalation

Escalation is the default whenever a check does not clearly pass. It hands the task to a human; it never blocks other work.

Escalate when:
- a verification gate returns `ESCALATE` or a result line is ambiguous;
- a tree reports `BLOCKED=`;
- a deploy rolls back;
- a monitor cluster is security, infra, data or unknown;
- a required check cannot run.

How:
1. Write `<records>/tasks/<KEY>/escalation.md` (OKF, `type: Escalation`): what happened, the evidence (paths, not prose), what was tried, what a human needs to decide.
2. File it in the tracker (`PADAKAN_TRACKER`) with a link to that file. Only the orchestrator files tickets.
3. Record it in the audit trail. Move on to other work.
