// The daytona CLI, always on Padakan's own profile.
//
// The CLI ignores DAYTONA_API_KEY in the environment and uses whatever `daytona login` saved under
// ~/.config/daytona, which may be another organization. So every call runs with HOME set to a private
// profile folder next to the records (<records>-daytona/, mode 700), logged in once with the
// DAYTONA_API_KEY from <records>/.env. Without that key nothing runs: a sandbox is never created in
// whatever organization the machine happens to be logged into.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SandboxError } from '../contract.mjs';

const run = promisify(execFile);

// The private profile folder (the CLI's HOME) for this records folder.
export const profileHome = (ctx) => `${ctx.records}-daytona`;

// How a human runs the CLI on the same profile, e.g. to watch a tree: `HOME=… daytona ssh <id>`.
export const cliPrefix = (ctx) => `HOME=${profileHome(ctx)} daytona`;

const fingerprint = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

async function call(home, args, timeout) {
  try {
    const { stdout, stderr } = await run('daytona', args, { timeout, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, HOME: home } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (e.code === 'ENOENT') throw new SandboxError('the daytona CLI is not installed (brew install daytonaio/cli/daytona)', { code: 'NO_CLI' });
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
  }
}

// Log the profile in when it is new or the key changed. The key is passed to `daytona login` only.
export async function ensureProfile(ctx) {
  const key = ctx.settings?.DAYTONA_API_KEY;
  if (!key) throw new SandboxError('DAYTONA_API_KEY is not set in <records>/.env: Padakan never uses the machine\'s own daytona login', { code: 'NO_DAYTONA_KEY' });
  const home = profileHome(ctx);
  const marker = join(home, '.padakan-key');
  if (existsSync(marker) && (await readFile(marker, 'utf8')).trim() === fingerprint(key)) return home;
  await mkdir(home, { recursive: true });
  await chmod(home, 0o700);
  const r = await call(home, ['login', '--api-key', key], 60_000);
  if (r.code !== 0) throw new SandboxError('daytona login with DAYTONA_API_KEY failed', { code: 'DAYTONA_LOGIN_FAILED' });
  await writeFile(marker, `${fingerprint(key)}\n`, { mode: 0o600 });
  return home;
}

// runDaytona(ctx, args, { timeout }) -> { code, stdout, stderr }
export async function runDaytona(ctx, args, { timeout = 10 * 60_000 } = {}) {
  const home = await ensureProfile(ctx);
  return call(home, args, timeout + 30_000);
}
