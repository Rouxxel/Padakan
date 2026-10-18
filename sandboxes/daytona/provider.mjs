// The Daytona sandbox provider: one Daytona sandbox per task, baked from snapshot/Dockerfile.
//
// Everything goes through the `daytona` CLI. The CLI facts this file relies on (proven on v0.192):
//   - `daytona exec ID --timeout S -- "<cmd>"` re-joins everything after `--` into ONE shell
//     string, so a command is sent as one string and never wrapped in `bash -c`.
//   - its exit status is not reliable, so every command writes `$?` to a per-run sentinel file and
//     a second exec reads it back. A missing sentinel is a failure, never a success.
//   - `create -e K=V` is sandbox metadata anyone in the org can read, so secrets never go there.
//     They travel per exec as `export K='v';` and land only in files under the sandbox user's HOME.
//   - CPU, memory and disk are fixed when the snapshot is baked; `create` refuses them next to
//     --snapshot.
//   - files move as base64 over exec, in chunks small enough for ARG_MAX.
//
// The CLI runner can be replaced through ctx.daytonaRun(args, { timeout }) -> { code, stdout, stderr },
// which is how the tests run every remote command against a local shell.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, rm, stat, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname, basename, relative, sep, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SandboxError, SECRET_FILE_RE, secretValues } from '../contract.mjs';
import { runDaytona, cliPrefix } from './cli.mjs';
import { SETTINGS } from '../../orchestrator/lib/env.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTE = join(HERE, 'remote');

export const name = 'daytona';
export const capabilities = [
  'create', 'bootstrap', 'seed', 'exec', 'push', 'pull', 'brief', 'attach', 'url', 'status',
  'pause', 'resume', 'evidence', 'retire', 'destroy',
];

const PADAKAN_DIR = '.padakan';
// base64 characters per exec: well under ARG_MAX, and under the 32k command line of Windows hosts
// Linux caps ONE argument at 128 KiB (MAX_ARG_STRLEN), and the whole chunk travels as one sh -c argument.
const CHUNK = process.platform === 'win32' ? 24_000 : 100_000;
// tar on the orchestrator's machine. On Windows, Git's GNU tar reads "C:\..." as host:path, so use the
// bsdtar Windows ships in System32 (Windows 10+), which understands drive paths.
const LOCAL_TAR = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const CLAUDE_BLOCKS = ['CLAUDE-padakan.md', 'CLAUDE-evidence.md', 'CLAUDE-disk.md'];

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────

const cli = (ctx, args, opts) => (ctx.daytonaRun ? ctx.daytonaRun(args, opts) : runDaytona(ctx, args, opts));

// Replace every secret setting's value with *** before text leaves this module.
function scrub(ctx, text) {
  let out = String(text ?? '');
  for (const v of secretValues(ctx.settings, SETTINGS)) out = out.split(v).join('***');
  for (const v of Object.values(ctx.extraSecrets || {})) if (v && v.length >= 4) out = out.split(v).join('***');
  return out;
}

const tail = (text, n = 400) => text.trim().slice(-n);
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
// `~/x` -> "$HOME"/'x', so paths stored in the handle stay portable between sandboxes.
const rpath = (p) => (p.startsWith('~/') ? `"$HOME"/${q(p.slice(2))}` : q(p));

// Run one shell string in the sandbox and read its exit status back from a sentinel.
// env values are exported in front of the command; they are never echoed or returned.
async function remote(ctx, id, script, { env = {}, cwd = null, timeout = 600 } = {}) {
  const sentinel = `"$HOME"/${PADAKAN_DIR}/run-${randomBytes(6).toString('hex')}.done`;
  const exports = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `export ${k}=${q(v)};`)
    .join(' ');
  const line = [
    'export PATH="$HOME/.local/bin:$PATH";',
    exports,
    `mkdir -p "$HOME"/${PADAKAN_DIR}; rm -f ${sentinel};`,
    `(${cwd ? `cd ${rpath(cwd)} || exit 97\n` : ''}${script}\n);`,
    `echo $? > ${sentinel}`,
  ].filter(Boolean).join(' ');
  const r = await cli(ctx, ['exec', id, '--timeout', String(timeout), '--', line], { timeout: timeout * 1000 });
  const done = await cli(ctx, ['exec', id, '--timeout', '60', '--', `cat ${sentinel} 2>/dev/null; rm -f ${sentinel}`], { timeout: 60_000 });
  const code = /^\s*(\d+)\s*$/.test(done.stdout) ? Number(done.stdout.trim()) : null;
  const stdout = scrub(ctx, r.stdout);
  const stderr = scrub(ctx, r.stderr);
  if (code === null) {
    return { code: -1, sentinel: false, stdout, stderr: `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}no exit sentinel: the command did not finish (exec status ${r.code})` };
  }
  return { code, sentinel: true, stdout, stderr };
}

