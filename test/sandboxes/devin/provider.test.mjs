// The Devin provider through the real gateway, against the mock Devin API (D.1: P1, P5–P16).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startMockDevin } from '../../helpers/mock-devin.mjs';
import { tempDir, removeDir } from '../../helpers/index.mjs';
import { openGateway } from '../../../sandboxes/index.mjs';
import { UnsupportedVerb, checkProvider } from '../../../sandboxes/contract.mjs';
import { loadSettings } from '../../../orchestrator/lib/env.mjs';
import { makeProvider, CostGateError } from '../../../sandboxes/devin/provider.mjs';
import * as devinModule from '../../../sandboxes/devin/provider.mjs';
import { REPORT_SCHEMA } from '../../../sandboxes/devin/state.mjs';
import { sessionCap, budgetLeft } from '../../../core/cost.mjs';
import { validateText } from '../../../core/okf.mjs';

let mock;
let dir;
let clock;
let effect;
const item = { step: 'devin-session', unit: 'acu', low: 2, likely: 4, high: 5, required: true };

before(async () => {
  mock = await startMockDevin();
});
after(() => mock.close());
beforeEach(async () => {
  if (dir) await removeDir(dir);
  dir = await tempDir();
  clock = Date.parse('2026-10-18T12:00:00Z');
  effect = { onRemote: true };
  mock.requests.length = 0;
});
after(async () => dir && removeDir(dir));

function env(extra = {}) {
  const settings = loadSettings({
    exported: {
      PADAKAN_SANDBOX_PROVIDER: 'devin', PADAKAN_MAX_TREES: '5',
      DEVIN_API_URL: mock.apiUrl, DEVIN_API_KEY: mock.apiKey, DEVIN_ORG_ID: mock.orgId,
      PADAKAN_DEVIN_USD_PER_ACU: '2', PADAKAN_BUDGET_TASK_USD: '20', ...extra,
    },
  });
  const devin = makeProvider({
    effects: {
      repoSlug: async () => 'o/r',
      baseSha: async () => 'a'.repeat(40),
      prHead: async () => ({ headSha: 'b'.repeat(40), state: 'OPEN', checks: [], onRemote: effect.onRemote }),
    },
    clientOptions: { sleep: async () => {} },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pricesYaml: '',
  });
  const records = join(dir, 'shop-padakan');
  const ctx = { settings, records, repo: join(dir, 'shop') };
  return { settings, ctx, records, gw: openGateway(ctx, { providers: { devin } }) };
}

async function briefFile() {
  const f = join(dir, 'brief.md');
  await writeFile(f, '---\ntype: Brief\ntitle: PAD-12\n---\n# Export CSV\n');
  return f;
}
const plant = async (e, id = 'pad-12', opts = {}) =>
  e.gw.create(id, { task: 'PAD-12', brief: await briefFile(), estimate: item, ledger: [], run: 'r-1', title: 'Export CSV', ...opts });
const lastCreate = () => mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/sessions')).at(-1);
const report = (o = {}) => ({ task: 'PAD-12', pr_url: 'https://github.com/o/r/pull/12', branch: 'padakan/PAD-12', acs: [{ id: 'AC1', verdict: 'pass' }], evidence: [], blocked: null, ...o });
const PR = [{ pr_url: 'https://github.com/o/r/pull/12', pr_state: 'open' }];
const record = { what_changed: 'Added CSV export.', files: 'src/export.ts', architecture: 'Button -> API -> CSV writer', seams: 'export API', next_step: 'none', misreadings: 'It is not streaming.', open: 'Large files.' };

