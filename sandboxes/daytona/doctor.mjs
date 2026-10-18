// Onboarding checks for the Daytona provider. Loaded by orchestrator/doctor.mjs when
// PADAKAN_SANDBOX_PROVIDER=daytona. Returns [{ name, ok, level?, detail }]; never prints a secret.

import { runDaytona, profileHome } from './cli.mjs';

const okRow = (name, detail) => ({ name, ok: true, detail });
const failRow = (name, detail) => ({ name, ok: false, level: 'fail', detail });
const warnRow = (name, detail) => ({ name, ok: false, level: 'warn', detail });

async function defaultRun(ctx, args) {
  try {
    return await runDaytona(ctx, args, { timeout: 60_000 });
  } catch (e) {
    if (e.code === 'NO_CLI') return { code: 127, stdout: '', stderr: 'not installed' };
    return { code: 1, stdout: '', stderr: e.message };
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

  // 2. auth: only DAYTONA_API_KEY, on Padakan's own CLI profile (never the machine's daytona login).
  if (!s.DAYTONA_API_KEY) {
    rows.push(failRow('auth', 'DAYTONA_API_KEY is not set in <records>/.env (Padakan never uses the machine\'s own daytona login)'));
    return rows;
  }
  const list = await cli(['list']);
  if (list.code === 0) rows.push(okRow('auth', `DAYTONA_API_KEY accepted (profile ${profileHome(ctx)})`));
  else rows.push(failRow('auth', 'daytona list failed with DAYTONA_API_KEY: the key is wrong or revoked'));

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