async function must(ctx, id, script, opts, what) {
  const r = await remote(ctx, id, script, opts);
  if (r.code !== 0) throw new SandboxError(`${what} failed in ${id} (exit ${r.code}): ${tail(r.stderr || r.stdout)}`, { code: 'REMOTE_FAILED' });
  return r;
}

// Write bytes to a file in the sandbox: base64 in chunks, decoded and size-checked there.
async function pushBytes(ctx, id, dest, bytes, { mode = null } = {}) {
  const b64 = Buffer.from(bytes).toString('base64');
  const tmp = `"$HOME"/${PADAKAN_DIR}/push-${randomBytes(6).toString('hex')}.b64`;
  for (let i = 0; i === 0 || i < b64.length; i += CHUNK) {
    await must(ctx, id, `printf %s ${q(b64.slice(i, i + CHUNK))} ${i === 0 ? '>' : '>>'} ${tmp}`, {}, 'push');
  }
  const d = rpath(dest);
  const r = await must(ctx, id, `mkdir -p "$(dirname ${d})" && base64 -d < ${tmp} > ${d} && rm -f ${tmp}${mode ? ` && chmod ${mode} ${d}` : ''} && wc -c < ${d}`, {}, 'push');
  if (Number(r.stdout.trim()) !== bytes.length) throw new SandboxError(`push to ${id} wrote ${r.stdout.trim()} of ${bytes.length} bytes`, { code: 'PUSH_TRUNCATED' });
}

// ── settings the tree needs ─────────────────────────────────────────────────────────────────────

async function ghToken(ctx) {
  const s = ctx.settings || {};
  if (s.GH_TOKEN_SOURCE === 'pat') {
    if (!s.GH_PAT) throw new SandboxError('GH_TOKEN_SOURCE is pat but GH_PAT is empty', { code: 'NO_GH_TOKEN' });
    return s.GH_PAT;
  }
  if (ctx.ghToken) return ctx.ghToken();
  try {
    const t = (await run('gh', ['auth', 'token'], { timeout: 20_000 })).stdout.trim();
    if (t) return t;
  } catch {
    // reported below without the command's output
  }
  throw new SandboxError('no GitHub token for the tree: run `gh auth login` on this machine or set GH_TOKEN_SOURCE=pat', { code: 'NO_GH_TOKEN' });
}

// An https URL lets `gh auth setup-git` authenticate the clone; ssh remotes are rewritten to it.
export function cloneUrl(remoteUrl) {
  const m = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(remoteUrl);
  return m ? `https://${m[1]}/${m[2]}.git` : remoteUrl;
}

