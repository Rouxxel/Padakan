---
name: verify-web
description: "The verify kit for web targets: Playwright MCP, Chrome DevTools MCP, browser logs, unit tests, video and trace. Load when proving a web change."
---

# Verify kit: web

| Tool | Use |
|---|---|
| Playwright MCP | drive the app in a browser and assert on what changed |
| Chrome DevTools MCP | console errors, network requests and responses, performance |
| vitest / jest (the project's runner) | the task's tests and the suite |
| lighthouse | performance and accessibility when a criterion is about them |

Steps:
1. Start the app the way the project documents it (or use the PR preview URL from the brief).
2. For each criterion: perform the interaction, then assert on the captured request or response and on state re-read from the API, not only on the screen.
3. Record: Playwright video and trace on, numbered screenshots at each step.
4. Check the console and network for new errors during the run.
