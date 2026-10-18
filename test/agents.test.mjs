import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { parseFrontmatter } from '../core/okf.mjs';

const EXPECTED = [
  'acceptance-tester', 'bug-agent', 'builder', 'capability-resolver', 'design-implementer', 'evidence-builder', 'planner',
  'report-writer', 'security-auditor', 'test-runner', 'test-writer', 'tree-operator', 'ux-designer', 'verifier',
];
const dir = join(ROOT, 'agents');
const load = async () =>
  Promise.all((await readdir(dir)).filter((f) => f.endsWith('.md')).sort().map(async (f) => ({ file: f, text: await readFile(join(dir, f), 'utf8') })));

test('the 14 agents from the architecture exist, and nothing else', async () => {
  assert.deepEqual((await load()).map((a) => a.file.replace(/\.md$/, '')), EXPECTED);
});

test('frontmatter: name matches the file, description, tools, model, color, effort', async () => {
  for (const { file, text } of await load()) {
    const { data, problems } = parseFrontmatter(text);
    assert.deepEqual(problems, [], file);
    assert.equal(data.name, file.replace(/\.md$/, ''), file);
    assert.ok(data.description && data.description.length > 40, `${file} description`);
    assert.ok(['opus', 'sonnet', 'haiku'].includes(data.model), `${file} model`);
    assert.ok(['low', 'medium', 'high', 'xhigh'].includes(data.effort), `${file} effort`);
    assert.ok(data.color, `${file} color`);
    assert.ok(data.tools && data.tools.length, `${file} tools`);
  }
});

test('AC2: no agent can dispatch another agent', async () => {
  for (const { file, text } of await load()) {
    const tools = parseFrontmatter(text).data.tools.split(',').map((t) => t.trim());
    assert.ok(!tools.includes('Task') && !tools.includes('Agent'), `${file} must not have Task or Agent`);
  }
});

test('AC1: every agent ends with exactly one documented result line', async () => {
  for (const { file, text } of await load()) {
    const m = text.match(/## Result line\n\n```\n([^\n]+)\n```\n?$/);
    assert.ok(m, `${file} ends with a "## Result line" block holding one line`);
    assert.match(m[1], /^[A-Z_]+=\S/, `${file} result line is KEY=value pairs`);
  }
});

test('AC3: every agent is told to write OKF documents, a trace log and no secrets', async () => {
  for (const { file, text } of await load()) {
    assert.match(text, /Open Knowledge Format/, file);
    assert.ok(text.includes(`logs/${file.slice(0, -3)}.md`), `${file} trace log path`);
    assert.match(text, /Secrets/, file);
    assert.match(text, /never call another agent/i, file);
  }
});
