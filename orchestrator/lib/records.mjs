// The records folder: everything Padakan knows about a project, kept next to the repo and never
// committed to it. This module is the only resolver of its path; nothing else builds it by hand.
//
//   <parent>/<repo>/            the code
//   <parent>/<repo>-padakan/    the records (name from PADAKAN_RECORDS_NAME, or PADAKAN_RECORDS_DIR)
//
// Linked worktrees and submodules resolve to the main repository, so every checkout of a project
// shares one records folder. Resolution reads files only; it never starts a subprocess.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { dirname, basename, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from './env.mjs';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Folders created by init(). Each holds one kind of record (see PLUGIN-STRUCTURE.md §4).
export const LAYOUT = ['plan', 'tasks', 'sandboxes', 'decisions', 'audit', 'cost', 'monitor', 'ledger'];

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The main repository root for any path inside a repo, a linked worktree or a submodule.
// Returns null when cwd is not inside a git repository.
export function mainRepoRoot(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dir;
      // A .git file: a linked worktree or a submodule. Follow "gitdir:".
      const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
      if (!m) return dir;
      const gitdir = resolve(dir, m[1].trim());
      const wt = gitdir.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
      if (wt) return wt[1];
      const sub = gitdir.match(/^(.*?)[\\/]\.git[\\/]modules[\\/]/);
      if (sub) return mainRepoRoot(sub[1]);
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// The records folder for a repository. `name` may contain {repo}; `dir` (absolute) overrides it.
export function recordsDir(cwd = process.cwd(), { name = '{repo}-padakan', dir = '' } = {}) {
  if (dir) {
    if (!isAbsolute(dir)) throw new Error(`PADAKAN_RECORDS_DIR must be an absolute path, got "${dir}"`);
    return resolve(dir);
  }
  const root = mainRepoRoot(cwd);
  if (!root) throw new Error(`not inside a git repository: ${cwd}`);
  const folder = name.replaceAll('{repo}', basename(root));
  if (!folder || folder.includes('/') || folder.includes('\\') || folder === '.' || folder === '..') {
    throw new Error(`PADAKAN_RECORDS_NAME must be a plain folder name, got "${name}"`);
  }
  return join(dirname(root), folder);
}

// Settings and the records folder together. The records location itself can only come from the
// exported environment or the plugin .env, because the records .env lives inside the folder it names.
export function loadContext({ cwd = process.cwd(), exported = process.env, pluginRoot = PLUGIN_ROOT } = {}) {
  const pluginEnvFile = join(pluginRoot, '.env');
  const pre = loadSettings({ exported, pluginEnvFile });
  const dir = recordsDir(cwd, { name: pre.PADAKAN_RECORDS_NAME, dir: pre.PADAKAN_RECORDS_DIR || '' });
  const settings = loadSettings({ exported, recordsEnvFile: join(dir, '.env'), pluginEnvFile });
  return { settings, records: dir, repo: mainRepoRoot(cwd) };
}

const today = () => new Date().toISOString();

function okf({ type, title, description, tags, body }) {
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\ntags: [${tags.join(', ')}]\ntimestamp: ${today()}\n---\n\n${body}\n`;
}

async function writeIfMissing(path, content) {
  if (existsSync(path)) return false;
  await writeFile(path, content, { flag: 'wx' }).catch((e) => {
    if (e.code !== 'EEXIST') throw e;
  });
  return true;
}

// Create the records layout. Idempotent: existing files are never overwritten.
export async function init(dir, { repo = basename(dir).replace(/-padakan$/, '') } = {}) {
  await mkdir(dir, { recursive: true });
  for (const sub of LAYOUT) await mkdir(join(dir, sub), { recursive: true });
  const created = [];
  const files = {
    'index.md': okf({
      type: 'Index',
      title: `${repo} · Padakan records`,
      description: `Everything Padakan planned, built, verified and decided for ${repo}.`,
      tags: ['padakan', 'records', 'index'],
      body: [
        `# ${repo} · Padakan records`,
        '',
        '| Folder | Holds |',
        '|---|---|',
        '| [plan/](./plan/) | PRD, stories, task plan, approved manifests |',
        '| [tasks/](./tasks/) | one folder per task: brief, checks, evidence, record |',
        '| [decisions/](./decisions/) | cost decision reports and answers |',
        '| [monitor/](./monitor/) | clusters, triage and bug-agent reports per tick |',
        '| sandboxes/ · audit/ · cost/ · ledger/ | machine data (JSON and JSONL) |',
        '',
        '## Tasks',
        '',
        '| Key | Verdict | Record | Written |',
        '|---|---|---|---|',
      ].join('\n'),
    }),
    'log.md': okf({
      type: 'Log',
      title: `${repo} · Padakan log`,
      description: 'Chronological, human-readable history. The signed history is audit/chain.jsonl.',
      tags: ['padakan', 'records', 'log'],
      body: `# ${repo} · Padakan log\n`,
    }),
    'state.json': `${JSON.stringify({ version: 1, tasks: {} }, null, 2)}\n`,
    'ledger/known-failures.json': `${JSON.stringify({ entries: [] }, null, 2)}\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (await writeIfMissing(join(dir, rel), content)) created.push(rel);
  }
  return { dir, created };
}

// The folder for one task, created on first use. Keys are restricted so they are safe path segments.
export async function taskDir(dir, key) {
  if (!KEY_RE.test(key)) throw new Error(`invalid task key "${key}"`);
  const path = join(dir, 'tasks', key);
  await mkdir(join(path, 'logs'), { recursive: true });
  return path;
}

// Append one line to the human-readable log. The signed record is the audit chain, not this file.
export async function appendLog(dir, text) {
  const line = String(text).replace(/\s*\n\s*/g, ' ').trim();
  await appendFile(join(dir, 'log.md'), `- ${today()} · ${line}\n`);
}

export async function readState(dir) {
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
}
