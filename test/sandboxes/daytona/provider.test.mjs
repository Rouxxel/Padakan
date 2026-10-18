import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, removeDir, git } from '../../helpers/index.mjs';
import { setup } from '../../helpers/sandbox.mjs';
import { mockDaytona } from '../../helpers/mock-daytona.mjs';
import { openGateway } from '../../../sandboxes/index.mjs';
import { checkProvider } from '../../../sandboxes/contract.mjs';
import * as daytona from '../../../sandboxes/daytona/provider.mjs';
import { doctor } from '../../../sandboxes/daytona/doctor.mjs';
import { buildContext } from '../../../orchestrator/lib/context.mjs';
import { STEPS } from '../../../orchestrator/steps.mjs';
import { readState } from '../../../orchestrator/lib/state.mjs';

const TOKEN = 'sk-ant-oat01-main-token-value';
const FALLBACK = 'sk-ant-oat01-fallback-token-value';
const PAT = 'github_pat_test_value_1234';
const ENV = {
  PADAKAN_SANDBOX_PROVIDER: 'daytona',
  CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
  CLAUDE_CODE_OAUTH_FALLBACK_TOKEN: FALLBACK,
  GH_TOKEN_SOURCE: 'pat',
  GH_PAT: PAT,
  GIT_AUTHOR_NAME: 'Tree Author',
  GIT_AUTHOR_EMAIL: 'tree@example.com',
  DAYTONA_API_KEY: 'dtn_test_key_value',
};

async function project(env = {}, mockOpts = {}) {
  const s = await setup({ env: { ...ENV, ...env } });
  const dt = await mockDaytona(mockOpts);
  const ctx = { ...s.ctx, daytonaRun: dt.run };
  const gw = openGateway(ctx, { providers: { daytona } });
  return { ...s, dt, ctx, gw };
}

// A planted, seeded and bootstrapped tree.
async function planted(env, mockOpts) {
  const p = await project(env, mockOpts);
  const handle = await p.gw.create('pad-1', { task: 'PAD-1', branch: 'padakan/PAD-1' });
  await p.gw.seed('pad-1');
  await p.gw.bootstrap('pad-1');
  return { ...p, handle, tree: join(p.dt.home('pad-1'), 'trees', 'pad-1') };
}

const cleanup = async (p) => {
  await removeDir(p.base);
  await removeDir(p.dt.root);
};

test('the daytona provider satisfies the contract', () => {
  assert.deepEqual(checkProvider(daytona, 'daytona'), []);
  for (const v of ['bootstrap', 'seed', 'pause', 'resume', 'evidence', 'retire']) assert.ok(daytona.capabilities.includes(v), v);
});

test('create passes only public values to the CLI and records a portable handle', async () => {
  const p = await project();
  try {
    const h = await p.gw.create('pad-1', { task: 'PAD-1', branch: 'padakan/PAD-1' });
    const args = p.dt.calls.find((a) => a[0] === 'create');
    assert.deepEqual(args.slice(0, 3), ['create', '--name', 'pad-1']);
    assert.ok(args.includes('--snapshot') && args.includes('padakan-base'));
    assert.ok(args.includes('purpose=padakan') && args.includes('tree=pad-1'));
    assert.ok(!args.includes('-e'), 'no env metadata on create');
    for (const flag of ['--cpu', '--memory', '--disk']) assert.ok(!args.includes(flag), `${flag} is fixed at bake time`);
    const text = JSON.stringify(p.dt.calls);
    for (const secret of [TOKEN, FALLBACK, PAT, ENV.DAYTONA_API_KEY]) assert.ok(!text.includes(secret));

    assert.equal(h.provider, 'daytona');
    assert.equal(h.state, 'ready');
    assert.equal(h.path, '~/trees/pad-1');
    assert.equal(h.base_sha, git(p.repo, 'rev-parse', 'HEAD'));
    const stored = await readFile(join(p.records, 'sandboxes', 'pad-1.json'), 'utf8');
    for (const secret of [TOKEN, FALLBACK, PAT]) assert.ok(!stored.includes(secret));
  } finally {
    await cleanup(p);
  }
});

