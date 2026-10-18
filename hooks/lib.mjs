// Shared helpers for Padakan's Claude Code hooks.
//
// A hook only acts when Padakan is active for the session's repository: the records folder exists
// and holds state.json (created by /padakan:onboard). Everywhere else the hooks stay out of the way.
//
// Deny rules fail closed: if Padakan is active and the rule cannot be evaluated, the tool call is
// denied. Informational hooks fail open: an error prints nothing and the session continues.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { loadContext } from '../orchestrator/lib/records.mjs';

export async function readPayload() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

// { settings, records, repo, state } when Padakan is active for cwd, otherwise null.
export function activeContext(cwd, { exported = process.env } = {}) {
  let ctx;
  try {
    ctx = loadContext({ cwd, exported });
  } catch {
    return null;
  }
  const stateFile = join(ctx.records, 'state.json');
  if (!existsSync(stateFile)) return null;
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    state = { unreadable: true };
  }
  return { ...ctx, state };
}

// The working tree root that contains a path: the nearest folder with a .git entry (dir or file).
export function worktreeRoot(path) {
  let dir = resolve(path);
  if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function isLinkedWorktree(cwd) {
  const root = worktreeRoot(cwd);
  return !!root && !statSync(join(root, '.git')).isDirectory();
}

export function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  );
  process.exit(0);
}

export function allow() {
  process.exit(0);
}

export function context(event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  process.exit(0);
}