test('P1 createSession sends every A.4 field, no secret values, and the session cap', async () => {
  const e = env({ DEVIN_PLAYBOOK_ID: 'pb-1', DEVIN_MODE: 'normal' });
  const h = await plant(e, 'pad-12', { manifest: { secrets: [{ name: 'STRIPE_TEST_KEY', id: 'sec-1' }] } });
  const req = lastCreate();
  const b = req.body;
  const expectedCap = sessionCap({ item, ledger: [], budgets: { run_usd: null, task_usd: 20, step_usd: null }, prices: { acu: 2 }, scope: { run: 'r-1', task: 'PAD-12' } }).max_acu_limit;
  assert.equal(b.max_acu_limit, expectedCap);
  assert.equal(b.max_acu_limit, 10);
  assert.match(b.prompt, /task PAD-12 in o\/r[\s\S]*branch padakan\/PAD-12/);
  assert.equal(b.title, 'PAD-12 · Export CSV');
  assert.deepEqual(b.repos, ['o/r']);
  assert.equal(b.platform, 'linux');
  assert.deepEqual(b.tags, ['padakan', 'task:PAD-12', 'run:r-1']);
  assert.equal(b.bypass_approval, true);
  assert.equal(b.resumable, true);
  assert.equal(b.playbook_id, 'pb-1');
  assert.equal(b.devin_mode, 'normal');
  assert.deepEqual(b.secret_ids, ['sec-1']);
  assert.deepEqual(b.attachment_urls, [mock.uploads.at(-1).url]);
  assert.deepEqual(b.structured_output_schema, REPORT_SCHEMA);
  assert.equal(b.structured_output_required, true);
  assert.ok(!req.raw.toString().includes(mock.apiKey), 'no secret value in the body');
  assert.ok(!(await readFile(join(e.records, 'sandboxes', 'pad-12.json'), 'utf8')).includes(mock.apiKey), 'no secret value in the handle');
  assert.equal(h.session_id, b && mock.sessions.get(h.session_id).session_id);
  assert.equal(h.max_acu_limit, 10);
  assert.equal(h.base_sha, 'a'.repeat(40));

  await plant(e, 'pad-13', { estimate: item });
  assert.equal(lastCreate().body.max_acu_limit, 10);
  const capped = env({ DEVIN_MAX_ACU: '7' });
  await plant(capped, 'pad-14');
  assert.equal(lastCreate().body.max_acu_limit, 7);
  const plain = env();
  await plant(plain, 'pad-15');
  assert.equal(lastCreate().body.playbook_id, undefined);
  assert.equal(lastCreate().body.devin_mode, undefined);
});

test('create runs the cost gate before anything is spent', async () => {
  const before = mock.sessions.size;
  for (const [extra, reason] of [[{ PADAKAN_BUDGET_TASK_USD: '5' }, 'task-cap'], [{ PADAKAN_DEVIN_USD_PER_ACU: '' }, 'no-price']]) {
    const e = env(extra);
    const err = await plant(e).catch((x) => x);
    assert.ok(err instanceof CostGateError, String(err));
    assert.equal(err.gate.reason, reason);
    assert.deepEqual(await readdir(join(e.records, 'sandboxes')), [], 'no handle left behind');
  }
  const low = env({ PADAKAN_BUDGET_TASK_USD: '10', DEVIN_MAX_ACU: '1' });
  assert.equal((await plant(low).catch((x) => x)).gate.reason, 'cap-below-low');
  assert.equal(mock.sessions.size, before, 'no session created');
});

test('P5 finished without a PR, or with a PR head not on the remote, is not done', async () => {
  const e = env();
  const h = await plant(e);
  mock.update(h.session_id, { status: 'running', status_detail: 'finished', structured_output: report(), pull_requests: [] });
  let r = await e.gw.poll('pad-12');
  assert.equal(r.state, 'working');
  assert.deepEqual(r.missing, ['pr']);
  mock.update(h.session_id, { pull_requests: PR });
  effect.onRemote = false;
  r = await e.gw.poll('pad-12');
  assert.deepEqual([r.state, r.missing], ['working', ['head-on-remote']]);
  assert.equal((await e.gw.status('pad-12')).state, 'working');
  clock += 10 * 60 * 1000;
  r = await e.gw.poll('pad-12');
  assert.equal(r.state, 'failed');
  assert.match(r.escalate, /^unverified-done:head-on-remote/);

  const h2 = await plant(e, 'pad-13');
  effect.onRemote = true;
  mock.update(h2.session_id, { status: 'exit', structured_output: report(), pull_requests: PR });
  r = await e.gw.poll('pad-13');
  assert.equal(r.state, 'done');
  assert.equal((await e.gw.get('pad-13')).state, 'done');
  assert.equal((await e.gw.status('pad-13')).state, 'done');
});

