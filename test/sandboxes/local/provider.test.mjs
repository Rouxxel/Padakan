// The local provider: one git worktree per task. Runs the contract verbs it declares end to end.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

