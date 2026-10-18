import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ROOT, makeRepo, removeDir, git, runNode } from '../helpers/index.mjs';
import { inspect, globToRegExp, parseDiff } from '../../core/diffcheck.mjs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';

const settings = loadSettings({ exported: {} }); // defaults: 60 lines, 3 files, .github/, infra/, **/*.lock

// A repo with a base commit; `change` writes files on top and commits them. Returns the base sha.
async function fixture(change, before = { 'src/app.js': 'export const a = 1;\n' }) {
  const env = await makeRepo('shop');
  const write = async (files) => {
    for (const [p, c] of Object.entries(files)) {
      await mkdir(dirname(join(env.repo, p)), { recursive: true });
      await writeFile(join(env.repo, p), c);
    }
  };
  await write(before);
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'base');
  env.base_sha = git(env.repo, 'rev-parse', 'HEAD');
  await write(change);
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '--allow-empty', '-m', 'change');
  return env;
}

async function check(change, opts = {}, before) {
  const env = await fixture(change, before);
  try {
    return await inspect({ repo: env.repo, base: env.base_sha, settings: opts.settings || settings, allowDependencies: opts.allow || [] });
  } finally {
    await removeDir(env.base);
  }
}

const by = (r, name) => r.checks.find((c) => c.name === name);

test('a small clean change passes every check', async () => {
  const r = await check({ 'src/app.js': 'export const a = 2;\n', 'src/app.test.js': 'test("a", () => {});\n' });
  assert.equal(r.pass, true, JSON.stringify(r.checks));
  assert.equal(r.lines, 3);
  assert.deepEqual(r.files, ['src/app.js', 'src/app.test.js']);
});

test('AC1: size trips over PADAKAN_MAX_DIFF_LINES', async () => {
  const r = await check({ 'src/big.js': Array.from({ length: 61 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n' });
  assert.equal(by(r, 'size').pass, false);
  assert.match(by(r, 'size').detail, /61 lines changed \(limit 60\)/);
  assert.equal(r.pass, false);
});

test('AC1: files trips over PADAKAN_MAX_DIFF_FILES', async () => {
  const r = await check({ 'a.js': '1\n', 'b.js': '2\n', 'c.js': '3\n', 'd.js': '4\n' });
  assert.equal(by(r, 'files').pass, false);
  assert.match(by(r, 'files').detail, /4 files changed \(limit 3\)/);
});

test('AC1: protected paths trip, by folder prefix and by glob', async () => {
  const r = await check({ '.github/workflows/ci.yml': 'on: push\n', 'web/yarn.lock': 'x\n' });
  assert.equal(by(r, 'protected').pass, false);
  assert.match(by(r, 'protected').detail, /\.github\/workflows\/ci\.yml \(\.github\/\)/);
  assert.match(by(r, 'protected').detail, /web\/yarn\.lock \(\*\*\/\*\.lock\)/);
});

test('AC1 + AC2: secrets trip and are reported by file and line, never by value', async () => {
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const generic = 'const api_key = "Zx9!qL2#vT7$mR4p";';
  const r = await check({ 'src/app.js': `export const a = 1;\nconst t = "${token}";\n${generic}\n` });
  const s = by(r, 'secrets');
  assert.equal(s.pass, false);
  assert.match(s.detail, /src\/app\.js:2 \(github-token\)/);
  assert.match(s.detail, /src\/app\.js:3 \(generic-secret\)/);
  assert.ok(!JSON.stringify(r).includes(token), 'the token value never appears');
  assert.ok(!JSON.stringify(r).includes('Zx9!qL2#vT7$mR4p'));
});

test('a low-entropy placeholder is not reported as a secret', async () => {
  const r = await check({ 'src/app.js': 'export const a = 1;\nconst password = "aaaaaaaaaaaaaaaa";\n' });
  assert.equal(by(r, 'secrets').pass, true);
});

test('AC1: dependency changes trip unless the task manifest allows them', async () => {
  const before = { 'src/app.js': 'x\n', 'package.json': '{"name":"shop"}\n' };
  const change = { 'package.json': '{"name":"shop","dependencies":{"left-pad":"1.0.0"}}\n' };
  const blocked = await check(change, {}, before);
  assert.equal(by(blocked, 'dependencies').pass, false);
  assert.match(by(blocked, 'dependencies').detail, /dependency files changed: package\.json/);
  const allowed = await check(change, { allow: ['package.json'] }, before);
  assert.equal(by(allowed, 'dependencies').pass, true);
  assert.match(by(allowed, 'dependencies').detail, /allowed by the task manifest/);
});

test('renames and deletions are counted', async () => {
  const env = await fixture({});
  try {
    git(env.repo, 'mv', 'src/app.js', 'src/main.js');
    git(env.repo, 'commit', '-q', '-m', 'rename');
    const r = await inspect({ repo: env.repo, base: env.base_sha, settings });
    assert.deepEqual(r.files, ['src/main.js']);
    assert.equal(r.lines, 0);
  } finally {
    await removeDir(env.base);
  }
});

test('AC3: identical input gives byte-identical output', async () => {
  const env = await fixture({ 'src/app.js': 'export const a = 3;\n', 'src/b.js': 'b\n' });
  try {
    const a = JSON.stringify(await inspect({ repo: env.repo, base: env.base_sha, settings }));
    const b = JSON.stringify(await inspect({ repo: env.repo, base: env.base_sha, settings }));
    assert.equal(a, b);
    const cli = runNode(join(ROOT, 'core', 'diffcheck.mjs'), [env.base_sha, 'HEAD', '--repo', env.repo], { env: { PADAKAN_MAX_DIFF_FILES: '1' } });
    assert.equal(cli.code, 1);
    assert.equal(JSON.parse(cli.stdout).checks.find((c) => c.name === 'files').pass, false);
  } finally {
    await removeDir(env.base);
  }
});

test('globToRegExp and parseDiff edge cases', () => {
  assert.ok(globToRegExp('**/*.lock').test('a/b/c.lock'));
  assert.ok(globToRegExp('**/*.lock').test('c.lock'));
  assert.ok(!globToRegExp('*.lock').test('a/c.lock'));
  assert.ok(globToRegExp('infra/').test('infra/main.tf'));
  assert.ok(!globToRegExp('infra/').test('src/infra/main.tf'));
  const files = parseDiff('diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n');
  assert.equal(files[0].binary, true);
});
