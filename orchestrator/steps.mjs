// The orchestrator's lifecycle steps. Each step:
//   - goes through the sandbox gateway, never a provider directly;
//   - asserts on effects (the remote branch, commits, the PR, CI), never on a status field alone;
//   - writes its details to the records folder and returns ONE result line.
//
// run(ctx, args) -> { line, code, details? }   ctx from orchestrator/lib/context.mjs
// bin/padakan <step> ... calls these; agents (mostly tree-operator and verifier) run that CLI.

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { init as initRecords, taskDir } from './lib/records.mjs';
import { readState, updateState, updateTask, getTask, treeId, branchFor, assertKey } from './lib/state.mjs';
import { validateFile, validateBundle } from '../core/okf.mjs';
import { inspect } from '../core/diffcheck.mjs';
import { verdict, resultLine } from '../core/gates.mjs';
import { readChecks } from '../core/checks.mjs';
import { resolve as resolveManifest, resultLine as manifestLine } from '../core/resolver.mjs';
import { collect } from '../core/collect-logs.mjs';
import { triage } from '../core/triage.mjs';
import { buildPack, renderMarkdown, renderHtml, ITEMS } from '../core/report.mjs';
import { adapterFor, gatedDeploy } from '../core/deploy.mjs';
import { DECISION_STEPS } from './decisions.mjs';

const ok = (line, details) => ({ line, code: 0, details });
const fail = (line, details) => ({ line, code: 1, details });

function flags(args) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2);
      const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      opt[k] = v;
    } else pos.push(args[i]);
  }
  return { pos, opt };
}

async function readJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeOkf(path, { type, title, description, tags, body }, now) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\ntags: [${tags.join(', ')}]\ntimestamp: ${now()}\n---\n\n${body}\n`);
}

async function taskTree(ctx, key) {
  const task = await getTask(ctx.records, key);
  if (!task.tree) throw new Error(`task ${key} has no tree; run \`padakan plant ${key}\``);
  return { task, handle: await ctx.gateway.get(task.tree) };
}

// ── init: create the records folder ─────────────────────────────────────────────────────────────
export async function init(ctx) {
  const r = await initRecords(ctx.records, { repo: ctx.repo ? ctx.repo.split('/').pop() : undefined });
  await ctx.audit.append({ type: 'records.init', summary: `records initialised (${r.created.length} files created)` });
  return ok(`RECORDS=${ctx.records} CREATED=${r.created.length}`);
}

// ── resolve <KEY>: the capability resolver chooses the task's tools; the human is not asked ──────
export async function resolve(ctx, args) {
  const key = assertKey(args[0]);
  const task = await getTask(ctx.records, key);
  const prdFile = join(ctx.records, 'plan', 'prd.md');
  const prd = existsSync(prdFile) ? await readFile(prdFile, 'utf8') : '';
  const { manifest, usage } = await resolveManifest({ task: { key, ...task }, prd, settings: ctx.settings, client: ctx.models(), now: ctx.now });
  const dir = await taskDir(ctx.records, key);
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await updateTask(ctx.records, key, { target: manifest.target, platform: manifest.platform }, ctx.now);
  await ctx.audit.append({ type: 'manifest.resolved', task: key, target: manifest.target, model: manifest.resolved_by, usage, summary: `manifest resolved (${manifest.target} on ${manifest.platform})` });
  return ok(manifestLine(`tasks/${key}/manifest.json`, manifest));
}

// A remote sandbox gets its credentials first (seed), then its checkout (bootstrap). Returns a
// failure result, or null when the tree is ready.
async function prepare(ctx, key, id, branch, provider) {
  for (const verb of ['seed', 'bootstrap']) {
    if (!(await ctx.gateway.supports(id, verb))) continue;
    try {
      await ctx.gateway[verb](id);
    } catch (e) {
      await updateTask(ctx.records, key, { status: 'plant-failed', tree: id, branch, provider }, ctx.now);
      await ctx.audit.append({ type: `tree.${verb}_failed`, task: key, tree: id, provider, summary: `tree ${id}: ${verb} failed` });
      return fail(`TREE=${id} STATE=failed STEP=${verb}`, [e.message]);
    }
  }
  return null;
}

