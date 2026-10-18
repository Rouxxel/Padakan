// The local sandbox provider: one git worktree per task on the orchestrator's machine.
// Used for development, and as the Mac host for device probes.
//
// Worktrees live next to the records folder, in <records>-trees/<id>, so they never sit inside the
// OKF bundle. Padakan's files inside a tree go under .padakan/, which is excluded from git.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, cp, readdir, readFile, writeFile, appendFile, stat, open, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { SandboxError, SECRET_FILE_RE } from '../contract.mjs';

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const gitTry = (cwd, ...args) => git(cwd, ...args).catch(() => null);

export const name = 'local';
export const capabilities = ['create', 'exec', 'push', 'pull', 'brief', 'attach', 'url', 'status', 'evidence', 'retire', 'destroy'];

const PADAKAN_DIR = '.padakan';
// POSIX sh: /bin/sh, or on Windows the `sh` that ships with Git for Windows (on PATH with git).
const SHELL = process.platform === 'win32' ? 'sh' : '/bin/sh';
const treesRoot = (records) => `${records}-trees`;

function inside(root, p) {
  const r = relative(root, resolve(root, p));
  return !r.startsWith('..') && !isAbsolute(r);
}

async function exclude(worktree) {
  const common = await git(worktree, 'rev-parse', '--git-common-dir');
  const file = join(resolve(worktree, common), 'info', 'exclude');
  await mkdir(join(file, '..'), { recursive: true });
  const text = existsSync(file) ? await readFile(file, 'utf8') : '';
  if (!text.split('\n').includes(`/${PADAKAN_DIR}/`)) await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}/${PADAKAN_DIR}/\n`);
}

// create(ctx, id, { repo, branch, base }) -> handle fields
export async function create(ctx, id, { repo = ctx.repo, branch = `padakan/${id}`, base = 'HEAD', task } = {}) {
  if (!repo) throw new SandboxError('local provider needs the repository path');
  const baseSha = await gitTry(repo, 'rev-parse', '--verify', `${base}^{commit}`);
  if (!baseSha) throw new SandboxError(`base "${base}" is not a commit in ${repo}`, { code: 'BAD_BASE' });
  // With a remote, the base must already be pushed, so the work can always be recovered from it.
  const remotes = await git(repo, 'remote');
  // A relative remote URL resolves against the current directory, which inside a worktree is a
  // different folder, so pushes from the tree would fail.
  for (const r of remotes.split('\n').filter(Boolean)) {
    const u = await gitTry(repo, 'remote', 'get-url', r);
    if (u && /^\.\.?[\\/]/.test(u)) {
      throw new SandboxError(`remote "${r}" is a relative path (${u}); trees live in another folder, so make it absolute: git remote set-url ${r} ${resolve(repo, u)}`, { code: 'RELATIVE_REMOTE' });
    }
  }
  if (remotes) {
    const onRemote = await git(repo, 'branch', '-r', '--contains', baseSha);
    if (!onRemote) throw new SandboxError(`base ${baseSha.slice(0, 12)} is not on any remote; push it first`, { code: 'UNPUSHED_BASE' });
  }
  const path = join(treesRoot(ctx.records), id);
  if (existsSync(path)) throw new SandboxError(`worktree path already exists: ${path}`, { code: 'EXISTS' });
  await mkdir(treesRoot(ctx.records), { recursive: true });
  const existing = await gitTry(repo, 'rev-parse', '--verify', `refs/heads/${branch}`);
  if (existing) {
    // A recycled tree: reuse the branch, fast-forwarded to the base when the base is ahead of it.
    await git(repo, 'worktree', 'add', '-q', path, branch);
    const behind = (await gitTry(repo, 'merge-base', '--is-ancestor', existing, baseSha)) !== null;
    if (behind && existing !== baseSha) await git(path, 'reset', '-q', '--hard', baseSha);
  } else {
    await git(repo, 'worktree', 'add', '-q', '-b', branch, path, baseSha);
  }
  await mkdir(join(path, PADAKAN_DIR, 'evidence'), { recursive: true });
  await exclude(path);
  return { repo, branch, base_sha: baseSha, path, url: null, state: 'ready', ...(task ? { task } : {}) };
}

// exec(ctx, handle, cmd) -> { code, stdout, stderr }. One shell string, run in the worktree.
export async function exec(ctx, handle, cmd, { timeout = 10 * 60_000 } = {}) {
  try {
    const { stdout, stderr } = await run(SHELL, ['-c', cmd], { cwd: handle.path, timeout, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
  }
}

// push(ctx, handle, from, to): copy a file or folder into the worktree. Refuses credential-shaped files.
export async function push(ctx, handle, from, to) {
  if (!inside(handle.path, to)) throw new SandboxError(`push target leaves the tree: ${to}`, { code: 'BAD_PATH' });
  const files = (await stat(from)).isDirectory() ? await walk(from) : [from];
  const leaked = files.find((f) => SECRET_FILE_RE.test(f));
  if (leaked) throw new SandboxError(`refusing to push a credential-shaped file: ${basename(leaked)}`, { code: 'SECRET_FILE' });
  await cp(from, resolve(handle.path, to), { recursive: true });
  return { ok: true, files: files.length };
}

// pull(ctx, handle, from, to): copy a file or folder out of the worktree.
export async function pull(ctx, handle, from, to) {
  if (!inside(handle.path, from)) throw new SandboxError(`pull source leaves the tree: ${from}`, { code: 'BAD_PATH' });
  await cp(resolve(handle.path, from), to, { recursive: true });
  return { ok: true };
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

// ── the builder: claude in the worktree, headless or in a herdr pane ───────────────────────────

const PROMPT = 'Read .padakan/BRIEF.md and do the task it describes. End with the report line it asks for.';
const driver = (ctx) => ctx.settings?.PADAKAN_DRIVER || 'herdr';
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function agentEnv(ctx) {
  const env = { ...process.env, PADAKAN_PROMPT: PROMPT };
  if (ctx.settings?.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = ctx.settings.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

// Tree settings for claude: the tree model, no attribution lines.
async function claudeSettings(ctx, handle) {
  const file = join(handle.path, PADAKAN_DIR, 'claude-settings.json');
  const settings = { includeCoAuthoredBy: false, attribution: { commit: '', pr: '' }, ...(ctx.settings?.PADAKAN_TREE_MODEL ? { model: ctx.settings.PADAKAN_TREE_MODEL } : {}) };
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

// Headless: `claude -p` detached in the worktree. Its pid goes to agent.pid, its exit code to agent.exit.
async function startHeadless(ctx, handle) {
  const dir = join(handle.path, PADAKAN_DIR);
  const settingsFile = await claudeSettings(ctx, handle);
  const log = await open(join(dir, 'agent.log'), 'a');
  const script = `claude -p "$PADAKAN_PROMPT" --dangerously-skip-permissions --settings ${q(settingsFile)}; echo $? > ${q(join(dir, 'agent.exit'))}`;
  await rm(join(dir, 'agent.exit'), { force: true });
  const child = spawn('/bin/sh', ['-c', script], { cwd: handle.path, env: agentEnv(ctx), detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref();
  await log.close();
  await writeFile(join(dir, 'agent.pid'), `${child.pid}\n`);
  return child.pid;
}

export function herdrNames(ctx, handle) {
  const session = `${ctx.settings?.HERDR_SESSION_PREFIX || 'padakan'}-${handle.id}`;
  return { session, agent: session.slice(0, 32) }; // herdr caps agent names at 32 characters
}

const sh = (ctx, cwd, script, timeout = 420_000) => run('/bin/sh', ['-c', script], { cwd, env: agentEnv(ctx), timeout, maxBuffer: 16 * 1024 * 1024 });

// brief(ctx, handle, briefPath): deliver the OKF brief to .padakan/BRIEF.md, then start the builder
// (headless) or prompt the herdr agent that attach started.
export async function brief(ctx, handle, briefPath) {
  await cp(briefPath, join(handle.path, PADAKAN_DIR, 'BRIEF.md'));
  if (driver(ctx) === 'headless') {
    const pid = await startHeadless(ctx, handle);
    return { ok: true, agent: 'running', pid, handle: { state: 'working' } };
  }
  const { session, agent } = herdrNames(ctx, handle);
  try {
    await sh(ctx, handle.path, `herdr --session ${q(session)} agent prompt ${q(agent)} "$PADAKAN_PROMPT"`, 60_000);
  } catch {
    // no herdr agent yet: attach starts it and the brief is already in place for it
    return { ok: true, agent: 'none', note: 'run attach to start the herdr agent', handle: { state: 'working' } };
  }
  return { ok: true, agent: 'running', handle: { state: 'working' } };
}

// attach(ctx, handle): headless returns the log to follow. herdr starts a server for the tree's
// session, the workspace and a claude agent in it, and clears the folder-trust prompt (whose default
// is "No, exit").
export async function attach(ctx, handle) {
  if (driver(ctx) === 'headless') return { watch: 'log', cwd: handle.path, command: `tail -f ${join(handle.path, PADAKAN_DIR, 'agent.log')}` };
  const { session, agent } = herdrNames(ctx, handle);
  const S = q(session);
  const settingsFile = await claudeSettings(ctx, handle);
  await sh(ctx, handle.path, [
    `pgrep -f "[h]erdr --session ${session} server" >/dev/null || (nohup herdr --session ${S} server > ${q(join(handle.path, PADAKAN_DIR, 'herdr-server.log'))} 2>&1 &)`,
    'sleep 2',
    `herdr --session ${S} pane list 2>/dev/null | grep -q pane_id || herdr --session ${S} workspace create --cwd ${q(handle.path)} --label ${S} --focus >/dev/null 2>&1`,
    `herdr --session ${S} agent list 2>/dev/null | grep -q '"agent_status"' || herdr --session ${S} agent start ${q(agent)} --kind claude --pane w1:p1 --timeout 240000 -- --dangerously-skip-permissions --settings ${q(settingsFile)} 2>&1 | head -3`,
    'for _ in 1 2 3; do',
    `  screen=$(herdr --session ${S} pane read w1:p1 --source visible --lines 12 2>/dev/null)`,
    '  printf %s "$screen" | grep -q "trust this folder" || break',
    `  printf %s "$screen" | grep -qE '❯ *No, exit' && herdr --session ${S} pane send-keys w1:p1 down && sleep 1`,
    `  herdr --session ${S} pane send-keys w1:p1 enter; sleep 5`,
    'done',
    'true',
  ].join('\n'));
  if (existsSync(join(handle.path, PADAKAN_DIR, 'BRIEF.md'))) {
    await sh(ctx, handle.path, `herdr --session ${S} agent prompt ${q(agent)} "$PADAKAN_PROMPT"`, 60_000).catch(() => {});
  }
  return { watch: 'herdr', cwd: handle.path, session, command: `herdr --session ${session}` };
}

export async function url(ctx, handle, port = 3000) {
  return { url: `http://localhost:${port}` };
}

