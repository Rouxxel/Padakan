---
type: Decision Report
title: <D-nnnn> · <TASK> · <step> over budget
description: <One sentence: what is paused and what is being asked.>
tags: [decision, cost]
timestamp: <YYYY-MM-DDTHH:MM:SSZ>
id: <D-nnnn>
task: <TASK>
step: <step>
tree: <tree id or none>
run: <run id>
reason: <task-cap | step-cap | run-cap | session-cap-hit | cap-below-low | no-price>
required: <true | false>
status: open
unit: <acu | ci_minute | ...>
high_usd: <n>
recommendation: <approve | cheaper:<name> | skip | raise | abort>
alternatives: [<names of cheaper options>]
---

# <D-nnnn> · <step> for <TASK> is over budget

> Written by `padakan decision` (numbers, options) and `report-writer` (prose). Every number comes
> from the cost gate and the ledger; none is estimated by hand. Machine data: `<D-nnnn>.json`.

## What

The step and the task it belongs to.

## Why it matters

The claim this step proves and the risk it covers.

## Cost

| | Low | Likely | High |
|---|---|---|---|
| This step (<unit>) | <n> | <n> | <n> |
| This step (USD) | $<n> | $<n> | $<n> |

Budget left: step $<n> · task $<n> · run $<n>. Spent so far on this task: $<n>.
Paused because: <reason>.

## Options

| Option | Cost (high) | What it leaves uncovered |
|---|---|---|
| approve | $<n> | nothing |
| cheaper:<name> | $<n> | <gap> |
| skip *(optional steps only)* | $0 | <what stays unverified>; the change will not auto-ship |
| raise | | the budget is raised and the gate runs again |
| abort | $0 | the task is escalated to a human |

## If skipped

What stays unverified, in one paragraph. (Left out when the step is required: required steps can never be skipped for cost.)

## Recommendation

One option and why, in two sentences.

## Answer

`/padakan:decide <D-nnnn> <approve | cheaper:<name> | skip | raise:<usd> | abort>`
