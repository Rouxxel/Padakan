import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, tempDir, removeDir } from '../helpers/index.mjs';
import { SETTINGS, loadSettings, parseEnv, renderExample, SettingsError } from '../../orchestrator/lib/env.mjs';

async function withFiles(records, plugin, fn) {
  const dir = await tempDir();
  try {
    const recordsEnvFile = join(dir, 'records.env');
    const pluginEnvFile = join(dir, 'plugin.env');
    if (records !== null) await writeFile(recordsEnvFile, records);
    if (plugin !== null) await writeFile(pluginEnvFile, plugin);
    return await fn({ recordsEnvFile, pluginEnvFile });
  } finally {
    await removeDir(dir);
  }
}

test('AC1: load order is exported, then records .env, then plugin .env, then the default', async () => {
  await withFiles(
    'PADAKAN_MAX_TREES=5\nPADAKAN_LANGUAGE=de\n',
    'PADAKAN_MAX_TREES=7\nPADAKAN_LANGUAGE=fr\nPADAKAN_WATCH_INTERVAL_MIN=30\n',
    async (files) => {
      const s = loadSettings({ exported: { PADAKAN_MAX_TREES: '9' }, ...files });
      assert.equal(s.PADAKAN_MAX_TREES, 9);
      assert.equal(s.source('PADAKAN_MAX_TREES'), 'exported');
      assert.equal(s.PADAKAN_LANGUAGE, 'de');
      assert.equal(s.source('PADAKAN_LANGUAGE'), 'records .env');
      assert.equal(s.PADAKAN_WATCH_INTERVAL_MIN, 30);
      assert.equal(s.source('PADAKAN_WATCH_INTERVAL_MIN'), 'plugin .env');
      assert.equal(s.PADAKAN_DEPLOY_TARGET, 'simulated');
      assert.equal(s.source('PADAKAN_DEPLOY_TARGET'), 'default');
    },
  );
});

test('missing .env files are fine; defaults are typed', () => {
  const s = loadSettings({ exported: {}, recordsEnvFile: '/nope/.env', pluginEnvFile: undefined });
  assert.equal(s.PADAKAN_SANDBOX_PROVIDER, 'devin');
  assert.equal(s.DEVIN_BYPASS_APPROVAL, true);
  assert.deepEqual(s.PADAKAN_PROTECTED_PATHS, ['.github/', 'infra/', '**/*.lock']);
  assert.equal(s.PADAKAN_SLO_ERROR_RATE, 0.01);
  assert.equal(s.PADAKAN_BUDGET_RUN_USD, null, 'an empty budget means no cap');
  assert.ok(Object.isFrozen(s));
});

test('AC2: an invalid value fails naming the key and the allowed values', () => {
  assert.throws(
    () => loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'aws' } }),
    (e) => e instanceof SettingsError && /PADAKAN_SANDBOX_PROVIDER: "aws" is not one of devin, daytona, local/.test(e.message),
  );
  assert.throws(() => loadSettings({ exported: { PADAKAN_MAX_TREES: 'three' } }), /PADAKAN_MAX_TREES: expected a whole number/);
  assert.throws(() => loadSettings({ exported: { PADAKAN_MAX_TREES: '2.5' } }), /PADAKAN_MAX_TREES: expected a whole number/);
  assert.throws(() => loadSettings({ exported: { PADAKAN_CANARY_PERCENT: '150' } }), /PADAKAN_CANARY_PERCENT: must be at most 100/);
  assert.throws(() => loadSettings({ exported: { DEVIN_BYPASS_APPROVAL: 'yes' } }), /DEVIN_BYPASS_APPROVAL: expected true or false/);
  assert.throws(() => loadSettings({ exported: { NEBIUS_BASE_URL: 'ftp://x' } }), /NEBIUS_BASE_URL: expected an http\(s\) URL/);
});

test('all problems are reported at once', () => {
  try {
    loadSettings({ exported: { PADAKAN_MAX_TREES: 'x', PADAKAN_DRIVER: 'tmux', PADAKAN_TYPO: '1' } });
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.problems.length, 3);
  }
});

test('unknown keys fail: any key in a .env file, PADAKAN_* keys in the exported environment', async () => {
  assert.throws(() => loadSettings({ exported: { PADAKAN_MAX_TREE: '3' } }), /PADAKAN_MAX_TREE: unknown setting in the exported environment/);
  // Unrelated exported variables are not ours to judge.
  assert.doesNotThrow(() => loadSettings({ exported: { PATH: '/bin', HOME: '/tmp' } }));
  await withFiles('DEVIN_API_KY=abc\n', null, (files) => {
    assert.throws(() => loadSettings({ exported: {}, ...files }), /DEVIN_API_KY: unknown setting in records \.env/);
  });
});

test('AC3: .env.example lists every key in SETTINGS and nothing else, and matches the generator', async () => {
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  assert.equal(text, renderExample(), 'run `node orchestrator/lib/env.mjs --example > .env.example`');
  const keys = Object.keys(parseEnv(text));
  assert.deepEqual(keys.sort(), SETTINGS.map((s) => s.key).sort());
});

test('AC4: secret values never appear in describe() or in errors', async () => {
  const secret = 'cog_super_secret_value_123';
  const s = loadSettings({ exported: { DEVIN_API_KEY: secret, GH_PAT: 'ghp_also_secret' } });
  const out = s.describe();
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes('ghp_also_secret'));
  assert.match(out, /^DEVIN_API_KEY=\*\*\*  \(exported\)$/m);
  // A malformed line in a .env file is reported by line number, never by content.
  await withFiles(`DEVIN_API_KEY ${secret}\n`, null, (files) => {
    assert.throws(
      () => loadSettings({ exported: {}, ...files }),
      (e) => /records\.env:1: not a KEY=VALUE line/.test(e.message) && !e.message.includes(secret),
    );
  });
});

test('missing() lists required settings, including conditional ones', () => {
  const s = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'devin' } });
  assert.deepEqual(s.missing().sort(), ['GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'PADAKAN_DEVIN_USD_PER_ACU']);
  const local = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'local', GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c' } });
  assert.deepEqual(local.missing(), []);
});

test('parseEnv handles quotes, export and inline comments', () => {
  const v = parseEnv(`# comment\nexport A=1\nB="two words # not a comment"\nC='x'\nD=plain # comment\nE=\n`);
  assert.deepEqual(v, { A: '1', B: 'two words # not a comment', C: 'x', D: 'plain', E: '' });
});

test('every setting is documented and typed', () => {
  for (const s of SETTINGS) {
    assert.ok(s.desc && s.desc.length > 5, `${s.key} has a description`);
    assert.ok(['string', 'path', 'url', 'enum', 'bool', 'list', 'int', 'number'].includes(s.type), `${s.key} type`);
    if (s.type === 'enum') assert.ok(s.values.includes(s.default) || s.default === '', `${s.key} default is allowed`);
  }
  assert.equal(new Set(SETTINGS.map((s) => s.key)).size, SETTINGS.length, 'no duplicate keys');
});
