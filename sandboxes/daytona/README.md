---
type: Guide
title: Daytona sandbox provider
description: How to bake the snapshot and run Padakan trees as Daytona sandboxes, with Claude Code driven by herdr inside each one.
tags: [sandboxes, daytona, setup]
timestamp: 2026-10-18T00:00:00Z
resource: https://www.daytona.io/docs
---

# Daytona sandbox provider

Every Padakan tree is one Daytona sandbox created from a snapshot that holds tooling only. Padakan runs its own agent inside it: Claude Code, under a herdr server that owns the agent's terminal, so `herdr agent list` reports real state. Use it when you want Claude Code as the builder instead of Devin, or when a task needs a shell, a browser and a preview URL you control.

Set `PADAKAN_SANDBOX_PROVIDER=daytona` in `<records>/.env`.

## Setup

1. Install the CLI and log in, or put `DAYTONA_API_KEY` in `<records>/.env`:
   ```bash
   brew install daytonaio/cli/daytona
   daytona login
   ```
2. Bake the snapshot once (CPU, memory and disk are fixed here; `create` cannot change them):
   ```bash
   daytona snapshot create padakan-base \
     --dockerfile sandboxes/daytona/snapshot/Dockerfile --cpu 2 --memory 4 --disk 10
   ```
3. Set what `seed` needs: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), optionally `CLAUDE_CODE_OAUTH_FALLBACK_TOKEN`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, and a GitHub token source (`GH_TOKEN_SOURCE=host` uses `gh auth token`; `pat` uses `GH_PAT`).
4. Run `padakan doctor`. It checks the CLI, auth, the snapshot and these settings.

## What each verb does

| Verb | How |
|---|---|
| `create` | `daytona create --name <id> --snapshot --target --auto-stop --auto-delete --label purpose=padakan --label tree=<id>`. The base commit must already be on the remote. No secret and no `-e` on this line: `-e` is metadata anyone in the org can read. |
| `seed` | Writes `~/.claude-env` (mode 600, sourced from `.bashrc`), the token picker `~/.local/bin/claude-token.sh`, `gh auth login` from a token file deleted at once plus `gh auth setup-git`, the git identity, `~/.claude/settings.json` (tree model, no attribution) and the fenced blocks of `~/.claude/CLAUDE.md`. Running it twice changes nothing. |
| `bootstrap` | Runs `remote/bootstrap.sh`: clone, then check out the task branch (local, remote, or new from the base). Success is the last line `BOOTSTRAP-OK`. Idempotent. |
| `exec` | One shell string in the checkout. The exit status comes from a per-run sentinel file read by a second exec; a missing sentinel returns `code: -1`, a failure. Secret values in the output are replaced by `***`. |
| `push` · `pull` | base64 over exec in chunks under ARG_MAX, decoded and size-checked in the sandbox; folders travel as tar. Credential-shaped files and paths outside the checkout are refused. |
| `attach` | Starts the herdr server with Claude's auth in its environment, the workspace and the agent (`--dangerously-skip-permissions`), then clears the folder-trust dialog, whose default is "No, exit". With `PADAKAN_DRIVER=headless` it returns the agent log instead. |
| `brief` | Delivers `.padakan/BRIEF.md`, then prompts the herdr agent, or starts `claude -p` under nohup when headless. |
| `url` | `daytona preview-url <id> -p <port>`, matched on `daytonaproxy`. |
| `status` | `daytona info`: started is live (done when `.padakan/DONE` exists), stopped or archived is paused, deleted or an error is gone. |
| `pause` · `resume` | `daytona stop` · `daytona start`. |
| `evidence` | Pulls `.padakan/evidence/` into `<records>/tasks/<KEY>/evidence/daytona/`. |
| `retire` | Pulls `.padakan/record.md`, then destroys (never forced). |
| `destroy` | Refuses with uncommitted or unpushed work unless forced; a stopped sandbox is started to check. The branch on the remote is kept. |

`padakan plant` runs `create`, then `seed`, then `bootstrap`.

## Watching a tree

```bash
daytona ssh <id>
herdr --session padakan-<id>
```

## Files

- `provider.mjs`: the verbs above. The CLI can be replaced through `ctx.daytonaRun`, which is how `test/sandboxes/daytona/` runs every remote script against a local shell.
- `doctor.mjs`: onboarding checks.
- `snapshot/Dockerfile`: Ubuntu 24.04 (linux/amd64), Node 22, gh, Playwright with Chromium and Chrome, Playwright MCP, Claude Code, herdr and its Claude hook, onboarding pre-cleared, `CMD ["sleep", "infinity"]`. No secrets.
- `remote/bootstrap.sh`, `remote/claude-token.sh`, and the `CLAUDE-*.md` blocks the tree agent reads (tree rules, evidence recording, the 10 GB disk ceiling).

## Not yet checked live

The tests run the real remote scripts against a mock CLI. A first run against a real Daytona org still has to confirm the `daytona info` output format and the herdr attach sequence on the baked snapshot.
