---
name: evidence-pack
description: "The four items every change must carry (video, architecture of the change, files touched, tests and CI), how each is produced and how it is verified. Load when recording or assembling evidence."
---

# The evidence pack

| # | Item | Produced by | Verified by |
|---|---|---|---|
| 1 | **Video** of the change working | the building agent, with the verify kit | opened; it follows the acceptance criteria's steps |
| 2 | **Architecture of the change** | the building agent | compared with the real diff and call graph |
| 3 | **Files touched or edited** | git, mechanically | recomputed from git |
| 4 | **Tests and CI** | the task's tests, the suite, the e2e run | re-read from CI |

Inside a tree, record under `.padakan/evidence/`: `run.mp4` (or `.webm`), `trace.zip`, numbered screenshots (`01-<step>.png`), and `notes.md` with one line per criterion: `ACn | pass|fail | evidence`.

Rules:
- An item is `verified` only after the orchestrator's verifier opened it at its source. `present` is only a claim.
- A missing item stays missing; never fill it with prose.
- Never record credentials on screen or in a file.
