import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, tempDir, removeDir, runNode } from './helpers.mjs';
import { parseFrontmatter, validateText, validateFile, validateBundle, linksIn } from '../core/okf.mjs';
import { init } from '../orchestrator/lib/records.mjs';

const doc = (fm, body = '# Body\n') => `---\n${fm}\n---\n\n${body}`;
const FULL = 'type: Brief\ntitle: A brief\ndescription: What to build.\ntags: [task, brief]\ntimestamp: 2026-10-18T14:22:00Z';

test('parses scalars, inline lists, block lists and quotes', () => {
  const { data, problems } = parseFrontmatter(
    doc('type: Evidence Report\ntitle: "PAD-12 · Export: CSV"\ntags: [a, "b c"]\nsources:\n  - ./x.md\n  - ./y.md\ncount: 3 # a comment'),
  );
  assert.deepEqual(problems, []);
  assert.equal(data.type, 'Evidence Report');
  assert.equal(data.title, 'PAD-12 · Export: CSV');
  assert.deepEqual(data.tags, ['a', 'b c']);
  assert.deepEqual(data.sources, ['./x.md', './y.md']);
  assert.equal(data.count, '3');
});

test('a complete Padakan document passes', () => {
  assert.deepEqual(validateText(doc(FULL)), []);
});

test('AC1: a document without type fails, and so does one with no frontmatter', () => {
  assert.ok(validateText(doc(FULL.replace('type: Brief\n', ''))).includes('missing required field: type'));
  assert.deepEqual(validateText('# Just markdown\n'), ['no frontmatter (a document must start with ---)']);
});

test('the okf profile requires only type; the padakan profile requires the usual fields', () => {
  assert.deepEqual(validateText(doc('type: Note'), { profile: 'okf' }), []);
  const p = validateText(doc('type: Note'));
  assert.deepEqual(p.sort(), ['missing field: description', 'missing field: tags', 'missing field: timestamp', 'missing field: title']);
});

test('timestamps must be ISO 8601, except placeholders in template mode', () => {
  assert.ok(validateText(doc(FULL.replace(/timestamp: .*/, 'timestamp: yesterday'))).some((p) => p.startsWith('timestamp is not ISO 8601')));
  assert.deepEqual(validateText(doc(FULL.replace(/timestamp: .*/, 'timestamp: 2026-10-18'))), []);
  const tpl = doc(FULL.replace(/timestamp: .*/, 'timestamp: <YYYY-MM-DDTHH:MM:SSZ>'));
  assert.ok(validateText(tpl).length > 0);
  assert.deepEqual(validateText(tpl, { template: true }), []);
});

test('links in code are ignored; external links are not checked', () => {
  assert.deepEqual(linksIn('[a](./x.md) `[b](./y.md)`\n```\n[c](./z.md)\n```\n[d](https://e.com) ![img](./i.png)'), ['./x.md', 'https://e.com', './i.png']);
});

test('AC2: a broken relative link fails with the file and the link', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir, 'tasks', 'PAD-12'), { recursive: true });
    await writeFile(join(dir, 'tasks', 'PAD-12', 'record.md'), doc(FULL, '# Record\n'));
    await writeFile(join(dir, 'tasks', 'PAD-12', 'brief.md'), doc(FULL, 'See [the record](./record.md#verdict), [missing](./nope.md) and [root](/tasks/PAD-12/record.md).\n'));
    const problems = await validateFile(join(dir, 'tasks', 'PAD-12', 'brief.md'), { root: dir });
    assert.deepEqual(problems, ['broken link: ./nope.md']);
    const all = await validateBundle(dir);
    assert.equal(all.length, 1);
    assert.match(all[0].file, /brief\.md$/);
  } finally {
    await removeDir(dir);
  }
});

test('a link that leaves the bundle fails', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'outside.md'), doc(FULL));
    await writeFile(join(dir, 'b', 'a.md'), doc(FULL, '[up](../outside.md)\n'));
    assert.deepEqual(await validateFile(join(dir, 'b', 'a.md'), { root: join(dir, 'b') }), ['link leaves the bundle: ../outside.md']);
  } finally {
    await removeDir(dir);
  }
});

test('AC3: the shipped templates pass in template mode', async () => {
  const results = await validateBundle(join(ROOT, 'templates'), { template: true });
  assert.deepEqual(results, []);
});

test('AC3: a freshly initialised records folder is a valid OKF bundle', async () => {
  const dir = join(await tempDir(), 'shop-padakan');
  try {
    await init(dir);
    assert.deepEqual(await validateBundle(dir), []);
  } finally {
    await removeDir(join(dir, '..'));
  }
});

test('the orchestrator rules are valid OKF', async () => {
  assert.deepEqual(await validateFile(join(ROOT, 'orchestrator', 'RULES.md')), []);
});

test('CLI exits 1 and prints one line per problem', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'bad.md'), doc('title: no type'));
    const r = runNode(join(ROOT, 'core', 'okf.mjs'), ['--profile', 'okf', join(dir, 'bad.md')]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /bad\.md: missing required field: type/);
    const ok = runNode(join(ROOT, 'core', 'okf.mjs'), ['--template', join(ROOT, 'templates')]);
    assert.equal(ok.code, 0, ok.stdout);
  } finally {
    await removeDir(dir);
  }
});
