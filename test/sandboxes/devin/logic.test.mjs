import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mapStatus, verifyDone, doneCandidateExpired, REPORT_SCHEMA, RETIRE_SCHEMA, DONE_CANDIDATE, DONE_TIMEOUT_MS } from '../../../sandboxes/devin/state.mjs';
import { answer, onceThenEscalate, REPLIES, MAX_ANSWERS } from '../../../sandboxes/devin/answers.mjs';
import { renderPrompt, renderContinuation, renderRetireMessage, branchFor } from '../../../sandboxes/devin/prompt.mjs';
import { STATES } from '../../../sandboxes/contract.mjs';

// P4: every row of the A.5 table maps to the right state (table-driven).
test('P4 status mapping', () => {
  const rows = [
    ['new', null, 'ready', 'poll'],
    ['claimed', null, 'ready', 'poll'],
    ['resuming', null, 'ready', 'poll'],
    ['running', 'working', 'working', 'poll'],
    ['running', 'waiting_for_user', 'waiting', 'answer'],
    ['running', 'waiting_for_approval', 'waiting', 'approve-once'],
    ['running', 'finished', DONE_CANDIDATE, 'verify-effect'],
    ['exit', null, DONE_CANDIDATE, 'verify-effect'],
    ['suspended', 'usage_limit_exceeded', 'paused', 'cost-gate'],
    ['suspended', 'user_usage_limit_exceeded', 'paused', 'cost-gate'],
    ['suspended', 'org_usage_limit_exceeded', 'paused', 'cost-gate'],
    ...['out_of_credits', 'out_of_quota', 'no_quota_allocation', 'payment_declined', 'contract_expired', 'total_session_limit_exceeded'].map((d) => ['suspended', d, 'failed', 'escalate']),
    ['suspended', 'inactivity', 'waiting', 'nudge-once'],
    ['suspended', 'user_request', 'paused', 'leave'],
    ['error', null, 'failed', 'recycle-once'],
    ['suspended', 'error', 'failed', 'recycle-once'],
  ];
  for (const [status, status_detail, state, action] of rows) {
    const got = mapStatus({ status, status_detail });
    assert.deepEqual([got.state, got.action], [state, action], `${status}/${status_detail}`);
    if (state !== DONE_CANDIDATE) assert.ok(STATES.includes(state), `${state} is a contract state`);
  }
  for (const unknown of [{ status: 'weird' }, { status: 'running', status_detail: 'dancing' }, { status: 'suspended', status_detail: 'new_reason' }, {}]) {
    assert.deepEqual([mapStatus(unknown).state, mapStatus(unknown).action], ['failed', 'escalate'], JSON.stringify(unknown));
  }
  assert.equal(mapStatus({ status: 'suspended', status_detail: 'out_of_credits' }).reason, 'account:out_of_credits');
});

// P8: usage_limit_exceeded -> paused, reason session-cap-hit.
test('P8 hitting the ACU cap is a cost-gate pause', () => {
  assert.deepEqual(mapStatus({ status: 'suspended', status_detail: 'usage_limit_exceeded' }), { state: 'paused', action: 'cost-gate', reason: 'session-cap-hit' });
});

const report = (o = {}) => ({ task: 'PAD-12', pr_url: 'https://github.com/o/r/pull/12', branch: 'padakan/PAD-12', acs: [{ id: 'AC1', verdict: 'pass' }], evidence: [], blocked: null, ...o });
const pr = [{ pr_url: 'https://github.com/o/r/pull/12', pr_state: 'open' }];

// P5: finished without a PR, or with a PR whose head is not on the remote, is not done.
test('P5 done needs a PR whose head is on the remote', () => {
  assert.deepEqual(verifyDone({ structured_output: report(), pull_requests: pr }, { headOnRemote: true }), { done: true, missing: [], errors: [] });
  assert.deepEqual(verifyDone({ structured_output: report(), pull_requests: [] }, { headOnRemote: true }).missing, ['pr']);
  assert.deepEqual(verifyDone({ structured_output: report(), pull_requests: pr }, { headOnRemote: false }).missing, ['head-on-remote']);
  assert.deepEqual(verifyDone({ structured_output: report(), pull_requests: pr }).missing, ['head-on-remote']);
  assert.equal(doneCandidateExpired(0, DONE_TIMEOUT_MS - 1), false);
  assert.equal(doneCandidateExpired(0, DONE_TIMEOUT_MS), true);
  assert.equal(doneCandidateExpired(null), false);
});