// The builder's process: running, exited:<code>, or none (nothing was started, or herdr drives it).
export function agentState(handle) {
  const dir = join(handle.path, PADAKAN_DIR);
  const exitFile = join(dir, 'agent.exit');
  if (existsSync(exitFile)) {
    const code = readFileSync(exitFile, 'utf8').trim();
    if (code !== '') return `exited:${code}`;
  }
  const pidFile = join(dir, 'agent.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    try {
      process.kill(pid, 0);
      return 'running';
    } catch {
      return 'exited:unknown'; // gone without writing its exit code (killed, or the machine restarted)
    }
  }
  return 'none';
}

export async function status(ctx, handle) {
  if (!existsSync(handle.path)) return { state: 'gone', handle: { state: 'gone' } };
  if (existsSync(join(handle.path, PADAKAN_DIR, 'DONE'))) return { state: 'done', handle: { state: 'done' } };
  const agent = agentState(handle);
  let state = handle.state === 'provisioning' ? 'ready' : handle.state;
  if (agent === 'running') state = 'working';
  else if (agent === 'exited:0') state = 'waiting';
  else if (agent.startsWith('exited:')) state = 'failed';
  else if (state === 'working' && driver(ctx) === 'headless') state = 'waiting'; // briefed, but nothing runs
  return { state, agent, ...(state !== handle.state ? { handle: { state } } : {}) };
}

