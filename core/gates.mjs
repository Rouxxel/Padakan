// The verification gates: the one function that decides whether a change may ship.
// Plain rules on the inputs below; no model, no I/O, the same input always gives the same verdict.
//
// verdict(input) -> { verdict: 'SHIP' | 'HUMAN_MERGE' | 'ESCALATE', reasons: [{ gate, level, detail }] }
//
// input = {
//   taskTests:  { status: 'pass'|'fail'|'not-run', passed?, failed? }        the task's own tests, in the suite
//   acceptance: [{ id, result: 'pass'|'fail'|'unproven'|'not-run'|'not-exercised', optional? }]   proven live
//   suite:      { status: 'pass'|'fail'|'not-run', failed? }                 the full regression suite
//   e2e:        [{ feature, verdict: 'PASS'|'KNOWN'|'FAIL'|'BROKEN'|'STOPPED'|'NOT RUN' }]   [] when none applies
//   diff:       the result of core/diffcheck.mjs                             { pass, checks }
//   okf:        [problem strings] for the documents agents wrote             [] when clean
//   evidence:   { video, architecture, files, ci }: each 'verified'|'present'|'missing'
//   skipped:    names of optional checks the human waived at the cost gate (e.g. 'video', 'AC5', 'e2e:checkout')
//   requires:   { video } from the manifest (core/checks.mjs); absent means everything is required
//   invalid:    [problem strings] for check files that do not match schemas/checks.json
// }
//
// Rules:
//   - a missing input never ships: ESCALATE
//   - proven twice: task tests pass in the suite AND every acceptance criterion passes live;
//     unproven, not-run and not-exercised are never a pass
//   - no regressions: the suite passes; e2e FAIL, BROKEN and STOPPED block, KNOWN does not, NOT RUN blocks
//   - diff inspection passes; agent documents are valid OKF
//   - evidence items must be verified by the orchestrator; "present" is only the agent's claim
//   - an optional check the human skipped yields HUMAN_MERGE instead of ESCALATE
//   - the task's tests, the suite and diff inspection can never be skipped
//   - video is only required when the manifest says so (a UI target or a video step)
//   - no CI on the repository (evidence.ci = none) means a human merges
//   - an invalid check file escalates

export const VERDICTS = ['SHIP', 'HUMAN_MERGE', 'ESCALATE'];
export const NEVER_SKIPPED = ['taskTests', 'suite', 'diff'];
const EVIDENCE_ITEMS = ['video', 'architecture', 'files', 'ci'];
const E2E_BLOCKING = ['FAIL', 'BROKEN', 'STOPPED'];

export function verdict(input = {}) {
  const reasons = [];
  const esc = (gate, detail) => reasons.push({ gate, level: 'ESCALATE', detail });
  const human = (gate, detail) => reasons.push({ gate, level: 'HUMAN_MERGE', detail });
  const skipped = new Set(Array.isArray(input.skipped) ? input.skipped : []);
  for (const name of NEVER_SKIPPED) if (skipped.has(name)) esc(name, `${name} cannot be skipped for cost; the waiver is ignored`);

  for (const problem of Array.isArray(input.invalid) ? input.invalid : []) esc('checks', problem);
  const requires = { video: true, ...(input.requires || {}) };

  for (const key of ['taskTests', 'acceptance', 'suite', 'e2e', 'diff', 'okf', 'evidence']) {
    if (input[key] === undefined || input[key] === null) esc(key, `missing input: ${key}`);
  }

  // Proven twice, part 1: the task's tests in the suite.
  if (input.taskTests) {
    if (input.taskTests.status !== 'pass') esc('taskTests', `task tests ${input.taskTests.status ?? 'unknown'}${input.taskTests.failed ? ` (${input.taskTests.failed} failing)` : ''}`);
  }

  // Proven twice, part 2: every acceptance criterion live.
  if (Array.isArray(input.acceptance)) {
    if (input.acceptance.length === 0) esc('acceptance', 'no acceptance criteria were proven live');
    for (const c of [...input.acceptance].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))) {
      if (c.result === 'pass') continue;
      const detail = `${c.id} ${c.result ?? 'unknown'}`;
      if (c.result === 'fail') esc('acceptance', detail);
      else if (c.optional && skipped.has(c.id)) human('acceptance', `${detail} (optional, skipped by the human at the cost gate)`);
      else esc('acceptance', `${detail}: never a pass`);
    }
  } else if (input.acceptance !== undefined && input.acceptance !== null) esc('acceptance', 'acceptance must be a list');

  // No regressions.
  if (input.suite && input.suite.status !== 'pass') esc('suite', `regression suite ${input.suite.status ?? 'unknown'}${input.suite.failed ? ` (${input.suite.failed} failing)` : ''}`);
  if (Array.isArray(input.e2e)) {
    for (const f of [...input.e2e].sort((a, b) => String(a.feature).localeCompare(String(b.feature)))) {
      if (E2E_BLOCKING.includes(f.verdict)) esc('e2e', `${f.feature} ${f.verdict}`);
      else if (f.verdict === 'NOT RUN') {
        if (skipped.has(`e2e:${f.feature}`)) human('e2e', `${f.feature} NOT RUN (skipped by the human at the cost gate)`);
        else esc('e2e', `${f.feature} NOT RUN`);
      } else if (f.verdict !== 'PASS' && f.verdict !== 'KNOWN') esc('e2e', `${f.feature} has an unknown verdict ${f.verdict}`);
    }
  }

  // Diff inspection and documents.
  if (input.diff) {
    if (input.diff.pass !== true) {
      const failed = (input.diff.checks || []).filter((c) => !c.pass).map((c) => c.name);
      esc('diff', `diff inspection failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
    }
  }
  if (Array.isArray(input.okf) && input.okf.length) esc('okf', `${input.okf.length} invalid document${input.okf.length > 1 ? 's' : ''}`);

  // Evidence pack, re-checked by the orchestrator.
  if (input.evidence) {
    for (const item of EVIDENCE_ITEMS) {
      const state = input.evidence[item];
      if (state === 'verified') continue;
      if (item === 'video' && !requires.video) continue;
      if (item === 'ci' && state === 'none') {
        human('evidence', 'no CI configured on the repository: a human merges');
        continue;
      }
      if (skipped.has(item) && item === 'video') human('evidence', 'video skipped by the human at the cost gate');
      else if (state === 'present') esc('evidence', `${item} is present but not verified at its source`);
      else esc('evidence', `${item} ${state ?? 'missing'}`);
    }
  }

  const level = reasons.some((r) => r.level === 'ESCALATE') ? 'ESCALATE' : reasons.length ? 'HUMAN_MERGE' : 'SHIP';
  return { verdict: level, reasons };
}

// One line for the orchestrator: VERDICT=SHIP or VERDICT=ESCALATE REASONS=n FIRST="…"
export function resultLine(v) {
  if (v.verdict === 'SHIP') return 'VERDICT=SHIP';
  const first = v.reasons.find((r) => r.level === v.verdict) || v.reasons[0];
  return `VERDICT=${v.verdict} REASONS=${v.reasons.length} FIRST="${first.gate}: ${first.detail.replaceAll('"', "'")}"`;
}