test('P6 structured output that fails report.json is a failed check', async () => {
  const e = env();
  const h = await plant(e);
  mock.update(h.session_id, { status: 'exit', structured_output: report({ acs: [{ id: 'X', verdict: 'maybe' }] }), pull_requests: PR });
  const r = await e.gw.poll('pad-12');
  assert.equal(r.state, 'working');
  assert.ok(r.missing.includes('report'));
  assert.ok(r.report_errors.length >= 2);
});

test('P7 questions are answered by rule; a second unknown question escalates', async () => {
  const e = env();
  const h = await plant(e);
  mock.update(h.session_id, { status: 'running', status_detail: 'waiting_for_user' });
  mock.devinSays(h.session_id, 'Here is my test plan. Does this plan look right?');
  let r = await e.gw.poll('pad-12');
  assert.equal(r.reply, 'Approved. Proceed without asking again.');
  assert.equal(mock.messagesOf(h.session_id).at(-1).message, r.reply);
  let stored = await e.gw.get('pad-12');
  assert.equal(stored.questions_answered, 1);
  assert.ok(stored.message_cursor);

  mock.devinSays(h.session_id, 'What colour should the logo be?');
  r = await e.gw.poll('pad-12');
  assert.equal(r.reply, 'Choose the most conservative option, note it in the PR, continue.');
  mock.devinSays(h.session_id, 'What font size?');
  const sent = mock.messagesOf(h.session_id).length;
  r = await e.gw.poll('pad-12');
  assert.equal(r.escalate, 'repeated-question');
  assert.equal(r.question, 'What font size?');
  assert.equal(mock.messagesOf(h.session_id).length, sent, 'no reply sent when escalating');
});

test('P8 hitting the session cap pauses with session-cap-hit; spend and the 80% warning are returned for the ledger', async () => {
  const e = env();
  const h = await plant(e);
  mock.update(h.session_id, { status: 'running', status_detail: 'working', acus_consumed: 8 });
  let r = await e.gw.poll('pad-12', { ledger: [], run: 'r-1' });
  assert.deepEqual(r.ledger_entries.map((x) => x.kind), ['spend', 'warn']);
  assert.equal(r.ledger_entries[0].usd, 16);
  assert.equal(r.ledger_entries[0].session_id, h.session_id);
  mock.update(h.session_id, { status: 'suspended', status_detail: 'usage_limit_exceeded', acus_consumed: 10 });
  r = await e.gw.poll('pad-12', { ledger: r.ledger_entries, run: 'r-1' });
  assert.deepEqual([r.state, r.action, r.escalate], ['paused', 'cost-gate', 'session-cap-hit']);
  assert.deepEqual(r.ledger_entries.map((x) => x.kind), ['spend']);
  assert.equal((await e.gw.get('pad-12')).state, 'paused');
});

test('P9 evidence downloads the newest video and writes a sha256 manifest', async () => {
  const e = env();
  const h = await plant(e);
  mock.addAttachment(h.session_id, 'brief.md', 'ours');
  mock.addAttachment(h.session_id, 'shot 1.png', 'PNG');
  mock.addAttachment(h.session_id, 'run.mp4', 'OLD');
  mock.addAttachment(h.session_id, 'run-final.mp4', 'NEWVIDEO');
  const ev = await e.gw.evidence('pad-12', 'PAD-12');
  assert.equal(ev.video, 'tasks/PAD-12/evidence/devin/run-final.mp4');
  assert.equal(ev.files.length, 3, 'our own brief is skipped');
  const manifest = JSON.parse(await readFile(join(e.records, 'tasks', 'PAD-12', 'evidence', 'devin', 'manifest.json'), 'utf8'));
  const final = manifest.files.find((f) => f.name === 'run-final.mp4');
  assert.equal(final.sha256, createHash('sha256').update('NEWVIDEO').digest('hex'));
  assert.ok(manifest.files.some((f) => f.name === 'shot_1.png'), 'unsafe characters are replaced');

  const h2 = await plant(e, 'pad-13');
  mock.addAttachment(h2.session_id, 'notes.txt', 'n');
  assert.equal((await e.gw.evidence('pad-13', 'PAD-13')).video, null);
  const h3 = await plant(e, 'pad-14');
  mock.addAttachment(h3.session_id, 'empty.mp4', '');
  await assert.rejects(e.gw.evidence('pad-14', 'PAD-14'), /recording empty\.mp4 is empty/);
});

