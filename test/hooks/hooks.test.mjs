import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, makeRepo, removeDir, git } from '../helpers/index.mjs';
import { init } from '../../orchestrator/lib/records.mjs';

// Run a hook script with a JSON payload on stdin, as Claude Code does.
function hook(name, payload, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PADAKAN_')));
  const r = spawnSync(process.execPath, [join(ROOT, 'hooks', `${name}.mjs`)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
  let out = null;
  try {
    out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    out = { raw: r.stdout };
  }
  return { code: r.status, out, stderr: r.stderr };
}
const decision = (r) => r.out?.hookSpecificOutput?.permissionDecision ?? 'allow';

async function project({ active = true, state = { version: 1, tasks: {} } } = {}) {
  const env = await makeRepo('shop');
  env.records = join(env.parent, 'shop-padakan');
  if (active) {
    await init(env.records);
    await writeFile(join(env.records, 'state.json'), JSON.stringify(state));
  }
  return env;
}

test('hooks.json wires every hook to a script that exists', async () => {
  const cfg = JSON.parse(await readFile(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const commands = Object.values(cfg.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.equal(commands.length, 4);
  for (const c of commands) {
    const m = c.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w-]+\.mjs)/);
    assert.ok(m, c);
    await readFile(join(ROOT, m[1]));
  }
});

describe('outside a Padakan project every hook stays out of the way', () => {
  test('questions and writes are allowed, session start prints nothing', async () => {
    const env = await project({ active: false });
    try {
      assert.equal(decision(hook('guard-question', { cwd: env.repo, tool_input: { questions: [{ question: 'Which DB?' }] } })), 'allow');
      assert.equal(decision(hook('guard-write', { cwd: env.repo, tool_input: { file_path: join(env.repo, '.github/x.yml'), content: 'x' } })), 'allow');
      const s = hook('session-start', { cwd: env.repo });
      assert.equal(s.code, 0);
      assert.equal(s.out, null);
    } finally {
      await removeDir(env.base);
    }
  });
});

describe('AC2: no questions except the plan gate and cost decisions', () => {
  test('an ordinary question is denied with instructions', async () => {
    const env = await project();
    try {
      const r = hook('guard-question', { cwd: env.repo, tool_input: { questions: [{ header: 'DB', question: 'Postgres or MySQL?' }] } });
      assert.equal(decision(r), 'deny');
      assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /report BLOCKED=/);
    } finally {
      await removeDir(env.base);
    }
  });

  test('a cost question naming an existing decision report is allowed; a made-up one is not', async () => {
    const env = await project();
    try {
      await writeFile(join(env.records, 'decisions', 'D-0003.md'), '---\ntype: Decision Report\n---\n');
      assert.equal(decision(hook('guard-question', { cwd: env.repo, tool_input: { questions: [{ header: 'Cost gate', question: 'Approve D-0003?' }] } })), 'allow');
      assert.equal(decision(hook('guard-question', { cwd: env.repo, tool_input: { questions: [{ question: 'Approve D-0099?' }] } })), 'deny');
    } finally {
      await removeDir(env.base);
    }
  });

  test('during the plan gate the human may be asked', async () => {
    const env = await project({ state: { version: 1, tasks: {}, gate: 'plan' } });
    try {
      assert.equal(decision(hook('guard-question', { cwd: env.repo, tool_input: { questions: [{ question: 'Approve the PRD?' }] } })), 'allow');
    } finally {
      await removeDir(env.base);
    }
  });

  test('unreadable input is denied (fails closed)', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'hooks', 'guard-question.mjs')], { input: '{not json', encoding: 'utf8' });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('writes: protected paths and secrets', () => {
  test('a protected path is denied, an ordinary one allowed', async () => {
    const env = await project();
    try {
      const r = hook('guard-write', { cwd: env.repo, tool_input: { file_path: join(env.repo, '.github', 'workflows', 'ci.yml'), content: 'on: push' } });
      assert.equal(decision(r), 'deny');
      assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /\.github\/workflows\/ci\.yml is a protected path/);
      assert.equal(decision(hook('guard-write', { cwd: env.repo, tool_input: { file_path: join(env.repo, 'src', 'app.js'), content: 'export {}' } })), 'allow');
      assert.equal(decision(hook('guard-write', { cwd: env.repo, tool_input: { file_path: 'web/yarn.lock', content: 'x' } })), 'deny', 'relative paths resolve from cwd');
    } finally {
      await removeDir(env.base);
    }
  });

  test('protected paths apply inside a tree worktree too', async () => {
    const env = await project();
    try {
      const wt = join(env.base, 'trees', 'pad-1');
      git(env.repo, 'worktree', 'add', '-q', '-b', 'padakan/pad-1', wt);
      assert.equal(decision(hook('guard-write', { cwd: wt, tool_input: { file_path: join(wt, 'infra', 'main.tf'), content: 'x' } })), 'deny');
    } finally {
      await removeDir(env.base);
    }
  });

  test('a secret in Write, Edit or MultiEdit content is denied by kind, never echoed', async () => {
    const env = await project();
    try {
      const token = `ghp_${'Q7w8E9r0T1'.repeat(4)}`;
      for (const tool_input of [
        { file_path: join(env.repo, 'a.js'), content: `const t = "${token}";` },
        { file_path: join(env.repo, 'a.js'), old_string: 'x', new_string: `t = "${token}"` },
        { file_path: join(env.repo, 'a.js'), edits: [{ old_string: 'x', new_string: 'fine' }, { old_string: 'y', new_string: token }] },
      ]) {
        const r = hook('guard-write', { cwd: env.repo, tool_input });
        assert.equal(decision(r), 'deny');
        assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /github-token/);
        assert.ok(!r.stdout?.includes?.(token) && !JSON.stringify(r.out).includes(token));
      }
    } finally {
      await removeDir(env.base);
    }
  });

  test('the records .env is where secrets belong', async () => {
    const env = await project();
    try {
      const r = hook('guard-write', { cwd: env.repo, tool_input: { file_path: join(env.records, '.env'), content: `DEVIN_API_KEY=cog_${'a1B2'.repeat(6)}` } });
      assert.equal(decision(r), 'allow');
    } finally {
      await removeDir(env.base);
    }
  });
});