// P6: structured output that fails report.json is a failed check.
test('P6 invalid structured output is not done', () => {
  const cases = [null, report({ task: 'pad-12' }), report({ acs: [{ id: 'X1', verdict: 'pass' }] }), report({ extra: 1 }), (({ blocked, ...r }) => r)(report())];
  for (const so of cases) {
    const v = verifyDone({ structured_output: so, pull_requests: pr }, { headOnRemote: true });
    assert.equal(v.done, false, JSON.stringify(so));
    assert.ok(v.missing.includes('report'));
    assert.ok(v.errors.length > 0);
  }
  const noRecord = verifyDone({ structured_output: report(), pull_requests: pr }, { headOnRemote: true }, RETIRE_SCHEMA);
  assert.match(noRecord.errors.join(), /record: required/);
});

test('report schema is self-contained (Devin rejects external $ref)', async () => {
  const text = await readFile(new URL('../../../sandboxes/devin/schemas/report.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /"\$ref"/);
  assert.ok(Buffer.byteLength(text) < 64 * 1024);
  assert.deepEqual(REPORT_SCHEMA.required, ['task', 'pr_url', 'branch', 'acs', 'evidence', 'blocked']);
});

const devin = (message) => [{ event_id: 'e1', message: 'old', source: 'user' }, { event_id: 'e2', message, source: 'devin' }];

// P7: plan confirmation gets the approval reply; a second unknown question escalates.
test('P7 answers by rule', () => {
  const a = answer(devin('Here is my test plan: 1. run, 2. record. Does this plan look right?'));
  assert.equal(a.reply, REPLIES.approve);
  assert.equal(a.handle.questions_answered, 1);

  const u1 = answer(devin('Hmm, what is the meaning of life?'), { questions_answered: 1 });
  assert.equal(u1.reply, REPLIES.conservative);
  assert.equal(u1.handle.unknown_questions_answered, 1);
  const u2 = answer(devin('And what about the universe?'), { questions_answered: 2, unknown_questions_answered: 1 });
  assert.equal(u2.escalate, 'repeated-question');
  assert.equal(u2.reply, undefined);
  assert.equal(u2.question, 'And what about the universe?');
});

test('secrets: named in the manifest -> answered, otherwise escalate', () => {
  const secrets = [{ name: 'STRIPE_TEST_KEY' }];
  assert.equal(answer(devin('I need the STRIPE_TEST_KEY to proceed with this plan'), {}, { secrets }).reply, REPLIES.secret('STRIPE_TEST_KEY'));
  assert.equal(answer(devin('Please share the database password'), {}, { secrets }).escalate, 'missing-secret');
  assert.equal(answer(devin('What are the login credentials for staging?')).escalate, 'missing-secret');
});

test('option questions, limits, nothing to answer', () => {
  assert.equal(answer(devin('Should I use option A or option B?')).reply, REPLIES.conservative);
  assert.equal(answer(devin('Which approach do you prefer?'), { unknown_questions_answered: 1 }).reply, REPLIES.conservative);
  assert.equal(answer(devin('Does this plan look right?'), { questions_answered: MAX_ANSWERS }).escalate, 'too-many-questions');
  assert.deepEqual(answer([{ message: 'we said this', source: 'user' }]).reply, null);
  assert.equal(answer([]).kind, 'none');
});

test('approval and inactivity: once, then escalate', () => {
  const first = onceThenEscalate('approval', {});
  assert.equal(first.reply, REPLIES.approval);
  assert.equal(onceThenEscalate('approval', first.handle).escalate, 'approval-requested-again');
  const nudge = onceThenEscalate('inactivity', {});
  assert.equal(nudge.reply, REPLIES.nudge);
  assert.equal(onceThenEscalate('inactivity', nudge.handle).escalate, 'inactive-again');
});

test('prompts follow A.6', () => {
  const p = renderPrompt({ task: 'PAD-12', repo: 'o/r', briefName: 'brief.md', base: 'main', protectedPaths: ['.github/', 'infra/'] });
  for (const part of ['task PAD-12 in o/r', 'attached (brief.md)', 'Never ask questions', 'branch padakan/PAD-12', 'PR against main', 'No AI attribution', 'Do not touch: .github/, infra/', 'screen recording', 'structured output']) {
    assert.ok(p.includes(part), `prompt misses "${part}"`);
  }
  const c = renderContinuation({ task: 'PAD-12', prUrl: 'https://github.com/o/r/pull/12', repo: 'o/r', briefName: 'brief.md' });
  assert.ok(c.startsWith('This continues task PAD-12.'));
  assert.ok(c.includes('read the open PR https://github.com/o/r/pull/12'));
  assert.ok(c.includes('Never ask questions'), 'continuation includes the normal prompt');
  assert.match(renderRetireMessage({ task: 'PAD-12' }), /seven sections[\s\S]*misreadings[\s\S]*is_final=true/);
  assert.equal(branchFor('PAD-12'), 'padakan/PAD-12');
  assert.throws(() => renderPrompt({ task: 'pad 12', repo: 'o/r' }));
});