test('create refuses an unpushed base and cleans up a failed create', async () => {
  const p = await project();
  try {
    git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
    await assert.rejects(p.gw.create('pad-1', { branch: 'padakan/PAD-1' }), (e) => e.code === 'UNPUSHED_BASE');
    assert.equal(p.dt.calls.length, 0, 'nothing is created before the base check');
  } finally {
    await cleanup(p);
  }
  const f = await project({}, { failCreate: true });
  try {
    await assert.rejects(f.gw.create('pad-1', {}), (e) => e.code === 'CREATE_FAILED' && /quota exceeded/.test(e.message));
    assert.equal(existsSync(join(f.records, 'sandboxes', 'pad-1.json')), false);
    assert.deepEqual(f.dt.calls.at(-1), ['delete', 'pad-1']);
  } finally {
    await cleanup(f);
  }
});

test('seed writes credentials into the sandbox only, and is idempotent', async () => {
  const p = await project();
  try {
    await p.gw.create('pad-1', { branch: 'padakan/PAD-1' });
    await p.gw.seed('pad-1');
    const home = p.dt.home('pad-1');
    const env = await readFile(join(home, '.claude-env'), 'utf8');
    assert.match(env, new RegExp(`CLAUDE_CODE_OAUTH_TOKEN='${TOKEN}'`));
    assert.match(env, new RegExp(`CLAUDE_CODE_OAUTH_FALLBACK_TOKEN='${FALLBACK}'`));
    assert.match(env, /IS_SANDBOX=1/);
    // The mock sandbox is a local folder; real sandboxes are Linux. Windows hosts have no Unix modes.
    if (process.platform !== 'win32') assert.equal((await stat(join(home, '.claude-env'))).mode & 0o777, 0o600);
    assert.match(await readFile(join(home, '.bashrc'), 'utf8'), /\.claude-env/);
    assert.equal(await readFile(join(home, 'gh-received'), 'utf8'), PAT);
    assert.equal(existsSync(join(home, '.padakan', 'gh.tok')), false, 'the token file is deleted');
    assert.match(await readFile(join(home, 'gh.log'), 'utf8'), /gh auth setup-git/);
    assert.match(await readFile(join(home, '.gitconfig'), 'utf8'), /name = Tree Author[\s\S]*email = tree@example.com/);
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.includeCoAuthoredBy, false);
    assert.ok(existsSync(join(home, '.local', 'bin', 'claude-token.sh')));
    const md = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    for (const block of ['tree', 'evidence', 'disk']) assert.match(md, new RegExp(`padakan:${block}:start`));

    await p.gw.seed('pad-1');
    assert.equal(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8'), md, 'seeding twice changes nothing');
    assert.equal((await readFile(join(home, '.bashrc'), 'utf8')).split('\n').filter((l) => l.includes('claude-env')).length, 1);

    // The secrets reached the sandbox per exec, never through create.
    const create = JSON.stringify(p.dt.calls.filter((a) => a[0] !== 'exec'));
    for (const secret of [TOKEN, PAT]) assert.ok(!create.includes(secret));
    assert.ok(!(await readFile(join(p.records, 'sandboxes', 'pad-1.json'), 'utf8')).includes(TOKEN));
  } finally {
    await cleanup(p);
  }
});

test('seed refuses to run without a Claude token or a commit identity', async () => {
  const p = await project({ CLAUDE_CODE_OAUTH_TOKEN: '' });
  try {
    await p.gw.create('pad-1', {});
    await assert.rejects(p.gw.seed('pad-1'), (e) => e.code === 'NO_CLAUDE_TOKEN');
  } finally {
    await cleanup(p);
  }
});