describe('PostToolUse audit and SessionStart', () => {
  test('a commit in the main checkout is appended to the audit trail; a tree commit is not', async () => {
    const env = await project();
    try {
      hook('audit-post', { cwd: env.repo, tool_input: { command: 'git commit -m "feat: x"' }, tool_response: {} });
      hook('audit-post', { cwd: env.repo, tool_input: { command: 'ls -la' } });
      const wt = join(env.base, 'trees', 'pad-2');
      git(env.repo, 'worktree', 'add', '-q', '-b', 'padakan/pad-2', wt);
      hook('audit-post', { cwd: wt, tool_input: { command: 'git commit -m tree' } });
      const chain = (await readFile(join(env.records, 'audit', 'chain.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(chain.length, 1);
      assert.equal(chain[0].event.type, 'git.commit');
      assert.match(chain[0].event.head, /^[0-9a-f]{40}$/);
    } finally {
      await removeDir(env.base);
    }
  });

  test('session start injects the orchestrator rules and the current state', async () => {
    const env = await project({ state: { version: 1, tasks: { 'PAD-1': { status: 'building' }, 'PAD-2': { status: 'done' } } } });
    try {
      await writeFile(join(env.records, 'cost', 'ledger.jsonl'), `${JSON.stringify({ kind: 'spend', usd: 1.25 })}\n${JSON.stringify({ kind: 'spend', usd: 0.5 })}\n`);
      const r = hook('session-start', { cwd: env.repo, source: 'startup' });
      const text = r.out.hookSpecificOutput.additionalContext;
      assert.equal(r.out.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(text, /You are the Padakan orchestrator/);
      assert.match(text, /Tasks: 2 \(1 open\): PAD-1 building/);
      assert.match(text, /Spent so far: \$1\.75/);
      assert.match(text, /Missing settings: .*GIT_AUTHOR_NAME/);
      assert.ok(!text.startsWith('---'), 'frontmatter is stripped');
    } finally {
      await removeDir(env.base);
    }
  });
});