test('P10 retire writes an OKF record.md with seven sections and archives; incomplete times out', async () => {
  const e = env();
  const h = await plant(e);
  mock.update(h.session_id, { status: 'running', status_detail: 'finished', structured_output: report({ record }) });
  const r = await e.gw.retire('pad-12', 'PAD-12');
  assert.deepEqual([r.record, r.sections], ['tasks/PAD-12/record.md', 7]);
  const text = await readFile(join(e.records, 'tasks', 'PAD-12', 'record.md'), 'utf8');
  assert.deepEqual(validateText(text), []);
  for (const h2 of ['## What changed', '## What a reader will get wrong', '## What is still open', 'Large files.']) assert.ok(text.includes(h2), h2);
  assert.equal(mock.sessions.get(h.session_id).is_archived, true);
  assert.match(mock.messagesOf(h.session_id).at(-1).message, /seven sections/);

  const h2 = await plant(e, 'pad-13');
  mock.update(h2.session_id, { structured_output: report({ record: { ...record, open: '', seams: undefined } }) });
  await assert.rejects(e.gw.retire('pad-13', 'PAD-13', { timeoutMs: 60_000, pollMs: 15_000 }), /5 of 7 sections after the timeout/);
  assert.ok(!existsSync(join(e.records, 'tasks', 'PAD-13', 'record.md')));
});

test('P11 destroy refuses unless the PR head is on the remote, or force', async () => {
  const e = env();
  const h = await plant(e);
  await assert.rejects(e.gw.destroy('pad-12'), /has no PR/);
  mock.update(h.session_id, { pull_requests: PR });
  effect.onRemote = false;
  await assert.rejects(e.gw.destroy('pad-12'), /PR head is not on the remote/);
  assert.equal(mock.sessions.get(h.session_id).terminated, undefined);
  effect.onRemote = true;
  assert.equal((await e.gw.destroy('pad-12')).destroyed, true);
  assert.equal(mock.sessions.get(h.session_id).terminated, true);
  assert.deepEqual(await e.gw.list(), []);

  const h2 = await plant(e, 'pad-13');
  assert.equal((await e.gw.destroy('pad-13', { force: true })).destroyed, true);
  assert.equal(mock.sessions.get(h2.session_id).terminated, true);
});

test('P12 shell verbs throw UnsupportedVerb', async () => {
  const e = env();
  await plant(e);
  for (const verb of ['exec', 'push', 'pull', 'seed', 'bootstrap', 'attach']) {
    await assert.rejects(e.gw[verb]('pad-12', 'x'), (err) => err instanceof UnsupportedVerb && err.verb === verb && err.provider === 'devin', verb);
  }
});

test('P13 the devin module satisfies the shared contract and loads through the gateway', async () => {
  assert.deepEqual(checkProvider(devinModule, 'devin'), []);
  const e = env();
  const gw = openGateway(e.ctx);
  await assert.rejects(gw.create('pad-99', { task: 'PAD-99' }), /brief path/, 'real module loaded and ran');
});

test('P14 the gateway refuses more than PADAKAN_MAX_TREES live sessions', async () => {
  const e = env({ PADAKAN_MAX_TREES: '2' });
  const before = mock.sessions.size;
  await plant(e, 't-1');
  await plant(e, 't-2');
  await assert.rejects(plant(e, 't-3'), /PADAKAN_MAX_TREES is 2 and 2 trees are live/);
  assert.equal(mock.sessions.size, before + 2, 'no third session was created');
});