test('bootstrap clones the remote and checks out the task branch from the base, idempotently', async () => {
  const p = await planted();
  try {
    assert.equal(git(p.tree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'padakan/PAD-1');
    assert.equal(git(p.tree, 'rev-parse', 'HEAD'), p.handle.base_sha);
    assert.ok(existsSync(join(p.tree, '.padakan', 'evidence')));
    assert.match(await readFile(join(p.tree, '.git', 'info', 'exclude'), 'utf8'), /^\/\.padakan\/$/m);
    const again = await p.gw.bootstrap('pad-1');
    assert.equal(again.ok, true);
    assert.match(again.checkout, /^padakan\/PAD-1@[0-9a-f]+$/);
  } finally {
    await cleanup(p);
  }
});

test('bootstrap fails without the BOOTSTRAP-OK line', async () => {
  const p = await project();
  try {
    await p.gw.create('pad-1', {});
    await writeFile(join(p.dt.home('pad-1'), '.local', 'bin', 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(p.gw.bootstrap('pad-1'), (e) => e.code === 'BOOTSTRAP_FAILED');
  } finally {
    await cleanup(p);
  }
});

test('exec reads the exit status from the sentinel; a missing sentinel is a failure', async () => {
  const p = await planted();
  try {
    const ok = await p.gw.exec('pad-1', 'git rev-parse --abbrev-ref HEAD');
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout.trim(), 'padakan/PAD-1', 'runs in the checkout');
    assert.equal((await p.gw.exec('pad-1', 'exit 7')).code, 7);
    p.dt.opts.dropSentinel = true;
    const lost = await p.gw.exec('pad-1', 'true');
    assert.equal(lost.code, -1);
    assert.equal(lost.sentinel, false);
    assert.match(lost.stderr, /no exit sentinel/);
  } finally {
    await cleanup(p);
  }
});

test('exec output never carries a secret value', async () => {
  const p = await planted();
  try {
    const r = await p.gw.exec('pad-1', '. "$HOME/.claude-env"; echo "token=$CLAUDE_CODE_OAUTH_TOKEN"; echo "pat=$(cat "$HOME/gh-received")" >&2');
    assert.equal(r.stdout.trim(), 'token=***');
    assert.equal(r.stderr.trim(), 'pat=***');
  } finally {
    await cleanup(p);
  }
});

test('push and pull move files and folders, and refuse credentials and paths outside the tree', async () => {
  const p = await planted();
  try {
    await writeFile(join(p.base, 'one.txt'), 'hello\n');
    await p.gw.push('pad-1', join(p.base, 'one.txt'), 'docs/one.txt');
    assert.equal(await readFile(join(p.tree, 'docs', 'one.txt'), 'utf8'), 'hello\n');

    const dir = join(p.base, 'bundle');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'a');
    await writeFile(join(dir, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 255]));
    assert.equal((await p.gw.push('pad-1', dir, 'fixtures')).files, 2);
    assert.deepEqual([...(await readFile(join(p.tree, 'fixtures', 'sub', 'b.bin')))], [0, 1, 2, 255]);

    await assert.rejects(p.gw.push('pad-1', join(p.base, 'one.txt'), '../escape.txt'), (e) => e.code === 'BAD_PATH');
    await writeFile(join(dir, '.env'), 'X=1\n');
    await assert.rejects(p.gw.push('pad-1', dir, 'fixtures'), (e) => e.code === 'SECRET_FILE');

    const out = join(p.base, 'out');
    await p.gw.pull('pad-1', 'docs/one.txt', join(out, 'one.txt'));
    assert.equal(await readFile(join(out, 'one.txt'), 'utf8'), 'hello\n');
    await p.gw.pull('pad-1', 'fixtures', join(out, 'fx'));
    assert.equal(await readFile(join(out, 'fx', 'a.txt'), 'utf8'), 'a');
    await assert.rejects(p.gw.pull('pad-1', '/etc/passwd', out), (e) => e.code === 'BAD_PATH');
  } finally {
    await cleanup(p);
  }
});

