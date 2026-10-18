import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers/index.mjs';
import { parseFrontmatter, validateFile } from '../../core/okf.mjs';

const dir = join(ROOT, 'skills');
const folders = async () => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();

test('AC1: every skill folder has a SKILL.md with name and description', async () => {
  const names = await folders();
  assert.equal(names.length, 13);
  for (const name of names) {
    const file = join(dir, name, 'SKILL.md');
    assert.ok(existsSync(file), `${name}/SKILL.md`);
    const { data, problems } = parseFrontmatter(await readFile(file, 'utf8'));
    assert.deepEqual(problems, [], name);
    assert.equal(data.name, name);
    assert.ok(data.description && data.description.length > 40, `${name} description`);
  }
});

test('AC2: CATALOG.md lists exactly the skill folders, and is valid OKF', async () => {
  const text = await readFile(join(dir, 'CATALOG.md'), 'utf8');
  const listed = [...text.matchAll(/\| \[`([a-z0-9-]+)`\]\(\.\/\1\/SKILL\.md\) \|/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, await folders());
  assert.deepEqual(await validateFile(join(dir, 'CATALOG.md'), { root: dir }), []);
});

test('AC3: verify kits name the MCP servers and CLIs from TOOLS.md', async () => {
  const tools = await readFile(join(ROOT, 'documentation', 'infrastructure', 'TOOLS.md'), 'utf8');
  const expect = {
    'verify-web': ['Playwright MCP', 'Chrome DevTools MCP'],
    'verify-ios': ['MobileBuildMCP', 'xcodebuild', 'simctl'],
    'verify-android': ['AndroidBuildMCP', 'adb-mcp', 'adb'],
    'verify-backend': ['curl', 'docker logs'],
  };
  for (const [skill, names] of Object.entries(expect)) {
    const text = await readFile(join(dir, skill, 'SKILL.md'), 'utf8');
    for (const n of names) assert.ok(text.includes(n), `${skill} names ${n}`);
  }
  // The MCP servers the kits rely on are the ones documented in TOOLS.md.
  for (const mcp of ['Playwright', 'Chrome DevTools', 'MobileBuildMCP', 'AndroidBuildMCP', 'adb-mcp']) {
    assert.ok(tools.includes(mcp), `TOOLS.md lists ${mcp}`);
  }
});

test('descriptions are quoted, so a YAML parser reads them whole', async () => {
  for (const name of await folders()) {
    const text = await readFile(join(dir, name, 'SKILL.md'), 'utf8');
    assert.match(text, /^description: ".+"$/m, name);
  }
});