const gitHost = async (cwd, ...args) => (await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const gitHostTry = (cwd, ...args) => gitHost(cwd, ...args).catch(() => null);

// ── create ──────────────────────────────────────────────────────────────────────────────────────

// create(ctx, id, { repo, branch, base, task }) -> handle fields. Only public values reach the CLI.
// preflight(ctx, { repo, base }) -> { baseSha, origin }: everything create needs, checked without
// creating anything, so recycle can refuse before it destroys the old tree.
export async function preflight(ctx, { repo = ctx.repo, base = 'HEAD' } = {}) {
  if (!repo) throw new SandboxError('the daytona provider needs the repository path');
  if (!ctx.daytonaRun && !ctx.settings?.DAYTONA_API_KEY) throw new SandboxError('DAYTONA_API_KEY is not set in <records>/.env', { code: 'NO_DAYTONA_KEY' });
  const baseSha = await gitHostTry(repo, 'rev-parse', '--verify', `${base}^{commit}`);
  if (!baseSha) throw new SandboxError(`base "${base}" is not a commit in ${repo}`, { code: 'BAD_BASE' });
  const origin = await gitHostTry(repo, 'remote', 'get-url', 'origin');
  if (!origin) throw new SandboxError('the repository has no origin remote; a Daytona tree clones from it', { code: 'NO_REMOTE' });
  // The tree clones the base from the remote, so it must already be pushed there.
  const onRemote = await gitHostTry(repo, 'branch', '-r', '--contains', baseSha);
  if (!onRemote) throw new SandboxError(`base ${baseSha.slice(0, 12)} is not on any remote; push it first`, { code: 'UNPUSHED_BASE' });
  return { baseSha, origin };
}

export async function create(ctx, id, { repo = ctx.repo, branch = `padakan/${id}`, base = 'HEAD', task } = {}) {
  const s = ctx.settings || {};
  const { baseSha, origin } = await preflight(ctx, { repo, base });
  const args = [
    'create', '--name', id,
    '--snapshot', s.DAYTONA_SNAPSHOT || 'padakan-base',
    '--target', s.DAYTONA_TARGET || 'eu',
    '--auto-stop', String(s.DAYTONA_AUTO_STOP ?? 15),
    '--auto-delete', String(s.DAYTONA_AUTO_DELETE ?? 1440),
    '--label', 'purpose=padakan',
    '--label', `tree=${id}`,
  ];
  const r = await cli(ctx, args, { timeout: 5 * 60_000 });
  if (r.code !== 0) {
    await cli(ctx, ['delete', id], { timeout: 120_000 }).catch(() => {});
    throw new SandboxError(`daytona create ${id} failed: ${tail(scrub(ctx, r.stderr || r.stdout))}`, { code: 'CREATE_FAILED' });
  }
  return {
    repo: cloneUrl(origin),
    branch,
    base_sha: baseSha,
    path: `~/trees/${id}`,
    url: null,
    state: 'ready',
    snapshot: s.DAYTONA_SNAPSHOT || 'padakan-base',
    target: s.DAYTONA_TARGET || 'eu',
    ...(task ? { task } : {}),
  };
}

// ── seed: credentials and standing instructions, written once per sandbox ──────────────────────

// Replace or append each fenced block in ~/.claude/CLAUDE.md, so seeding twice changes nothing.
export function mergeBlocks(existing, blocks) {
  let text = existing || '';
  for (const block of blocks) {
    const m = /<!-- (padakan:[a-z-]+):start -->/.exec(block);
    if (!m) continue;
    const re = new RegExp(`<!-- ${m[1]}:start -->[\\s\\S]*?<!-- ${m[1]}:end -->\\n?`);
    const body = block.endsWith('\n') ? block : `${block}\n`;
    text = re.test(text) ? text.replace(re, body) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${body}`;
  }
  return text;
}

// seed(ctx, handle): ~/.claude-env (mode 600, sourced from .bashrc), the token picker, gh auth,
// git identity, Claude settings without attribution, and the fenced blocks of ~/.claude/CLAUDE.md.
export async function seed(ctx, handle) {
  const s = ctx.settings || {};
  if (!s.CLAUDE_CODE_OAUTH_TOKEN) throw new SandboxError('CLAUDE_CODE_OAUTH_TOKEN is not set (run `claude setup-token`)', { code: 'NO_CLAUDE_TOKEN' });
  if (!s.GIT_AUTHOR_NAME || !s.GIT_AUTHOR_EMAIL) throw new SandboxError('GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL must be set', { code: 'NO_IDENTITY' });
  const gh = await ghToken(ctx);
  const sctx = { ...ctx, extraSecrets: { gh } };
  const id = handle.id;

  // 1. ~/.claude-env, written from exported values so no secret is ever in a file we push.
  await must(sctx, id, [
    'umask 077',
    `{ printf "export CLAUDE_CODE_OAUTH_TOKEN='%s'\\n" "$CLAUDE_CODE_OAUTH_TOKEN";`,
    ` [ -n "$CLAUDE_CODE_OAUTH_FALLBACK_TOKEN" ] && printf "export CLAUDE_CODE_OAUTH_FALLBACK_TOKEN='%s'\\n" "$CLAUDE_CODE_OAUTH_FALLBACK_TOKEN";`,
    ` echo 'export IS_SANDBOX=1'; echo 'export PATH="$HOME/.local/bin:$PATH"'; } > "$HOME/.claude-env"`,
    'chmod 600 "$HOME/.claude-env"',
    'touch "$HOME/.bashrc"',
    `grep -qF '. "$HOME/.claude-env"' "$HOME/.bashrc" || echo '[ -f "$HOME/.claude-env" ] && . "$HOME/.claude-env"' >> "$HOME/.bashrc"`,
  ].join('\n'), { env: { CLAUDE_CODE_OAUTH_TOKEN: s.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_FALLBACK_TOKEN: s.CLAUDE_CODE_OAUTH_FALLBACK_TOKEN } }, 'seeding ~/.claude-env');

  // 2. the token picker: probes the main token and falls back when it is rate-limited.
  await pushBytes(sctx, id, '~/.local/bin/claude-token.sh', await readFile(join(REMOTE, 'claude-token.sh')), { mode: '755' });

  // 3. gh from a token file that is deleted at once, then git over https through gh.
  await must(sctx, id, [
    'umask 077',
    `printf %s "$PADAKAN_GH_TOKEN" > "$HOME/${PADAKAN_DIR}/gh.tok"`,
    `gh auth login --hostname github.com --with-token < "$HOME/${PADAKAN_DIR}/gh.tok"; rc=$?`,
    `rm -f "$HOME/${PADAKAN_DIR}/gh.tok"`,
    '[ $rc -eq 0 ] && gh auth setup-git',
  ].join('\n'), { env: { PADAKAN_GH_TOKEN: gh } }, 'gh auth');

  // 4. git identity and Claude settings: the tree model, no attribution lines.
  const settings = { model: s.PADAKAN_TREE_MODEL || undefined, includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } };
  await must(sctx, id, [
    `git config --global user.name ${q(s.GIT_AUTHOR_NAME)}`,
    `git config --global user.email ${q(s.GIT_AUTHOR_EMAIL)}`,
    'git config --global init.defaultBranch main',
  ].join('\n'), {}, 'git identity');
  await pushBytes(sctx, id, '~/.claude/settings.json', Buffer.from(`${JSON.stringify(settings, null, 2)}\n`));

  // 5. ~/.claude/CLAUDE.md: Padakan's blocks merged into whatever is there.
  const current = await remote(sctx, id, 'cat "$HOME/.claude/CLAUDE.md" 2>/dev/null; true');
  const blocks = CLAUDE_BLOCKS.map((f) => readFileSync(join(REMOTE, f), 'utf8'));
  await pushBytes(sctx, id, '~/.claude/CLAUDE.md', Buffer.from(mergeBlocks(current.code === 0 ? current.stdout : '', blocks)));

  return { ok: true, seeded: ['claude-env', 'claude-token', 'gh', 'git-identity', 'claude-settings', 'claude-md'] };
}

// ── bootstrap: clone and check out the task branch ─────────────────────────────────────────────

export async function bootstrap(ctx, handle) {
  const script = await readFile(join(REMOTE, 'bootstrap.sh'), 'utf8');
  const r = await remote(ctx, handle.id, script, {
    env: { PADAKAN_TREE: handle.id, PADAKAN_REPO_URL: handle.repo, PADAKAN_BRANCH: handle.branch, PADAKAN_BASE_SHA: handle.base_sha },
    timeout: 900,
  });
  const lines = r.stdout.trim().split('\n');
  if (r.code !== 0 || lines.at(-1) !== 'BOOTSTRAP-OK') {
    throw new SandboxError(`bootstrap of ${handle.id} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`, { code: 'BOOTSTRAP_FAILED' });
  }
  const checkout = (lines.find((l) => l.startsWith('CHECKOUT=')) || '').slice('CHECKOUT='.length) || null;
  return { ok: true, checkout, handle: { state: 'ready' } };
}

// ── exec, push, pull, brief ────────────────────────────────────────────────────────────────────

// exec(ctx, handle, cmd, { timeout }) -> { code, stdout, stderr, sentinel }. Runs in the checkout.
// code is -1 when the exit sentinel is missing: the command did not finish, which is a failure.
export async function exec(ctx, handle, cmd, { timeout = 600 } = {}) {
  return remote(ctx, handle.id, cmd, { cwd: handle.path, timeout });
}

function relInside(p) {
  // Paths inside the sandbox are POSIX paths, whatever the host OS.
  if (typeof p !== 'string' || !p || posix.isAbsolute(p) || /^[A-Za-z]:|\\/.test(p)) return null;
  const n = posix.normalize(p);
  return n === '..' || n.startsWith(`..${'/'}`) ? null : n;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// push(ctx, handle, from, to): copy a local file or folder into the checkout. Refuses
// credential-shaped files and targets outside the checkout.
export async function push(ctx, handle, from, to) {
  const rel = relInside(to);
  if (!rel) throw new SandboxError(`push target leaves the tree: ${to}`, { code: 'BAD_PATH' });
  const isDir = (await stat(from)).isDirectory();
  const files = isDir ? await walk(from) : [from];
  const leaked = files.find((f) => SECRET_FILE_RE.test(f));
  if (leaked) throw new SandboxError(`refusing to push a credential-shaped file: ${basename(leaked)}`, { code: 'SECRET_FILE' });
  const dest = `${handle.path}/${rel}`;
  if (!isDir) {
    await pushBytes(ctx, handle.id, dest, await readFile(from));
    return { ok: true, files: 1 };
  }
  const tar = await run('tar', ['-czf', '-', '-C', from, '.'], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  const archive = `~/${PADAKAN_DIR}/push-${randomBytes(6).toString('hex')}.tgz`;
  await pushBytes(ctx, handle.id, archive, tar.stdout);
  await must(ctx, handle.id, `mkdir -p ${rpath(dest)} && tar -xzf ${rpath(archive)} -C ${rpath(dest)} && rm -f ${rpath(archive)}`, {}, 'push');
  return { ok: true, files: files.length };
}

// pull(ctx, handle, from, to): copy a file or folder out of the checkout to a local path.
export async function pull(ctx, handle, from, to) {
  const rel = relInside(from);
  if (!rel) throw new SandboxError(`pull source leaves the tree: ${from}`, { code: 'BAD_PATH' });
  const src = `${handle.path}/${rel}`;
  const s = rpath(src);
  const r = await must(ctx, handle.id,
    `if [ -d ${s} ]; then printf 'D:'; tar -czf - -C ${s} . | base64 | tr -d '\\n'; elif [ -f ${s} ]; then printf 'F:'; base64 < ${s} | tr -d '\\n'; else echo "missing: ${rel}" >&2; exit 3; fi`,
    { timeout: 900 }, 'pull');
  const [kind, b64] = [r.stdout.slice(0, 2), r.stdout.slice(2).trim()];
  const bytes = Buffer.from(b64, 'base64');
  if (kind === 'F:') {
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, bytes);
    return { ok: true, files: 1 };
  }
  if (kind !== 'D:') throw new SandboxError(`pull from ${handle.id} returned no archive`, { code: 'PULL_FAILED' });
  const tmp = await mkdtemp(join(tmpdir(), 'padakan-pull-'));
  try {
    await writeFile(join(tmp, 'a.tgz'), bytes);
    await mkdir(to, { recursive: true });
    await run(LOCAL_TAR, ['-xzf', 'a.tgz', '-C', to], { cwd: tmp });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { ok: true, files: (await walk(to)).length };
}

// brief(ctx, handle, briefPath): deliver the OKF brief to .padakan/BRIEF.md, then start the agent
// on it when the driver is headless, or prompt the herdr agent started by attach.
export async function brief(ctx, handle, briefPath) {
  await pushBytes(ctx, handle.id, `${handle.path}/${PADAKAN_DIR}/BRIEF.md`, await readFile(briefPath));
  const prompt = 'Read .padakan/BRIEF.md and do the task it describes. End with the report line it asks for.';
  if ((ctx.settings?.PADAKAN_DRIVER || 'herdr') === 'headless') {
    await must(ctx, handle.id,
      `. "$HOME/.claude-env"; nohup claude -p ${q(prompt)} --dangerously-skip-permissions > ${PADAKAN_DIR}/agent.log 2>&1 < /dev/null & echo $! > ${PADAKAN_DIR}/agent.pid`,
      { cwd: handle.path }, 'starting the agent');
  } else {
    const { session, agent } = herdrNames(ctx, handle);
    await must(ctx, handle.id, `herdr --session ${q(session)} agent prompt ${q(agent)} ${q(prompt)}`, { cwd: handle.path }, 'prompting the agent');
  }
  return { ok: true, handle: { state: 'working' } };
}

// ── attach: the agent runs inside the sandbox, under a herdr server that owns its PTY ──────────

export function herdrNames(ctx, handle) {
  const prefix = ctx.settings?.HERDR_SESSION_PREFIX || 'padakan';
  const session = `${prefix}-${handle.id}`;
  return { session, agent: session.slice(0, 32) }; // herdr caps agent names at 32 characters
}

// attach(ctx, handle) -> { watch, cwd, session, command }. With the herdr driver it starts the
// server with Claude's auth, the workspace and the agent, and clears the folder-trust dialog.
export async function attach(ctx, handle) {
  if ((ctx.settings?.PADAKAN_DRIVER || 'herdr') === 'headless') {
    return { watch: 'log', cwd: handle.path, command: `${cliPrefix(ctx)} exec ${handle.id} -- "tail -f ${handle.path}/${PADAKAN_DIR}/agent.log"` };
  }
  const { session, agent } = herdrNames(ctx, handle);
  const S = q(session);
  await must(ctx, handle.id, [
    `pgrep -f "[h]erdr --session ${session} server" >/dev/null || (set -a; . "$HOME/.claude-env"; set +a; nohup herdr --session ${S} server > "$HOME/${PADAKAN_DIR}/herdr-server.log" 2>&1 &)`,
    'sleep 3',
    `herdr --session ${S} pane list 2>/dev/null | grep -q pane_id || herdr --session ${S} workspace create --cwd ${rpath(handle.path)} --label ${S} --focus >/dev/null 2>&1`,
    `herdr --session ${S} agent list 2>/dev/null | grep -q '"agent_status"' || herdr --session ${S} agent start ${q(agent)} --kind claude --pane w1:p1 --timeout 240000 -- --dangerously-skip-permissions 2>&1 | head -3`,
    // Folder trust defaults to "No, exit": move to "Yes" before Enter, and only while the dialog is up.
    'for _ in 1 2 3; do',
    `  screen=$(herdr --session ${S} pane read w1:p1 --source visible --lines 12 2>/dev/null)`,
    '  printf %s "$screen" | grep -q "trust this folder" || break',
    `  printf %s "$screen" | grep -qE '❯ *No, exit' && herdr --session ${S} pane send-keys w1:p1 down && sleep 1`,
    `  herdr --session ${S} pane send-keys w1:p1 enter; sleep 5`,
    'done',
    'true',
  ].join('\n'), { cwd: handle.path, timeout: 420 }, 'starting the herdr agent');
  return { watch: 'herdr', cwd: handle.path, session, command: `${cliPrefix(ctx)} ssh ${handle.id}  # then: herdr --session ${session}` };
}

// ── url, status, pause, resume ─────────────────────────────────────────────────────────────────

export async function url(ctx, handle, port = 3000) {
  const r = await cli(ctx, ['preview-url', handle.id, '-p', String(port)], { timeout: 60_000 });
  const m = /https?:\/\/\S*daytonaproxy\S*/.exec(r.stdout);
  if (r.code !== 0 || !m) throw new SandboxError(`no preview URL for ${handle.id} port ${port}: ${tail(scrub(ctx, r.stderr || r.stdout))}`, { code: 'NO_URL' });
  return { url: m[0], handle: { url: m[0] } };
}

// The sandbox's Daytona state from `daytona info`: JSON when the CLI gives it, the State line otherwise.
export function parseInfo(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.state === 'string') return j.state.toLowerCase();
  } catch {
    // text output
  }
  const m = /state\W+([a-z_]+)/i.exec(text) || /\b(started|running|stopped|archived|deleted|error|starting|stopping|creating|restoring|archiving)\b/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

async function daytonaState(ctx, id) {
  const r = await cli(ctx, ['info', id], { timeout: 60_000 });
  if (r.code !== 0) return 'deleted';
  return parseInfo(r.stdout) || 'unknown';
}

export async function status(ctx, handle) {
  const st = await daytonaState(ctx, handle.id);
  if (st === 'deleted' || st === 'error' || st === 'destroyed') return { state: 'gone', daytona: st, handle: { state: 'gone' } };
  if (st === 'stopped' || st === 'archived') return { state: 'paused', daytona: st, handle: { state: 'paused' } };
  if (st === 'started' || st === 'running') {
    const done = await remote(ctx, handle.id, `test -f ${PADAKAN_DIR}/DONE`, { cwd: handle.path, timeout: 60 });
    if (done.code === 0) return { state: 'done', daytona: st, handle: { state: 'done' } };
    const state = ['provisioning', 'paused'].includes(handle.state) ? 'ready' : handle.state;
    return { state, daytona: st, ...(state !== handle.state ? { handle: { state } } : {}) };
  }
  return { state: handle.state, daytona: st };
}

export async function pause(ctx, handle) {
  const r = await cli(ctx, ['stop', handle.id], { timeout: 180_000 });
  if (r.code !== 0) throw new SandboxError(`daytona stop ${handle.id} failed: ${tail(scrub(ctx, r.stderr || r.stdout))}`, { code: 'PAUSE_FAILED' });
  return { ok: true, handle: { state: 'paused' } };
}

export async function resume(ctx, handle) {
  const r = await cli(ctx, ['start', handle.id], { timeout: 300_000 });
  if (r.code !== 0) throw new SandboxError(`daytona start ${handle.id} failed: ${tail(scrub(ctx, r.stderr || r.stdout))}`, { code: 'RESUME_FAILED' });
  return { ok: true, handle: { state: 'ready' } };
}

// ── evidence, destroy, retire ──────────────────────────────────────────────────────────────────

// evidence(ctx, handle, key): pull .padakan/evidence/ into <records>/tasks/<key>/evidence/daytona/.
export async function evidence(ctx, handle, key) {
  const has = await remote(ctx, handle.id, `test -d ${PADAKAN_DIR}/evidence && [ -n "$(ls -A ${PADAKAN_DIR}/evidence)" ]`, { cwd: handle.path, timeout: 60 });
  if (has.code !== 0) return { video: null, files: [] };
  const dst = join(ctx.records, 'tasks', key, 'evidence', 'daytona');
  await pull(ctx, handle, `${PADAKAN_DIR}/evidence`, dst);
  const files = (await walk(dst)).map((f) => relative(ctx.records, f).split(sep).join('/'));
  return { video: files.find((f) => /\.(mp4|webm|mov)$/i.test(f)) || null, files };
}

async function unsaved(ctx, handle) {
  const r = await must(ctx, handle.id,
    `cd ${rpath(handle.path)} 2>/dev/null || { echo "0 0"; exit 0; }; echo "$(git status --porcelain | wc -l) $(git rev-list HEAD --not --remotes | wc -l)"`,
    { timeout: 120 }, 'checking for unsaved work');
  const [uncommitted, unpushed] = r.stdout.trim().split('\n').at(-1).trim().split(/\s+/).map(Number);
  return { uncommitted, unpushed };
}

// destroy(ctx, handle, { force }): refuses with uncommitted or unpushed work unless forced. A stopped
// sandbox is started to check. The branch on the remote is kept.
export async function destroy(ctx, handle, { force = false } = {}) {
  const st = await daytonaState(ctx, handle.id);
  if (st === 'deleted') return { destroyed: true };
  if (!force) {
    if (st === 'stopped' || st === 'archived') await resume(ctx, handle);
    const u = await unsaved(ctx, handle);
    if (u.uncommitted || u.unpushed) {
      throw new SandboxError(`refusing to destroy ${handle.id}: ${u.uncommitted} uncommitted and ${u.unpushed} unpushed changes`, { code: 'UNSAVED_WORK' });
    }
  }
  const r = await cli(ctx, ['delete', handle.id], { timeout: 180_000 });
  if (r.code !== 0 && !/not found/i.test(`${r.stdout}${r.stderr}`)) {
    throw new SandboxError(`daytona delete ${handle.id} failed: ${tail(scrub(ctx, r.stderr || r.stdout))}`, { code: 'DESTROY_FAILED' });
  }
  return { destroyed: true };
}

// retire(ctx, handle, key): pull the building agent's record, then destroy the tree (never forced).
export async function retire(ctx, handle, key) {
  let record = null;
  const has = await remote(ctx, handle.id, `test -f ${PADAKAN_DIR}/record.md`, { cwd: handle.path, timeout: 60 });
  if (has.code === 0) {
    await pull(ctx, handle, `${PADAKAN_DIR}/record.md`, join(ctx.records, 'tasks', key, 'record.md'));
    record = join('tasks', key, 'record.md');
  }
  const d = await destroy(ctx, handle);
  return { record, ...d };
}

// Exposed for the tests and the doctor.
export const _internal = { remote, pushBytes, scrub };
