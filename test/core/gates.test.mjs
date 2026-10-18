import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict, resultLine, NEVER_SKIPPED } from '../../core/gates.mjs';

// Everything green.
const good = () => ({
  taskTests: { status: 'pass', passed: 6 },
  acceptance: [
    { id: 'AC1', result: 'pass' },
    { id: 'AC2', result: 'pass' },
  ],
  suite: { status: 'pass' },
  e2e: [{ feature: 'auth/sign-in', verdict: 'PASS' }],
  diff: { pass: true, checks: [{ name: 'size', pass: true }] },
  okf: [],
  evidence: { video: 'verified', architecture: 'verified', files: 'verified', ci: 'verified' },
  skipped: [],
});
const with_ = (patch) => ({ ...good(), ...patch });

// AC1: one row per rule.
const table = [
  ['all green ships', good(), 'SHIP'],
  ['task tests failing', with_({ taskTests: { status: 'fail', failed: 2 } }), 'ESCALATE', /task tests fail \(2 failing\)/],
  ['task tests not run', with_({ taskTests: { status: 'not-run' } }), 'ESCALATE', /task tests not-run/],
  ['an acceptance criterion fails', with_({ acceptance: [{ id: 'AC1', result: 'fail' }] }), 'ESCALATE', /AC1 fail/],
  ['unproven is never a pass', with_({ acceptance: [{ id: 'AC1', result: 'unproven' }] }), 'ESCALATE', /AC1 unproven: never a pass/],
  ['not-run is never a pass', with_({ acceptance: [{ id: 'AC1', result: 'not-run' }] }), 'ESCALATE', /never a pass/],
  ['not-exercised is never a pass', with_({ acceptance: [{ id: 'AC2', result: 'not-exercised' }] }), 'ESCALATE', /AC2 not-exercised/],
  ['no acceptance criteria at all', with_({ acceptance: [] }), 'ESCALATE', /no acceptance criteria were proven live/],
  [
    'an optional criterion the human skipped',
    with_({ acceptance: [{ id: 'AC1', result: 'pass' }, { id: 'AC5', result: 'not-run', optional: true }], skipped: ['AC5'] }),
    'HUMAN_MERGE',
    /AC5 not-run \(optional, skipped/,
  ],
  [
    'an optional criterion nobody skipped still escalates',
    with_({ acceptance: [{ id: 'AC5', result: 'not-run', optional: true }] }),
    'ESCALATE',
  ],
  ['suite failing', with_({ suite: { status: 'fail', failed: 1 } }), 'ESCALATE', /regression suite fail/],
  ['e2e FAIL blocks', with_({ e2e: [{ feature: 'checkout', verdict: 'FAIL' }] }), 'ESCALATE', /checkout FAIL/],
  ['e2e BROKEN blocks', with_({ e2e: [{ feature: 'checkout', verdict: 'BROKEN' }] }), 'ESCALATE'],
  ['e2e STOPPED blocks', with_({ e2e: [{ feature: 'checkout', verdict: 'STOPPED' }] }), 'ESCALATE'],
  ['e2e KNOWN does not block', with_({ e2e: [{ feature: 'checkout', verdict: 'KNOWN' }] }), 'SHIP'],
  ['e2e NOT RUN blocks', with_({ e2e: [{ feature: 'checkout', verdict: 'NOT RUN' }] }), 'ESCALATE'],
  ['e2e NOT RUN skipped by the human', with_({ e2e: [{ feature: 'checkout', verdict: 'NOT RUN' }], skipped: ['e2e:checkout'] }), 'HUMAN_MERGE'],
  ['no e2e applies', with_({ e2e: [] }), 'SHIP'],
  ['diff inspection fails', with_({ diff: { pass: false, checks: [{ name: 'secrets', pass: false }, { name: 'size', pass: true }] } }), 'ESCALATE', /diff inspection failed: secrets/],
  ['invalid documents', with_({ okf: ['brief.md: missing field: tags'] }), 'ESCALATE', /1 invalid document/],
  ['evidence present but not verified', with_({ evidence: { ...good().evidence, ci: 'present' } }), 'ESCALATE', /ci is present but not verified/],
  ['evidence missing', with_({ evidence: { ...good().evidence, architecture: 'missing' } }), 'ESCALATE', /architecture missing/],
  ['video skipped by the human', with_({ evidence: { ...good().evidence, video: 'missing' }, skipped: ['video'] }), 'HUMAN_MERGE', /video skipped/],
  ['the task tests cannot be skipped', with_({ taskTests: { status: 'not-run' }, skipped: ['taskTests'] }), 'ESCALATE', /cannot be skipped for cost/],
];

for (const [name, input, expected, detail] of table) {
  test(`AC1: ${name} → ${expected}`, () => {
    const v = verdict(input);
    assert.equal(v.verdict, expected, JSON.stringify(v.reasons));
    if (detail) assert.ok(v.reasons.some((r) => detail.test(r.detail)), JSON.stringify(v.reasons));
  });
}

test('AC2: a missing input never yields SHIP', () => {
  for (const key of ['taskTests', 'acceptance', 'suite', 'e2e', 'diff', 'okf', 'evidence']) {
    const input = good();
    delete input[key];
    const v = verdict(input);
    assert.equal(v.verdict, 'ESCALATE', key);
    assert.ok(v.reasons.some((r) => r.detail === `missing input: ${key}`), key);
  }
  assert.equal(verdict({}).verdict, 'ESCALATE');
  assert.equal(verdict().verdict, 'ESCALATE');
});

test('AC3: the output is deterministic, whatever the input order', () => {
  const a = with_({ acceptance: [{ id: 'AC10', result: 'fail' }, { id: 'AC2', result: 'unproven' }], e2e: [{ feature: 'b', verdict: 'FAIL' }, { feature: 'a', verdict: 'BROKEN' }] });
  const b = with_({ acceptance: [{ id: 'AC2', result: 'unproven' }, { id: 'AC10', result: 'fail' }], e2e: [{ feature: 'a', verdict: 'BROKEN' }, { feature: 'b', verdict: 'FAIL' }] });
  assert.equal(JSON.stringify(verdict(a)), JSON.stringify(verdict(b)));
  assert.deepEqual(verdict(a).reasons.map((r) => r.detail.split(' ')[0]), ['AC2', 'AC10', 'a', 'b']);
});

test('the result line is one line for the orchestrator', () => {
  assert.equal(resultLine(verdict(good())), 'VERDICT=SHIP');
  const line = resultLine(verdict(with_({ suite: { status: 'fail' } })));
  assert.match(line, /^VERDICT=ESCALATE REASONS=1 FIRST="suite: regression suite fail"$/);
  assert.ok(!line.includes('\n'));
  assert.deepEqual(NEVER_SKIPPED, ['taskTests', 'suite', 'diff']);
});

test('requirements from the manifest: video only for UI targets; no CI means a human merges; invalid files escalate', () => {
  const backend = with_({ evidence: { video: 'not-applicable', architecture: 'verified', files: 'verified', ci: 'verified' }, requires: { video: false } });
  assert.equal(verdict(backend).verdict, 'SHIP');
  const missingVideo = with_({ evidence: { video: 'missing', architecture: 'verified', files: 'verified', ci: 'verified' }, requires: { video: false } });
  assert.equal(verdict(missingVideo).verdict, 'SHIP', 'a backend task does not need a video');
  const ui = with_({ evidence: { video: 'not-applicable', architecture: 'verified', files: 'verified', ci: 'verified' } });
  assert.equal(verdict(ui).verdict, 'ESCALATE', 'without requires, video is required');
  const noCi = with_({ evidence: { video: 'verified', architecture: 'verified', files: 'verified', ci: 'none' } });
  const v = verdict(noCi);
  assert.equal(v.verdict, 'HUMAN_MERGE');
  assert.match(v.reasons[0].detail, /no CI configured/);
  const bad = verdict(with_({ invalid: ['checks/tests.json: value.status: "ok" not in enum'] }));
  assert.equal(bad.verdict, 'ESCALATE');
  assert.equal(bad.reasons[0].gate, 'checks');
});