// ── plant <KEY> [--provider p] [--base ref] ─────────────────────────────────────────────────────
export async function plant(ctx, args) {
  const { pos, opt } = flags(args);
  const key = assertKey(pos[0]);
  const id = treeId(key);
  const branch = branchFor(key);
  const handle = await ctx.gateway.create(id, { task: key, branch, base: opt.base || 'HEAD', ...(opt.provider ? { provider: opt.provider } : {}) });
  const failed = await prepare(ctx, key, id, branch, handle.provider);
  if (failed) return failed;
  await updateTask(ctx.records, key, { status: 'planted', tree: id, branch, base: handle.base_sha || null, provider: handle.provider }, ctx.now);
  await ctx.audit.append({ type: 'tree.planted', task: key, tree: id, provider: handle.provider, summary: `tree ${id} planted on ${handle.provider}` });
  return ok(`TREE=${id} STATE=${handle.state} BRANCH=${branch}`);
}

// ── attach <KEY>: where to watch the tree ───────────────────────────────────────────────────────
export async function attach(ctx, args) {
  const key = assertKey(args[0]);
  const { handle } = await taskTree(ctx, key);
  if (await ctx.gateway.supports(handle.id, 'attach')) {
    const r = await ctx.gateway.attach(handle.id);
    return ok(`TREE=${handle.id} WATCH=${r.watch || 'none'} CWD=${r.cwd || 'none'}`);
  }
  const u = await ctx.gateway.url(handle.id);
  return ok(`TREE=${handle.id} WATCH=${u.url || handle.url || 'none'}`);
}

// ── brief <KEY> <brief.md>: validate, store, deliver ────────────────────────────────────────────
export async function brief(ctx, args) {
  const key = assertKey(args[0]);
  const file = args[1];
  if (!file || !existsSync(file)) return fail(`BRIEF=missing PATH=${file || 'none'}`);
  const problems = await validateFile(file);
  if (problems.length) return fail(`BRIEF=invalid PROBLEMS=${problems.length}`, problems);
  const { handle } = await taskTree(ctx, key);
  const dir = await taskDir(ctx.records, key);
  const stored = join(dir, 'brief.md');
  if (file !== stored) await cp(file, stored);
  await ctx.gateway.brief(handle.id, stored);
  await updateTask(ctx.records, key, { status: 'building' }, ctx.now);
  await ctx.audit.append({ type: 'tree.briefed', task: key, tree: handle.id, summary: 'brief delivered' });
  return ok(`TREE=${handle.id} BRIEF=delivered`);
}

// ── poll <KEY>: state plus the effect on the remote and GitHub ──────────────────────────────────
export async function poll(ctx, args) {
  const key = assertKey(args[0]);
  const { task, handle } = await taskTree(ctx, key);
  const st = (await ctx.gateway.supports(handle.id, 'poll')) ? await ctx.gateway.poll(handle.id) : await ctx.gateway.status(handle.id);
  const state = st.state || handle.state;
  const sha = await ctx.github.remoteBranch(ctx.repo, task.branch);
  const commits = sha && task.base ? await ctx.github.commitsAhead(ctx.repo, task.base, task.branch) : 0;
  const pr = sha ? await ctx.github.prForBranch(ctx.repo, task.branch) : null;
  const checks = pr ? await ctx.github.prChecks(ctx.repo, pr.number) : { ci: 'none', checks: [] };
  const done = !!(sha && commits > 0 && pr && pr.headRefOid === sha);
  const effect = { state, agent: st.agent || null, remote_sha: sha, commits, pr, ci: checks.ci, checks: checks.checks, done, at: ctx.now() };
  const dir = await taskDir(ctx.records, key);
  await mkdir(join(dir, 'checks'), { recursive: true });
  await writeFile(join(dir, 'checks', 'poll.json'), `${JSON.stringify(effect, null, 2)}\n`);
  await updateTask(ctx.records, key, { tree_state: state, ...(pr ? { pr: pr.url, pr_number: pr.number } : {}), head: sha }, ctx.now);
  return ok(`TREE=${handle.id} STATE=${state}${st.agent ? ` AGENT=${st.agent}` : ''} PUSHED=${sha ? 'yes' : 'no'} COMMITS=${commits} PR=${pr ? pr.url : 'none'} CI=${checks.ci} EFFECT=${done ? 'done' : 'not-yet'}`);
}

