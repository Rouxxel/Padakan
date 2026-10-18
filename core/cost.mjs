// Cost gate: estimates, budget left, the gate decision, the Devin session cap and ledger lines.
// Deterministic arithmetic only: no network, no models, no file writes (the orchestrator appends
// the lines this module returns to <records>/cost/ledger.jsonl).

export const LEDGER_KINDS = ['estimate', 'gate', 'spend', 'warn', 'decision'];
export const WARN_RATIO = 0.8;

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function parseAmount(raw, key) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got "${raw}"`);
  return n;
}

// Flat "unit: price" YAML (registry/prices.yml); .env overrides the Devin ACU price.
export function loadPrices({ yamlText = '', env = {} } = {}) {
  const prices = {};
  for (const line of yamlText.split(/\r?\n/)) {
    const m = line.replace(/#.*$/, '').match(/^\s*([\w:./-]+)\s*:\s*(\S+)\s*$/);
    if (m) prices[m[1]] = parseAmount(m[2], `prices.yml ${m[1]}`);
  }
  const acu = parseAmount(env.PADAKAN_DEVIN_USD_PER_ACU, 'PADAKAN_DEVIN_USD_PER_ACU');
  if (acu !== null) prices.acu = acu;
  return prices;
}

export function budgetsFromEnv(env = {}) {
  return {
    run_usd: parseAmount(env.PADAKAN_BUDGET_RUN_USD, 'PADAKAN_BUDGET_RUN_USD'),
    task_usd: parseAmount(env.PADAKAN_BUDGET_TASK_USD, 'PADAKAN_BUDGET_TASK_USD'),
    step_usd: parseAmount(env.PADAKAN_BUDGET_STEP_USD, 'PADAKAN_BUDGET_STEP_USD'),
  };
}

// -> { low_usd, likely_usd, high_usd }, or null when the unit has no price.
export function estimate(item, prices) {
  const price = prices?.[item.unit];
  if (!isNum(price)) return null;
  if (!isNum(item.low) || !isNum(item.high) || item.low > item.high) {
    throw new Error(`estimate for ${item.step} needs numeric low <= high`);
  }
  const likely = isNum(item.likely) ? item.likely : item.high;
  return { low_usd: round6(item.low * price), likely_usd: round6(likely * price), high_usd: round6(item.high * price) };
}

const inRun = (e, scope) => e.run === scope.run;
const inTask = (e, scope) => inRun(e, scope) && e.task === scope.task;
const sum = (entries, field) => entries.reduce((acc, e) => acc + (isNum(e[field]) ? e[field] : 0), 0);

// Spend comes from "spend" lines; a human "approve" adds a one-off allowance ("decision" lines with
// allowance_usd) for ONE step of one task. The allowance is the approved step's alone:
//   - for that step (scope.step), all of it is extra room;
//   - for every other step, only what the approved step has already spent from it is credited back,
//     so its approved overspend never eats the budget the other steps had.
// Without scope.step, every allowance counts as far as it is spent.
export function budgetLeft(ledger, budgets, scope) {
  const spends = ledger.filter((e) => e.kind === 'spend');
  const allowances = ledger.filter((e) => e.kind === 'decision' && isNum(e.allowance_usd));
  const left = (cap, match) => {
    if (cap === null || cap === undefined) return Infinity;
    const mine = spends.filter((e) => match(e, scope));
    const byStep = new Map();
    for (const a of allowances.filter((e) => match(e, scope))) {
      const k = `${a.task}\u0000${a.step}`;
      byStep.set(k, { task: a.task, step: a.step, usd: (byStep.get(k)?.usd ?? 0) + a.allowance_usd });
    }
    let credit = 0;
    for (const a of byStep.values()) {
      const own = scope.step !== undefined && a.task === scope.task && a.step === scope.step;
      const used = sum(mine.filter((e) => e.task === a.task && e.step === a.step), 'usd');
      credit += own ? a.usd : Math.min(a.usd, used);
    }
    return round6(cap + credit - sum(mine, 'usd'));
  };
  return { run_usd: left(budgets.run_usd, inRun), task_usd: left(budgets.task_usd, inTask) };
}

function stepCap(ledger, budgets, scope, step) {
  if (budgets.step_usd === null || budgets.step_usd === undefined) return Infinity;
  const allowance = sum(ledger.filter((e) => e.kind === 'decision' && inTask(e, scope) && e.step === step), 'allowance_usd');
  return round6(budgets.step_usd + allowance);
}

const finiteOrNull = (n) => (Number.isFinite(n) ? n : null);

// Never returns "skip": only a human can skip, and only an optional step (decision report).
export function gate({ item, ledger = [], budgets, prices, scope }) {
  const left = budgetLeft(ledger, budgets, { ...scope, step: item.step });
  const step = stepCap(ledger, budgets, scope, item.step);
  const cap = Math.min(step, left.task_usd, left.run_usd);
  const base = {
    estimate: null,
    left: { run_usd: finiteOrNull(left.run_usd), task_usd: finiteOrNull(left.task_usd), step_usd: finiteOrNull(step) },
    cheapest_cap_usd: finiteOrNull(cap),
    required: item.required === true,
  };
  const est = estimate(item, prices);
  if (!est) return { ...base, decision: 'pause', reason: 'no-price' };
  const out = { ...base, estimate: est };
  if (est.high_usd > step) return { ...out, decision: 'pause', reason: 'step-cap' };
  if (est.high_usd > left.task_usd) return { ...out, decision: 'pause', reason: 'task-cap' };
  if (est.high_usd > left.run_usd) return { ...out, decision: 'pause', reason: 'run-cap' };
  return { ...out, decision: 'run', reason: null };
}

// max_acu_limit for a Devin session: Devin stops itself at the budget even if Padakan crashes.
// -> { decision: 'run', max_acu_limit } | { decision: 'pause', reason }
// max_acu_limit is null only when no budget and no hard max are set (nothing to cap at).
export function sessionCap({ item, ledger = [], budgets, prices, scope, hardMax = null }) {
  if (item.unit !== 'acu') throw new Error(`sessionCap needs an "acu" item, got "${item.unit}"`);
  const price = prices?.acu;
  if (!isNum(price)) return { decision: 'pause', reason: 'no-price' };
  const left = budgetLeft(ledger, budgets, { ...scope, step: item.step });
  const capUsd = Math.min(stepCap(ledger, budgets, scope, item.step), left.task_usd, left.run_usd);
  const byBudget = price === 0 ? Infinity : Math.max(0, capUsd) / price;
  const units = Math.min(byBudget, isNum(hardMax) ? hardMax : Infinity);
  if (units === Infinity) return { decision: 'run', max_acu_limit: null };
  const max = Math.floor(units);
  if (max < 1 || max < item.low) return { decision: 'pause', reason: 'cap-below-low', max_acu_limit: max };
  return { decision: 'run', max_acu_limit: max };
}

// Estimate for the work left after a cap was hit (used when a human raises the budget).
export function remainingEstimate(item, spentUnits, minUnits = 0) {
  const rest = (n) => Math.max(minUnits, round6(n - spentUnits));
  return {
    ...item,
    low: rest(item.low),
    likely: rest(isNum(item.likely) ? item.likely : item.high),
    high: rest(item.high),
  };
}

// Ledger lines for one poll tick: the spend delta since the last tick and, once per session,
// a warning at 80 % of max_acu_limit.
export function spendTick({ ledger = [], run, task, step, session_id, acus_consumed, max_acu_limit, usdPerAcu, now }) {
  if (!isNum(usdPerAcu)) throw new Error('spendTick needs usdPerAcu');
  const mine = ledger.filter((e) => e.session_id === session_id);
  const seen = sum(mine.filter((e) => e.kind === 'spend'), 'qty');
  const out = [];
  const delta = round6(acus_consumed - seen);
  if (delta > 0) {
    out.push(entry({ run, task, step, session_id, now, kind: 'spend', unit: 'acu', qty: delta, usd: round6(delta * usdPerAcu), source: 'acus_consumed' }));
  }
  const warned = mine.some((e) => e.kind === 'warn');
  if (!warned && isNum(max_acu_limit) && max_acu_limit > 0 && acus_consumed >= WARN_RATIO * max_acu_limit) {
    out.push(entry({ run, task, step, session_id, now, kind: 'warn', acus: acus_consumed, max_acu_limit }));
  }
  return out;
}

function entry({ now, ...fields }) {
  return { ts: now ?? new Date().toISOString(), ...fields };
}

// Validate one ledger entry and return it as a JSONL line (the orchestrator appends it).
export function record(e) {
  if (!LEDGER_KINDS.includes(e.kind)) throw new Error(`ledger kind must be one of ${LEDGER_KINDS.join(', ')}`);
  for (const key of ['run', 'task', 'step']) {
    if (typeof e[key] !== 'string' || !e[key]) throw new Error(`ledger entry needs "${key}"`);
  }
  return JSON.stringify(e.ts ? e : { ts: new Date().toISOString(), ...e }) + '\n';
}

export function parseLedger(text) {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`ledger line ${i + 1} is not valid JSON`);
    }
  });
}
