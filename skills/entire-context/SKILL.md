---
name: entire-context
description: "How agents use Entire, when enabled, to answer questions about intent and code before guessing: search over past sessions, checkpoints, and the local code graph. Load before asking anything about why code is the way it is."
---

# Ask Entire first

Only when `ENTIRE_ENABLED=true`.

| Question | Command |
|---|---|
| Why was this built this way? What did the developers intend? | `entire search "<topic>" --compact --limit 5` (needs `ENTIRE_SEARCH=on`), then `entire checkpoint explain <id>` |
| Where is X implemented? | `entire graph query "<plain-language task>"` |
| What is the definition of X? | `entire graph def <symbol>` |
| What calls X, or what does X call? | `entire graph neighbors <symbol>` |
| What would changing X affect? | `entire graph impact <symbol>` |
| What changed semantically on this branch? | `entire graph diff main..HEAD` |

- The graph is local (no network); search needs the repo connected to Entire, so with `ENTIRE_SEARCH=off` skip it.
- Quote what you used (checkpoint id, `file:line`) in your notes.
- If Entire has no answer, follow the `no-questions` skill.