test('a large file crosses in several chunks and arrives whole', async () => {
  const p = await planted();
  try {
    const big = Buffer.alloc(400_000, 7);
    await writeFile(join(p.base, 'big.bin'), big);
    await p.gw.push('pad-1', join(p.base, 'big.bin'), 'big.bin');
    assert.equal((await stat(join(p.tree, 'big.bin'))).size, big.length);
  } finally {
    await cleanup(p);
  }
});

test('attach starts the herdr server, workspace and agent inside the tree', async () => {
  const p = await planted({ HERDR_SESSION_PREFIX: 'padakan-long-prefix' });
  try {
    const r = await p.gw.attach('pad-1');
    assert.equal(r.watch, 'herdr');
    assert.equal(r.session, 'padakan-long-prefix-pad-1');
    const log = await readFile(join(p.dt.home('pad-1'), 'herdr.log'), 'utf8');
    assert.match(log, /herdr --session padakan-long-prefix-pad-1 server/);
    assert.match(log, /workspace create --cwd .*trees\/pad-1/);
    const start = log.split('\n').find((l) => l.includes('agent start'));
    const agent = start.split(' ')[4];
    assert.ok(agent.length <= 32, 'herdr caps agent names at 32 characters');
    assert.match(start, /--kind claude .* -- --dangerously-skip-permissions/);
  } finally {
    await cleanup(p);
  }
});

