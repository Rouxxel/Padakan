import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, makeRepo, removeDir, git } from './helpers.mjs';

const readJson = async (p) => JSON.parse(await readFile(join(ROOT, p), 'utf8'));

test('plugin manifest names the plugin and its version', async () => {
  const m = await readJson('.claude-plugin/plugin.json');
  assert.equal(m.name, 'padakan');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description.length > 20);
});

test('marketplace lists the plugin from the repo root', async () => {
  const m = await readJson('.claude-plugin/marketplace.json');
  const p = m.plugins.find((x) => x.name === 'padakan');
  assert.ok(p, 'padakan is listed');
  assert.equal(p.source, './');
});

test('package.json has no runtime dependencies', async () => {
  const p = await readJson('package.json');
  assert.equal(p.dependencies, undefined);
  assert.equal(p.devDependencies, undefined);
  assert.equal(p.type, 'module');
});

test('orchestrator rules exist and are an OKF document', async () => {
  const text = await readFile(join(ROOT, 'orchestrator/RULES.md'), 'utf8');
  assert.match(text, /^---\n(?:[\s\S]*?\n)?type: Rules\n[\s\S]*?\n---\n/);
  for (const field of ['title:', 'description:', 'tags:', 'timestamp:']) assert.ok(text.includes(field), field);
});

test('.gitignore keeps secrets out and does not hide plugin code', async () => {
  const text = await readFile(join(ROOT, '.gitignore'), 'utf8');
  const lines = text.split('\n').map((l) => l.trim());
  for (const l of ['.env', '.env.*', '!.env.example', 'secrets/', '*credentials*.json']) assert.ok(lines.includes(l), l);
  assert.ok(!lines.includes('lib/'), 'a bare lib/ rule would hide orchestrator/lib/');
});

test('makeRepo builds a real repo with a sibling-ready parent folder', async () => {
  const { base, repo } = await makeRepo('demo');
  try {
    await access(join(repo, '.git'));
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  } finally {
    await removeDir(base);
  }
});
