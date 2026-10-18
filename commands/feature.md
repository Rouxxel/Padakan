---
description: "Scaffold a critical feature's five documents and its spec"
argument-hint: "<area>/<slug>"
allowed-tools: Bash, Read, Write
---

# /padakan:feature $ARGUMENTS

Load the `feature-docs` and `e2e-playbook` skills.

1. Create `features/$ARGUMENTS/` with `feature.md`, `stories.md`, `workflow.md` (with a diagram), `playbook.md` and `setup.md`, each a valid OKF document, plus `tests/<slug>.spec.ts` with one labelled soft assertion per criterion.
2. Check them with `node ${CLAUDE_PLUGIN_ROOT}/core/okf.mjs features/$ARGUMENTS`.
3. Report the stories, criteria and assertions counts.

Follow `${CLAUDE_PLUGIN_ROOT}/orchestrator/RULES.md`. Every sub-agent gets one brief naming the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the records folder and the paths it may write, and returns one result line.
