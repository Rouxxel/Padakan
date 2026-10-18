---
name: feature-docs
description: "The five documents every critical feature ships with (feature, stories, workflow, playbook, setup) and the rules that link them. Load when creating or checking a feature folder."
---

# The five feature documents

Every critical feature lives in `features/<area>/<slug>/`:

| File | Owns |
|---|---|
| `feature.md` | what it is, who it serves, what breaks without it, priority and risk |
| `stories.md` | `US1`…`USn`: a real role and one outcome each, with "done when" |
| `workflow.md` | the architecture (with a diagram) and how to confirm each effect at its source |
| `playbook.md` | the steps and the criteria `AC1`…`ACn`, and which story each criterion judges |
| `setup.md` | what it needs before it can run, and what it costs |
| `tests/<slug>.spec.ts` | the playbook as a test: one test, one soft assertion per criterion, labelled `ACn: …` |

Rules, enforced by the CI docs gate:
- every story has at least one criterion, and every criterion belongs to a story;
- every criterion in the playbook has a matching labelled assertion in the spec;
- `workflow.md` has a diagram;
- all five documents are valid OKF;
- a criterion the product fails is never weakened or deleted: it goes to the known-defect ledger with its issue.
