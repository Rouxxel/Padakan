import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeRepo, removeDir, git, tempDir } from '../helpers/index.mjs';
import { mainRepoRoot, recordsDir, init, taskDir, appendLog, loadContext, LAYOUT, readState } from '../../orchestrator/lib/records.mjs';

test('the records folder sits next to the repo, named {repo}-padakan', async () => {
  const { base, repo, parent } = await makeRepo('shop');
  try {
    assert.equal(mainRepoRoot(join(repo)), repo);
    await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    assert.equal(recordsDir(join(repo, 'src', 'deep')), join(parent, 'shop-padakan'));
    assert.equal(recordsDir(repo, { name: 'records-{repo}' }), join(parent, 'records-shop'));
  } finally {
    await removeDir(base);
  }
});

test('AC1: a linked worktree resolves to the same records folder as the main checkout', async () => {
  const { base, repo, parent } = await makeRepo('shop');
  try {
    const wt = join(base, 'elsewhere', 'shop-task-12');
    git(repo, 'worktree', 'add', '-q', '-b', 'task-12', wt);
    assert.equal(mainRepoRoot(wt), repo);
    assert.equal(recordsDir(wt), join(parent, 'shop-padakan'));
  } finally {
    await removeDir(base);
  }
});

test('a submodule resolves to its superproject', async () => {
  const { base, repo, parent } = await makeRepo('shop');
  try {
    // Simulate the layout git creates for a submodule: <super>/libs/ui/.git is a file pointing into .git/modules.
    const sub = join(repo, 'libs', 'ui');
    await mkdir(join(repo, '.git', 'modules', 'libs', 'ui'), { recursive: true });
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, '.git'), 'gitdir: ../../.git/modules/libs/ui\n');
    assert.equal(mainRepoRoot(sub), repo);
    assert.equal(recordsDir(sub), join(parent, 'shop-padakan'));
  } finally {
    await removeDir(base);
  }
});

test('PADAKAN_RECORDS_DIR overrides the name and must be absolute', async () => {
  const { base, repo } = await makeRepo('shop');
  try {
    assert.equal(recordsDir(repo, { dir: '/srv/padakan/shop' }), resolve('/srv/padakan/shop'), 'a native absolute path (C:\srv\... on Windows)');
    assert.throws(() => recordsDir(repo, { dir: 'relative/path' }), /must be an absolute path/);
    assert.throws(() => recordsDir(repo, { name: '../escape' }), /plain folder name/);
  } finally {
    await removeDir(base);
  }
});

test('outside a repository there is no records folder', async () => {
  const dir = await tempDir();
  try {
    assert.equal(mainRepoRoot(dir), null);
    assert.throws(() => recordsDir(dir), /not inside a git repository/);
  } finally {
    await removeDir(dir);
  }
});

test('AC2: init() builds the layout and is idempotent', async () => {
  const dir = join(await tempDir(), 'shop-padakan');
  try {
    const first = await init(dir);
    assert.deepEqual(first.created.sort(), ['index.md', 'ledger/known-failures.json', 'log.md', 'state.json']);
    for (const sub of LAYOUT) assert.ok((await stat(join(dir, sub))).isDirectory(), sub);
    await writeFile(join(dir, 'log.md'), 'kept\n');
    const second = await init(dir);
    assert.deepEqual(second.created, []);
    assert.equal(await readFile(join(dir, 'log.md'), 'utf8'), 'kept\n', 'existing files are never overwritten');
    assert.deepEqual(await readState(dir), { version: 1, tasks: {} });
  } finally {
    await removeDir(join(dir, '..'));
  }
});

test('AC3: index.md and log.md are OKF documents', async () => {
  const dir = join(await tempDir(), 'shop-padakan');
  try {
    await init(dir);
    for (const f of ['index.md', 'log.md']) {
      const text = await readFile(join(dir, f), 'utf8');
      const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(fm, `${f} has frontmatter`);
      for (const k of ['type', 'title', 'description', 'tags', 'timestamp']) assert.match(fm[1], new RegExp(`^${k}: .+`, 'm'), `${f} ${k}`);
      assert.match(fm[1], /^timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m);
    }
  } finally {
    await removeDir(join(dir, '..'));
  }
});

test('taskDir() validates keys and appendLog() writes one line per entry', async () => {
  const dir = join(await tempDir(), 'shop-padakan');
  try {
    await init(dir);
    const t = await taskDir(dir, 'PAD-12');
    assert.ok((await stat(join(t, 'logs'))).isDirectory());
    await assert.rejects(taskDir(dir, '../escape'), /invalid task key/);
    await assert.rejects(taskDir(dir, 'a/b'), /invalid task key/);
    await appendLog(dir, 'PAD-12 planted\nin a tree');
    const log = await readFile(join(dir, 'log.md'), 'utf8');
    assert.match(log, /\n- \d{4}-\d{2}-\d{2}T[^ ]+ · PAD-12 planted in a tree\n$/);
  } finally {
    await removeDir(join(dir, '..'));
  }
});

test('loadContext() reads the records .env for settings, but not for the records location', async () => {
  const { base, repo, parent } = await makeRepo('shop');
  try {
    const plugin = join(base, 'plugin');
    await mkdir(plugin);
    await writeFile(join(plugin, '.env'), 'PADAKAN_LANGUAGE=fr\nPADAKAN_MAX_TREES=2\n');
    const records = join(parent, 'shop-padakan');
    await mkdir(records);
    await writeFile(join(records, '.env'), 'PADAKAN_MAX_TREES=4\n');
    const ctx = loadContext({ cwd: repo, exported: {}, pluginRoot: plugin });
    assert.equal(ctx.records, records);
    assert.equal(ctx.repo, repo);
    assert.equal(ctx.settings.PADAKAN_MAX_TREES, 4, 'records .env wins over plugin .env');
    assert.equal(ctx.settings.PADAKAN_LANGUAGE, 'fr');
  } finally {
    await removeDir(base);
  }
});
