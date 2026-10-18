# APIs, frameworks and tools

Every external service, framework and tool Padakan uses, what it does for us, and where it is configured. Settings are environment variables (see `../tech_docs/PLUGIN-STRUCTURE.md` §5).

## Platform

| Tool | Role in Padakan | Configured by | Link |
|---|---|---|---|
| **Claude Code** | Host of the plugin; runs the orchestrator and the sub-agents; default agent inside trees | `CLAUDE_CODE_OAUTH_TOKEN`, `PADAKAN_TREE_MODEL` | https://docs.claude.com/en/docs/claude-code |
| **herdr** | Terminal multiplexer for coding agents; every tree agent runs in a pane the human can watch; the orchestrator drives agents through its agent API | `PADAKAN_TERMINAL`, `PADAKAN_DRIVER` | |
| **Node.js 22** | All plugin scripts (`orchestrator/`, `sandboxes/`, `core/`), zero dependencies, `node --test` | | https://nodejs.org |

## Models

| Tool | Role | Configured by | Link |
|---|---|---|---|
| **Nebius Token Factory** | OpenAI-compatible API over open models; serves the decision models and the `openai-compat` builder harness | `NEBIUS_API_KEY`, `NEBIUS_BASE_URL` (`https://api.tokenfactory.nebius.com/v1/`) | https://docs.tokenfactory.nebius.com |
| **NVIDIA Nemotron** | Default triage and capability-resolver model (`nvidia/nemotron-3-super-120b-a12b`: 128K context, function calling and structured output) | `PADAKAN_TRIAGE_MODEL`, `PADAKAN_RESOLVER_MODEL` | https://nebius.com/services/token-factory/nemotron |

## Sandboxes and agents

| Tool | Role | Configured by | Link |
|---|---|---|---|
| **Devin** | Default sandbox provider: one session per task in a VM booted from our snapshot (blueprints); Linux, macOS (Xcode, iOS Simulator) or Windows; Computer Use with recorded testing; loads Claude Code plugins. Research: [DEVIN.md](DEVIN.md) | `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `DEVIN_PLATFORM`, `DEVIN_MAX_ACU` | https://docs.devin.ai |
| **Daytona** | Alternative provider when we run our own agent (Claude Code + herdr) in a sandbox we control. 10 GB disk per sandbox by default | `DAYTONA_*` | https://www.daytona.io/docs |
| **GitHub + gh CLI** | Clone, branch, push, PRs, CI status | `GH_TOKEN_SOURCE`, `GH_PAT` | https://cli.github.com |

## Context

| Tool | Role | Configured by | Link |
|---|---|---|---|
| **Entire** (optional) | Agent sessions captured as checkpoints linked to commits; `entire search` over sessions, commits and code (needs the repo connected to Entire) | `ENTIRE_ENABLED`, `ENTIRE_SEARCH`, `ENTIRE_REPO` | https://entire.io · https://docs.entire.io |
| **Entire Graph** (optional) | Local code graph (tree-sitter, no network): `query`, `def`, `neighbors`, `impact`, `diff`; used by agents for code questions and by diff inspection for blast radius | `ENTIRE_ENABLED` | https://github.com/entireio/entire-graph |
| **Linear** | Issues: the orchestrator files and updates them; trees never get access | `PADAKAN_TRACKER`, `LINEAR_API_KEY` | https://linear.app |

## Knowledge format

| Format | Role | Link |
|---|---|---|
| **Open Knowledge Format (OKF v0.1)** | Every document an agent writes: markdown with YAML frontmatter (`type` required; `title`, `description`, `resource`, `tags`, `timestamp`), one concept per file, `index.md` and `log.md` per bundle. Validated by `core/okf.mjs` | https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing |

## Verification (verify kits)

| Tool | Target | Link |
|---|---|---|
| **Playwright** + **Playwright MCP** | Web: drive and assert in a browser; video, trace, screenshots | https://playwright.dev |
| **Chrome DevTools MCP** | Web: console, network, performance | https://github.com/ChromeDevTools/chrome-devtools-mcp |
| **MobileBuildMCP** (getsentry, formerly XcodeBuildMCP) | iOS: build, run and test on the simulator, UI automation, logs; macOS 14.5+, Xcode 16+ | https://github.com/getsentry/MobileBuildMCP |
| **AndroidBuildMCP** or **adb-mcp** | Android: Gradle build, emulator, UI tree, logcat, screen recording; Android SDK, JDK 17+ | https://github.com/dev-jackson/androidbuild-mcp · https://github.com/iksnerd/adb-mcp |
| **ffmpeg** | Merge recorded clips into one seekable H.264 video per run | https://ffmpeg.org |
| **Docker** | Log source for the monitor loop (`docker logs`) | https://docs.docker.com |

## Deploy

| Tool | Role | Configured by |
|---|---|---|
| Simulated canary (default) | Flag, canary percentage, SLO watch, auto-rollback without a real platform | `PADAKAN_DEPLOY_TARGET=simulated` |
| Railway or Vercel (later) | Real gated deploy | `PADAKAN_DEPLOY_TARGET` |
