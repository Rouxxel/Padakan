import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, tempDir, removeDir, runNode } from './helpers.mjs';
import { docsGate, checkFeature } from '../core/docs-gate.mjs';

const fm = (type) => `---\ntype: ${type}\ntitle: Sign-in ${type}\ndescription: ${type} for sign-in.\ntags: [auth]\ntimestamp: 2026-10-18T00:00:00Z\n---\n\n`;

// A complete, valid feature folder.
async function feature(root, area = 'auth', slug = 'sign-in') {
  const dir = join(root, area, slug);
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'feature.md'), `${fm('Feature')}# Sign-in\nWhat it is.\n`);
  await writeFile(join(dir, 'stories.md'), `${fm('Stories')}# Stories\n\n## US1 Keep me out\n\n## US2 Send me back\n`);
  await writeFile(join(dir, 'workflow.md'), `${fm('Workflow')}# How it works\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`);
  await writeFile(join(dir, 'playbook.md'), `${fm('Playbook')}# Playbook\n\n| Story | Criteria |\n|---|---|\n| US1 | AC1, AC2 |\n| US2 | AC3 |\n`);
  await writeFile(join(dir, 'setup.md'), `${fm('Setup')}# Setup\nA mailbox.\n`);
  await writeFile(join(dir, 'tests', `${slug}.spec.ts`), `test('sign-in', async () => {\n  expect.soft(a, 'AC1: no workspace').toBe(0);\n  expect.soft(b, 'AC2: no foreign host').toEqual([]);\n  expect.soft(c, "AC3: lands where headed").toBe(true);\n});\n`);
  return dir;
}

test('a complete feature passes', async () => {
  const root = await tempDir();
  try {
    await feature(root);
    const r = await docsGate(root);
    assert.equal(r.features, 1);
    assert.deepEqual(r.results, []);
  } finally {
    await removeDir(root);
  }
});

test('AC1: each missing piece fails the gate', async () => {
  const cases = [
    ['a missing document', async (d) => rm(join(d, 'setup.md')), /setup\.md is missing/],
    ['an invalid OKF document', async (d) => writeFile(join(d, 'feature.md'), '# no frontmatter\n'), /feature\.md: no frontmatter/],
    ['a missing spec', async (d) => rm(join(d, 'tests', 'sign-in.spec.ts')), /tests\/sign-in\.spec\.ts is missing/],
    ['a workflow without a diagram', async (d) => writeFile(join(d, 'workflow.md'), `${fm('Workflow')}Words only.\n`), /workflow\.md has no diagram/],
    ['a story with no criterion', async (d) => writeFile(join(d, 'stories.md'), `${fm('Stories')}## US1\n## US2\n## US3 Orphan\n`), /US3 has no criterion/],
    ['a criterion in no story', async (d) => writeFile(join(d, 'playbook.md'), `${fm('Playbook')}| US1 | AC1, AC2 |\n| US2 | AC3 |\n\nStep 4 is judged by AC4.\n`), /AC4 belongs to no story/],
    ['a criterion without an assertion', async (d) => writeFile(join(d, 'tests', 'sign-in.spec.ts'), `expect.soft(a, 'AC1: x');\nexpect.soft(b, 'AC3: y');\n`), /AC2 has no labelled assertion/],
    ['a criterion naming an unknown story', async (d) => writeFile(join(d, 'playbook.md'), `${fm('Playbook')}| US1 | AC1, AC2 |\n| US2 | AC3 |\n| US9 | AC3 |\n`), /AC3 names US9/],
  ];
  for (const [name, breakIt, expected] of cases) {
    const root = await tempDir();
    try {
      const dir = await feature(root);
      await breakIt(dir);
      const problems = await checkFeature(dir, { root });
      assert.ok(problems.some((p) => expected.test(p)), `${name}: ${JSON.stringify(problems)}`);
    } finally {
      await removeDir(root);
    }
  }
});

test('the CLI prints one line per problem and a result line', async () => {
  const root = await tempDir();
  try {
    await feature(root);
    const bad = await feature(root, 'billing', 'checkout');
    await rm(join(bad, 'stories.md'));
    const r = runNode(join(ROOT, 'core', 'docs-gate.mjs'), [root]);
    assert.equal(r.code, 1);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.at(-1), 'DOCS_GATE=fail FEATURES=2 PROBLEMS=1');
    assert.equal(lines[0], 'billing/checkout: stories.md is missing');
  } finally {
    await removeDir(root);
  }
});

test('AC2: the CI templates use no secret in a run line and never target production', async () => {
  for (const f of ['ci/github/padakan-docs-gate.yml', 'ci/github/padakan-e2e.yml', '.github/workflows/test.yml']) {
    const text = await readFile(join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /echo .*\$\{\{\s*secrets\./, `${f} must not echo a secret`);
    assert.doesNotMatch(text, /set -x/, `${f} must not trace commands`);
    assert.match(text, /permissions:\n\s+contents: read/, `${f} has read-only permissions`);
  }
  const e2e = await readFile(join(ROOT, 'ci', 'github', 'padakan-e2e.yml'), 'utf8');
  assert.match(e2e, /refusing to run against production/);
  assert.match(e2e, /pull_request/);
  assert.match(e2e, /branches: \[main\]/);
});
