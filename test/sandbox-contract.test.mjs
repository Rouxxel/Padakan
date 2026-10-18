// The contract every sandbox provider must pass, run against each provider for the verbs it declares,
// plus the gateway's own guarantees.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, removeDir, git, tempDir } from './helpers.mjs';
import { openGateway } from '../sandboxes/index.mjs';
import { UnsupportedVerb, checkProvider, VERBS } from '../sandboxes/contract.mjs';
import * as local from '../sandboxes/local/provider.mjs';
import { init } from '../orchestrator/lib/records.mjs';
import { loadSettings } from '../orchestrator/lib/env.mjs';

// A minimal in-memory provider: proves the gateway works for any provider, not only local.
function fakeProvider({ failCreate = false, leak = null } = {}) {
  const trees = new Map();
  return {
    name: 'fake',
    capabilities: ['create', 'status', 'message', 'destroy'],
    async create(ctx, id) {
      if (failCreate) throw new Error('provider exploded');
      trees.set(id, []);
      return { state: 'working', session_id: `sess-${id}`, ...(leak ? { note: leak } : {}) };
    },
    async status(ctx, h) {
      return { state: trees.has(h.id) ? h.state : 'gone' };
    },
    async message(ctx, h, text) {
      trees.get(h.id).push(text);
      return { ok: true, handle: { questions_answered: (h.questions_answered || 0) + 1 } };
    },
    async destroy(ctx, h) {
      trees.delete(h.id);
      return { destroyed: true };
    },
  };
}

async function setup({ withRemote = true, env = {} } = {}) {
  const { base, repo, parent } = await makeRepo('shop');
  if (withRemote) {
    const remote = join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  }
  const records = join(parent, 'shop-padakan');
  await init(records);
  const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'local', PADAKAN_MAX_TREES: '3', ...env } });
  return { base, repo, records, ctx: { settings, records, repo } };
}

describe('provider modules', () => {
  test('local satisfies the contract shape', () => {
    assert.deepEqual(checkProvider(local, 'local'), []);
  });
  test('checkProvider catches a broken provider', () => {
    const p = checkProvider({ name: 'x', capabilities: ['create', 'fly'] }, 'x');
    assert.ok(p.some((m) => m.includes('unknown verb in capabilities: fly')));
    assert.ok(p.some((m) => m.includes('declares "create" but does not export it')));
    assert.ok(p.some((m) => m.includes('must support "status"')));
  });
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

describe('gateway guarantees', () => {
  test('AC2: a failed create leaves no handle behind', async () => {
    const env = await setup();
    try {
      const gw = openGateway({ ...env.ctx, settings: loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'devin' } }) }, { providers: { devin: fakeProvider({ failCreate: true }) } });
      await assert.rejects(gw.create('pad-20'), /provider exploded/);
      assert.deepEqual(await readdir(join(env.records, 'sandboxes')), []);
    } finally {
      await removeDir(env.base);
    }
  });

  test('AC3: a handle never contains the value of a secret setting', async () => {
    const env = await setup();
    try {
      const secret = 'cog_live_secret_token_value';
      const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'devin', DEVIN_API_KEY: secret } });
      const gw = openGateway({ ...env.ctx, settings }, { providers: { devin: fakeProvider({ leak: `Bearer ${secret}` }) } });
      await assert.rejects(gw.create('pad-21'), /contains the value of a secret setting/);
      assert.deepEqual(await readdir(join(env.records, 'sandboxes')), []);
      const ok = openGateway({ ...env.ctx, settings }, { providers: { devin: fakeProvider() } });
      await ok.create('pad-22');
      assert.ok(!(await readFile(join(env.records, 'sandboxes', 'pad-22.json'), 'utf8')).includes(secret));
    } finally {
      await removeDir(env.base);
    }
  });

  test('an undeclared verb throws UnsupportedVerb', async () => {
    const env = await setup();
    try {
      const gw = openGateway({ ...env.ctx, settings: loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'devin' } }) }, { providers: { devin: fakeProvider() } });
      await gw.create('pad-23');
      await assert.rejects(gw.exec('pad-23', 'ls'), (e) => e instanceof UnsupportedVerb && e.verb === 'exec' && e.provider === 'devin');
      assert.equal(await gw.supports('pad-23', 'message'), true);
      const r = await gw.message('pad-23', 'hello');
      assert.equal(r.ok, true);
      assert.equal((await gw.get('pad-23')).questions_answered, 1, 'result.handle is merged into the stored handle');
      assert.equal((await gw.get('pad-23')).session_id, 'sess-pad-23');
    } finally {
      await removeDir(env.base);
    }
  });

  test('PADAKAN_MAX_TREES is enforced by counting live handles', async () => {
    const env = await setup({ env: {} });
    try {
      const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'devin', PADAKAN_MAX_TREES: '2' } });
      const gw = openGateway({ ...env.ctx, settings }, { providers: { devin: fakeProvider() } });
      await gw.create('t-1');
      await gw.create('t-2');
      await assert.rejects(gw.create('t-3'), /PADAKAN_MAX_TREES is 2 and 2 trees are live/);
      await gw.destroy('t-1');
      await gw.create('t-3');
    } finally {
      await removeDir(env.base);
    }
  });

  test('ids are validated, duplicates refused, unknown providers explained', async () => {
    const env = await setup();
    try {
      const gw = openGateway({ ...env.ctx, settings: loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'devin' } }) }, { providers: { devin: fakeProvider() } });
      await assert.rejects(gw.create('Bad_ID'), /invalid sandbox id/);
      await gw.create('dup');
      await assert.rejects(gw.create('dup'), /already exists/);
      await assert.rejects(gw.get('nope'), /no sandbox "nope"/);
      await assert.rejects(openGateway(env.ctx).create('x', { provider: 'nosuch' }), /no sandbox provider "nosuch"/);
    } finally {
      await removeDir(env.base);
    }
  });

  test('every verb in the contract is reachable through the gateway', async () => {
    const dir = await tempDir();
    try {
      const gw = openGateway({ settings: {}, records: dir });
      for (const v of VERBS) assert.equal(typeof gw[v], 'function', v);
    } finally {
      await removeDir(dir);
    }
  });
});