test('brief delivers .padakan/BRIEF.md and starts the agent (headless) or prompts it (herdr)', async () => {
  const p = await planted({ PADAKAN_DRIVER: 'headless' });
  try {
    await writeFile(join(p.base, 'brief.md'), '---\ntype: Brief\n---\n# do it\n');
    const r = await p.gw.brief('pad-1', join(p.base, 'brief.md'));
    assert.equal(r.ok, true);
    assert.equal((await p.gw.get('pad-1')).state, 'working');
    assert.match(await readFile(join(p.tree, '.padakan', 'BRIEF.md'), 'utf8'), /# do it/);
    const log = join(p.dt.home('pad-1'), 'claude.log');
    for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((res) => setTimeout(res, 20));
    assert.match(await readFile(log, 'utf8'), /claude -p Read \.padakan\/BRIEF\.md.* --dangerously-skip-permissions/);
  } finally {
    await cleanup(p);
  }
  const h = await planted();
  try {
    await writeFile(join(h.base, 'brief.md'), '# b\n');
    await h.gw.brief('pad-1', join(h.base, 'brief.md'));
    assert.match(await readFile(join(h.dt.home('pad-1'), 'herdr.log'), 'utf8'), /agent prompt padakan-pad-1 Read \.padakan\/BRIEF\.md/);
  } finally {
    await cleanup(h);
  }
});

test('url, status, pause and resume follow the Daytona state', async () => {
  const p = await planted();
  try {
    const u = await p.gw.url('pad-1', 5173);
    assert.equal(u.url, 'https://5173-pad-1.proxy.daytonaproxy01.net');
    assert.equal((await p.gw.get('pad-1')).url, u.url);

    assert.equal((await p.gw.status('pad-1')).state, 'ready');
    await p.gw.pause('pad-1');
    assert.equal((await p.gw.get('pad-1')).state, 'paused');
    assert.equal((await p.gw.status('pad-1')).daytona, 'stopped');
    await p.gw.resume('pad-1');
    assert.equal((await p.gw.status('pad-1')).state, 'ready');

    await writeFile(join(p.tree, '.padakan', 'DONE'), '');
    assert.equal((await p.gw.status('pad-1')).state, 'done');
    p.dt.boxes.get('pad-1').state = 'deleted';
    assert.equal((await p.gw.status('pad-1')).state, 'gone');
  } finally {
    await cleanup(p);
  }
});

test('evidence pulls .padakan/evidence into the task folder; retire pulls the record', async () => {
  const p = await planted();
  try {
    assert.deepEqual(await p.gw.evidence('pad-1', 'PAD-1'), { video: null, files: [] });
    await mkdir(join(p.tree, '.padakan', 'evidence', 'browser'), { recursive: true });
    await writeFile(join(p.tree, '.padakan', 'evidence', 'notes.md'), 'AC1 pass\n');
    await writeFile(join(p.tree, '.padakan', 'evidence', 'browser', 'run.webm'), 'video');
    const ev = await p.gw.evidence('pad-1', 'PAD-1');
    assert.equal(ev.video, join('tasks', 'PAD-1', 'evidence', 'daytona', 'browser', 'run.webm'));
    assert.equal(await readFile(join(p.records, 'tasks', 'PAD-1', 'evidence', 'daytona', 'notes.md'), 'utf8'), 'AC1 pass\n');

    await writeFile(join(p.tree, '.padakan', 'record.md'), '# record\n');
    const r = await p.gw.retire('pad-1', 'PAD-1');
    assert.equal(r.destroyed, true);
    assert.equal(await readFile(join(p.records, 'tasks', 'PAD-1', 'record.md'), 'utf8'), '# record\n');
    assert.equal(existsSync(join(p.records, 'sandboxes', 'pad-1.json')), false);
  } finally {
    await cleanup(p);
  }
});

test('destroy refuses uncommitted or unpushed work unless forced', async () => {
  const p = await planted();
  try {
    await writeFile(join(p.tree, 'wip.txt'), 'x');
    await assert.rejects(p.gw.destroy('pad-1'), (e) => e.code === 'UNSAVED_WORK' && /1 uncommitted and 0 unpushed/.test(e.message));
    git(p.tree, 'add', 'wip.txt');
    git(p.tree, '-c', 'user.name=T', '-c', 'user.email=t@e.st', 'commit', '-q', '-m', 'wip');
    await assert.rejects(p.gw.destroy('pad-1'), (e) => /0 uncommitted and 1 unpushed/.test(e.message));

    // A stopped sandbox is started to check, not deleted blind.
    await p.gw.pause('pad-1');
    await assert.rejects(p.gw.destroy('pad-1'), (e) => e.code === 'UNSAVED_WORK');
    assert.equal(p.dt.boxes.get('pad-1').state, 'started');

    git(p.tree, 'push', '-q', 'origin', 'padakan/PAD-1');
    assert.equal((await p.gw.destroy('pad-1')).destroyed, true);
    assert.equal(p.dt.boxes.get('pad-1').state, 'deleted');
    assert.equal(git(p.base, '--git-dir', join(p.base, 'remote.git'), 'rev-parse', '--verify', 'padakan/PAD-1').length, 40, 'the branch survives');
  } finally {
    await cleanup(p);
  }
  const f = await planted();
  try {
    await writeFile(join(f.tree, 'wip.txt'), 'x');
    assert.equal((await f.gw.call('destroy', 'pad-1', { force: true })).destroyed, true);
  } finally {
    await cleanup(f);
  }
});

test('plant seeds and bootstraps a remote tree, and reports a failed step', async () => {
  const p = await project();
  try {
    const ctx = buildContext({ base: { settings: p.ctx.settings, records: p.records, repo: p.repo }, overrides: { gateway: p.gw } });
    const r = await STEPS.plant(ctx, ['PAD-3']);
    assert.equal(r.line, 'TREE=pad-3 STATE=ready BRANCH=padakan/PAD-3');
    assert.equal(git(join(p.dt.home('pad-3'), 'trees', 'pad-3'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'padakan/PAD-3');
    assert.equal((await readState(p.records)).tasks['PAD-3'].status, 'planted');
  } finally {
    await cleanup(p);
  }
  const f = await project({ CLAUDE_CODE_OAUTH_TOKEN: '' });
  try {
    const ctx = buildContext({ base: { settings: f.ctx.settings, records: f.records, repo: f.repo }, overrides: { gateway: f.gw } });
    const r = await STEPS.plant(ctx, ['PAD-4']);
    assert.equal(r.code, 1);
    assert.equal(r.line, 'TREE=pad-4 STATE=failed STEP=seed');
    assert.equal((await readState(f.records)).tasks['PAD-4'].status, 'plant-failed');
  } finally {
    await cleanup(f);
  }
});

test('helpers: clone URL, CLAUDE.md blocks and daytona info parsing', () => {
  assert.equal(daytona.cloneUrl('git@github.com:acme/shop.git'), 'https://github.com/acme/shop.git');
  assert.equal(daytona.cloneUrl('ssh://git@github.com/acme/shop.git'), 'https://github.com/acme/shop.git');
  assert.equal(daytona.cloneUrl('https://github.com/acme/shop.git'), 'https://github.com/acme/shop.git');

  const block = '<!-- padakan:tree:start -->\nnew\n<!-- padakan:tree:end -->\n';
  assert.equal(daytona.mergeBlocks('', [block]), block);
  const mine = '# my notes\n';
  const merged = daytona.mergeBlocks(mine, [block]);
  assert.ok(merged.startsWith(mine) && merged.endsWith(block));
  assert.equal(daytona.mergeBlocks(merged.replace('new', 'old'), [block]), merged);

  assert.equal(daytona.parseInfo('Name: x\nState:  started\n'), 'started');
  assert.equal(daytona.parseInfo('{"name":"x","state":"STOPPED"}'), 'stopped');
  assert.equal(daytona.parseInfo('nothing here'), null);
});

test('the remote files are generic and the snapshot follows the Daytona rules', async () => {
  const dir = join(ROOT, 'sandboxes', 'daytona');
  const docker = await readFile(join(dir, 'snapshot', 'Dockerfile'), 'utf8');
  assert.match(docker, /^FROM --platform=linux\/amd64 ubuntu:24\.04$/m);
  assert.match(docker, /CMD \["sleep", "infinity"\]/);
  assert.ok(!/ENV .*(TOKEN|KEY|SECRET)=/.test(docker), 'no secrets baked in');
  const boot = await readFile(join(dir, 'remote', 'bootstrap.sh'), 'utf8');
  assert.match(boot.trim().split('\n').at(-1), /^echo BOOTSTRAP-OK$/);
  for (const f of ['CLAUDE-padakan.md', 'CLAUDE-evidence.md', 'CLAUDE-disk.md']) {
    const text = await readFile(join(dir, 'remote', f), 'utf8');
    assert.match(text, /^<!-- padakan:[a-z]+:start -->/);
    assert.match(text, /<!-- padakan:[a-z]+:end -->\n$/);
  }
});

test('the daytona doctor checks the CLI, auth, snapshot and seed settings without printing secrets', async () => {
  const s = await setup({ env: ENV });
  const dt = await mockDaytona();
  try {
    const rows = await doctor({ ...s.ctx, daytonaRun: dt.run });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    for (const n of ['cli', 'auth', 'snapshot', 'claude-token', 'gh-token', 'identity']) assert.equal(by[n].ok, true, n);
    assert.ok(!JSON.stringify(rows).includes(TOKEN));

    const missing = await doctor({ ...s.ctx, settings: { ...s.ctx.settings, DAYTONA_SNAPSHOT: 'other', CLAUDE_CODE_OAUTH_TOKEN: '' }, daytonaRun: dt.run });
    const m = Object.fromEntries(missing.map((r) => [r.name, r]));
    assert.match(m.snapshot.detail, /daytona snapshot create other --dockerfile sandboxes\/daytona\/snapshot\/Dockerfile/);
    assert.equal(m['claude-token'].ok, false);

    const none = await doctor({ ...s.ctx, daytonaRun: async () => ({ code: 127, stdout: '', stderr: 'not installed' }) });
    assert.equal(none[0].name, 'cli');
    assert.equal(none[0].ok, false);
  } finally {
    await removeDir(s.base);
    await removeDir(dt.root);
  }
});
