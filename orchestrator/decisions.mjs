// Cost decision reports and the human's answers (IMPLEMENTATION-DEVIN-COSTGATE.md part C).
//
//   padakan decision <KEY> --input <file.json>   open a report when the cost gate pauses a step
//   padakan decision-check <D-nnnn>              OKF, schema and completeness check before showing it
//   padakan decide <D-nnnn> <answer> [--by name] answer it: approve | cheaper:<name> | skip | raise:<usd> | abort
//
// The orchestrator is the only writer of decisions/, cost/ledger.jsonl, state.json and the audit
// trail. Every number in a report comes from core/cost.mjs and the ledger; report-writer only adds
// prose. A required step can never be skipped. With no answer, the tree stays paused.

import { readFile, writeFile, readdir, mkdir, appendFile, chmod } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFrontmatter, validateText } from '../core/okf.mjs';
import { validate } from '../core/schema.mjs';
import { gate, sessionCap, estimate, loadPrices, budgetsFromEnv, budgetLeft, remainingEstimate, record, parseLedger } from '../core/cost.mjs';
import { updateTask, getTask, assertKey } from './lib/state.mjs';
import { PLUGIN_ROOT } from './lib/records.mjs';

const REPORT_SCHEMA = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'schemas', 'decision-report.json'), 'utf8'));
const ANSWER_SCHEMA = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'schemas', 'decision-answer.json'), 'utf8'));
const PRICES_FILE = join(PLUGIN_ROOT, 'registry', 'prices.yml');

export const ID_RE = /^D-\d{4,}$/;
export const TODO = '_(report-writer: fill this in)_';
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const BUDGET_KEY = { 'step-cap': 'PADAKAN_BUDGET_STEP_USD', 'run-cap': 'PADAKAN_BUDGET_RUN_USD' };
const budgetKeyFor = (reason) => BUDGET_KEY[reason] ?? 'PADAKAN_BUDGET_TASK_USD';
const BUDGET_FIELD = { PADAKAN_BUDGET_STEP_USD: 'step_usd', PADAKAN_BUDGET_RUN_USD: 'run_usd', PADAKAN_BUDGET_TASK_USD: 'task_usd' };

