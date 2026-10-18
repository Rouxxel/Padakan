// Shared test helpers. Zero dependencies.
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Tests never start the real claude or herdr: stubs go first on PATH for every test process.
// claude logs its arguments to $PADAKAN_STUB_LOG, sleeps $PADAKAN_STUB_SLEEP seconds and exits
// with $PADAKAN_STUB_EXIT; herdr logs and exits 0; daytona logs its HOME and arguments.
export const STUB_BIN = mkdtempSync(join(tmpdir(), 'padakan-stubs-'));
writeFileSync(join(STUB_BIN, 'claude'), '#!/bin/sh\necho "claude $*" >> "${PADAKAN_STUB_LOG:-/dev/null}"\nsleep "${PADAKAN_STUB_SLEEP:-0}"\nexit "${PADAKAN_STUB_EXIT:-0}"\n', { mode: 0o755 });
writeFileSync(join(STUB_BIN, 'daytona'), '#!/bin/sh\necho "HOME=$HOME daytona $*" >> "${PADAKAN_STUB_LOG:-/dev/null}"\nexit "${PADAKAN_STUB_EXIT:-0}"\n', { mode: 0o755 });
writeFileSync(join(STUB_BIN, 'herdr'), '#!/bin/sh\necho "herdr $*" >> "${PADAKAN_STUB_LOG:-/dev/null}"\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${STUB_BIN}:${process.env.PATH}`;

// A fresh temporary directory, realpath'd so macOS /var → /private/var does not break comparisons.
export async function tempDir(prefix = 'padakan-') {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeDir(dir) {
  // Windows keeps files busy for a moment after a child process (git, sh) exits: retry.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A real git repo at <tmp>/parent/<name> with one commit, so sibling folders (the records folder) can be tested.
export async function makeRepo(name = 'app') {
  const base = await tempDir();
  const repo = join(base, 'parent', name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return { base, repo, parent: join(base, 'parent') };
}

// Run a Node script and return { code, stdout, stderr } instead of throwing on a non-zero exit.
export function runNode(script, args = [], { cwd = ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
