import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { parseFrontmatter } from '../core/okf.mjs';
import { STEPS } from '../orchestrator/steps.mjs';

const EXPECTED = ['build', 'decide', 'evidence', 'feature', 'onboard', 'pause', 'plan', 'replay', 'rollback', 'status', 'watch'];
const dir = join(ROOT, 'commands');
const load = async () => Promise.all((await readdir(dir)).sort().map(async (f) => ({ name: f.replace(/\.md$/, ''), text: await readFile(join(dir, f), 'utf8') })));

test('the 11 commands exist with a quoted description and allowed tools', async () => {
  const cmds = await load();
  assert.deepEqual(cmds.map((c) => c.name), EXPECTED);
  for (const { name, text } of cmds) {
    const { data, problems } = parseFrontmatter(text);
    assert.deepEqual(problems, [], name);
    assert.match(text, /^description: ".{20,}"$/m, name);
    assert.ok(data['allowed-tools'], `${name} allowed-tools`);
  }
});

test('AC1: every command names the script it follows, and every padakan step it uses exists', async () => {
  const steps = new Set([...Object.keys(STEPS), 'doctor']);
  for (const { name, text } of await load()) {
    assert.match(text, /bin\/padakan|core\/(audit|okf|cost|deploy|collect-logs|triage)\.mjs/, `${name} names a script`);
    for (const m of text.matchAll(/bin\/padakan`? `?([a-z]+)/g)) assert.ok(steps.has(m[1]), `${name} uses unknown step "${m[1]}"`);
  }
});

test('AC1: commands that dispatch agents name agents that exist', async () => {
  const agents = new Set((await readdir(join(ROOT, 'agents'))).map((f) => f.replace(/\.md$/, '')));
  for (const { name, text } of await load()) {
    for (const m of text.matchAll(/dispatch \*\*([a-z-]+)\*\*/gi)) assert.ok(agents.has(m[1]), `${name} dispatches unknown agent ${m[1]}`);
  }
});

test('AC2: only onboard and plan may ask the human; decide answers a cost report', async () => {
  for (const { name, text } of await load()) {
    const tools = parseFrontmatter(text).data['allowed-tools'];
    if (['onboard', 'plan'].includes(name)) assert.match(tools, /AskUserQuestion/, name);
    else assert.doesNotMatch(tools, /AskUserQuestion/, `${name} must not ask the human`);
  }
  const plan = (await load()).find((c) => c.name === 'plan').text;
  assert.match(plan, /gate open/);
  assert.match(plan, /gate close/);
  assert.match((await load()).find((c) => c.name === 'decide').text, /decision report/);
});
