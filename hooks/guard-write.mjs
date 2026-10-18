// PreToolUse on Edit, Write, MultiEdit and NotebookEdit:
//   - deny writes under PADAKAN_PROTECTED_PATHS (relative to the working tree the file is in);
//   - deny content that looks like a secret (reported by kind, never by value).
// The records folder's own .env is the one place secrets belong, so it is exempt from the secret check.

import { relative, join, basename, resolve, sep } from 'node:path';
import { readPayload, activeContext, worktreeRoot, deny, allow } from './lib.mjs';
import { globToRegExp, secretKinds } from '../core/diffcheck.mjs';

let payload;
try {
  payload = await readPayload();
} catch {
  deny('could not read the hook input');
}

const ctx = activeContext(payload.cwd || process.cwd());
if (!ctx) allow();

try {
  const input = payload.tool_input || {};
  const file = input.file_path || input.notebook_path;
  if (!file) deny('a write without a file path cannot be checked');
  const abs = resolve(payload.cwd || process.cwd(), file);

  const root = worktreeRoot(abs);
  if (root) {
    const rel = relative(root, abs).split(sep).join('/');
    const hit = (ctx.settings.PADAKAN_PROTECTED_PATHS || []).find((g) => globToRegExp(g).test(rel));
    if (hit) deny(`${rel} is a protected path (${hit} in PADAKAN_PROTECTED_PATHS). Changes there go to a human; escalate instead.`);
  }

  const recordsEnv = join(ctx.records, '.env');
  if (abs !== recordsEnv) {
    const texts = [input.content, input.new_string, input.new_source, ...(Array.isArray(input.edits) ? input.edits.map((e) => e.new_string) : [])].filter(
      (t) => typeof t === 'string',
    );
    const kinds = [...new Set(texts.flatMap((t) => t.split('\n').flatMap((line) => secretKinds(line))))];
    if (kinds.length) {
      deny(`refusing to write what looks like a secret (${kinds.join(', ')}) into ${basename(abs)}. Reference the setting by name instead; secrets live only in <records>/.env.`);
    }
  }
  allow();
} catch (e) {
  deny(`the write could not be checked (${e.message})`);
}
