// The Devin sandbox provider (IMPLEMENTATION-DEVIN-COSTGATE.md part A).
//
// One Devin session per tree, driven only through the Devin API v3. Devin is the agent: there is
// no shell, no file push and no herdr, so the shell verbs are not declared.
//
// Never trust the report: a session that says it finished counts as done only when its structured
// output validates, a PR exists and the PR's head commit is on the remote.
// Providers never write handles or the cost ledger: verbs return `handle` updates for the gateway
// and `ledger_entries` for the orchestrator to append.
//
// The default export surface uses the real client, gh and git. Tests build one with makeProvider().

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, relative } from 'node:path';
import { createClient as defaultCreateClient, DevinError } from './client.mjs';
import { mapStatus, verifyDone, doneCandidateExpired, REPORT_SCHEMA, DONE_CANDIDATE } from './state.mjs';
import { answer, onceThenEscalate, REPLIES } from './answers.mjs';
import { renderPrompt, renderContinuation, renderRetireMessage, renderBriefMessage, branchFor } from './prompt.mjs';
import { gate, sessionCap, loadPrices, budgetsFromEnv, spendTick } from '../../core/cost.mjs';
import { SandboxError } from '../contract.mjs';

export const name = 'devin';
export const capabilities = ['create', 'brief', 'status', 'poll', 'message', 'pause', 'resume',
  'raiseBudget', 'evidence', 'retire', 'destroy', 'url', 'spend'];

export const RECORD_SECTIONS = ['what_changed', 'files', 'architecture', 'seams', 'next_step', 'misreadings', 'open'];
const SECTION_TITLES = {
  what_changed: 'What changed', files: 'Files', architecture: 'Architecture', seams: 'Seams',
  next_step: 'Next step', misreadings: 'What a reader will get wrong', open: 'What is still open',
};
const VIDEO_RE = /\.(mp4|webm|mov)$/i;
const PRICES_FILE = new URL('../../registry/prices.yml', import.meta.url);

export class CostGateError extends SandboxError {
  constructor(result) {
    super(`cost gate paused the Devin session: ${result.reason}`, { code: 'COST_GATE' });
    this.gate = result;
  }
}

