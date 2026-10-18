import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRepo, removeDir, tempDir } from '../helpers/index.mjs';
import { gatedDeploy, simulatedAdapter, adapterFor, DeployError } from '../../core/deploy.mjs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';
import { buildContext } from '../../orchestrator/lib/context.mjs';
import { STEPS } from '../../orchestrator/steps.mjs';
import { updateTask, readState } from '../../orchestrator/lib/state.mjs';

const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'local', PADAKAN_SLO_ERROR_RATE: '0.02', PADAKAN_CANARY_PERCENT: '10' } });
const release = { task: 'PAD-1', head: 'a'.repeat(40) };

test('a healthy canary is promoted to everyone', async () => {
  const dir = await tempDir();
  try {
    const adapter = simulatedAdapter({ records: dir, series: [0.001, 0.0, 0.01] });
    const r = await gatedDeploy({ adapter, release, settings });
    assert.equal(r.outcome, 'promoted');
    assert.equal(r.windows.length, 3);
    const sim = JSON.parse(await readFile(join(dir, 'deploy', 'simulated.json'), 'utf8'));
    assert.deepEqual(sim.live, { task: 'PAD-1', head: release.head });
    assert.deepEqual(sim.history.map((h) => h.event), ['flag-on', 'canary', 'promote']);
    assert.equal(sim.history[1].percent, 10);
  } finally {
    await removeDir(dir);
  }
});

test('AC1: an SLO breach during the canary rolls back by itself', async () => {
  const dir = await tempDir();
  try {
    const adapter = simulatedAdapter({ records: dir, series: [0.001, 0.05, 0] });
    const r = await gatedDeploy({ adapter, release, settings });
    assert.equal(r.outcome, 'rolled-back');
    assert.match(r.reason, /error rate 0\.05 above the SLO 0\.02 in canary window 2/);
    const sim = JSON.parse(await readFile(join(dir, 'deploy', 'simulated.json'), 'utf8'));
    assert.equal(sim.flags['PAD-1'], 'off');
    assert.equal(sim.live, null, 'the change never reached everyone');
  } finally {
    await removeDir(dir);
  }
});

test('unreadable metrics roll back too', async () => {
  const adapter = { name: 'x', flagOn: async () => {}, setCanary: async () => {}, metrics: async () => ({}), promote: async () => assert.fail('must not promote'), rollback: async () => {} };
  assert.equal((await gatedDeploy({ adapter, release, settings })).outcome, 'rolled-back');
});

test('AC2: the target is an adapter; unbuilt targets say so', () => {
  assert.equal(adapterFor(settings, { records: '/tmp/x' }).name, 'simulated');
  assert.throws(() => adapterFor(loadSettings({ exported: { PADAKAN_DEPLOY_TARGET: 'vercel' } }), {}), (e) => e instanceof DeployError && /not built yet/.test(e.message));
});

test('padakan deploy: only merged changes; a rollback escalates and is audited; a human can roll back', async () => {
  const env = await makeRepo('shop');
  try {
    const records = join(env.parent, 'shop-padakan');
    const ctx = buildContext({ base: { settings, records, repo: env.repo } });
    await STEPS.init(ctx);
    await updateTask(records, 'PAD-7', { status: 'verified' });
    assert.match((await STEPS.deploy(ctx, ['PAD-7'])).line, /DEPLOY=no REASON="task is verified; only a merged change is deployed"/);

    await updateTask(records, 'PAD-7', { status: 'merged', merged_head: 'b'.repeat(40) });
    ctx.deployAdapter = simulatedAdapter({ records, series: [0.5] });
    const bad = await STEPS.deploy(ctx, ['PAD-7']);
    assert.equal(bad.code, 1);
    assert.equal(bad.line, 'DEPLOY=rolled-back TARGET=simulated CANARY=10% ERROR_RATE=0.5 ESCALATED=yes');
    assert.equal((await readState(records)).tasks['PAD-7'].status, 'escalated');

    await updateTask(records, 'PAD-8', { status: 'merged', merged_head: 'c'.repeat(40) });
    ctx.deployAdapter = simulatedAdapter({ records, series: [0, 0, 0] });
    assert.equal((await STEPS.deploy(ctx, ['PAD-8'])).line, 'DEPLOY=promoted TARGET=simulated CANARY=10% ERROR_RATE=0');
    assert.equal((await readState(records)).tasks['PAD-8'].status, 'done');
    assert.equal((await STEPS.rollback(ctx, ['PAD-8'])).line, 'ROLLBACK=done TARGET=simulated');

    const types = (await ctx.audit.replay()).map((e) => e.event.type).filter((t) => t.startsWith('deploy.'));
    assert.deepEqual(types, ['deploy.rollback', 'deploy.promote', 'deploy.rollback']);
    const deployJson = JSON.parse(await readFile(join(records, 'tasks', 'PAD-7', 'deploy.json'), 'utf8'));
    assert.equal(deployJson.outcome, 'rolled-back');
  } finally {
    await removeDir(env.base);
  }
});
