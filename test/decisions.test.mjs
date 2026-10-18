// Cost decision reports and answers (IMPLEMENTATION-DEVIN-COSTGATE.md D.3: R1–R7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, removeDir, runNode, ROOT } from './helpers.mjs';
import { startMockDevin } from './helpers/mock-devin.mjs';
import { init } from '../orchestrator/lib/records.mjs';
import { loadSettings } from '../orchestrator/lib/env.mjs';
import { buildContext } from '../orchestrator/lib/context.mjs';
import { readState } from '../orchestrator/lib/state.mjs';
import { createDecision, checkDecision, decide, readDecision, parseAnswer, decideStep, TODO } from '../orchestrator/decisions.mjs';
import { makeProvider } from '../sandboxes/devin/provider.mjs';
import { parseLedger, record } from '../core/cost.mjs';
import { validateText } from '../core/okf.mjs';

let mock;
before(async () => {
  mock = await startMockDevin();
});
after(() => mock.close());

const optional = { step: 'device-probe', unit: 'acu', low: 2, likely: 4, high: 5, required: false };
const required = { step: 'devin-session', unit: 'acu', low: 2, likely: 4, high: 15, required: true };
const prose = { what: 'The device probe for PAD-12.', why: 'It proves AC3 on a real phone.', if_skipped: 'AC3 stays unproven on devices.', recommendation_why: 'It is cheap and covers the risk.' };

