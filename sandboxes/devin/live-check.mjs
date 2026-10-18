#!/usr/bin/env node
// Live checks against a real Devin organization (IMPLEMENTATION-DEVIN-COSTGATE.md D.4).
//
//   node sandboxes/devin/live-check.mjs            read-only: token, permission, list parameters (free)
//   node sandboxes/devin/live-check.mjs --spend    also creates small sessions (spends ACUs, capped)
//
// Settings come from the usual .env files (exported env, then <records>/.env, then the plugin .env).
// Prints one line per check and a JSON summary to paste into documentation/infrastructure/DEVIN.md.
// Never prints the token. Every session it creates is tagged padakan-live-check, capped at
// --cap ACU (default 1, at most 3) and terminated at the end, whatever happens.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';
import { createClient, redact } from './client.mjs';
import { doctor } from './doctor.mjs';
import { REPORT_SCHEMA } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const SPEND = args.includes('--spend');
const CAP = Math.min(3, Math.max(1, Number(args[args.indexOf('--cap') + 1]) || 1));
const POLL_MS = 15_000;
const WAIT_MS = Number(args[args.indexOf('--wait-min') + 1] || 12) * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pluginEnv = join(ROOT, '.env');
const settings = loadSettings({ exported: process.env, pluginEnvFile: existsSync(pluginEnv) ? pluginEnv : undefined });
const secret = [settings.DEVIN_API_KEY].filter(Boolean);
const out = (s) => console.log(redact(s, secret));
const summary = { ran_at: new Date().toISOString(), spend: SPEND, cap_acu: CAP, checks: {} };
const note = (k, v) => {
  summary.checks[k] = v;
  out(`CHECK ${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
};

for (const r of await doctor({ settings })) out(`DOCTOR ${r.ok ? 'ok' : r.level || 'fail'} ${r.name}: ${r.detail}`);
if (!settings.DEVIN_API_KEY || !settings.DEVIN_ORG_ID) {
  out('STOP: DEVIN_API_KEY and DEVIN_ORG_ID are needed');
  process.exit(1);
}
const c = createClient({ apiUrl: settings.DEVIN_API_URL, apiKey: settings.DEVIN_API_KEY, orgId: settings.DEVIN_ORG_ID });

// ── Free: list parameters and response shapes (pending item: GET /sessions query parameters) ──
const page = await c.listSessions({ first: 1 });
note('list.first', { accepted: true, keys: Object.keys(page ?? {}), items: page?.items?.length ?? null });
try {
  const tagged = await c.listSessions({ tags: ['padakan-live-check'], first: 5 });
  note('list.tags_repeated', { accepted: true, items: tagged?.items?.length ?? null });
} catch (e) {
  note('list.tags_repeated', { accepted: false, error: e.message });
}
if (page?.items?.[0]) note('session.keys', Object.keys(page.items[0]).sort());

if (!SPEND) {
  out('\nRead-only checks done. Run with --spend to create capped test sessions (D.4 items 1-6).');
  out(`SUMMARY ${JSON.stringify(summary)}`);
  process.exit(0);
}

// ── Spending: small sessions, always terminated ──────────────────────────────────────────────
const created = [];
const tags = ['padakan-live-check'];
const prompt = (n) =>
  `Padakan live check ${n}. Do not change any repository. Reply with a one-line greeting, then call ` +
  'structured output with task "PAD-1", pr_url "", branch "", acs [], evidence [], blocked "live check". ' +
  'Then wait.';
async function start(n, extra = {}) {
  const s = await c.createSession({ prompt: prompt(n), title: `padakan live check ${n}`, tags, max_acu_limit: CAP, bypass_approval: true, resumable: true, structured_output_schema: REPORT_SCHEMA, structured_output_required: true, ...extra });
  created.push(s.session_id);
  return s;
}
async function waitFor(id, pred, label) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < WAIT_MS) {
    s = await c.getSession(id);
    if (pred(s)) return s;
    await sleep(POLL_MS);
  }
  out(`WAIT ${label}: timed out after ${WAIT_MS / 60000} min (last status ${s?.status}/${s?.status_detail})`);
  return s;
}

try {
  // 1 + 6: structured output, and two sessions in parallel
  const [a, b] = await Promise.all([start('A'), start('B')]);
  note('parallel.created', { a: a.session_id, b: b.session_id });
  const done = (s) => s.structured_output || ['exit', 'error', 'suspended'].includes(s.status) || s.status_detail === 'finished' || s.status_detail === 'waiting_for_user';
  const [sa, sb] = await Promise.all([waitFor(a.session_id, done, 'A'), waitFor(b.session_id, done, 'B')]);
  note('structured_output.arrives', { a: !!sa?.structured_output, b: !!sb?.structured_output, sample_keys: Object.keys(sa?.structured_output ?? {}) });
  note('parallel.both_ran', { a: `${sa?.status}/${sa?.status_detail}`, b: `${sb?.status}/${sb?.status_detail}`, acus: [sa?.acus_consumed, sb?.acus_consumed] });

  // 5: archive, then a message resumes it with its state
  await c.archiveSession(a.session_id);
  const archived = await c.getSession(a.session_id);
  await c.sendMessage(a.session_id, 'Still there? Reply with one word.');
  const resumed = await waitFor(a.session_id, (s) => s.status === 'running' || s.status === 'resuming', 'resume');
  note('archive_then_message', { after_archive: `${archived.status}/${archived.status_detail}`, is_archived: archived.is_archived, after_message: `${resumed?.status}/${resumed?.status_detail}` });

  // messages: field names on a real session (pending item: POST /messages body)
  const msgs = await c.listMessages(a.session_id);
  note('messages.shape', { keys: Object.keys(msgs ?? {}), item_keys: Object.keys(msgs?.items?.[0] ?? {}), sources: [...new Set((msgs?.items ?? []).map((m) => m.source))] });

  // 2: what status_detail appears at the ACU cap (B keeps working until the cap)
  await c.sendMessage(b.session_id, 'Count slowly from 1 to 100000, one number per message, until you are stopped.');
  const capped = await waitFor(b.session_id, (s) => s.status === 'suspended' || s.status === 'exit' || s.status === 'error', 'cap');
  note('cap_hit', { status: capped?.status, status_detail: capped?.status_detail, acus_consumed: capped?.acus_consumed, max_acu_limit: CAP });

  // 4: attachments on a session (the testing-mode video name needs a real PR; this records the shape)
  const atts = await c.listAttachments(b.session_id);
  note('attachments.shape', { keys: Object.keys(atts ?? {}), names: (atts?.items ?? []).map((x) => x.name) });
} catch (e) {
  out(`ERROR ${e.message}`);
  summary.error = redact(e.message, secret);
} finally {
  for (const id of created) {
    try {
      await c.terminateSession(id, { archive: true });
      out(`CLEANUP terminated ${id}`);
    } catch (e) {
      out(`CLEANUP failed for ${id}: ${e.message} (terminate it in the Devin web app)`);
    }
  }
}
out(`\nSUMMARY ${JSON.stringify(summary)}`);