// ── verify <KEY>: facts in, verdict out ─────────────────────────────────────────────────────────
// Agents write their facts to tasks/<KEY>/checks/: tests.json, acceptance.json, suite.json, e2e.json,
// evidence.json. This step adds diff inspection and the OKF check, then runs the gates.
export async function verify(ctx, args) {
  const key = assertKey(args[0]);
  const task = await getTask(ctx.records, key);
  const dir = await taskDir(ctx.records, key);
  const checks = join(dir, 'checks');
  const head = task.head || (await ctx.github.remoteBranch(ctx.repo, task.branch));
  const manifest = (await readJson(join(dir, 'manifest.json'))) || {};

  let diff;
  if (head && task.base) {
    diff = await inspect({ repo: ctx.repo, base: task.base, head, settings: ctx.settings, allowDependencies: manifest.allowDependencies || [] });
  }
  const okf = (await validateBundle(dir)).map((p) => `${relative(ctx.records, p.file).split(sep).join('/')}: ${p.problem}`);
  const facts = await readChecks({ dir: checks, manifest: manifest.target ? manifest : null });
  const input = { ...facts.input, diff, okf, invalid: facts.invalid, skipped: task.skipped || [] };
  const v = verdict(input);
  await mkdir(checks, { recursive: true });
  await writeFile(join(checks, 'verify.json'), `${JSON.stringify({ head, input, notes: facts.notes, ...v }, null, 2)}\n`);
  await writeOkf(
    join(checks, 'verify.md'),
    {
      type: 'Verification',
      title: `${key} · ${v.verdict}`,
      description: `Gates verdict for ${key} at ${head ? head.slice(0, 12) : 'no head'}.`,
      tags: ['verification', v.verdict.toLowerCase()],
      body: [`# ${key} · ${v.verdict}`, '', `Head: \`${head || 'none'}\``, '', '| Gate | Level | Detail |', '|---|---|---|', ...v.reasons.map((r) => `| ${r.gate} | ${r.level} | ${r.detail.replaceAll('|', '/')} |`), v.reasons.length ? '' : 'All gates passed.', ...(facts.notes.length ? ['', ...facts.notes.map((n) => `- ${n}`)] : [])].join('\n'),
    },
    ctx.now,
  );
  const status = v.verdict === 'ESCALATE' ? 'escalated' : 'verified';
  await updateTask(ctx.records, key, { status, verdict: v.verdict, verified_head: head }, ctx.now);
  await ctx.audit.append({ type: 'gates.verdict', task: key, head, verdict: v.verdict, reasons: v.reasons.length, summary: `verdict ${v.verdict}` });
  return { line: `${resultLine(v)} CHECKS=${relative(ctx.records, join(checks, 'verify.md')).split(sep).join('/')}`, code: v.verdict === 'ESCALATE' ? 1 : 0 };
}