async function project(extra = {}) {
  const base = await tempDir();
  const records = join(base, 'shop-padakan');
  await init(records);
  const settings = loadSettings({
    exported: {
      PADAKAN_SANDBOX_PROVIDER: 'devin', DEVIN_API_URL: mock.apiUrl, DEVIN_API_KEY: mock.apiKey, DEVIN_ORG_ID: mock.orgId,
      PADAKAN_DEVIN_USD_PER_ACU: '2', PADAKAN_BUDGET_TASK_USD: '5', ...extra,
    },
  });
  const devin = makeProvider({
    effects: { repoSlug: async () => 'o/r', baseSha: async () => 'a'.repeat(40), prHead: async () => ({ headSha: 'b'.repeat(40), onRemote: true }) },
    clientOptions: { sleep: async () => {} },
    pricesYaml: '',
  });
  const ctx = buildContext({ base: { settings, records, repo: join(base, 'shop') }, overrides: { providers: { devin } } });
  return { base, records, ctx };
}
const ledgerOf = async (records) => (existsSync(join(records, 'cost', 'ledger.jsonl')) ? parseLedger(await readFile(join(records, 'cost', 'ledger.jsonl'), 'utf8')) : []);
const auditOf = async (records) => (await readFile(join(records, 'audit', 'chain.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).event);
const open = (p, o = {}) => createDecision(p.ctx, { task: 'PAD-12', run: 'r-1', item: optional, step: optional.step, ...o });

test('R1 a paused gate produces an OKF report that passes the schema; prose gaps are reported', async () => {
  const p = await project();
  try {
    const r = await open(p);
    assert.deepEqual([r.id, r.path, r.draft], ['D-0001', 'decisions/D-0001.md', true]);
    const d = await readDecision(p.records, 'D-0001');
    assert.deepEqual(validateText(d.text), []);
    assert.equal(d.data.reason, 'task-cap');
    assert.equal(d.data.high_usd, 10);
    assert.equal(d.data.required, false);
    assert.equal(d.data.status, 'open');
    assert.match(d.text, /\| This step \(USD\) \| \$4\.00 \| \$8\.00 \| \$10\.00 \|/);
    assert.match(d.text, /Budget left: step n\/a · task \$5\.00/);
    const problems = await checkDecision(p.records, 'D-0001');
    assert.deepEqual(problems, ['prose missing: What', 'prose missing: Why it matters', 'prose missing: If skipped', 'prose missing: Recommendation']);
    assert.equal((await readState(p.records)).tasks['PAD-12'].status, 'paused');

    const full = await open(p, prose);
    assert.equal(full.draft, false);
    assert.deepEqual(await checkDecision(p.records, full.id), []);
    assert.ok(!(await readFile(join(p.records, 'decisions', `${full.id}.md`), 'utf8')).includes(TODO));
    await assert.rejects(createDecision(p.ctx, { task: 'PAD-12', item: { ...optional, high: 1, low: 1, likely: 1 } }), /nothing to decide/);
  } finally {
    await removeDir(p.base);
  }
});

test('R1 the template itself is a valid OKF template', async () => {
  const r = runNode(join(ROOT, 'core', 'okf.mjs'), ['--template', join(ROOT, 'templates', 'decision-report.md')]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('R2 a required step has no skip option, and skip on it is refused', async () => {
  const p = await project();
  try {
    const r = await open(p, { item: required, step: required.step, ...prose });
    const d = await readDecision(p.records, r.id);
    assert.equal(d.data.required, true);
    assert.doesNotMatch(d.text, /^\| skip \|/m);
    assert.doesNotMatch(d.text, /^## If skipped/m);
    assert.match(d.text, /required: it can never be skipped for cost/);
    assert.deepEqual(await checkDecision(p.records, r.id), []);
    await assert.rejects(decide(p.ctx, r.id, 'skip'), /required: it cannot be skipped/);
    assert.equal((await readDecision(p.records, r.id)).data.status, 'open', 'still open after a refused answer');
    await assert.rejects(createDecision(p.ctx, { task: 'PAD-12', item: required, recommendation: 'skip' }), /cannot be skipped/);
  } finally {
    await removeDir(p.base);
  }
});

test('R3 every answer has its effect, a ledger decision line and an audit entry', async () => {
  const p = await project();
  try {
    const alternatives = [{ name: 'web-only', unit: 'acu', low: 1, likely: 1, high: 2, uncovered: 'mobile not probed' }];

    const a = await open(p);
    let r = await decide(p.ctx, a.id, 'approve', { by: 'ana' });
    assert.deepEqual([r.action, r.by], ['run-step', 'ana']);
    assert.equal((await ledgerOf(p.records)).at(-1).allowance_usd, 10);

    const c = await open(p, { task: 'PAD-22', item: { ...optional, step: 'video' }, step: 'video', alternatives });
    r = await decide(p.ctx, c.id, 'cheaper:web-only');
    assert.deepEqual([r.action, r.option], ['run-alternative', 'web-only']);
    await assert.rejects(decide(p.ctx, (await open(p, { task: 'PAD-29', item: { ...optional, step: 'e2e' }, step: 'e2e', alternatives })).id, 'cheaper:nope'), /no alternative "nope"/);

    const s = await open(p, { task: 'PAD-23', item: { ...optional, step: 'browser-matrix' }, step: 'browser-matrix' });
    r = await decide(p.ctx, s.id, 'skip');
    assert.equal(r.action, 'skipped');
    let task = (await readState(p.records)).tasks['PAD-23'];
    assert.ok(task.skipped.includes('browser-matrix'));
    assert.equal(task.auto_ship, false);

    const ra = await open(p, { task: 'PAD-24', item: { ...optional, step: 'probe-2' }, step: 'probe-2' });
    r = await decide(p.ctx, ra.id, 'raise:50');
    assert.equal(r.action, 'run-step');
    assert.match(await readFile(join(p.records, '.env'), 'utf8'), /^PADAKAN_BUDGET_TASK_USD=50$/m);

    const ab = await open(p, { task: 'PAD-25', item: { ...optional, step: 'probe-3' }, step: 'probe-3' });
    r = await decide(p.ctx, ab.id, 'abort');
    assert.equal(r.action, 'escalated');
    task = (await readState(p.records)).tasks['PAD-25'];
    assert.equal(task.status, 'escalated');

    const answers = (await ledgerOf(p.records)).filter((e) => e.kind === 'decision').map((e) => e.answer);
    assert.deepEqual(answers, ['approve', 'cheaper', 'skip', 'raise', 'abort']);
    const audited = (await auditOf(p.records)).filter((e) => e.type === 'cost.decision.answered').map((e) => e.answer);
    assert.deepEqual(audited, ['approve', 'cheaper', 'skip', 'raise', 'abort']);
    const answerFile = JSON.parse(await readFile(join(p.records, 'decisions', `${a.id}.answer.json`), 'utf8'));
    assert.deepEqual([answerFile.id, answerFile.answer, answerFile.by], [a.id, 'approve', 'ana']);
    assert.equal((await readDecision(p.records, a.id)).data.status, 'answered');
  } finally {
    await removeDir(p.base);
  }
});

test('R4 an answered, missing or malformed decision is refused', async () => {
  const p = await project();
  try {
    const r = await open(p);
    await decide(p.ctx, r.id, 'approve');
    await assert.rejects(decide(p.ctx, r.id, 'approve'), /already answered/);
    await assert.rejects(decide(p.ctx, 'D-9999', 'approve'), /no decision D-9999/);
    await assert.rejects(decide(p.ctx, 'nope', 'approve'), /invalid decision id/);
    const r2 = await open(p, { task: 'PAD-13' });
    for (const bad of ['yes', 'raise:0', 'raise:-5', 'raise:abc', 'cheaper:', 'Approve']) assert.throws(() => parseAnswer(bad), /invalid answer/, bad);
    await assert.rejects(decide(p.ctx, r2.id, 'raise:3'), /must be higher than the current PADAKAN_BUDGET_TASK_USD=5/);
    const cli = await decideStep(p.ctx, [r.id, 'approve']);
    assert.equal(cli.code, 1);
    assert.match(cli.line, /^DECIDED=refused CODE=ANSWERED/);
  } finally {
    await removeDir(p.base);
  }
});

async function plantDevin(p, id, task) {
  const brief = join(p.base, `${id}.md`);
  await writeFile(brief, '---\ntype: Brief\n---\n# b\n');
  return p.ctx.gateway.create(id, { task, brief, estimate: { ...required, high: 5 }, ledger: [], run: 'r-1' });
}

test('R5 with no answer the paused tree spends nothing while another tree keeps running', async () => {
  const p = await project({ PADAKAN_BUDGET_TASK_USD: '100' });
  try {
    const a = await plantDevin(p, 'pad-12', 'PAD-12');
    const b = await plantDevin(p, 'pad-13', 'PAD-13');
    mock.update(a.session_id, { status: 'suspended', status_detail: 'usage_limit_exceeded', acus_consumed: 10 });
    mock.update(b.session_id, { status: 'running', status_detail: 'working', acus_consumed: 1 });
    const ledger = [];
    const tick = async (id) => {
      const r = await p.ctx.gateway.poll(id, { ledger, run: 'r-1' });
      ledger.push(...r.ledger_entries);
      return r;
    };
    assert.equal((await tick('pad-12')).escalate, 'session-cap-hit');
    await createDecision(p.ctx, { task: 'PAD-12', run: 'r-1', tree: 'pad-12', item: required, step: required.step, reason: 'session-cap-hit' });
    const spentA = () => ledger.filter((e) => e.task === 'PAD-12' && e.kind === 'spend').reduce((s, e) => s + e.qty, 0);
    for (let i = 2; i <= 4; i++) {
      mock.update(b.session_id, { acus_consumed: i });
      await tick('pad-12');
      await tick('pad-13');
    }
    assert.equal(spentA(), 10, 'paused tree: no new spend');
    assert.equal(ledger.filter((e) => e.task === 'PAD-13' && e.kind === 'spend').reduce((s, e) => s + e.qty, 0), 4, 'other tree kept running');
    assert.equal((await p.ctx.gateway.get('pad-12')).state, 'paused');
    assert.equal((await readState(p.records)).tasks['PAD-12'].status, 'paused');
  } finally {
    await removeDir(p.base);
  }
});

test('R6 raise writes the records .env, never the plugin .env', async () => {
  const p = await project();
  const pluginEnv = join(ROOT, '.env');
  const before = existsSync(pluginEnv) ? await readFile(pluginEnv, 'utf8') : null;
  try {
    await writeFile(join(p.records, '.env'), 'PADAKAN_LANGUAGE=en\nPADAKAN_BUDGET_TASK_USD=5\n');
    const r = await open(p, { item: { ...optional, step: 'step-a' }, step: 'step-a' });
    await decide(p.ctx, r.id, 'raise:25');
    assert.equal(await readFile(join(p.records, '.env'), 'utf8'), 'PADAKAN_LANGUAGE=en\nPADAKAN_BUDGET_TASK_USD=25\n');
    const stepCtx = { ...p.ctx, settings: loadSettings({ exported: { PADAKAN_DEVIN_USD_PER_ACU: '2', PADAKAN_BUDGET_STEP_USD: '1' } }) };
    const r2 = await createDecision(stepCtx, { task: 'PAD-13', run: 'r-1', item: { ...optional, step: 'step-b' } });
    assert.equal((await readDecision(p.records, r2.id)).data.reason, 'step-cap');
    await decide(stepCtx, r2.id, 'raise:30');
    assert.match(await readFile(join(p.records, '.env'), 'utf8'), /^PADAKAN_BUDGET_STEP_USD=30$/m, 'a step-cap raise writes the step budget');
    assert.equal(existsSync(pluginEnv) ? await readFile(pluginEnv, 'utf8') : null, before, 'plugin .env untouched');
  } finally {
    await removeDir(p.base);
  }
});

test('R7 raise on a session-cap-hit re-gates on the remaining work and continues once; a second pause opens a new report', async () => {
  for (const [extra, expect] of [[{}, 'raised'], [{ PADAKAN_BUDGET_RUN_USD: '22' }, 'new-decision']]) {
    const p = await project({ PADAKAN_BUDGET_TASK_USD: '20', ...extra });
    try {
      const h = await plantDevin(p, 'pad-12', 'PAD-12');
      mock.update(h.session_id, { status: 'suspended', status_detail: 'usage_limit_exceeded', acus_consumed: 10, pull_requests: [{ pr_url: 'https://github.com/o/r/pull/12', pr_state: 'open' }] });
      const r = await p.ctx.gateway.poll('pad-12', { ledger: [], run: 'r-1' });
      await writeFile(join(p.records, 'cost', 'ledger.jsonl'), r.ledger_entries.map((e) => record(e)).join(''));
      const d = await createDecision(p.ctx, { task: 'PAD-12', run: 'r-1', tree: 'pad-12', item: required, step: required.step, reason: 'session-cap-hit', ...prose });
      const sessions = mock.sessions.size;
      const ans = await decide(p.ctx, d.id, 'raise:40');
      assert.equal(ans.action, expect);
      if (expect === 'raised') {
        assert.equal(mock.sessions.size, sessions + 1, 'exactly one continuation session');
        assert.equal(ans.max_acu_limit, 10, 'remaining $20 of task budget at $2/ACU');
        assert.equal(mock.sessions.get(h.session_id).is_archived, true);
        const stored = await p.ctx.gateway.get('pad-12');
        assert.deepEqual(stored.previous_session_ids, [h.session_id]);
        assert.equal(stored.last_raise_decision, d.id);
        assert.match((await decideStep(p.ctx, [d.id, 'approve'])).line, /refused/);
      } else {
        assert.equal(mock.sessions.size, sessions, 'no session created');
        assert.match(ans.next_decision, /^D-\d{4}$/);
        const next = await readDecision(p.records, ans.next_decision);
        assert.equal(next.data.reason, 'run-cap');
        assert.equal(next.data.status, 'open');
      }
    } finally {
      await removeDir(p.base);
    }
  }
});
