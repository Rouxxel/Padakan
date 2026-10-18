// SessionStart: give the orchestrator its rules and where things stand.
// Claude Code does not load a plugin's CLAUDE.md, so the rules (orchestrator/RULES.md) arrive here.
// Fails open: when Padakan is not active for this repository, or anything goes wrong, it prints nothing.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPayload, activeContext, context } from './lib.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const payload = await readPayload();
  const ctx = activeContext(payload.cwd || process.cwd());
  if (!ctx) process.exit(0);

  const rules = readFileSync(join(PLUGIN, 'orchestrator', 'RULES.md'), 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim();
  const tasks = Object.entries(ctx.state.tasks || {});
  const open = tasks.filter(([, t]) => !['done', 'shipped', 'closed'].includes(t?.status));

  let spent = 0;
  const ledger = join(ctx.records, 'cost', 'ledger.jsonl');
  if (existsSync(ledger)) {
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind === 'spend' && typeof e.usd === 'number') spent += e.usd;
      } catch {
        // skip a bad line
      }
    }
  }
  const s = ctx.settings;
  const cap = (v) => (v === null || v === undefined ? 'no cap' : `$${v}`);
  const status = [
    `Padakan is active for ${ctx.repo}.`,
    `Records: ${ctx.records}`,
    `Sandbox provider: ${s.PADAKAN_SANDBOX_PROVIDER}. Max trees: ${s.PADAKAN_MAX_TREES}.`,
    `Tasks: ${tasks.length} (${open.length} open)${open.length ? `: ${open.slice(0, 10).map(([k, t]) => `${k} ${t?.status || 'unknown'}`).join(', ')}` : ''}.`,
    `Spent so far: $${spent.toFixed(2)}. Caps: run ${cap(s.PADAKAN_BUDGET_RUN_USD)}, task ${cap(s.PADAKAN_BUDGET_TASK_USD)}, step ${cap(s.PADAKAN_BUDGET_STEP_USD)}.`,
    ctx.state.gate === 'plan' ? 'The plan gate is open: the human may be asked about the plan.' : 'The plan gate is closed: ask the human only through a cost decision report.',
  ];
  const missing = s.missing();
  if (missing.length) status.push(`Missing settings: ${missing.join(', ')} (run /padakan:onboard).`);

  context('SessionStart', `${rules}\n\n## Current state\n\n${status.map((l) => `- ${l}`).join('\n')}`);
} catch {
  process.exit(0);
}