// evidence(ctx, handle, key): copy .padakan/evidence/ into <records>/tasks/<key>/evidence/local/.
export async function evidence(ctx, handle, key) {
  const src = join(handle.path, PADAKAN_DIR, 'evidence');
  const dst = join(ctx.records, 'tasks', key, 'evidence', 'local');
  if (!existsSync(src)) return { video: null, files: [] };
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true });
  const files = (await walk(dst)).map((f) => relative(ctx.records, f).split(sep).join('/'));
  return { video: files.find((f) => /\.(mp4|webm|mov)$/i.test(f)) || null, files };
}

async function unsaved(handle) {
  const dirty = (await git(handle.path, 'status', '--porcelain')).split('\n').filter(Boolean);
  const remotes = await git(handle.path, 'remote');
  const ahead = remotes
    ? (await git(handle.path, 'rev-list', handle.branch, '--not', '--remotes')).split('\n').filter(Boolean)
    : (await git(handle.path, 'rev-list', `${handle.base_sha}..${handle.branch}`)).split('\n').filter(Boolean);
  return { uncommitted: dirty.length, unpushed: ahead.length };
}

// destroy(ctx, handle, { force }): refuses with uncommitted or unpushed work unless forced. The branch is kept.
export async function destroy(ctx, handle, { force = false } = {}) {
  if (!existsSync(handle.path)) return { destroyed: true };
  if (!force) {
    const u = await unsaved(handle);
    if (u.uncommitted || u.unpushed) {
      throw new SandboxError(`refusing to destroy ${handle.id}: ${u.uncommitted} uncommitted and ${u.unpushed} unpushed changes`, { code: 'UNSAVED_WORK' });
    }
  }
  await git(handle.repo, 'worktree', 'remove', '--force', handle.path);
  return { destroyed: true };
}

// retire(ctx, handle, key): pull the building agent's record, then destroy the tree (never forced).
export async function retire(ctx, handle, key) {
  const src = join(handle.path, PADAKAN_DIR, 'record.md');
  let record = null;
  if (existsSync(src)) {
    const dst = join(ctx.records, 'tasks', key);
    await mkdir(dst, { recursive: true });
    await cp(src, join(dst, 'record.md'));
    record = `tasks/${key}/record.md`;
  }
  const d = await destroy(ctx, handle);
  return { record, ...d };
}
