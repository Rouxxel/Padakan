---
type: Catalog
title: Padakan skills
description: Every skill the plugin ships, with when to load it. Kept in sync with the folders by test/skills.test.mjs.
tags: [skills, catalog]
timestamp: 2026-10-18T00:00:00Z
---

# Padakan skills

| Skill | When to load it |
|---|---|
| [`cost-gate`](./cost-gate/SKILL.md) | How the cost gate works and how to report spend: estimates as ranges, required versus optional steps, pausing over budget, decision reports. Load when estimating, spending or reporting cost. |
| [`e2e-playbook`](./e2e-playbook/SKILL.md) | How to write a critical-flow end-to-end spec that is trustworthy: soft assertions per criterion, judging on captured traffic, fresh identities, never production, not-exercised is never a pass. Load when writing or running e2e specs. |
| [`entire-context`](./entire-context/SKILL.md) | How agents use Entire, when enabled, to answer questions about intent and code before guessing: search over past sessions, checkpoints, and the local code graph. Load before asking anything about why code is the way it is. |
| [`escalation`](./escalation/SKILL.md) | When and how to escalate to a human: the default whenever a check does not clearly pass. Load when a gate is unclear or work is blocked. |
| [`evidence-pack`](./evidence-pack/SKILL.md) | The four items every change must carry (video, architecture of the change, files touched, tests and CI), how each is produced and how it is verified. Load when recording or assembling evidence. |
| [`feature-docs`](./feature-docs/SKILL.md) | The five documents every critical feature ships with (feature, stories, workflow, playbook, setup) and the rules that link them. Load when creating or checking a feature folder. |
| [`no-questions`](./no-questions/SKILL.md) | The no-questions rule: Padakan agents never ask a human anything except at the plan gate and the cost gate. Load when you are unsure what to do. |
| [`okf`](./okf/SKILL.md) | How to write an Open Knowledge Format document: frontmatter fields, one concept per file, links, index.md and log.md. Load before writing any markdown file Padakan keeps. |
| [`triage-categories`](./triage-categories/SKILL.md) | The eight categories the monitor loop sorts production errors into, and where each goes. Load when triaging logs. |
| [`verify-android`](./verify-android/SKILL.md) | The verify kit for Android targets: AndroidBuildMCP or adb-mcp, Gradle, the emulator, logcat and screen recording. Load when proving an Android change. |
| [`verify-backend`](./verify-backend/SKILL.md) | The verify kit for backend and API targets: HTTP probes, container logs, the project's test runner. Load when proving a backend change. |
| [`verify-ios`](./verify-ios/SKILL.md) | The verify kit for iOS targets: MobileBuildMCP or xcodebuild and simctl on a macOS sandbox, simulator recording. Load when proving an iOS change. |
| [`verify-web`](./verify-web/SKILL.md) | The verify kit for web targets: Playwright MCP, Chrome DevTools MCP, browser logs, unit tests, video and trace. Load when proving a web change. |
