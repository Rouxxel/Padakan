<!-- padakan:evidence:start -->
# Evidence: every test you run in the app is recorded, or it did not happen

Nothing you do in a browser here can be watched live, so the recording is how a human validates what you did. A test without a video, a trace and numbered screenshots is narration, and it is treated as not run.

Write everything for this task under `.padakan/evidence/` in the repository (it is excluded from git; the orchestrator pulls it). Never copy `~/.claude-env` or any credential into it.

For every acceptance check in the running app:

1. Drive it from a **Playwright script**, not the MCP, so it records:
   ```js
   import { createRequire } from 'node:module';
   const { chromium } = createRequire(import.meta.url)('playwright');
   const DIR = `${process.cwd()}/.padakan/evidence/browser`;
   const ctx = await (await chromium.launch()).newContext({
     recordVideo: { dir: DIR, size: { width: 1440, height: 900 } }, viewport: { width: 1440, height: 900 }, locale: 'en-US',
   });
   await ctx.tracing.start({ screenshots: true, snapshots: true });
   const page = await ctx.newPage();
   // … the real flow: type the value, click the button, complete the dialog …
   await page.screenshot({ path: `${DIR}/01-<what-it-shows>.png` });   // numbered, named
   await ctx.tracing.stop({ path: `${DIR}/trace.zip` });
   await ctx.close();                                                  // flushes the video
   ```
2. **Confirm each ACn at its source** (the network response, a re-read after reload, the stored record) and write `.padakan/evidence/notes.md`: one line per criterion, pass or fail, the confirming evidence quoted, and the screenshot number that backs it.
3. Write `.padakan/evidence/architecture.md` (OKF): what the task changed, the components involved, and why.
4. End your report with `EVIDENCE=.padakan/evidence`.

Rules: numbered screenshots (`01-`, `02-` …) named for what they show; never a screenshot of a green toast as proof; never "done, tests pass" without the `EVIDENCE=` line. A sign-in failure is a sandbox problem, not a test result: report it as such.
<!-- padakan:evidence:end -->
