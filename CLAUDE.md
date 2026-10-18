# Working on the Padakan plugin

This file is for contributors building the plugin. The orchestrator's own rules, which the plugin gives to its users' sessions, are in `orchestrator/RULES.md` (Claude Code does not load a plugin's `CLAUDE.md`, so a SessionStart hook injects them).

## Read first

- `documentation/tech_docs/ARCHITECTURE.md`: what Padakan does.
- `documentation/tech_docs/PLUGIN-STRUCTURE.md`: where every file goes and every `.env` setting.
- `documentation/tech_docs/IMPLEMENTATION-DEVIN-COSTGATE.md`: the Devin provider, cost gate and decision report plan.

## Rules for code in this repo

- **Node 22+, zero dependencies.** Built-ins only (`fetch`, `node:test`, `node:fs/promises`, `node:crypto`, `node:child_process`). No npm packages.
- **Tests with every change.** `npm test` runs `node --test` over `test/**/*.test.mjs`. A module without tests is not done.
- **Deterministic where it decides.** Nothing in `core/` calls a model to decide whether a change may ship.
- **Settings only from `.env`**, through `orchestrator/lib/env.mjs`. Never read `process.env` for a Padakan setting anywhere else.
- **Secrets** are never logged, written to the records folder, put in a prompt or included in an error.
- **OKF** for every markdown document the plugin writes: frontmatter with `type`, `title`, `description`, `tags`, `timestamp`.
- **Records live outside the repo**, resolved only by `orchestrator/lib/records.mjs`.

## Workflow

- One GitHub issue per change, labeled by area and priority. Branch `<issue>-<slug>`, a PR that closes the issue, squash-merged into `main` once `npm test` passes.
- No AI attribution lines in commits or PRs beyond the team's agreed trailer.
- Check the plugin with `npm run check` (tests plus `claude plugin validate .`).
