import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  gate, sessionCap, budgetLeft, estimate, record, parseLedger, spendTick,
  remainingEstimate, loadPrices, budgetsFromEnv,
} from '../../core/cost.mjs';

const scope = { run: 'r-1', task: 'PAD-12' };
const prices = { acu: 2 };
const item = (o = {}) => ({ step: 'devin-session', unit: 'acu', low: 2, likely: 4, high: 5, required: true, ...o });
const budgets = (o = {}) => ({ run_usd: null, task_usd: null, step_usd: null, ...o });
const spend = (usd, o = {}) => ({ kind: 'spend', run: 'r-1', task: 'PAD-12', step: 'devin-session', usd, ...o });

// C1: each gate rule, unset budgets and no-price (table-driven). high = 5 ACU * $2 = $10.
test('C1 gate rules', () => {
  const cases = [
    { name: 'all unset -> run', b: budgets(), ledger: [], want: ['run', null] },
    { name: 'step cap', b: budgets({ step_usd: 9 }), ledger: [], want: ['pause', 'step-cap'] },
    { name: 'task cap', b: budgets({ task_usd: 15 }), ledger: [spend(6)], want: ['pause', 'task-cap'] },
    { name: 'run cap', b: budgets({ run_usd: 20 }), ledger: [spend(11, { task: 'PAD-9' })], want: ['pause', 'run-cap'] },
    { name: 'step checked before task', b: budgets({ step_usd: 1, task_usd: 1 }), ledger: [], want: ['pause', 'step-cap'] },
    { name: 'exactly at cap -> run', b: budgets({ step_usd: 10, task_usd: 10, run_usd: 10 }), ledger: [], want: ['run', null] },
    { name: 'other run spend ignored', b: budgets({ run_usd: 10 }), ledger: [spend(50, { run: 'r-0' })], want: ['run', null] },
  ];
  for (const c of cases) {
    const g = gate({ item: item(), ledger: c.ledger, budgets: c.b, prices, scope });
    assert.deepEqual([g.decision, g.reason], c.want, c.name);
  }
  const noPrice = gate({ item: item({ unit: 'device_minute' }), budgets: budgets(), prices, scope });
  assert.deepEqual([noPrice.decision, noPrice.reason], ['pause', 'no-price']);
  assert.equal(gate({ item: item(), budgets: budgets(), prices: {}, scope }).reason, 'no-price');
});

test('C1 a human allowance lifts the caps for that step only', () => {
  const allowance = { kind: 'decision', run: 'r-1', task: 'PAD-12', step: 'devin-session', allowance_usd: 10 };
  const b = budgets({ step_usd: 1, task_usd: 1 });
  assert.equal(gate({ item: item(), ledger: [allowance], budgets: b, prices, scope }).decision, 'run');
  const other = gate({ item: item({ step: 'device-probe' }), ledger: [allowance], budgets: b, prices, scope });
  assert.equal(other.reason, 'step-cap');
});

// C2: compares against high, never likely.
test('C2 gate uses high, not likely', () => {
  const g = gate({ item: item({ likely: 1, high: 5 }), budgets: budgets({ step_usd: 5 }), prices, scope });
  assert.equal(g.decision, 'pause');
  assert.equal(g.estimate.likely_usd, 2);
  assert.equal(g.estimate.high_usd, 10);
});

// C3: sessionCap respects step, task, run and hardMax; cap-below-low.
test('C3 sessionCap', () => {
  const cap = (b, o = {}) => sessionCap({ item: item(), budgets: budgets(b), prices, scope, ...o });
  assert.equal(cap({ step_usd: 30 }).max_acu_limit, 15);
  assert.equal(cap({ step_usd: 30, task_usd: 20 }).max_acu_limit, 10);
  assert.equal(cap({ step_usd: 30, task_usd: 20, run_usd: 13 }).max_acu_limit, 6);
  assert.equal(cap({ step_usd: 30 }, { hardMax: 7 }).max_acu_limit, 7);
  assert.equal(cap({ task_usd: 9 }, { ledger: [spend(4)] }).max_acu_limit, 2);
  assert.deepEqual([cap({ task_usd: 3 }).decision, cap({ task_usd: 3 }).reason], ['pause', 'cap-below-low']);
  assert.equal(cap({}).max_acu_limit, null);
  assert.equal(cap({}, { prices: {} }).reason, 'no-price');
  assert.throws(() => cap({}, { item: item({ unit: 'ci_minute' }) }));
});

