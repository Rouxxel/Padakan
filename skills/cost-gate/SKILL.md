---
name: cost-gate
description: "How the cost gate works and how to report spend: estimates as ranges, required versus optional steps, pausing over budget, decision reports. Load when estimating, spending or reporting cost."
---

# The cost gate

The only question Padakan ever asks a human after the plan gate is about money.

- **Estimates** are ranges in native units: `{ step, unit, low, likely, high, required }` (units: Devin ACU, model tokens, CI or device minutes). The gate compares the **high** value against the budget left at step, task and run level (`PADAKAN_BUDGET_*_USD`).
- **Within budget:** the step runs and the spend is logged to `<records>/cost/ledger.jsonl` (by the orchestrator).
- **Over budget:** only that tree pauses; nothing is spent; `report-writer` writes a decision report to `<records>/decisions/`; the human answers with `/padakan:decide`.
- **A missing price pauses.** The gate never assumes something is free.
- **Never waived for cost:** the build session, the task's tests, the regression suite, diff inspection. Optional examples: device probes, video recording, a browser matrix, a second e2e run.
- A change shipped with a skipped optional check goes to a human merge, never straight to production.

Implementation: `core/cost.mjs` (see `documentation/tech_docs/IMPLEMENTATION-DEVIN-COSTGATE.md` §B and §C).