// ── Real effects: git and gh on the orchestrator's machine ─────────────────────────────────────
const run = promisify(execFile);
const sh = async (cmd, args, opts = {}) => (await run(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout.trim();

export const realEffects = {
  // owner/repo from the repo's origin remote
  async repoSlug(repoPath) {
    const url = await sh('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
    if (!m) throw new SandboxError(`origin is not a GitHub repository: ${url}`, { code: 'NO_GITHUB_REMOTE' });
    return m[1];
  },
  // Full SHA of the base; it must already be on a remote so the work can always be recovered.
  async baseSha(repoPath, base) {
    const sha = await sh('git', ['rev-parse', '--verify', `${base}^{commit}`], { cwd: repoPath }).catch(() => null);
    if (!sha) throw new SandboxError(`base "${base}" is not a commit in ${repoPath}`, { code: 'BAD_BASE' });
    const onRemote = await sh('git', ['branch', '-r', '--contains', sha], { cwd: repoPath }).catch(() => '');
    if (!onRemote) throw new SandboxError(`base ${sha.slice(0, 12)} is not on any remote; push it first`, { code: 'UNPUSHED_BASE' });
    return sha;
  },
  // The PR's head commit, and whether GitHub has that commit.
  async prHead(prUrl) {
    const view = JSON.parse(await sh('gh', ['pr', 'view', prUrl, '--json', 'headRefOid,state,statusCheckRollup']));
    const slug = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1];
    const onRemote = slug && view.headRefOid
      ? await sh('gh', ['api', `repos/${slug}/commits/${view.headRefOid}`, '--silent']).then(() => true, () => false)
      : false;
    return { headSha: view.headRefOid ?? null, state: view.state ?? null, checks: view.statusCheckRollup ?? [], onRemote };
  },
};

// ── Provider factory ───────────────────────────────────────────────────────────────────────────
export function makeProvider({
  createClient = defaultCreateClient,
  effects = realEffects,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clientOptions = {},
  pricesYaml,
} = {}) {
  const clients = new WeakMap();
  const clientFor = (settings) => {
    if (!clients.has(settings)) {
      clients.set(settings, createClient({ apiUrl: settings.DEVIN_API_URL, apiKey: settings.DEVIN_API_KEY, orgId: settings.DEVIN_ORG_ID, ...clientOptions }));
    }
    return clients.get(settings);
  };
  const iso = () => new Date(now()).toISOString();
  const prices = async (settings) =>
    loadPrices({ yamlText: pricesYaml ?? (await readFile(PRICES_FILE, 'utf8').catch(() => '')), env: settings });

  // The cost gate and the session cap, before anything is spent. Throws CostGateError on pause.
  async function capFor(settings, item, { ledger = [], run, task }) {
    if (!item) throw new SandboxError('Devin create needs the session estimate (opts.estimate) for the cost gate', { code: 'NO_ESTIMATE' });
    const p = await prices(settings);
    const budgets = budgetsFromEnv(settings);
    const scope = { run, task };
    const g = gate({ item, ledger, budgets, prices: p, scope });
    if (g.decision !== 'run') throw new CostGateError(g);
    const cap = sessionCap({ item, ledger, budgets, prices: p, scope, hardMax: settings.DEVIN_MAX_ACU });
    if (cap.decision !== 'run') throw new CostGateError({ ...g, decision: 'pause', reason: cap.reason, max_acu_limit: cap.max_acu_limit });
    return cap.max_acu_limit;
  }

  function sessionBody(settings, { prompt, title, repo, platform, tags, maxAcu, secretIds, attachmentUrls }) {
    const body = {
      prompt,
      title,
      repos: [repo],
      platform,
      tags,
      bypass_approval: settings.DEVIN_BYPASS_APPROVAL !== false,
      resumable: true,
      structured_output_schema: REPORT_SCHEMA,
      structured_output_required: true,
    };
    if (maxAcu != null) body.max_acu_limit = maxAcu;
    if (settings.DEVIN_PLAYBOOK_ID) body.playbook_id = settings.DEVIN_PLAYBOOK_ID;
    if (settings.DEVIN_MODE) body.devin_mode = settings.DEVIN_MODE;
    if (secretIds?.length) body.secret_ids = secretIds;
    if (attachmentUrls?.length) body.attachment_urls = attachmentUrls;
    return body;
  }

  async function upload(settings, briefPath) {
    const content = await readFile(briefPath);
    return clientFor(settings).uploadAttachment({ name: basename(briefPath), content, type: 'text/markdown' });
  }

  async function getOrGone(settings, id) {
    try {
      return await clientFor(settings).getSession(id);
    } catch (e) {
      if (e instanceof DevinError && e.status === 404) return null;
      throw e;
    }
  }

  // Effect on GitHub for the session's PRs: done needs every PR's head on the remote.
  async function effectOf(session) {
    const prs = session.pull_requests ?? [];
    if (!prs.length) return { headOnRemote: false, prs: [] };
    const heads = await Promise.all(prs.map((p) => effects.prHead(p.pr_url).catch((e) => ({ error: e.message, onRemote: false }))));
    return { headOnRemote: heads.every((h) => h.onRemote), prs: heads.map((h, i) => ({ pr_url: prs[i].pr_url, ...h })) };
  }

  // ── Verbs ────────────────────────────────────────────────────────────────────────────────────

  // create(ctx, id, { task, brief, estimate, ledger, run, repo, base, title, manifest })
  async function create(ctx, id, opts = {}) {
    const { settings } = ctx;
    const { task, brief: briefPath, estimate, ledger, run = 'run', base = 'main', manifest = {} } = opts;
    if (!task) throw new SandboxError('Devin create needs the task key', { code: 'NO_TASK' });
    if (!briefPath) throw new SandboxError('Devin create needs the brief path', { code: 'NO_BRIEF' });

    const maxAcu = await capFor(settings, estimate, { ledger, run, task });
    const repo = opts.repo && /^[^/\\]+\/[^/\\]+$/.test(opts.repo) ? opts.repo : await effects.repoSlug(ctx.repo);
    const baseSha = await effects.baseSha(ctx.repo, base);
    const branch = branchFor(task);
    const platform = manifest.platform || settings.DEVIN_PLATFORM;
    const tags = ['padakan', `task:${task}`, `run:${run}`];
    const secretIds = (manifest.secrets ?? []).map((s) => s.id).filter(Boolean);
    const att = await upload(settings, briefPath);
    const prompt = renderPrompt({ task, repo, briefName: att.name, base, protectedPaths: settings.PADAKAN_PROTECTED_PATHS ?? [] });
    const title = opts.title ? `${task} · ${opts.title}` : task;

    const session = await clientFor(settings).createSession(
      sessionBody(settings, { prompt, title, repo, platform, tags, maxAcu, secretIds, attachmentUrls: [att.url] }),
    );
    return {
      state: mapStatus(session).state === DONE_CANDIDATE ? 'working' : mapStatus(session).state,
      task, session_id: session.session_id, url: session.url, repo, branch, base, base_sha: baseSha, platform, title, tags,
      ...(maxAcu != null ? { max_acu_limit: maxAcu } : {}),
      brief_name: att.name, brief_url: att.url, secret_ids: secretIds, secret_names: (manifest.secrets ?? []).map((s) => s.name).filter(Boolean),
      acus_last: 0, acus_previous: 0, previous_session_ids: [], questions_answered: 0, message_cursor: null,
    };
  }

  // brief(ctx, handle, briefPath): a new or updated brief for a running session.
  async function brief(ctx, handle, briefPath) {
    const att = await upload(ctx.settings, briefPath);
    await clientFor(ctx.settings).sendMessage(handle.session_id, renderBriefMessage({ task: handle.task, briefName: att.name }), { attachmentUrls: [att.url] });
    return { ok: true, handle: { brief_name: att.name, brief_url: att.url } };
  }

  // status(ctx, handle): the tree state; `done` only after the effect is verified.
  async function status(ctx, handle) {
    const session = await getOrGone(ctx.settings, handle.session_id);
    if (!session) return { state: 'gone', handle: { state: 'gone' } };
    const m = mapStatus(session);
    if (m.state !== DONE_CANDIDATE) return { state: m.state, action: m.action, reason: m.reason, handle: { state: m.state } };
    const v = verifyDone(session, await effectOf(session));
    const state = v.done ? 'done' : 'working';
    return { state, action: v.done ? 'none' : 'verify-effect', missing: v.missing, handle: { state } };
  }

  // poll(ctx, handle, { ledger, run, step }): one poll tick (A.5).
  async function poll(ctx, handle, { ledger = [], run = 'run', step = 'devin-session' } = {}) {
    const { settings } = ctx;
    const client = clientFor(settings);
    const session = await getOrGone(settings, handle.session_id);
    if (!session) return { state: 'gone', handle: { state: 'gone' } };

    const m = mapStatus(session);
    const out = { state: m.state, action: m.action, reason: m.reason, report: session.structured_output ?? null, prs: session.pull_requests ?? [] };
    const upd = { acus_last: session.acus_consumed ?? 0 };

    // 3. spend: ledger lines for the orchestrator to append
    const usdPerAcu = settings.PADAKAN_DEVIN_USD_PER_ACU;
    out.acus = (handle.acus_previous ?? 0) + (session.acus_consumed ?? 0);
    out.ledger_entries = usdPerAcu == null ? [] : spendTick({
      ledger, run, task: handle.task, step, session_id: handle.session_id,
      acus_consumed: session.acus_consumed ?? 0, max_acu_limit: handle.max_acu_limit, usdPerAcu, now: iso(),
    });

    // 2. questions, approvals, inactivity
    if (m.action === 'answer') {
      const page = await client.listMessages(handle.session_id, handle.message_cursor ? { after: handle.message_cursor } : {});
      const a = answer(page.items ?? [], handle, { secrets: (handle.secret_names ?? []).map((n) => ({ name: n })) });
      Object.assign(upd, a.handle, { message_cursor: page.end_cursor ?? handle.message_cursor ?? null });
      out.question = a.question;
      if (a.reply) {
        await client.sendMessage(handle.session_id, a.reply);
        out.reply = a.reply;
      } else if (a.escalate) out.escalate = a.escalate;
    } else if (m.action === 'approve-once' || m.action === 'nudge-once') {
      const o = onceThenEscalate(m.action === 'approve-once' ? 'approval' : 'inactivity', handle);
      Object.assign(upd, o.handle);
      if (o.reply) {
        await client.sendMessage(handle.session_id, o.reply);
        out.reply = o.reply;
      } else out.escalate = o.escalate;
    } else if (m.action === 'escalate' || m.action === 'recycle-once' || m.action === 'cost-gate') {
      out.escalate = m.reason;
    }

    // 4–5. the effect decides done
    if (m.state === DONE_CANDIDATE) {
      const effect = await effectOf(session);
      const v = verifyDone(session, effect);
      out.effect = effect;
      out.missing = v.missing;
      out.report_errors = v.errors;
      if (v.done) {
        out.state = 'done';
        upd.done_candidate_since = null;
      } else {
        const since = handle.done_candidate_since ?? now();
        upd.done_candidate_since = since;
        if (doneCandidateExpired(since, now())) {
          out.state = 'failed';
          out.escalate = `unverified-done:${v.missing.join(',')}`;
        } else out.state = 'working';
      }
    }
    upd.state = out.state;
    out.handle = upd;
    return out;
  }

  async function message(ctx, handle, text) {
    await clientFor(ctx.settings).sendMessage(handle.session_id, text);
    return { ok: true };
  }

  // pause: archive puts the session to sleep; a message resumes it. Used by the cost gate.
  async function pause(ctx, handle) {
    await clientFor(ctx.settings).archiveSession(handle.session_id);
    return { state: 'paused', handle: { state: 'paused' } };
  }

  async function resume(ctx, handle, text = REPLIES.nudge) {
    await clientFor(ctx.settings).sendMessage(handle.session_id, text);
    return { state: 'working', handle: { state: 'working' } };
  }

  // raiseBudget(ctx, handle, { cap_acu, decision, pr_url }): the API cannot change max_acu_limit on
  // a live session, so archive the capped one and continue in a new session on the same branch.
  async function raiseBudget(ctx, handle, { cap_acu, decision, pr_url } = {}) {
    const { settings } = ctx;
    if (!decision) throw new SandboxError('raiseBudget needs the id of an answered decision report', { code: 'NO_DECISION' });
    if (!Number.isFinite(cap_acu) || cap_acu <= 0) throw new SandboxError('raiseBudget needs a positive cap_acu', { code: 'BAD_CAP' });
    let cap = Math.max(Math.floor(cap_acu), settings.DEVIN_CONTINUATION_MIN_ACU ?? 1);
    if (settings.DEVIN_MAX_ACU) cap = Math.min(cap, settings.DEVIN_MAX_ACU);

    const client = clientFor(settings);
    const old = await getOrGone(settings, handle.session_id);
    if (old && !old.is_archived) await client.archiveSession(handle.session_id);
    const prUrl = pr_url ?? old?.pull_requests?.[0]?.pr_url ?? null;
    const prompt = renderContinuation({
      task: handle.task, prUrl, repo: handle.repo, briefName: handle.brief_name ?? 'brief.md', base: handle.base ?? 'main',
      protectedPaths: settings.PADAKAN_PROTECTED_PATHS ?? [],
    });
    const session = await client.createSession(sessionBody(settings, {
      prompt, title: handle.title ?? handle.task, repo: handle.repo, platform: handle.platform, tags: handle.tags ?? ['padakan', `task:${handle.task}`],
      maxAcu: cap, secretIds: handle.secret_ids, attachmentUrls: handle.brief_url ? [handle.brief_url] : [],
    }));
    const previous = [...(handle.previous_session_ids ?? []), handle.session_id];
    return {
      session_id: session.session_id,
      max_acu_limit: cap,
      handle: {
        session_id: session.session_id, url: session.url, max_acu_limit: cap, state: 'working',
        previous_session_ids: previous,
        acus_previous: (handle.acus_previous ?? 0) + (old?.acus_consumed ?? handle.acus_last ?? 0),
        acus_last: 0, questions_answered: 0, unknown_questions_answered: 0, approvals_sent: 0, nudges_sent: 0,
        message_cursor: null, done_candidate_since: null, last_raise_decision: decision,
      },
    };
  }

  // spend: ACUs across every session of this tree (continuations included).
  async function spend(ctx, handle) {
    const session = await getOrGone(ctx.settings, handle.session_id);
    const current = session?.acus_consumed ?? handle.acus_last ?? 0;
    return { acus: (handle.acus_previous ?? 0) + current, session_acus: current, handle: { acus_last: current } };
  }

  async function url(ctx, handle) {
    return { url: handle.url ?? null };
  }

  // evidence(ctx, handle, key): download the session's attachments (except our own brief) into
  // <records>/tasks/<key>/evidence/devin/ with a sha256 manifest. No video -> { video: null }.
  async function evidence(ctx, handle, key) {
    const client = clientFor(ctx.settings);
    const items = ((await client.listAttachments(handle.session_id)).items ?? []).filter((a) => a.name !== handle.brief_name);
    const dir = join(ctx.records, 'tasks', key, 'evidence', 'devin');
    await mkdir(dir, { recursive: true });
    const used = new Set();
    const files = [];
    for (const a of items) {
      let file = basename(String(a.name)).replace(/[^\w.\-]+/g, '_') || 'attachment';
      while (used.has(file)) file = `${file.replace(/(\.[^.]*)?$/, '')}-${used.size}${file.match(/\.[^.]*$/)?.[0] ?? ''}`;
      used.add(file);
      const dest = join(dir, file);
      await client.download(a.url, dest);
      const bytes = await readFile(dest);
      files.push({ name: file, path: relative(ctx.records, dest).split('\\').join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({ session_id: handle.session_id, files }, null, 2)}\n`);
    const videos = files.filter((f) => VIDEO_RE.test(f.name));
    const video = videos.at(-1) ?? null;
    if (video && (await stat(join(ctx.records, video.path))).size === 0) {
      throw new SandboxError(`recording ${video.name} is empty`, { code: 'EMPTY_VIDEO' });
    }
    return { video: video?.path ?? null, files: files.map((f) => f.path) };
  }

  // retire(ctx, handle, key, { timeoutMs, pollMs }): ask for the seven-section record, write it as
  // OKF record.md, then archive the session. Fewer than seven sections at the timeout is a failure.
  async function retire(ctx, handle, key, { timeoutMs = 15 * 60_000, pollMs = 15_000 } = {}) {
    const client = clientFor(ctx.settings);
    await client.sendMessage(handle.session_id, renderRetireMessage({ task: handle.task ?? key }));
    const deadline = now() + timeoutMs;
    let record = null;
    let sections = 0;
    for (;;) {
      const session = await client.getSession(handle.session_id);
      const so = session.structured_output;
      record = so?.record ?? null;
      sections = RECORD_SECTIONS.filter((s) => typeof record?.[s] === 'string' && record[s].trim()).length;
      if (sections === RECORD_SECTIONS.length) break;
      if (now() >= deadline) {
        throw new SandboxError(`retire: the record has ${sections} of ${RECORD_SECTIONS.length} sections after the timeout`, { code: 'RECORD_INCOMPLETE' });
      }
      await sleep(pollMs);
    }
    const dir = join(ctx.records, 'tasks', key);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'record.md');
    await writeFile(file, renderRecord({ key, handle, record, timestamp: iso() }));
    await client.archiveSession(handle.session_id);
    return { record: relative(ctx.records, file).split('\\').join('/'), sections, handle: { state: 'done', retired_at: iso() } };
  }

  // destroy(ctx, handle, { force }): refuse unless the PR head is on the remote, then terminate.
  async function destroy(ctx, handle, { force = false } = {}) {
    const session = await getOrGone(ctx.settings, handle.session_id);
    if (!session) return { destroyed: true };
    if (!force) {
      const effect = await effectOf(session);
      if (!effect.prs.length || !effect.headOnRemote) {
        throw new SandboxError(`refusing to destroy ${handle.id}: ${effect.prs.length ? 'the PR head is not on the remote' : 'the session has no PR'}; use force to discard`, { code: 'UNSAVED_WORK' });
      }
    }
    await clientFor(ctx.settings).terminateSession(handle.session_id);
    return { destroyed: true };
  }

  return { name, capabilities, create, brief, status, poll, message, pause, resume, raiseBudget, spend, url, evidence, retire, destroy };
}

// OKF record.md from the seven-section structured output.
export function renderRecord({ key, handle, record, timestamp }) {
  const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
  const desc = oneLine(record.what_changed).slice(0, 160).replace(/"/g, "'");
  const lines = [
    '---',
    'type: Record',
    `title: ${key} record`,
    `description: "${desc || 'Seven-section record written by the building agent.'}"`,
    'tags: [record, devin]',
    `timestamp: ${timestamp}`,
    `task: ${key}`,
    `session_id: ${handle.session_id}`,
    '---',
    '',
    `# ${key} record`,
    '',
    '> Written by the Devin session that built the task. Every statement here is a claim; the verifier re-checks it.',
  ];
  for (const s of RECORD_SECTIONS) lines.push('', `## ${SECTION_TITLES[s]}`, '', String(record[s]).trim());
  return `${lines.join('\n')}\n`;
}

const defaultProvider = makeProvider();
export const { create, brief, status, poll, message, pause, resume, raiseBudget, spend, url, evidence, retire, destroy } = defaultProvider;
