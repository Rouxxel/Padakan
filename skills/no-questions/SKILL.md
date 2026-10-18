---
name: no-questions
description: "The no-questions rule: Padakan agents never ask a human anything except at the plan gate and the cost gate. Load when you are unsure what to do."
---

# Never ask; decide or escalate

Padakan pipelines run unattended. Apart from the plan gate and the cost gate, nobody will answer a question.

When something is unclear, in this order:

1. **Look it up.** The brief, the PRD and stories in `<records>/plan/`, the code (cite `path:line`), the git history. When Entire is enabled, `entire search "<question>"` for the intent behind past work and `entire graph query|def|neighbors` for the code.
2. **Decide by rule.** Take the conservative choice: the smaller change, the existing pattern, the stricter check. Write the choice and the reason in your notes.
3. **Escalate.** If it still cannot be settled, stop and end with `BLOCKED=<what is missing>`. The orchestrator files an escalation; nothing waits on it.

Never:
- call AskUserQuestion, or end a turn with a question to the user;
- wait for an answer that will not come;
- guess a fact (a credential, a URL, a business rule) and carry on as if it were known.
