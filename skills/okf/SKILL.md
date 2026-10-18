---
name: okf
description: "How to write an Open Knowledge Format document: frontmatter fields, one concept per file, links, index.md and log.md. Load before writing any markdown file Padakan keeps."
---

# Writing OKF documents

Every markdown file a Padakan agent writes is an Open Knowledge Format (OKF v0.1) document.

## Frontmatter

```markdown
---
type: Evidence Report          # required by OKF
title: PAD-12 · Export the dashboard as CSV
description: One sentence saying what this document is.
resource: https://github.com/<owner>/<repo>/pull/12   # when the concept has a URL
tags: [dashboard, evidence]
timestamp: 2026-10-18T14:22:00Z   # ISO 8601
---
```

Padakan always writes `type`, `title`, `description`, `tags` and `timestamp`. Extra fields (`task`, `agent`, `verdict`) are allowed.

## Body

- One concept per file; the path is its identity (`tasks/PAD-12/record.md`).
- Link related documents with plain relative markdown links: `[the brief](./brief.md)`. A link starting with `/` is relative to the bundle root.
- A folder you write several documents into gets an `index.md` that lists them.
- Chronological history goes in `log.md`, one line per event.

## Check

`node <plugin>/core/okf.mjs <file-or-folder>` prints one line per problem and exits 1 when there is any. An invalid document is a failed check.