// C4: ledger lines round-trip through record/parseLedger into budgetLeft.
test('C4 ledger round-trip', () => {
  const lines = [
    record({ ts: 't', kind: 'spend', run: 'r-1', task: 'PAD-12', step: 's', usd: 2.5 }),
    record({ ts: 't', kind: 'spend', run: 'r-1', task: 'PAD-13', step: 's', usd: 4 }),
    record({ ts: 't', kind: 'warn', run: 'r-1', task: 'PAD-12', step: 's' }),
    record({ ts: 't', kind: 'decision', run: 'r-1', task: 'PAD-12', step: 's', allowance_usd: 1 }),
  ].join('');
  const ledger = parseLedger(lines);
  assert.equal(ledger.length, 4);
  assert.deepEqual(budgetLeft(ledger, budgets({ run_usd: 20, task_usd: 10 }), scope), { run_usd: 14.5, task_usd: 8.5 });
  assert.throws(() => record({ kind: 'oops', run: 'r', task: 't', step: 's' }));
  assert.throws(() => record({ kind: 'spend', task: 't', step: 's' }));
  assert.throws(() => parseLedger('{bad'));
});

// C5: never returns skip; a required item cannot be waived by the gate.
test('C5 gate never returns skip', () => {
  const decisions = new Set();
  for (const step_usd of [0, 1, 10, 100, null]) {
    for (const required of [true, false]) {
      const g = gate({ item: item({ required }), budgets: budgets({ step_usd }), prices, scope });
      decisions.add(g.decision);
      assert.equal(g.required, required);
    }
  }
  assert.deepEqual([...decisions].sort(), ['pause', 'run']);
});

// C6: the 80 % warn entry is written exactly once per session.
test('C6 warn once per session at 80%', () => {
  const ledger = [];
  const tick = (acus, session_id = 'devin-a') => {
    const out = spendTick({ ledger, ...scope, step: 'devin-session', session_id, acus_consumed: acus, max_acu_limit: 10, usdPerAcu: 2, now: 't' });
    ledger.push(...out);
    return out;
  };
  assert.deepEqual(tick(3).map((e) => e.kind), ['spend']);
  assert.deepEqual(tick(3), []);
  assert.deepEqual(tick(8).map((e) => e.kind), ['spend', 'warn']);
  assert.deepEqual(tick(9.5).map((e) => e.kind), ['spend']);
  assert.equal(ledger.filter((e) => e.kind === 'warn').length, 1);
  assert.equal(ledger.filter((e) => e.kind === 'spend').reduce((a, e) => a + e.qty, 0), 9.5);
  assert.deepEqual(tick(9, 'devin-b').map((e) => e.kind), ['spend', 'warn']);
  assert.equal(budgetLeft(ledger, budgets({ task_usd: 100 }), scope).task_usd, 100 - 2 * 18.5);
});

// C7: core/cost.mjs imports nothing (no models, no network).
test('C7 cost.mjs has no imports and no network', async () => {
  const src = await readFile(new URL('../../core/cost.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\bimport\(|\brequire\(|\bfetch\(/);
});

test('estimate, remainingEstimate, loadPrices, budgetsFromEnv', () => {
  assert.equal(estimate(item(), {}), null);
  assert.throws(() => estimate(item({ low: 6, high: 5 }), prices));
  assert.deepEqual(remainingEstimate(item({ low: 4, likely: 8, high: 15 }), 10, 2), item({ low: 2, likely: 2, high: 5 }));
  const p = loadPrices({ yamlText: '# c\nci_minute: 0\ndevice_minute: 0.25 # note\n', env: { PADAKAN_DEVIN_USD_PER_ACU: '2.25' } });
  assert.deepEqual(p, { ci_minute: 0, device_minute: 0.25, acu: 2.25 });
  assert.equal(loadPrices({}).acu, undefined);
  assert.throws(() => loadPrices({ env: { PADAKAN_DEVIN_USD_PER_ACU: '-1' } }));
  assert.deepEqual(budgetsFromEnv({ PADAKAN_BUDGET_TASK_USD: '5', PADAKAN_BUDGET_RUN_USD: '' }), { run_usd: null, task_usd: 5, step_usd: null });
  assert.throws(() => budgetsFromEnv({ PADAKAN_BUDGET_STEP_USD: 'abc' }));
});
