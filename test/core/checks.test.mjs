import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir, removeDir } from '../helpers/index.mjs';
import { readChecks, requirements } from '../../core/checks.mjs';
import { verdict } from '../../core/gates.mjs';

const backend = { target: 'backend', estimates: [{ step: 'build' }, { step: 'suite' }] };

test('requirements come from the manifest; no manifest requires everything', () => {
  assert.deepEqual(requirements(null), { video: true, e2e: true });
  assert.deepEqual(requirements(backend), { video: false, e2e: false });
  assert.deepEqual(requirements({ target: 'web', estimates: [] }), { video: true, e2e: false });
  assert.deepEqual(requirements({ target: 'backend', estimates: [{ step: 'video' }, { step: 'e2e-staging' }] }), { video: true, e2e: true });
});

test('a backend task with the documented files ships; the combined acceptance form is accepted', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'tests.json'), JSON.stringify({ status: 'pass', passed: 8, failed: 0 }));
    await writeFile(join(dir, 'suite.json'), JSON.stringify({ status: 'pass' }));
    await writeFile(join(dir, 'acceptance.json'), JSON.stringify({ acceptance: [{ id: 'AC1', result: 'pass' }, { id: 'AC2', result: 'pass' }], e2e: [] }));
    await writeFile(join(dir, 'evidence.json'), JSON.stringify({ video: 'not-applicable', architecture: 'verified', files: 'verified', ci: 'verified' }));
    const r = await readChecks({ dir, manifest: backend });
    assert.deepEqual(r.invalid, []);
    assert.equal(r.input.acceptance.length, 2);
    assert.deepEqual(r.input.e2e, []);
    const v = verdict({ ...r.input, diff: { pass: true, checks: [] }, okf: [], invalid: r.invalid });
    assert.equal(v.verdict, 'SHIP', JSON.stringify(v.reasons));
  } finally {
    await removeDir(dir);
  }
});

test('no e2e.json: [] when the manifest has no e2e step, missing when it has one', async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual((await readChecks({ dir, manifest: backend })).input.e2e, []);
    assert.equal((await readChecks({ dir, manifest: { target: 'web', estimates: [{ step: 'e2e-staging' }] } })).input.e2e, undefined);
    assert.equal((await readChecks({ dir })).input.e2e, undefined, 'no manifest: strict');
  } finally {
    await removeDir(dir);
  }
});

test('an invalid or unparsable file is named, and left out', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'tests.json'), JSON.stringify({ status: 'ok', passed: 8 }));
    await writeFile(join(dir, 'suite.json'), '{not json');
    await writeFile(join(dir, 'acceptance.json'), JSON.stringify([{ id: 'criterion one', result: 'pass' }]));
    const r = await readChecks({ dir, manifest: backend });
    assert.equal(r.input.taskTests, undefined);
    assert.equal(r.input.suite, undefined);
    assert.ok(r.invalid.some((i) => /^checks\/tests\.json: value\.status: "ok" not in enum/.test(i)), r.invalid.join('\n'));
    assert.ok(r.invalid.some((i) => /^checks\/suite\.json: not valid JSON/.test(i)));
    assert.ok(r.invalid.some((i) => /^checks\/acceptance\.json: .*id/.test(i)));
    assert.equal(verdict({ ...r.input, diff: { pass: true }, okf: [], invalid: r.invalid }).reasons[0].gate, 'checks');
  } finally {
    await removeDir(dir);
  }
});
