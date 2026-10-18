---
type: Guide
title: Sandbox providers
description: How the sandbox gateway works and what a provider must implement to plug into it.
tags: [sandboxes, contract]
timestamp: 2026-10-18T00:00:00Z
---

# Sandbox providers

Orchestrator steps never call a provider directly. They go through the gateway:

```js
import { openGateway } from './sandboxes/index.mjs';
const gw = openGateway({ settings, records, repo });
const handle = await gw.create('pad-12', { task: 'PAD-12', branch: 'padakan/PAD-12' });
await gw.brief('pad-12', briefPath);
const { state } = await gw.status('pad-12');
```

## What the gateway guarantees

- **Handles** live in `<records>/sandboxes/<id>.json` and match `schemas/sandbox-handle.json`. Only the gateway writes them.
- `create` **claims the handle first** (state `provisioning`) and deletes it if the provider throws.
- Later verbs load the handle and use **the provider recorded in it**, so changing `PADAKAN_SANDBOX_PROVIDER` never strands a live tree.
- A verb the provider does not declare throws **`UnsupportedVerb`**.
- `PADAKAN_MAX_TREES` is enforced by counting live handles.
- A handle that would contain the value of a secret setting is **refused**.
- A result with `destroyed: true` (from `destroy`, or `retire` when it ends the tree) removes the handle.

## Writing a provider

A provider is `sandboxes/<name>/provider.mjs`:

```js
export const name = 'devin';
export const capabilities = ['create', 'brief', 'status', 'poll', 'message', 'pause', 'resume',
  'raiseBudget', 'evidence', 'retire', 'destroy', 'url', 'spend'];

// create(ctx, id, opts) returns the fields for the new handle (at least { state }).
export async function create(ctx, id, opts) { /* … */ return { state: 'working', session_id, url }; }

// Every other verb: (ctx, handle, ...args). Return a result; put handle updates in result.handle.
export async function status(ctx, handle) { return { state: 'working', handle: { acus_last: 7.5 } }; }
```

- `ctx` is `{ settings, records, repo }`. `handle` is a frozen copy: never write it, return `result.handle` instead.
- Providers never write handles, the audit trail or the cost ledger.
- `create`, `status` and `destroy` are mandatory. Everything else is declared in `capabilities`.
- States: `ready`, `working`, `waiting`, `paused`, `done`, `failed`, `gone` (`provisioning` is the gateway's).
- Throw `SandboxError` from `contract.mjs` with a `code` for expected failures.

## Providers

| Provider | Status | Capabilities |
|---|---|---|
| `local` | built | create, exec, push, pull, brief, attach, url, status, evidence, retire, destroy |
| `devin` | built (mocked API; live checks in IMPLEMENTATION-DEVIN-COSTGATE.md D.4 pending) | create, brief, status, poll, message, pause, resume, raiseBudget, evidence, retire, destroy, url, spend |
| `daytona` | later | the shell verbs plus bootstrap and seed |

The shared suite is `test/sandbox-contract.test.mjs`. Add a `describe` block for a new provider that runs the verbs it declares, with its external API mocked. The Devin provider's suite is `test/devin-provider.test.mjs`: it runs every declared verb through this gateway against `test/helpers/mock-devin.mjs`, with `makeProvider()` injecting fake GitHub effects and a fake clock.