// ── evidence <KEY>: pull what the tree recorded ─────────────────────────────────────────────────
export async function evidence(ctx, args) {
  const key = assertKey(args[0]);
  const task = await getTask(ctx.records, key);
  const handle = task.tree ? await ctx.gateway.get(task.tree).catch(() => null) : null;
  if (handle && (await ctx.gateway.supports(handle.id, 'evidence'))) await ctx.gateway.evidence(handle.id, key);
  const head = task.head || (task.branch ? await ctx.github.remoteBranch(ctx.repo, task.branch) : null);
  const pack = await buildPack({ records: ctx.records, key, repo: ctx.repo, base: task.base, head });
  const dir = join(ctx.records, 'tasks', key, 'evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  await writeFile(join(dir, 'evidence-report.md'), renderMarkdown(pack, { title: task.title || key, verdict: task.verdict || null, now: ctx.now }));
  await writeFile(join(dir, 'evidence-report.html'), renderHtml(pack, { title: task.title || key, verdict: task.verdict || null }));
  const missing = ITEMS.filter((i) => pack.status[i] === 'missing');
  await ctx.audit.append({ type: 'evidence.pack', task: key, head, present: pack.present, missing, summary: `evidence pack ${pack.present}/4` });
  return { line: `PACK=tasks/${key}/evidence/evidence-report.md ITEMS=${pack.present}/4 MISSING=${missing.length ? missing.join(',') : 'none'}`, code: missing.length ? 1 : 0 };
}

// ── merge <KEY> [--approved-by name]: only a verified head, one at a time ───────────────────────
export async function merge(ctx, args) {
  const { pos, opt } = flags(args);
  const key = assertKey(pos[0]);
  const task = await getTask(ctx.records, key);
  const v = await readJson(join(ctx.records, 'tasks', key, 'checks', 'verify.json'));
  if (!v) return fail(`MERGED=no REASON="not verified; run padakan verify ${key}"`);
  if (v.verdict === 'ESCALATE') return fail('MERGED=no REASON="verdict is ESCALATE"');
  if (v.verdict === 'HUMAN_MERGE' && !opt['approved-by']) return fail('MERGED=no REASON="verdict is HUMAN_MERGE; needs --approved-by <name>"');
  const pr = await ctx.github.prForBranch(ctx.repo, task.branch);
  if (!pr) return fail('MERGED=no REASON="no pull request"');
  if (pr.headRefOid !== v.head) return fail('MERGED=no REASON="the PR changed after verification; verify again"');
  await ctx.github.mergePr(ctx.repo, pr.number);
  await updateTask(ctx.records, key, { status: 'merged', merged_head: v.head, ...(opt['approved-by'] ? { approved_by: opt['approved-by'] } : {}) }, ctx.now);
  await ctx.audit.append({ type: 'pr.merge', task: key, head: v.head, pr: pr.url, verdict: v.verdict, approved_by: opt['approved-by'] || null, summary: `merged ${pr.url}` });
  return ok(`MERGED=yes PR=${pr.url} HEAD=${v.head.slice(0, 12)}`);
}

// ── deploy <KEY>: behind a flag, then a canary; rolls back by itself when the SLO slips ─────────
export async function deploy(ctx, args) {
  const key = assertKey(args[0]);
  const task = await getTask(ctx.records, key);
  if (task.status !== 'merged') return fail(`DEPLOY=no REASON="task is ${task.status}; only a merged change is deployed"`);
  const adapter = ctx.deployAdapter || adapterFor(ctx.settings, { records: ctx.records });
  const release = { task: key, head: task.merged_head };
  const r = await gatedDeploy({ adapter, release, settings: ctx.settings, ...(ctx.deployOptions || {}) });
  const dir = await taskDir(ctx.records, key);
  await writeFile(join(dir, 'deploy.json'), `${JSON.stringify({ target: adapter.name, release, ...r, at: ctx.now() }, null, 2)}\n`);
  const last = r.windows.at(-1)?.error_rate ?? 'none';
  if (r.outcome === 'rolled-back') {
    await updateTask(ctx.records, key, { status: 'escalated', deploy: 'rolled-back', escalation: r.reason }, ctx.now);
    await ctx.audit.append({ type: 'deploy.rollback', task: key, head: release.head, target: adapter.name, reason: r.reason, summary: `deploy rolled back: ${r.reason}` });
    return fail(`DEPLOY=rolled-back TARGET=${adapter.name} CANARY=${r.percent}% ERROR_RATE=${last} ESCALATED=yes`);
  }
  await updateTask(ctx.records, key, { status: 'done', deploy: 'promoted' }, ctx.now);
  await ctx.audit.append({ type: 'deploy.promote', task: key, head: release.head, target: adapter.name, summary: `deployed ${release.head ? release.head.slice(0, 12) : ''} to everyone` });
  return ok(`DEPLOY=promoted TARGET=${adapter.name} CANARY=${r.percent}% ERROR_RATE=${last}`);
}

// ── rollback <KEY>: the human's right to undo at any time ───────────────────────────────────────
export async function rollback(ctx, args) {
  const key = assertKey(args[0]);
  const task = await getTask(ctx.records, key);
  const adapter = ctx.deployAdapter || adapterFor(ctx.settings, { records: ctx.records });
  await adapter.rollback({ task: key, head: task.merged_head }, 'rolled back by a human');
  await updateTask(ctx.records, key, { status: 'escalated', deploy: 'rolled-back', escalation: 'rolled back by a human' }, ctx.now);
  await ctx.audit.append({ type: 'deploy.rollback', task: key, by: 'human', summary: 'rolled back by a human' });
  return ok(`ROLLBACK=done TARGET=${adapter.name}`);
}

// ── retire <KEY>: pull the record, end the tree ─────────────────────────────────────────────────
export async function retire(ctx, args) {
  const key = assertKey(args[0]);
  const { handle } = await taskTree(ctx, key);
  const r = await ctx.gateway.retire(handle.id, key);
  await updateTask(ctx.records, key, { status: 'retired', tree_state: r.destroyed ? 'gone' : handle.state }, ctx.now);
  await ctx.audit.append({ type: 'tree.retired', task: key, tree: handle.id, record: r.record || null, summary: `tree ${handle.id} retired` });
  // RECORD=missing: the building agent left no .padakan/record.md to pull back.
  return ok(`TREE=${handle.id} RECORD=${r.record || 'missing'} DESTROYED=${r.destroyed ? 'yes' : 'no'}`);
}

// ── recycle <KEY>: a wedged tree is replaced, never nursed. The remote branch is the asset. ─────
// Order matters: nothing is destroyed until the new tree is known to be creatable, and work that is
// only in the old tree (uncommitted or unpushed) is never discarded without --force.
export async function recycle(ctx, args) {
  const { pos, opt } = flags(args);
  const key = assertKey(pos[0]);
  const { task, handle } = await taskTree(ctx, key);
  const sha = await ctx.github.remoteBranch(ctx.repo, task.branch);
  if (!sha) return fail(`RECYCLED=no REASON="branch ${task.branch} is not on the remote; nothing to recover from"`);
  try {
    await ctx.gateway.preflight(handle.provider, { repo: ctx.repo, base: sha });
  } catch (e) {
    return fail(`RECYCLED=no REASON=${JSON.stringify(e.message)}`, ['the old tree was left as it is']);
  }
  try {
    await ctx.gateway.destroy(handle.id, { force: opt.force === true });
  } catch (e) {
    if (e.code !== 'UNSAVED_WORK') throw e;
    return fail(`RECYCLED=no REASON=${JSON.stringify(`${e.message}; commit and push it, or recycle ${key} --force to discard it`)}`);
  }
  await ctx.audit.append({ type: 'tree.destroyed', task: key, tree: handle.id, forced: opt.force === true, summary: `tree ${handle.id} destroyed to be recycled` });
  let fresh;
  try {
    fresh = await ctx.gateway.create(handle.id, { task: key, branch: task.branch, base: sha, provider: handle.provider });
  } catch (e) {
    await updateTask(ctx.records, key, { status: 'plant-failed', tree_state: 'gone' }, ctx.now);
    await ctx.audit.append({ type: 'tree.recycle_failed', task: key, tree: handle.id, summary: `recycling ${handle.id} failed after the old tree was destroyed` });
    return fail(`RECYCLED=no TREE=gone REASON=${JSON.stringify(e.message)}`, [`the branch ${task.branch} is safe on the remote; padakan plant ${key} recreates the tree from it`]);
  }
  const failed = await prepare(ctx, key, handle.id, task.branch, handle.provider);
  if (failed) return failed;
  await ctx.audit.append({ type: 'tree.recycled', task: key, tree: handle.id, from: sha, summary: `tree ${handle.id} recycled from ${sha.slice(0, 12)}` });
  return ok(`TREE=${fresh.id} RECYCLED=yes FROM=${sha.slice(0, 12)}`);
}

// ── audit [KEY]: verify the signed trail, or replay one task ────────────────────────────────────
export async function audit(ctx, args) {
  const r = await ctx.audit.verify();
  const lines = [];
  if (args[0]) for (const e of await ctx.audit.replay({ task: assertKey(args[0]) })) lines.push(`${e.seq}\t${e.ts}\t${e.event.type}\t${e.event.summary || ''}`);
  if (!r.ok) return fail(`AUDIT=broken LINE=${r.broken.line} REASON=${JSON.stringify(r.broken.reason)}`, lines);
  return ok(`AUDIT=ok ENTRIES=${r.count}`, lines);
}

// ── gate open|close: the plan gate is the only window in which the human may be asked ───────────
export async function gate(ctx, args) {
  const action = args[0];
  if (!['open', 'close'].includes(action)) return fail('GATE=unchanged REASON="use: padakan gate open|close"');
  await updateState(ctx.records, (s) => {
    s.gate = action === 'open' ? 'plan' : null;
  });
  await ctx.audit.append({ type: `gate.${action}`, summary: `plan gate ${action === 'open' ? 'opened' : 'closed'}` });
  return ok(`GATE=${action === 'open' ? 'plan' : 'closed'}`);
}

// ── pause <KEY|all>: the kill switch. Stops spending where the provider can, and stops every step. ──
export async function pause(ctx, args) {
  const target = args[0];
  if (!target) return fail('PAUSED=0 REASON="use: padakan pause <KEY|all>"');
  const s = await readState(ctx.records);
  const keys = target === 'all' ? Object.keys(s.tasks || {}).filter((k) => !['merged', 'retired', 'done', 'paused'].includes(s.tasks[k].status)) : [assertKey(target)];
  let stopped = 0;
  for (const key of keys) {
    const t = s.tasks?.[key];
    if (!t) return fail(`PAUSED=0 REASON="no task ${key}"`);
    if (t.tree && (await ctx.gateway.list()).some((h) => h.id === t.tree) && (await ctx.gateway.supports(t.tree, 'pause'))) {
      await ctx.gateway.pause(t.tree);
      stopped++;
    }
    await updateTask(ctx.records, key, { status: 'paused', paused_from: t.status }, ctx.now);
    await ctx.audit.append({ type: 'task.paused', task: key, summary: 'paused by the kill switch' });
  }
  return ok(`PAUSED=${keys.length} TREES_STOPPED=${stopped}`);
}

// ── tick: one monitor tick. Collect, cluster, triage, dedupe, open tasks, list escalations. ────────
export async function tick(ctx, args) {
  const state = await readState(ctx.records);
  const now = ctx.now();
  const id = now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const since = state.monitor?.last_tick || new Date(Date.parse(now) - ctx.settings.PADAKAN_WATCH_INTERVAL_MIN * 60_000).toISOString();
  const collected = await collect({ sources: ctx.settings.PADAKAN_LOG_SOURCES, since, ...(ctx.collectOptions || {}) });
  const { items, usage } = await triage({ clusters: collected.clusters, client: collected.clusters.length ? ctx.models() : null, model: ctx.settings.PADAKAN_TRIAGE_MODEL, now: ctx.now });

  const openByFp = new Map(
    Object.entries(state.tasks || {})
      .filter(([, t]) => t.fingerprint && !['merged', 'retired', 'done'].includes(t.status))
      .map(([k, t]) => [t.fingerprint, k]),
  );
  const opened = [];
  const human = [];
  let dropped = 0;
  for (const item of items) {
    if (openByFp.has(item.fingerprint)) {
      item.duplicate_of = openByFp.get(item.fingerprint);
      continue;
    }
    if (item.route === 'task' || item.route === 'task-escalate') {
      const key = `MON-${item.fingerprint.slice(0, 8)}`;
      opened.push(key);
      await updateTask(ctx.records, key, {
        status: item.route === 'task' ? 'planned' : 'escalated',
        source: 'monitor',
        fingerprint: item.fingerprint,
        title: item.summary,
        severity: item.severity,
        category: item.category,
      }, ctx.now);
    } else if (item.route === 'human') human.push(item);
    else if (item.route === 'drop') dropped++;
  }

  const dir = join(ctx.records, 'monitor', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'clusters.json'), `${JSON.stringify(collected, null, 2)}\n`);
  await writeFile(join(dir, 'triage.json'), `${JSON.stringify({ items, usage }, null, 2)}\n`);
  const rows = items.map((i) => `| \`${i.fingerprint}\` | ${i.count} | ${i.category} | ${i.severity} | ${i.route}${i.duplicate_of ? ` (open: ${i.duplicate_of})` : ''} | ${String(i.summary).replaceAll('|', '/')} |`);
  await writeOkf(
    join(dir, 'report.md'),
    {
      type: 'Monitor Report',
      title: `Monitor tick ${id}`,
      description: `${items.length} clusters since ${since}: ${opened.length} new tasks, ${human.length} for a human, ${dropped} dropped.`,
      tags: ['monitor', 'triage'],
      body: [
        `# Monitor tick ${id}`,
        '',
        `Since ${since}. Events: ${collected.events}. Sources with errors: ${collected.errors.length}.`,
        '',
        '| Fingerprint | Count | Category | Severity | Route | Summary |',
        '|---|---|---|---|---|---|',
        ...rows,
        '',
        opened.length ? `New tasks: ${opened.join(', ')}.` : 'No new tasks.',
        human.length ? `For a human: ${human.map((h) => `\`${h.fingerprint}\` (${h.category}${h.reasons.length ? `, ${h.reasons.join('; ')}` : ''})`).join(', ')}.` : '',
        ...collected.errors.map((e) => `- Source ${e.source} failed: ${e.error}`),
      ].join('\n'),
    },
    ctx.now,
  );
  await updateState(ctx.records, (st) => {
    st.monitor = { ...(st.monitor || {}), last_tick: now };
  });
  await ctx.audit.append({ type: 'monitor.tick', tick: id, clusters: items.length, opened, human: human.length, summary: `monitor tick: ${items.length} clusters, ${opened.length} new tasks, ${human.length} for a human` });
  return ok(`CLUSTERS=${items.length} FIXABLE=${opened.length ? opened.join(',') : 'none'} HUMAN=${human.length} DROPPED=${dropped} REPORT=monitor/${id}/report.md${collected.errors.length ? ` SOURCE_ERRORS=${collected.errors.length}` : ''}`);
}

// ── status / ls: read-only views ────────────────────────────────────────────────────────────────
export async function status(ctx) {
  const s = await readState(ctx.records);
  const tasks = Object.entries(s.tasks || {});
  const open = tasks.filter(([, t]) => !['merged', 'retired', 'done'].includes(t.status));
  const details = tasks.map(([k, t]) => `${k}\t${t.status}\t${t.tree || '-'}\t${t.verdict || '-'}\t${t.pr || '-'}`);
  return ok(`TASKS=${tasks.length} OPEN=${open.length} GATE=${s.gate || 'closed'}`, details);
}

export async function ls(ctx) {
  const handles = await ctx.gateway.list();
  return ok(`TREES=${handles.length}`, handles.map((h) => `${h.id}\t${h.provider}\t${h.state}\t${h.task || '-'}\t${h.url || h.path || '-'}`));
}

export const STEPS = { init, gate, pause, resolve, tick, deploy, rollback, plant, attach, brief, poll, verify, evidence, merge, retire, recycle, status, ls, audit, ...DECISION_STEPS };

// Arguments per step, for usage lines. A step whose usage starts with <KEY> needs a task key.
export const USAGE = {
  init: '', doctor: '', status: '', ls: '', tick: '', audit: '[KEY]',
  gate: 'open|close', pause: '<KEY|all>',
  resolve: '<KEY>', plant: '<KEY> [--provider p] [--base ref]', attach: '<KEY>', brief: '<KEY> <brief.md>', poll: '<KEY>',
  verify: '<KEY>', evidence: '<KEY>', merge: '<KEY> [--approved-by name]', retire: '<KEY>', recycle: '<KEY> [--force]',
  deploy: '<KEY>', rollback: '<KEY>',
};
