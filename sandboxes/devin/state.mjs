// Devin session status -> Padakan tree state and the orchestrator's next action
// (IMPLEMENTATION-DEVIN-COSTGATE.md A.5), and the check that decides when a session is really done.
//
// A session that says it finished is only a candidate: mapStatus() returns `done?`, and the
// provider turns that into `done` only when verifyDone() holds (never trust the report).

import { readFileSync } from 'node:fs';
import { validate } from '../../core/schema.mjs';

export const REPORT_SCHEMA = JSON.parse(readFileSync(new URL('./schemas/report.json', import.meta.url), 'utf8'));
// At retire the seven-section record is required too.
export const RETIRE_SCHEMA = { ...REPORT_SCHEMA, required: [...REPORT_SCHEMA.required, 'record'] };

export const DONE_CANDIDATE = 'done?';
export const DONE_TIMEOUT_MS = 10 * 60 * 1000;

const CAP_HIT = ['usage_limit_exceeded', 'user_usage_limit_exceeded', 'org_usage_limit_exceeded'];
const ACCOUNT = ['out_of_credits', 'out_of_quota', 'no_quota_allocation', 'payment_declined', 'contract_expired', 'total_session_limit_exceeded'];

const r = (state, action, reason = null) => ({ state, action, reason });

// -> { state, action, reason }
//   state:  ready | working | waiting | paused | failed | 'done?'
//   action: poll | answer | approve-once | verify-effect | cost-gate | escalate | nudge-once | leave | recycle-once
// Anything not in the table fails safe: failed + escalate.
export function mapStatus({ status, status_detail: detail } = {}) {
  switch (status) {
    case 'new':
    case 'claimed':
    case 'resuming':
      return r('ready', 'poll');
    case 'running':
      if (detail === 'working' || detail == null) return r('working', 'poll');
      if (detail === 'waiting_for_user') return r('waiting', 'answer');
      if (detail === 'waiting_for_approval') return r('waiting', 'approve-once');
      if (detail === 'finished') return r(DONE_CANDIDATE, 'verify-effect');
      break;
    case 'exit':
      return r(DONE_CANDIDATE, 'verify-effect');
    case 'error':
      return r('failed', 'recycle-once', 'session-error');
    case 'suspended':
      if (CAP_HIT.includes(detail)) return r('paused', 'cost-gate', 'session-cap-hit');
      if (ACCOUNT.includes(detail)) return r('failed', 'escalate', `account:${detail}`);
      if (detail === 'inactivity') return r('waiting', 'nudge-once', 'inactivity');
      if (detail === 'user_request') return r('paused', 'leave', 'user-request');
      if (detail === 'error') return r('failed', 'recycle-once', 'session-error');
      break;
  }
  return r('failed', 'escalate', `unknown-status:${status}/${detail ?? ''}`);
}

// A session is done only when all three hold: the structured output validates, a PR exists,
// and the PR's head commit is on the remote. -> { done, missing: [...], errors: [...] }
// effect: { headOnRemote: boolean } from `gh pr view` (checked by the provider).
export function verifyDone({ structured_output: report, pull_requests: prs = [] } = {}, effect = {}, schema = REPORT_SCHEMA) {
  const missing = [];
  const errors = report ? validate(schema, report) : ['no structured output'];
  if (errors.length) missing.push('report');
  if (!prs.length) missing.push('pr');
  else if (!effect.headOnRemote) missing.push('head-on-remote');
  return { done: missing.length === 0, missing, errors };
}

// After DONE_TIMEOUT_MS in `done?` without passing verifyDone, the check has failed.
export function doneCandidateExpired(since, now = Date.now()) {
  return since != null && now - since >= DONE_TIMEOUT_MS;
}
