---
name: e2e-playbook
description: "How to write a critical-flow end-to-end spec that is trustworthy: soft assertions per criterion, judging on captured traffic, fresh identities, never production, not-exercised is never a pass. Load when writing or running e2e specs."
---

# Writing an e2e spec you can trust

1. **One test per feature, one `expect.soft` per criterion**, labelled `ACn: <criterion>`, so one run reports the whole list.
2. **Judge on captured traffic and state re-read out of band**, never on what the page appears to say.
3. **A phase that cannot run is annotated `not exercised`**, never silently skipped and never passed. A spec that stops early names every remaining criterion as stopped.
4. **Anchor selectors** (`/^Save$/`) and verify them against the live DOM.
5. **Mint identities every run**; never reuse a cached session.
6. **Never point a run at production.** Destructive flows are intercepted and judged on the captured request.
7. **Record video for passing runs too**: those prove the feature works.

Verdicts: `PASS`, `KNOWN` (a ledgered failure), `FAIL`, `BROKEN`, `STOPPED`, `NOT RUN`. CI runs the suite on the PR preview before the merge and on staging after it.
