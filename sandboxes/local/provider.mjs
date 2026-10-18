// The local sandbox provider: one git worktree per task on the orchestrator's machine.
// Used for development, and as the Mac host for device probes.
//
// Worktrees live next to the records folder, in <records>-trees/<id>, so they never sit inside the
// OKF bundle. Padakan's files inside a tree go under .padakan/, which is excluded from git.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, cp, readdir, readFile, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, resolve, relative, isAbsolute } from 'node:path';
import { SandboxError, SECRET_FILE_RE } from '../contract.mjs';

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const gitTry = (cwd, ...args) => git(cwd, ...args).catch(() => null);

export const name = 'local';
export const capabilities = ['create', 'exec', 'push', 'pull', 'brief', 'attach', 'url', 'status', 'evidence', 'retire', 'destroy'];

const PADAKAN_DIR = '.padakan';
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
  if (remotes) {
    const onRemote = await git(repo, 'branch', '-r', '--contains', baseSha);
    if (!onRemote) throw new SandboxError(`base ${baseSha.slice(0, 12)} is not on any remote; push it first`, { code: 'UNPUSHED_BASE' });
  }
  const path = join(treesRoot(ctx.records), id);
  if (existsSync(path)) throw new SandboxError(`worktree path already exists: ${path}`, { code: 'EXISTS' });
  await mkdir(treesRoot(ctx.records), { recursive: true });
  await git(repo, 'worktree', 'add', '-q', '-b', branch, path, baseSha);
  await mkdir(join(path, PADAKAN_DIR, 'evidence'), { recursive: true });
  await exclude(path);
  return { repo, branch, base_sha: baseSha, path, url: null, state: 'ready', ...(task ? { task } : {}) };
}

// exec(ctx, handle, cmd) -> { code, stdout, stderr }. One shell string, run in the worktree.
export async function exec(ctx, handle, cmd, { timeout = 10 * 60_000 } = {}) {
  try {
    const { stdout, stderr } = await run('/bin/sh', ['-c', cmd], { cwd: handle.path, timeout, maxBuffer: 64 * 1024 * 1024 });
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

// brief(ctx, handle, briefPath): deliver the OKF brief to .padakan/BRIEF.md.
export async function brief(ctx, handle, briefPath) {
  await cp(briefPath, join(handle.path, PADAKAN_DIR, 'BRIEF.md'));
  return { ok: true, handle: { state: 'working' } };
}

// attach: the agent runs in a herdr pane in the worktree; the orchestrator's attach step starts it.
export async function attach(ctx, handle) {
  return { watch: ctx.settings?.PADAKAN_TERMINAL === 'none' ? 'none' : 'herdr', cwd: handle.path };
}

export async function url(ctx, handle, port = 3000) {
  return { url: `http://localhost:${port}` };
}

export async function status(ctx, handle) {
  if (!existsSync(handle.path)) return { state: 'gone', handle: { state: 'gone' } };
  if (existsSync(join(handle.path, PADAKAN_DIR, 'DONE'))) return { state: 'done', handle: { state: 'done' } };
  return { state: handle.state === 'provisioning' ? 'ready' : handle.state };
}

// evidence(ctx, handle, key): copy .padakan/evidence/ into <records>/tasks/<key>/evidence/local/.
export async function evidence(ctx, handle, key) {
  const src = join(handle.path, PADAKAN_DIR, 'evidence');
  const dst = join(ctx.records, 'tasks', key, 'evidence', 'local');
  if (!existsSync(src)) return { video: null, files: [] };
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true });
  const files = (await walk(dst)).map((f) => relative(ctx.records, f));
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
    record = join('tasks', key, 'record.md');
  }
  const d = await destroy(ctx, handle);
  return { record, ...d };
}
