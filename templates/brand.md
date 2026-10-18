---
type: Brand
title: <Product> brand
description: Logo, palette, typography and voice. Written and approved at the plan gate; the designer agent and the report generator read it.
timestamp: <YYYY-MM-DDTHH:MM:SSZ>
approved_by: <user>
approved_at: <YYYY-MM-DDTHH:MM:SSZ>
---

# <Product> brand

Single source of truth for how the product looks and sounds. UI work and every generated
report (including the evidence report) copy these values exactly, never an approximation.

## Logo

| Asset | File | Use |
|---|---|---|
| Mark | `assets/logo-mark.svg` | favicon, avatars, small sizes |
| Wordmark | `assets/logo-wordmark.svg` | headers, reports |
| Clear space | <rule, for example the height of the mark on all sides> | |
| Minimum size | <px> | |

## Color

Defined once as tokens, with light and dark values. State the format used in the product's own styles.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` | <value> | <value> | primary actions, links |
| `--bg` | <value> | <value> | page background |
| `--surface` | <value> | <value> | cards, panels |
| `--text` | <value> | <value> | body text |
| `--muted` | <value> | <value> | secondary text |
| `--pass` | <value> | <value> | PASS verdicts |
| `--known` | <value> | <value> | KNOWN verdicts |
| `--fail` | <value> | <value> | FAIL and BROKEN verdicts |
| `--warn` | <value> | <value> | STOPPED, NOT RUN, cost gate |

## Typography

| Role | Family | Weights | Size scale |
|---|---|---|---|
| Heading | <family> | <weights> | <scale> |
| Body | <family> | <weights> | <scale> |
| Code | <family> | <weights> | <scale> |

## Voice

- **Tone:** <for example direct, plain, no hype>
- **Terminology:** <the words the product uses, and the ones it avoids>
- **Language:** <for example English only>

## Rules for the designer agent

- Reuse existing tokens and components before adding any.
- Reports are one self-contained page: no external CSS, fonts or scripts.
- Never invent a color; if a token is missing, add it here first and get it approved.
