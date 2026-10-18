// PreToolUse on AskUserQuestion: Padakan never asks the human anything, except
//   - at the plan gate (state.json says gate: "plan"), and
//   - for a cost decision: the question names a decision report that exists in <records>/decisions/.
// Everything else is denied with instructions to decide by rule or escalate.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPayload, activeContext, deny, allow } from './lib.mjs';

const REASON =
  'Padakan runs unattended: only the plan gate and cost decisions may ask the human. ' +
  'Decide by rule (take the conservative choice and record it in your notes), or stop and report BLOCKED=<what is missing> ' +
  'so the orchestrator escalates. See the no-questions skill.';

let payload;
try {
  payload = await readPayload();
} catch {
  deny(`could not read the hook input; ${REASON}`);
}

const ctx = activeContext(payload.cwd || process.cwd());
if (!ctx) allow();

try {
  if (ctx.state.gate === 'plan') allow();
  const text = JSON.stringify(payload.tool_input || {});
  const ids = [...new Set(text.match(/\bD-\d{4,}\b/g) || [])];
  if (ids.length && ids.every((id) => existsSync(join(ctx.records, 'decisions', `${id}.md`)))) allow();
  deny(REASON);
} catch {
  deny(REASON);
}
