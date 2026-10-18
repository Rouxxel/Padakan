<div align="center">

# Padakan

**Autonomous development you can trust.**
A Claude Code plugin that lets coding agents plan, fix, verify and ship on their own, and only lets a change reach production once the system has proven it safe.

[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://docs.claude.com/en/docs/claude-code)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Nebius Token Factory](https://img.shields.io/badge/Nebius-Token_Factory-052B42?style=for-the-badge)](https://docs.tokenfactory.nebius.com)
[![NVIDIA Nemotron](https://img.shields.io/badge/NVIDIA-Nemotron-76B900?style=for-the-badge&logo=nvidia&logoColor=white)](https://nebius.com/services/token-factory/nemotron)
<br>
[![Daytona](https://img.shields.io/badge/Sandboxes-Daytona-1F2937?style=for-the-badge)](https://www.daytona.io)
[![Devin](https://img.shields.io/badge/Sessions-Devin-0B6E4F?style=for-the-badge)](https://docs.devin.ai)
[![herdr](https://img.shields.io/badge/Terminal-herdr-4B5563?style=for-the-badge)](#)
[![Entire](https://img.shields.io/badge/Context-Entire-111827?style=for-the-badge)](https://entire.io)
[![OKF](https://img.shields.io/badge/Docs-Open_Knowledge_Format-4285F4?style=for-the-badge)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
<br>
[![Status](https://img.shields.io/badge/status-design-F59E0B?style=flat-square)](documentation/tech_docs/PLUGIN-STRUCTURE.md)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue?style=flat-square)](LICENSE)

</div>

## Why

Pointing a coding agent at a task and getting a plausible change is a solved problem. Shipping that change without a human reading it is not, so a human stays in the loop, the loop becomes the bottleneck, and the autonomy disappears. That is a trust problem, not a capability problem.

Padakan solves it with the system around the agent. The agent is a black box that can be swapped. What earns the trust is the set of checks, gates, evidence and records that every change passes through.

## What it does

| | |
|---|---|
| **One human gate, up front** | The human approves the PRD, the task plan, the budget and the brand once. A decision model, not the human, picks the tools each agent gets. After that nothing asks a question, unless a step would break the budget. |
| **The orchestrator only decides** | It decides, dispatches, merges, deploys and records. Sub-agents do all other work and return one line each, so the orchestrator stays fast over long runs. |
| **One sandbox per task** | Each agent works in its own Daytona sandbox or Devin session, watched live in herdr. |
| **Proven, not claimed** | Every change is proven twice, by its tests and live against the running app. The full suite and the critical-flow e2e suite stay green, and deterministic diff inspection confirms the change stays within its limits and touches no protected path, secret or unapproved dependency. |
| **Evidence on every PR** | A video of the change working, the architecture of the issue, the files touched and the CI results, each re-checked at its source. |
| **Safe to fail** | Gated deploy behind a flag and a canary, with automatic rollback when an SLO slips. |
| **Self-healing** | A monitor loop reads production logs, triages them with Nemotron on Nebius, and turns fixable defects into new tasks. |
| **Everything on the record** | A hash-chained audit trail and an Open Knowledge Format bundle of every brief, report and decision, kept next to the repo. |

## Install

In Claude Code (2.1.275 or later):

```
/plugin install padakan --marketplace Rouxxel/Padakan
```

## Status

In development. The build is tracked as GitHub issues, one per module; the plugin is not usable end to end yet. Setup steps will be added here as modules land.

## Documentation

| You want | Read |
|---|---|
| A visual walkthrough | [documentation/tech_docs/blueprint.html](documentation/tech_docs/blueprint.html) (open in a browser) |
| The architecture | [documentation/tech_docs/ARCHITECTURE.md](documentation/tech_docs/ARCHITECTURE.md) |
| The system diagram | [documentation/tech_docs/diagrams/system-overview.svg](documentation/tech_docs/diagrams/system-overview.svg) |
| The plugin's file structure and every `.env` setting | [documentation/tech_docs/PLUGIN-STRUCTURE.md](documentation/tech_docs/PLUGIN-STRUCTURE.md) |
| Every API, framework and tool used | [documentation/infrastructure/TOOLS.md](documentation/infrastructure/TOOLS.md) |
| Report and brand templates | [templates/](templates/) |

## Origin

Padakan started at the AI Hackathon with Nebius and NVIDIA in Berlin (October 2026).

## License

[Apache 2.0](LICENSE)
