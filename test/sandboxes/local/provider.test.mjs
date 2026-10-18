// The local provider: one git worktree per task. Runs the contract verbs it declares end to end.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeDir, git } from '../../helpers/index.mjs';
import { setup } from '../../helpers/sandbox.mjs';
import { openGateway } from '../../../sandboxes/index.mjs';
import { checkProvider } from '../../../sandboxes/contract.mjs';
import * as local from '../../../sandboxes/local/provider.mjs';

test('local satisfies the contract shape', () => {
  assert.deepEqual(checkProvider(local, 'local'), []);
});

describe('AC1: the contract suite passes for local', () => {
  test('create → brief → exec → push/pull → status → evidence → retire', async () => {
    const env = await setup();
    try {
      const gw = openGateway(env.ctx);
      const h = await gw.create('pad-12', { task: 'PAD-12' });
      assert.equal(h.provider, 'local');
      assert.equal(h.state, 'ready');
      assert.match(h.base_sha, /^[0-9a-f]{40}$/);
      assert.ok(existsSync(h.path), 'worktree exists');
      assert.ok(!h.path.startsWith(`${env.records}/`), 'worktree is outside the OKF bundle');

      const briefFile = join(env.base, 'brief.md');
      await writeFile(briefFile, '---\ntype: Brief\n---\n# Do it\n');
      await gw.brief('pad-12', briefFile);
      assert.equal((await gw.get('pad-12')).state, 'working');

      const r = await gw.exec('pad-12', 'echo hello && git rev-parse --abbrev-ref HEAD');
      assert.equal(r.code, 0);
      assert.match(r.stdout, /hello\npadakan\/pad-12/);
      assert.equal((await gw.exec('pad-12', 'exit 7')).code, 7);
      assert.equal((await gw.exec('pad-12', 'git status --porcelain')).stdout.trim(), '', '.padakan/ is excluded from git');

      await gw.exec('pad-12', 'echo "export const x = 1;" > feature.mjs && git add feature.mjs && git commit -q -m feat && git push -q origin HEAD');
      await gw.exec('pad-12', 'printf video > .padakan/evidence/run.mp4 && printf "---\\ntype: Record\\n---\\n" > .padakan/record.md');

      const ev = await gw.evidence('pad-12', 'PAD-12');
      assert.equal(ev.video, 'tasks/PAD-12/evidence/local/run.mp4');

      assert.equal((await gw.status('pad-12')).state, 'working');
      const ret = await gw.retire('pad-12', 'PAD-12');
      assert.equal(ret.destroyed, true);
      assert.equal(ret.record, 'tasks/PAD-12/record.md');
      assert.ok(existsSync(join(env.records, 'tasks', 'PAD-12', 'record.md')));
      assert.ok(!existsSync(h.path), 'worktree removed');
      assert.deepEqual(await gw.list(), [], 'handle removed with the tree');
    } finally {
      await removeDir(env.base);
    }
  });

  test('destroy refuses uncommitted or unpushed work unless forced', async () => {
    const env = await setup();
    try {
      const gw = openGateway(env.ctx);
      await gw.create('pad-13');
      await gw.exec('pad-13', 'echo x > wip.txt');
      await assert.rejects(gw.destroy('pad-13'), /1 uncommitted and 0 unpushed/);
      await gw.exec('pad-13', 'git add wip.txt && git commit -q -m wip');
      await assert.rejects(gw.destroy('pad-13'), /0 uncommitted and 1 unpushed/);
      assert.equal((await gw.destroy('pad-13', { force: true })).destroyed, true);
    } finally {
      await removeDir(env.base);
    }
  });

  test('push refuses credential-shaped files and paths that leave the tree', async () => {
    const env = await setup();
    try {
      const gw = openGateway(env.ctx);
      await gw.create('pad-14');
      const dir = join(env.base, 'payload');
      await mkdir(dir);
      await writeFile(join(dir, 'ok.txt'), 'fine');
      assert.equal((await gw.push('pad-14', join(dir, 'ok.txt'), 'ok.txt')).ok, true);
      await writeFile(join(dir, '.env'), 'X=1');
      await assert.rejects(gw.push('pad-14', dir, 'payload'), /credential-shaped file: \.env/);
      await assert.rejects(gw.push('pad-14', join(dir, 'ok.txt'), '../escape.txt'), /leaves the tree/);
      await gw.destroy('pad-14', { force: true });
    } finally {
      await removeDir(env.base);
    }
  });

  test('a base that is not on the remote is refused', async () => {
    const env = await setup();
    try {
      git(env.repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
      await assert.rejects(openGateway(env.ctx).create('pad-15'), /is not on any remote; push it first/);
    } finally {
      await removeDir(env.base);
    }
  });
});


describe('the builder in a local tree', () => {
  const waitFor = async (fn) => {
    for (let i = 0; i < 250 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 20));
  };

  test('headless: brief starts claude in the tree, and status follows the process', async () => {
    const env = await setup({ env: { PADAKAN_DRIVER: 'headless', PADAKAN_TREE_MODEL: 'claude-sonnet-5-5' } });
    const log = join(env.base, 'claude.log');
    process.env.PADAKAN_STUB_LOG = log;
    process.env.PADAKAN_STUB_SLEEP = '1';
    try {
      const gw = openGateway(env.ctx);
      const h = await gw.create('pad-1', { task: 'PAD-1' });
      const briefFile = join(env.base, 'brief.md');
      await writeFile(briefFile, '---\ntype: Brief\n---\n# Do it\n');
      const r = await gw.brief('pad-1', briefFile);
      assert.equal(r.agent, 'running');
      assert.equal((await gw.status('pad-1')).agent, 'running');
      assert.equal((await gw.status('pad-1')).state, 'working');
      await waitFor(() => existsSync(join(h.path, '.padakan', 'agent.exit')) && readFileSync(join(h.path, '.padakan', 'agent.exit'), 'utf8').trim() !== '');
      const done = await gw.status('pad-1');
      assert.deepEqual([done.state, done.agent], ['waiting', 'exited:0']);
      const line = readFileSync(log, 'utf8');
      assert.match(line, /claude -p Read \.padakan\/BRIEF\.md.* --dangerously-skip-permissions --settings .*claude-settings\.json/);
      const settings = JSON.parse(readFileSync(join(h.path, '.padakan', 'claude-settings.json'), 'utf8'));
      assert.equal(settings.includeCoAuthoredBy, false);
      assert.equal(settings.model, 'claude-sonnet-5-5');
      assert.equal(git(h.path, 'status', '--porcelain'), '', 'the agent files stay out of git');
    } finally {
      delete process.env.PADAKAN_STUB_LOG;
      delete process.env.PADAKAN_STUB_SLEEP;
      await removeDir(env.base);
    }
  });

  test('a builder that fails leaves the tree failed; a briefed tree with nothing running is waiting', async () => {
    const env = await setup({ env: { PADAKAN_DRIVER: 'headless' } });
    process.env.PADAKAN_STUB_EXIT = '3';
    try {
      const gw = openGateway(env.ctx);
      const h = await gw.create('pad-1', {});
      await writeFile(join(env.base, 'b.md'), '# b\n');
      await gw.brief('pad-1', join(env.base, 'b.md'));
      await waitFor(() => existsSync(join(h.path, '.padakan', 'agent.exit')) && readFileSync(join(h.path, '.padakan', 'agent.exit'), 'utf8').trim() !== '');
      assert.deepEqual([(await gw.status('pad-1')).state, (await gw.status('pad-1')).agent], ['failed', 'exited:3']);

      const h2 = await gw.create('pad-2', {});
      await writeFile(join(h2.path, '.padakan', 'BRIEF.md'), '# b\n');
      await gw.call('status', 'pad-2');
      const fake = { ...h2, state: 'working' };
      assert.deepEqual(await local.status(env.ctx, fake), { state: 'waiting', agent: 'none', handle: { state: 'waiting' } });
    } finally {
      delete process.env.PADAKAN_STUB_EXIT;
      await removeDir(env.base);
    }
  });

  test('herdr: attach starts the server, workspace and agent; brief prompts it', async () => {
    const env = await setup({ env: { PADAKAN_DRIVER: 'herdr' } });
    const log = join(env.base, 'herdr.log');
    process.env.PADAKAN_STUB_LOG = log;
    try {
      const gw = openGateway(env.ctx);
      const h = await gw.create('pad-1', {});
      const a = await gw.attach('pad-1');
      assert.equal(a.session, 'padakan-pad-1');
      const text = readFileSync(log, 'utf8');
      assert.match(text, /herdr --session padakan-pad-1 server/);
      assert.match(text, new RegExp(`workspace create --cwd ${h.path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
      assert.match(text, /agent start padakan-pad-1 --kind claude .* -- --dangerously-skip-permissions --settings/);
      await writeFile(join(env.base, 'b.md'), '# b\n');
      assert.equal((await gw.brief('pad-1', join(env.base, 'b.md'))).agent, 'running');
      assert.match(readFileSync(log, 'utf8'), /agent prompt padakan-pad-1 Read \.padakan\/BRIEF\.md/);
    } finally {
      delete process.env.PADAKAN_STUB_LOG;
      await removeDir(env.base);
    }
  });

  test('create refuses a relative remote URL and says how to fix it', async () => {
    const env = await setup();
    try {
      git(env.repo, 'remote', 'set-url', 'origin', '../remote.git');
      const gw = openGateway(env.ctx);
      await assert.rejects(gw.create('pad-1', {}), (e) => e.code === 'RELATIVE_REMOTE' && /git remote set-url origin \//.test(e.message));
      assert.equal(existsSync(join(env.records, 'sandboxes', 'pad-1.json')), false);
    } finally {
      await removeDir(env.base);
    }
  });
});
