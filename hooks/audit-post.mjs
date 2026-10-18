// PostToolUse on Bash: commits, pushes, merges and deploys run from the orchestrator's checkout are
// appended to the audit trail. Runs only in the main checkout (never in a tree's worktree), so the
// orchestrator stays the only writer. Fails open: an error never interrupts the session.

import { execFileSync } from 'node:child_process';
import { readPayload, activeContext, isLinkedWorktree } from './lib.mjs';
import { openAudit } from '../core/audit.mjs';

const RULES = [
  ['git.commit', /\bgit\s+(?:-C\s+\S+\s+)?commit\b/],
  ['git.push', /\bgit\s+(?:-C\s+\S+\s+)?push\b/],
  ['git.merge', /\bgit\s+(?:-C\s+\S+\s+)?merge\b/],
  ['pr.merge', /\bgh\s+pr\s+merge\b/],
  ['deploy', /\bpadakan\s+deploy\b|\bbin\/padakan\s+deploy\b/],
];

try {
  const payload = await readPayload();
  const cwd = payload.cwd || process.cwd();
  const command = String(payload.tool_input?.command || '');
  const types = RULES.filter(([, re]) => re.test(command)).map(([t]) => t);
  if (types.length && !isLinkedWorktree(cwd)) {
    const ctx = activeContext(cwd);
    if (ctx) {
      let head = null;
      try {
        head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        // not fatal
      }
      const audit = openAudit(ctx.records);
      for (const type of types) {
        await audit.append({ type, head, command: command.slice(0, 300), summary: `${type} at ${head ? head.slice(0, 12) : 'unknown head'}` });
      }
    }
  }
} catch {
  // fail open
}
process.exit(0);
