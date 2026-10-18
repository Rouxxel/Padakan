// The contract every sandbox provider must pass, run against each provider for the verbs it declares,
// plus the gateway's own guarantees.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { removeDir, tempDir } from '../helpers/index.mjs';
import { setup, fakeProvider } from '../helpers/sandbox.mjs';
import { openGateway } from '../../sandboxes/index.mjs';
import { UnsupportedVerb, checkProvider, VERBS } from '../../sandboxes/contract.mjs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';

describe('provider modules', () => {
  test('checkProvider catches a broken provider', () => {
    const p = checkProvider({ name: 'x', capabilities: ['create', 'fly'] }, 'x');
    assert.ok(p.some((m) => m.includes('unknown verb in capabilities: fly')));
    assert.ok(p.some((m) => m.includes('declares "create" but does not export it')));
    assert.ok(p.some((m) => m.includes('must support "status"')));
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
