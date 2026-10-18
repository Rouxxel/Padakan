---
description: "The plan gate: PRD, stories, tasks, budget and brand, approved once by the human; tools are chosen by the capability resolver"
argument-hint: "<target: what to build>"
allowed-tools: Bash, Read, Write, Agent, AskUserQuestion
---

# /padakan:plan $ARGUMENTS

The one human gate. Everything the pipelines need from the human is settled here, once.

1. `${CLAUDE_PLUGIN_ROOT}/bin/padakan gate open`.
2. Dispatch **planner** with the target (`$ARGUMENTS`) and the repository. It writes the PRD, stories and task plan to `<records>/plan/` and returns `PLAN= TASKS= STORIES=`.
3. Show the human the PRD and the task plan (summaries with links, not the whole files). Ask for approval or changes; re-dispatch planner with the changes until approved.
4. For each approved task, dispatch **capability-resolver**. It chooses the task's tools, platform and verify kit and estimates cost; this is its decision, not the human's. Show the human one summary table (target, platform, verify kit, cost range) for information only, and do not ask about it. An invalid manifest is re-dispatched once, then escalated.
5. Ask for the budget caps if `.env` has none, and write them to `<records>/.env`.
6. If `<records>/brand.md` does not exist, write it from `${CLAUDE_PLUGIN_ROOT}/templates/brand.md` with the human's logo, palette, typography and voice, and ask for approval.
7. If `ENTIRE_ENABLED=true` and `ENTIRE_SEARCH` is off, ask once whether to connect the repository to Entire for search. Record the answer in `.env`.
8. File each approved task in the tracker (`PADAKAN_TRACKER`) and add it to `state.json` with status `planned`:
   - `github` (default): `gh issue create` on the origin repository, title `<KEY>: <title>`, label `padakan`, body linking `tasks/<KEY>/`; record the issue URL on the task.
   - `linear`: create the issue with `LINEAR_API_KEY`; record its URL on the task.
   - `none`: `state.json` only.
9. `${CLAUDE_PLUGIN_ROOT}/bin/padakan gate close`. From now on nothing asks the human except a cost decision.

Follow `${CLAUDE_PLUGIN_ROOT}/orchestrator/RULES.md`. Every sub-agent gets one brief naming the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the records folder and the paths it may write, and returns one result line.
