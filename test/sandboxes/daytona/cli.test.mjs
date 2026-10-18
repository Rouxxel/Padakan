import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, removeDir } from '../../helpers/index.mjs';
import { runDaytona, profileHome, cliPrefix } from '../../../sandboxes/daytona/cli.mjs';
import { doctor } from '../../../sandboxes/daytona/doctor.mjs';

const KEY = 'dtn_test_key_value_123456';

test('the CLI always runs on a private profile logged in with DAYTONA_API_KEY, never the machine login', async () => {
  const base = await tempDir();
  const log = join(base, 'daytona.log');
  process.env.PADAKAN_STUB_LOG = log;
  try {
    const records = join(base, 'shop-padakan');
    await assert.rejects(runDaytona({ records, settings: {} }, ['list']), (e) => e.code === 'NO_DAYTONA_KEY');
    assert.equal(existsSync(log), false, 'nothing ran without the key');

    const ctx = { records, settings: { DAYTONA_API_KEY: KEY } };
    await runDaytona(ctx, ['list']);
    await runDaytona(ctx, ['info', 'pad-1']);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const home = profileHome(ctx);
    assert.equal(home, `${records}-daytona`);
    assert.deepEqual(lines, [`HOME=${home} daytona login --api-key ${KEY}`, `HOME=${home} daytona list`, `HOME=${home} daytona info pad-1`], 'one login, then every call on that HOME');
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.ok(!readFileSync(join(home, '.padakan-key'), 'utf8').includes(KEY), 'the marker holds a fingerprint, not the key');

    await runDaytona({ records, settings: { DAYTONA_API_KEY: `${KEY}-rotated` } }, ['list']);
    assert.match(readFileSync(log, 'utf8'), /login --api-key dtn_test_key_value_123456-rotated/, 'a new key logs in again');
    assert.equal(cliPrefix(ctx), `HOME=${home} daytona`);
  } finally {
    delete process.env.PADAKAN_STUB_LOG;
    await removeDir(base);
  }
});

test('doctor fails auth without DAYTONA_API_KEY instead of falling back to the machine login', async () => {
  const base = await tempDir();
  try {
    const rows = await doctor({ records: join(base, 'r'), settings: {} });
    const auth = rows.find((r) => r.name === 'auth');
    assert.equal(auth.ok, false);
    assert.match(auth.detail, /DAYTONA_API_KEY is not set/);
  } finally {
    await removeDir(base);
  }
});