class DecisionError extends Error {
  constructor(message, code = 'DECISION') {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────────────────────────
const dirOf = (records) => join(records, 'decisions');
const ledgerFile = (records) => join(records, 'cost', 'ledger.jsonl');
const usd = (n) => (n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : `$${n.toFixed(2)}`);
const isoNow = (ctx) => (ctx.now ? ctx.now() : new Date().toISOString());

async function readLedger(records) {
  return existsSync(ledgerFile(records)) ? parseLedger(await readFile(ledgerFile(records), 'utf8')) : [];
}

async function appendLedger(records, entries) {
  if (!entries.length) return;
  await mkdir(join(records, 'cost'), { recursive: true });
  await appendFile(ledgerFile(records), entries.map((e) => record(e)).join(''));
}

async function pricesFor(ctx) {
  const yamlText = existsSync(PRICES_FILE) ? await readFile(PRICES_FILE, 'utf8') : '';
  return loadPrices({ yamlText, env: ctx.settings ?? {} });
}

const budgetsFor = (ctx, overrides = {}) => ({ ...budgetsFromEnv(ctx.settings ?? {}), ...overrides });

function spent(ledger, { task, step, unit }) {
  const lines = ledger.filter((e) => e.kind === 'spend' && e.task === task && (!step || e.step === step) && (!unit || e.unit === unit));
  return { qty: lines.reduce((a, e) => a + (e.qty ?? 0), 0), usd: lines.reduce((a, e) => a + (e.usd ?? 0), 0) };
}

async function nextId(records) {
  const dir = dirOf(records);
  const nums = existsSync(dir) ? (await readdir(dir)).map((f) => f.match(/^D-(\d+)\.md$/)?.[1]).filter(Boolean).map(Number) : [];
  return `D-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0')}`;
}

// Set KEY=value in a .env file (the records .env: per project, survives plugin updates).
export async function setEnvValue(file, key, value) {
  const text = existsSync(file) ? await readFile(file, 'utf8') : '';
  const lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  await writeFile(file, `${lines.join('\n')}\n`);
  await chmod(file, 0o600).catch(() => {});
}

// ── Opening a report ────────────────────────────────────────────────────────────────────────────

// input: { task, step, run, tree?, item, reason?, alternatives?: [{ name, unit, low, likely?, high, uncovered }],
//          what?, why?, if_skipped?, recommendation?, recommendation_why? }
// The gate is recomputed here from the ledger; `reason` may be given only for pauses the gate does not
// see itself (session-cap-hit, cap-below-low). -> { id, path, draft }
export async function createDecision(ctx, input) {
  const task = assertKey(input.task);
  const item = { ...input.item, step: input.step ?? input.item?.step };
  if (!item.step || !item.unit) throw new DecisionError('a decision needs the step and its estimate (item with unit, low, high)');
  const run = input.run ?? 'run';
  const scope = { run, task };
  const ledger = await readLedger(ctx.records);
  const prices = await pricesFor(ctx);
  const budgets = budgetsFor(ctx);
  const g = gate({ item, ledger, budgets, prices, scope });
  const reason = input.reason ?? g.reason;
  if (!reason) throw new DecisionError(`nothing to decide: the gate allows ${item.step} for ${task}`, 'NOTHING_TO_DECIDE');
  const required = item.required === true;

  const alternatives = (input.alternatives ?? []).map((a) => {
    if (!NAME_RE.test(a.name ?? '')) throw new DecisionError(`alternative name "${a.name}" must be lowercase letters, digits and dashes`);
    return { ...a, step: a.step ?? `${item.step}:${a.name}`, required: false, estimate: estimate(a, prices) };
  });
  const recommendation = input.recommendation ?? (required ? (reason === 'no-price' ? 'abort' : 'raise') : alternatives.length ? `cheaper:${alternatives[0].name}` : 'skip');
  if (required && recommendation === 'skip') throw new DecisionError(`${item.step} is required and cannot be skipped for cost`, 'REQUIRED');
  if (recommendation.startsWith('cheaper:') && !alternatives.some((a) => `cheaper:${a.name}` === recommendation)) {
    throw new DecisionError(`recommendation ${recommendation} is not one of the listed alternatives`);
  }

  const id = await nextId(ctx.records);
  const now = isoNow(ctx);
  const machine = {
    id, task, step: item.step, run, tree: input.tree ?? null, reason, required, item,
    estimate: g.estimate, left: g.left, spent_task_usd: spent(ledger, { task }).usd, alternatives, created_at: now,
  };
  const text = renderDecision({ ...machine, what: input.what, why: input.why, if_skipped: input.if_skipped, recommendation, recommendation_why: input.recommendation_why, now });
  await mkdir(dirOf(ctx.records), { recursive: true });
  await writeFile(join(dirOf(ctx.records), `${id}.json`), `${JSON.stringify(machine, null, 2)}\n`);
  await writeFile(join(dirOf(ctx.records), `${id}.md`), text);
  await updateTask(ctx.records, task, { status: 'paused', decision: id }, ctx.now);
  await ctx.audit?.append({ type: 'cost.decision.opened', task, decision: id, step: item.step, reason, required, summary: `cost decision ${id} opened for ${task} (${item.step}, ${reason})` });
  return { id, path: `decisions/${id}.md`, draft: text.includes(TODO) };
}

export function renderDecision(d) {
  const est = d.estimate;
  const prose = (v) => (typeof v === 'string' && v.trim() ? v.trim() : TODO);
  const options = [
    `| approve | ${usd(est?.high_usd)} | nothing |`,
    ...d.alternatives.map((a) => `| cheaper:${a.name} | ${usd(a.estimate?.high_usd)} | ${String(a.uncovered ?? 'not stated').replace(/\|/g, '/')} |`),
    ...(d.required ? [] : ['| skip | $0 | this step stays unverified; the change will not auto-ship |']),
    '| raise | | the budget is raised and the gate runs again |',
    '| abort | $0 | the task is escalated to a human |',
  ];
  const lines = [
    '---',
    'type: Decision Report',
    `title: ${d.id} · ${d.task} · ${d.step} over budget`,
    `description: ${d.step} for ${d.task} is paused (${d.reason}); the human chooses how to continue.`,
    'tags: [decision, cost]',
    `timestamp: ${d.now}`,
    `id: ${d.id}`,
    `task: ${d.task}`,
    `step: ${d.step}`,
    `tree: ${d.tree ?? 'none'}`,
    `run: ${d.run}`,
    `reason: ${d.reason}`,
    `required: ${d.required}`,
    'status: open',
    `unit: ${d.item.unit}`,
    `high_usd: ${est?.high_usd ?? 'null'}`,
    `recommendation: ${d.recommendation}`,
    `alternatives: [${d.alternatives.map((a) => a.name).join(', ')}]`,
    '---',
    '',
    `# ${d.id} · ${d.step} for ${d.task} is over budget`,
    '',
    `> Numbers and options by \`padakan decision\`, from the cost gate and the ledger; prose by report-writer. Machine data: \`${d.id}.json\`.`,
    '',
    '## What',
    '',
    prose(d.what),
    '',
    '## Why it matters',
    '',
    prose(d.why),
    '',
    '## Cost',
    '',
    '| | Low | Likely | High |',
    '|---|---|---|---|',
    `| This step (${d.item.unit}) | ${d.item.low} | ${d.item.likely ?? d.item.high} | ${d.item.high} |`,
    `| This step (USD) | ${usd(est?.low_usd)} | ${usd(est?.likely_usd)} | ${usd(est?.high_usd)} |`,
    '',
    `Budget left: step ${usd(d.left?.step_usd)} · task ${usd(d.left?.task_usd)} · run ${usd(d.left?.run_usd)} (n/a means no cap). Spent so far on this task: ${usd(d.spent_task_usd)}.`,
    `Paused because: \`${d.reason}\`.${d.required ? ' **This step is required: it can never be skipped for cost.**' : ''}`,
    '',
    '## Options',
    '',
    '| Option | Cost (high) | What it leaves uncovered |',
    '|---|---|---|',
    ...options,
    '',
    ...(d.required ? [] : ['## If skipped', '', prose(d.if_skipped), '']),
    '## Recommendation',
    '',
    `**${d.recommendation}**. ${prose(d.recommendation_why)}`,
    '',
    '## Answer',
    '',
    `\`/padakan:decide ${d.id} <approve${d.alternatives.map((a) => ` | cheaper:${a.name}`).join('')}${d.required ? '' : ' | skip'} | raise:<usd> | abort>\``,
    '',
  ];
  return lines.join('\n');
}

// ── Reading and checking ────────────────────────────────────────────────────────────────────────
export async function readDecision(records, id) {
  if (!ID_RE.test(id ?? '')) throw new DecisionError(`invalid decision id "${id}" (expected D-0001)`, 'BAD_ID');
  const file = join(dirOf(records), `${id}.md`);
  if (!existsSync(file)) throw new DecisionError(`no decision ${id} in ${dirOf(records)}`, 'NOT_FOUND');
  const text = await readFile(file, 'utf8');
  const { data } = parseFrontmatter(text);
  const fm = { ...data };
  if (fm.required !== undefined) fm.required = fm.required === 'true' || fm.required === true;
  if (fm.high_usd !== undefined) fm.high_usd = fm.high_usd === 'null' ? null : Number(fm.high_usd);
  const machineFile = join(dirOf(records), `${id}.json`);
  const machine = existsSync(machineFile) ? JSON.parse(await readFile(machineFile, 'utf8')) : null;
  return { file, text, data: fm, machine };
}

// Problems that keep a report from being shown: OKF, schema, missing prose, a skip offered for a required step.
export async function checkDecision(records, id) {
  const d = await readDecision(records, id);
  const problems = [...validateText(d.text), ...validate(REPORT_SCHEMA, d.data)];
  if (!d.machine) problems.push(`machine data ${id}.json is missing`);
  for (const section of ['What', 'Why it matters', 'If skipped', 'Recommendation']) {
    const body = d.text.split(`## ${section}\n`)[1]?.split('\n## ')[0] ?? '';
    if (body.includes(TODO)) problems.push(`prose missing: ${section}`);
  }
  if (d.data.required) {
    if (/^\| skip \|/m.test(d.text)) problems.push('a required step offers skip');
    if (/^## If skipped/m.test(d.text)) problems.push('a required step has an "If skipped" section');
  }
  return problems;
}

// ── Answering ───────────────────────────────────────────────────────────────────────────────────
export function parseAnswer(raw) {
  const s = String(raw ?? '').trim();
  if (['approve', 'skip', 'abort'].includes(s)) return { answer: s };
  let m;
  if ((m = s.match(/^cheaper:([a-z0-9][a-z0-9-]*)$/))) return { answer: 'cheaper', option: m[1] };
  if ((m = s.match(/^raise:(\d+(?:\.\d+)?)$/)) && Number(m[1]) > 0) return { answer: 'raise', usd: Number(m[1]) };
  throw new DecisionError(`invalid answer "${s}": use approve | cheaper:<name> | skip | raise:<usd> | abort (raise needs a positive number)`, 'BAD_ANSWER');
}

// -> { id, answer, action, ... } (the answer record, also written to D-nnnn.answer.json)
export async function decide(ctx, id, rawAnswer, { by } = {}) {
  const d = await readDecision(ctx.records, id);
  if (d.data.status !== 'open') throw new DecisionError(`decision ${id} is already ${d.data.status}`, 'ANSWERED');
  if (!d.machine) throw new DecisionError(`decision ${id} has no machine data (${id}.json)`, 'NO_MACHINE_DATA');
  const a = parseAnswer(rawAnswer);
  const m = d.machine;
  const { task, step, run, tree, reason, required, item } = m;
  const scope = { run, task };
  const now = isoNow(ctx);
  const base = { ts: now, run, task, step, kind: 'decision', decision: id, answer: a.answer };
  const settings = ctx.settings ?? {};
  let budgets = budgetsFor(ctx);
  const result = { id, answer: a.answer, by: by || settings.GIT_AUTHOR_NAME || 'human', ts: now };

  if (a.answer === 'skip' && required) throw new DecisionError(`${step} is required: it cannot be skipped for cost (approve, raise or abort)`, 'REQUIRED');
  if ((a.answer === 'raise' || a.answer === 'approve') && reason === 'no-price') {
    throw new DecisionError(`${step} has no price, so the gate cannot measure it: set the price (for example PADAKAN_DEVIN_USD_PER_ACU), choose a cheaper option or abort`, 'NO_PRICE');
  }
  const alt = a.answer === 'cheaper' ? m.alternatives.find((x) => x.name === a.option) : null;
  if (a.answer === 'cheaper' && !alt) throw new DecisionError(`no alternative "${a.option}" in ${id} (listed: ${m.alternatives.map((x) => x.name).join(', ') || 'none'})`, 'NO_OPTION');
  if (a.answer === 'raise') {
    const key = budgetKeyFor(reason);
    const current = budgets[BUDGET_FIELD[key]];
    if (current !== null && current !== undefined && a.usd <= current) {
      throw new DecisionError(`raise:${a.usd} must be higher than the current ${key}=${current}`, 'BAD_RAISE');
    }
  }

  // Effects, in order: ledger line, then what the answer does.
  if (a.answer === 'approve') {
    await appendLedger(ctx.records, [{ ...base, allowance_usd: m.estimate?.high_usd ?? 0 }]);
    Object.assign(result, await carryOn(ctx, m, item, budgets));
  } else if (a.answer === 'cheaper') {
    await appendLedger(ctx.records, [{ ...base, option: a.option }]);
    result.option = a.option;
    const altItem = { step: alt.step, unit: alt.unit, low: alt.low, likely: alt.likely, high: alt.high, required: false };
    const g = gate({ item: altItem, ledger: await readLedger(ctx.records), budgets, prices: await pricesFor(ctx), scope });
    if (g.decision === 'run') result.action = 'run-alternative';
    else Object.assign(result, await reopen(ctx, m, altItem, g.reason));
  } else if (a.answer === 'skip') {
    await appendLedger(ctx.records, [base]);
    const t = await getTask(ctx.records, task).catch(() => ({}));
    await updateTask(ctx.records, task, { skipped: [...new Set([...(t.skipped ?? []), step])], auto_ship: false, status: 'building', decision: null }, ctx.now);
    result.action = 'skipped';
  } else if (a.answer === 'raise') {
    const key = budgetKeyFor(reason);
    await setEnvValue(join(ctx.records, '.env'), key, a.usd);
    budgets = { ...budgets, [BUDGET_FIELD[key]]: a.usd };
    await appendLedger(ctx.records, [{ ...base, usd: a.usd, budget_key: key }]);
    result.usd = a.usd;
    Object.assign(result, await carryOn(ctx, m, item, budgets));
  } else if (a.answer === 'abort') {
    await appendLedger(ctx.records, [base]);
    await updateTask(ctx.records, task, { status: 'escalated', escalation: `cost decision ${id} aborted`, decision: null }, ctx.now);
    if (tree && ctx.gateway) {
      const h = await ctx.gateway.get(tree).catch(() => null);
      if (h && !['paused', 'done', 'failed', 'gone'].includes(h.state) && (await ctx.gateway.supports(tree, 'pause'))) await ctx.gateway.pause(tree);
    }
    result.action = 'escalated';
  }

  const errors = validate(ANSWER_SCHEMA, result);
  if (errors.length) throw new DecisionError(`internal: invalid answer record: ${errors.join('; ')}`);
  await writeFile(join(dirOf(ctx.records), `${id}.answer.json`), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(d.file, d.text.replace(/^status: open$/m, 'status: answered'));
  if (['run-step', 'run-alternative', 'raised', 'regated-run'].includes(result.action)) {
    await updateTask(ctx.records, task, { status: 'building', decision: null }, ctx.now);
  }
  await ctx.audit?.append({ type: 'cost.decision.answered', task, decision: id, answer: a.answer, action: result.action, by: result.by, summary: `cost decision ${id}: ${rawAnswer} -> ${result.action}` });
  return result;
}

// After approve or raise: gate again. A capped Devin session continues through raiseBudget on the
// remaining estimate; anything else runs the step again. A second pause opens a new report.
async function carryOn(ctx, m, item, budgets) {
  const { task, step, run, tree, reason } = m;
  const scope = { run, task };
  const settings = ctx.settings ?? {};
  const ledger = await readLedger(ctx.records);
  const prices = await pricesFor(ctx);
  const canRaise = reason === 'session-cap-hit' && tree && ctx.gateway && (await ctx.gateway.supports(tree, 'raiseBudget').catch(() => false));
  if (canRaise) {
    const done = spent(ledger, { task, step, unit: item.unit }).qty;
    const rest = remainingEstimate(item, done, settings.DEVIN_CONTINUATION_MIN_ACU ?? 0);
    const g = gate({ item: rest, ledger, budgets, prices, scope });
    if (g.decision !== 'run') return reopen(ctx, m, rest, g.reason);
    const cap = sessionCap({ item: rest, ledger, budgets, prices, scope, hardMax: settings.DEVIN_MAX_ACU });
    if (cap.decision !== 'run') return reopen(ctx, m, rest, cap.reason);
    const capAcu = cap.max_acu_limit ?? Math.ceil(rest.high);
    const r = await ctx.gateway.raiseBudget(tree, { cap_acu: capAcu, decision: m.id });
    return { action: 'raised', session_id: r.session_id, max_acu_limit: r.max_acu_limit ?? capAcu };
  }
  const g = gate({ item, ledger, budgets, prices, scope });
  if (g.decision === 'run') return { action: reason === 'session-cap-hit' ? 'regated-run' : 'run-step' };
  return reopen(ctx, m, item, g.reason);
}

async function reopen(ctx, m, item, reason) {
  const next = await createDecision(ctx, { task: m.task, step: item.step, run: m.run, tree: m.tree, item, reason, alternatives: item.step === m.step ? m.alternatives : [] });
  return { action: 'new-decision', next_decision: next.id };
}

// ── CLI steps (bin/padakan) ─────────────────────────────────────────────────────────────────────
function flags(args) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    else pos.push(args[i]);
  }
  return { pos, opt };
}

const fail = (e, label) => ({ line: `${label}=refused CODE=${e.code || 'ERROR'} REASON=${JSON.stringify(e.message)}`, code: 1 });

export async function decisionStep(ctx, args) {
  const { pos, opt } = flags(args);
  try {
    if (!opt.input || !existsSync(opt.input)) throw new DecisionError('padakan decision <KEY> --input <file.json>', 'USAGE');
    const input = JSON.parse(await readFile(opt.input, 'utf8'));
    const r = await createDecision(ctx, { ...input, task: pos[0] ?? input.task });
    return { line: `DECISION=${r.path} ID=${r.id} STATUS=${r.draft ? 'draft' : 'ready'}`, code: 0 };
  } catch (e) {
    if (!(e instanceof DecisionError)) throw e;
    return fail(e, 'DECISION');
  }
}

export async function decisionCheckStep(ctx, args) {
  const problems = await checkDecision(ctx.records, args[0]);
  return { line: `DECISION=${args[0]} PROBLEMS=${problems.length}`, code: problems.length ? 1 : 0, details: problems };
}

export async function decideStep(ctx, args) {
  const { pos, opt } = flags(args);
  try {
    const r = await decide(ctx, pos[0], pos[1], { by: typeof opt.by === 'string' ? opt.by : undefined });
    const extra = [r.session_id && `SESSION=${r.session_id}`, r.max_acu_limit && `MAX_ACU=${r.max_acu_limit}`, r.next_decision && `NEXT=${r.next_decision}`].filter(Boolean);
    return { line: [`DECISION=${r.id}`, `ANSWER=${r.answer}${r.option ? `:${r.option}` : r.usd ? `:${r.usd}` : ''}`, `ACTION=${r.action}`, ...extra].join(' '), code: 0 };
  } catch (e) {
    if (!(e instanceof DecisionError)) throw e;
    return fail(e, 'DECIDED');
  }
}

export const DECISION_STEPS = { decision: decisionStep, 'decision-check': decisionCheckStep, decide: decideStep };
export { DecisionError };
