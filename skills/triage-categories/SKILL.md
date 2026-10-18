---
name: triage-categories
description: "The eight categories the monitor loop sorts production errors into, and where each goes. Load when triaging logs."
---

# Triage categories

| Category | Examples | Route |
|---|---|---|
| Code defect | crash, wrong output, regression, validation error | becomes a task; may be fixed by an agent |
| Performance / SLO | latency, memory leak, timeouts | becomes a task; usually escalated |
| Infra / config | OOM, restart loop, bad env var, disk | human |
| Security | auth spikes, secret in logs, injection attempts | human at once, never automatic |
| External dependency | third-party 5xx, DNS, quota | watch and retry, no change |
| Data issue | bad record, failed migration | human |
| Noise / expected | 4xx, health checks, known warnings | drop |
| Unknown / low confidence | cannot classify, conflicting signals | human (the default) |

- Each cluster also gets a severity (P0 to P3) and a fixable flag.
- A cluster with an open task for the same fingerprint never opens a second one.
- When in doubt between two categories, pick the one that routes to a human.
