// Onboarding checks for the Daytona provider. Loaded by orchestrator/doctor.mjs when
// PADAKAN_SANDBOX_PROVIDER=daytona. Returns [{ name, ok, level?, detail }]; never prints a secret.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const okRow = (name, detail) => ({ name, ok: true, detail });
const failRow = (name, detail) => ({ name, ok: false, level: 'fail', detail });
const warnRow = (name, detail) => ({ name, ok: false, level: 'warn', detail });

async function defaultRun(ctx, args) {
  const env = { ...process.env };
  if (ctx.settings?.DAYTONA_API_KEY) env.DAYTONA_API_KEY = ctx.settings.DAYTONA_API_KEY;
  if (ctx.settings?.DAYTONA_API_URL) env.DAYTONA_API_URL = ctx.settings.DAYTONA_API_URL;
  try {
    const { stdout, stderr } = await run('daytona', args, { timeout: 60_000, env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (e.code === 'ENOENT') return { code: 127, stdout: '', stderr: 'not installed' };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

export async function doctor(ctx) {
  const s = ctx.settings ?? {};
  const cli = (args) => (ctx.daytonaRun ? ctx.daytonaRun(args, { timeout: 60_000 }) : defaultRun(ctx, args));
  const rows = [];

  // 1. the CLI
  const v = await cli(['version']);
  if (v.code === 127) {
    rows.push(failRow('cli', 'the daytona CLI is not installed: brew install daytonaio/cli/daytona'));
    return rows;
  }
  rows.push(v.code === 0 ? okRow('cli', v.stdout.trim().split('\n')[0] || 'installed') : warnRow('cli', 'daytona version failed'));

  // 2. auth: an API key in .env, or a CLI login; `daytona list` proves either.
  const list = await cli(['list']);
  if (list.code === 0) rows.push(okRow('auth', s.DAYTONA_API_KEY ? 'DAYTONA_API_KEY accepted' : 'CLI login accepted'));
  else rows.push(failRow('auth', s.DAYTONA_API_KEY ? 'daytona list failed with DAYTONA_API_KEY: the key is wrong or revoked' : 'not logged in: set DAYTONA_API_KEY in <records>/.env or run `daytona login`'));

  // 3. the snapshot every tree is created from
  const snap = s.DAYTONA_SNAPSHOT || 'padakan-base';
  if (list.code === 0) {
    const snaps = await cli(['snapshot', 'list']);
    if (snaps.code === 0 && snaps.stdout.includes(snap)) rows.push(okRow('snapshot', snap));
    else {
      rows.push(failRow('snapshot', `snapshot "${snap}" not found: daytona snapshot create ${snap} --dockerfile sandboxes/daytona/snapshot/Dockerfile --cpu ${s.DAYTONA_CPU ?? 2} --memory ${s.DAYTONA_MEMORY ?? 4} --disk ${s.DAYTONA_DISK ?? 10}`));
    }
  }

  // 4. what seed needs: a Claude token, a GitHub token source, a commit identity
  rows.push(s.CLAUDE_CODE_OAUTH_TOKEN ? okRow('claude-token', 'set') : failRow('claude-token', 'CLAUDE_CODE_OAUTH_TOKEN is not set: run `claude setup-token`'));
  if (!s.CLAUDE_CODE_OAUTH_FALLBACK_TOKEN) rows.push(warnRow('claude-fallback', 'no CLAUDE_CODE_OAUTH_FALLBACK_TOKEN: a rate-limited token stops the tree'));
  if (s.GH_TOKEN_SOURCE === 'pat') rows.push(s.GH_PAT ? okRow('gh-token', 'GH_PAT') : failRow('gh-token', 'GH_TOKEN_SOURCE is pat but GH_PAT is empty'));
  else rows.push(okRow('gh-token', 'host (gh auth token); checked by the gh row'));
  rows.push(s.GIT_AUTHOR_NAME && s.GIT_AUTHOR_EMAIL ? okRow('identity', `${s.GIT_AUTHOR_NAME} <${s.GIT_AUTHOR_EMAIL}>`) : failRow('identity', 'GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL must be set'));

  if (Number(s.DAYTONA_DISK ?? 10) > 10) rows.push(warnRow('disk', `DAYTONA_DISK is ${s.DAYTONA_DISK} GB; Daytona caps a sandbox at 10 GB unless support raised it`));
  return rows;
}
