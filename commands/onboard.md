---
description: "Set Padakan up for this repository: records folder, settings in .env, environment checks"
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# /padakan:onboard

Onboarding is part of the plan gate: it is one of the two times the human is asked anything.

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/padakan init` to create the records folder next to the repository. Report its path.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/padakan gate open` so the human may be asked during setup.
3. Read `${CLAUDE_PLUGIN_ROOT}/.env.example`. Ask the human, in as few questions as possible, for the settings this project needs: sandbox provider and its credentials (`DEVIN_API_KEY`, `DEVIN_ORG_ID`, `PADAKAN_DEVIN_USD_PER_ACU` for Devin), `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`, budget caps (`PADAKAN_BUDGET_*_USD`), protected paths, tracker, and whether to enable Entire.
4. Write the answers to `<records>/.env` (never to the repository; chmod 600). Never echo a secret back.
5. Run `${CLAUDE_PLUGIN_ROOT}/bin/padakan doctor` and show its output verbatim. Fix what the human can fix now; list the rest.
6. Leave the gate open and tell the human the next step is `/padakan:plan`.

Follow `${CLAUDE_PLUGIN_ROOT}/orchestrator/RULES.md`. Every sub-agent gets one brief naming the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the records folder and the paths it may write, and returns one result line.
