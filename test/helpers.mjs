// Shared test helpers. Zero dependencies.
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A fresh temporary directory, realpath'd so macOS /var → /private/var does not break comparisons.
export async function tempDir(prefix = 'padakan-') {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true });
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