test('P15 raiseBudget archives the capped session and continues in exactly one new session', async () => {
  const e = env();
  const h = await plant(e);
  mock.update(h.session_id, { status: 'suspended', status_detail: 'usage_limit_exceeded', acus_consumed: 10, pull_requests: PR });
  const before = mock.sessions.size;
  await assert.rejects(e.gw.raiseBudget('pad-12', { cap_acu: 6 }), /answered decision report/);
  assert.equal(mock.sessions.size, before, 'no session without a decision');

  const r = await e.gw.raiseBudget('pad-12', { cap_acu: 6, decision: 'D-0001' });
  assert.equal(mock.sessions.size, before + 1, 'exactly one new session');
  assert.equal(mock.sessions.get(h.session_id).is_archived, true, 'capped session archived');
  const b = lastCreate().body;
  assert.equal(b.max_acu_limit, 6);
  assert.deepEqual(b.repos, ['o/r']);
  assert.deepEqual(b.tags, ['padakan', 'task:PAD-12', 'run:r-1']);
  assert.ok(b.prompt.startsWith('This continues task PAD-12.'));
  assert.ok(b.prompt.includes('padakan/PAD-12') && b.prompt.includes(PR[0].pr_url));
  assert.deepEqual(b.structured_output_schema, REPORT_SCHEMA);
  const stored = await e.gw.get('pad-12');
  assert.equal(stored.session_id, r.session_id);
  assert.deepEqual(stored.previous_session_ids, [h.session_id]);
  assert.equal(stored.acus_previous, 10);
  assert.equal(stored.last_raise_decision, 'D-0001');

  await e.gw.raiseBudget('pad-12', { cap_acu: 1, decision: 'D-0002' });
  assert.equal(lastCreate().body.max_acu_limit, 2, 'small raises round up to DEVIN_CONTINUATION_MIN_ACU');
  assert.equal((await e.gw.get('pad-12')).previous_session_ids.length, 2);
});

test('P16 after a raise, spend and the ledger total cover every session', async () => {
  const e = env();
  const h = await plant(e);
  const ledger = [];
  mock.update(h.session_id, { status: 'running', status_detail: 'working', acus_consumed: 10 });
  ledger.push(...(await e.gw.poll('pad-12', { ledger, run: 'r-1' })).ledger_entries);
  mock.update(h.session_id, { status: 'suspended', status_detail: 'usage_limit_exceeded' });
  const { session_id: next } = await e.gw.raiseBudget('pad-12', { cap_acu: 5, decision: 'D-0001' });
  mock.update(next, { status: 'running', status_detail: 'working', acus_consumed: 3 });
  ledger.push(...(await e.gw.poll('pad-12', { ledger, run: 'r-1' })).ledger_entries);
  assert.equal((await e.gw.spend('pad-12')).acus, 13);
  assert.ok(ledger.some((x) => x.session_id === next && x.kind === 'spend'), 'new spend lines carry the new session id');
  const left = budgetLeft(ledger, { run_usd: null, task_usd: 30, step_usd: null }, { run: 'r-1', task: 'PAD-12' });
  assert.equal(left.task_usd, 30 - 26, 'the gate sees the total across both sessions');
});

test('pause, resume, message, brief and url', async () => {
  const e = env();
  const h = await plant(e);
  mock.update(h.session_id, { status: 'running', status_detail: 'working' });
  assert.equal((await e.gw.pause('pad-12')).state, 'paused');
  assert.equal(mock.sessions.get(h.session_id).status, 'suspended');
  assert.equal((await e.gw.resume('pad-12', 'go on')).state, 'working');
  assert.equal(mock.sessions.get(h.session_id).status, 'running');
  assert.equal((await e.gw.message('pad-12', 'hi')).ok, true);
  await e.gw.brief('pad-12', await briefFile());
  const sent = mock.requests.filter((r) => r.path.endsWith('/messages') && r.method === 'POST').at(-1).body;
  assert.match(sent.message, /Updated brief for PAD-12/);
  assert.equal(sent.attachment_urls.length, 1);
  assert.equal((await e.gw.url('pad-12')).url, h.url);
});
