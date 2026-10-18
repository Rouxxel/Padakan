import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRepo, removeDir, git } from '../helpers/index.mjs';
import { buildPack, renderHtml, renderMarkdown, filesFromGit } from '../../core/report.mjs';
import { validateFile } from '../../core/okf.mjs';
import { verdict } from '../../core/gates.mjs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';
import { buildContext } from '../../orchestrator/lib/context.mjs';
import { STEPS } from '../../orchestrator/steps.mjs';
import { updateTask } from '../../orchestrator/lib/state.mjs';

async function setup() {
  const env = await makeRepo('shop');
  await writeFile(join(env.repo, 'a.js'), 'export const a = 1;\n');
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'base');
  env.base_sha = git(env.repo, 'rev-parse', 'HEAD');
  await writeFile(join(env.repo, 'a.js'), 'export const a = 2;\nexport const b = 3;\n');
  await mkdir(join(env.repo, 'img'));
  await writeFile(join(env.repo, 'img', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'change');
  env.head = git(env.repo, 'rev-parse', 'HEAD');
  env.records = join(env.parent, 'shop-padakan');
  return env;
}

test('AC1: files touched come from git, including binaries', async () => {
  const env = await setup();
  try {
    const files = await filesFromGit(env.repo, env.base_sha, env.head);
    assert.deepEqual(files, [
      { path: 'a.js', added: 2, deleted: 1, binary: false },
      { path: 'img/logo.png', added: 0, deleted: 0, binary: true },
    ]);
  } finally {
    await removeDir(env.base);
  }
});

test('AC2: a missing item marks the pack incomplete, and the gates do not ship it', async () => {
  const env = await setup();
  try {
    const dir = join(env.records, 'tasks', 'PAD-1');
    await mkdir(join(dir, 'evidence', 'local'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'architecture.md'), '---\ntype: Architecture\ntitle: x\ndescription: x\ntags: [x]\ntimestamp: 2026-10-18T00:00:00Z\n---\n');
    const pack = await buildPack({ records: env.records, key: 'PAD-1', repo: env.repo, base: env.base_sha, head: env.head });
    assert.deepEqual(pack.status, { video: 'missing', architecture: 'present', files: 'present', ci: 'missing' });
    assert.equal(pack.present, 2);
    // Even a complete pack is only "present"; the gates need "verified".
    const v = verdict({ taskTests: { status: 'pass' }, acceptance: [{ id: 'AC1', result: 'pass' }], suite: { status: 'pass' }, e2e: [], diff: { pass: true }, okf: [], evidence: pack.status });
    assert.equal(v.verdict, 'ESCALATE');
    assert.ok(v.reasons.some((r) => r.detail === 'video missing'));
    assert.ok(v.reasons.some((r) => r.detail === 'architecture is present but not verified at its source'));
  } finally {
    await removeDir(env.base);
  }
});

test('an empty recording does not count as a video', async () => {
  const env = await setup();
  try {
    const ev = join(env.records, 'tasks', 'PAD-2', 'evidence', 'local');
    await mkdir(ev, { recursive: true });
    await writeFile(join(ev, 'empty.mp4'), '');
    await writeFile(join(ev, 'run.webm'), 'frames');
    const pack = await buildPack({ records: env.records, key: 'PAD-2' });
    assert.equal(pack.items.video.path, 'evidence/local/run.webm');
  } finally {
    await removeDir(env.base);
  }
});

test('AC3: the HTML report is self-contained; the markdown report is valid OKF', async () => {
  const env = await setup();
  try {
    const dir = join(env.records, 'tasks', 'PAD-3');
    await mkdir(join(dir, 'evidence', 'local'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'local', 'run.mp4'), 'video-bytes');
    await writeFile(join(dir, 'evidence', 'architecture.md'), '---\ntype: Architecture\ntitle: x\ndescription: x\ntags: [x]\ntimestamp: 2026-10-18T00:00:00Z\n---\n');
    await mkdir(join(dir, 'checks'), { recursive: true });
    await writeFile(join(dir, 'checks', 'poll.json'), JSON.stringify({ ci: 'pass', checks: [{ name: 'test', bucket: 'pass' }], pr: { url: 'https://github.com/o/r/pull/3' } }));
    const pack = await buildPack({ records: env.records, key: 'PAD-3', repo: env.repo, base: env.base_sha, head: env.head });
    assert.equal(pack.present, 4);
    const html = renderHtml({ ...pack, task: 'PAD-3<script>' }, { title: 'CSV <b>export</b>' });
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /(src|href)="https?:/i);
    assert.doesNotMatch(html, /@import|url\(http/i);
    assert.match(html, /PAD-3&lt;script&gt;/);
    assert.match(html, /<video controls preload="metadata" src="\.\/local\/run\.mp4">/);
    const mdFile = join(dir, 'evidence', 'evidence-report.md');
    await writeFile(mdFile, renderMarkdown(pack, { title: 'CSV export' }));
    assert.deepEqual(await validateFile(mdFile, { root: env.records }), []);
    assert.match(await readFile(mdFile, 'utf8'), /\| `a\.js` \| 2 \| 1 \|/);
  } finally {
    await removeDir(env.base);
  }
});

test('padakan evidence builds the pack, renders both reports and reports what is missing', async () => {
  const env = await setup();
  try {
    const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'local' } });
    const ctx = buildContext({ base: { settings, records: env.records, repo: env.repo }, overrides: { github: { remoteBranch: async () => null } } });
    await STEPS.init(ctx);
    await updateTask(env.records, 'PAD-4', { status: 'building', base: env.base_sha, head: env.head, title: 'CSV export' });
    const r = await STEPS.evidence(ctx, ['PAD-4']);
    assert.equal(r.code, 1);
    assert.equal(r.line, 'PACK=tasks/PAD-4/evidence/evidence-report.md ITEMS=1/4 MISSING=video,architecture,ci');
    for (const f of ['pack.json', 'evidence-report.md', 'evidence-report.html']) await readFile(join(env.records, 'tasks', 'PAD-4', 'evidence', f));
  } finally {
    await removeDir(env.base);
  }
});
