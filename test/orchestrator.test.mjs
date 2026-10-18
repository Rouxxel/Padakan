import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, makeRepo, removeDir, git, runNode } from './helpers.mjs';
import { buildContext } from '../orchestrator/lib/context.mjs';
import { createGithub } from '../orchestrator/lib/github.mjs';
import { STEPS } from '../orchestrator/steps.mjs';
import { doctor } from '../orchestrator/doctor.mjs';
import { loadSettings } from '../orchestrator/lib/env.mjs';
import { readState } from '../orchestrator/lib/state.mjs';

const okfDoc = (type, title) => `---\ntype: ${type}\ntitle: ${title}\ndescription: ${title} for the test.\ntags: [test]\ntimestamp: 2026-10-18T10:00:00Z\n---\n\n# ${title}\n`;

// A project with a bare remote, initialised records, the local provider and a GitHub whose PRs are faked.
async function project() {
  const env = await makeRepo('shop');
  const remote = join(env.base, 'remote.git');
  git(env.base, 'init', '-q', '--bare', remote);
  git(env.repo, 'remote', 'add', 'origin', remote);
  await writeFile(join(env.repo, 'app.js'), 'export const a = 1;\n');
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'app');
  git(env.repo, 'push', '-q', '-u', 'origin', 'main');
  const records = join(env.parent, 'shop-padakan');
  const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'local', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.st' } });
  const fake = { pr: null, merged: [] };
  const real = createGithub();
  const github = {
    ...real,
    prForBranch: async () => fake.pr,
    prChecks: async () => ({ ci: 'pass', checks: [{ name: 'ci', bucket: 'pass' }] }),
    mergePr: async (repo, n) => {
      fake.merged.push(n);
      return { merged: true };
    },
  };
  const ctx = buildContext({ base: { settings, records, repo: env.repo }, overrides: { github } });
  return { ...env, records, ctx, fake };
}

const run = (ctx, step, ...args) => STEPS[step](ctx, args);

test('the full lifecycle: init → plant → brief → work → poll → verify → merge → retire', async () => {
  const p = await project();
  try {
    assert.match((await run(p.ctx, 'init')).line, /^RECORDS=.*shop-padakan CREATED=4$/);

    const planted = await run(p.ctx, 'plant', 'PAD-12');
    assert.equal(planted.line, 'TREE=pad-12 STATE=ready BRANCH=padakan/PAD-12');
    assert.equal((await readState(p.records)).tasks['PAD-12'].status, 'planted');

    // An invalid brief is refused; a valid OKF brief is stored and delivered.
    await writeFile(join(p.base, 'bad.md'), '# no frontmatter\n');
    const bad = await run(p.ctx, 'brief', 'PAD-12', join(p.base, 'bad.md'));
    assert.equal(bad.code, 1);
    assert.match(bad.line, /^BRIEF=invalid PROBLEMS=1$/);
    await writeFile(join(p.base, 'brief.md'), okfDoc('Brief', 'PAD-12 brief'));
    assert.equal((await run(p.ctx, 'brief', 'PAD-12', join(p.base, 'brief.md'))).line, 'TREE=pad-12 BRIEF=delivered');

    // Nothing pushed yet: the effect is not done, whatever the tree says.
    assert.match((await run(p.ctx, 'poll', 'PAD-12')).line, /PUSHED=no COMMITS=0 PR=none CI=none EFFECT=not-yet$/);

    // The builder works in the tree and pushes.
    const r = await p.ctx.gateway.exec('pad-12', 'echo "export const b = 2;" > b.js && git add b.js && git commit -q -m "feat: b" && git push -q origin HEAD');
    assert.equal(r.code, 0, r.stderr);
    const sha = git(p.repo, 'ls-remote', 'origin', 'refs/heads/padakan/PAD-12').split(/\s+/)[0];
    p.fake.pr = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', headRefOid: sha };
    assert.match((await run(p.ctx, 'poll', 'PAD-12')).line, /PUSHED=yes COMMITS=1 PR=https:\/\/github\.com\/o\/r\/pull\/7 CI=pass EFFECT=done$/);

    // Without the agents' facts the gates escalate, and merge refuses.
    const v1 = await run(p.ctx, 'verify', 'PAD-12');
    assert.equal(v1.code, 1);
    assert.match(v1.line, /^VERDICT=ESCALATE REASONS=\d+ FIRST="taskTests: missing input: taskTests" CHECKS=tasks\/PAD-12\/checks\/verify\.md$/);
    assert.match((await run(p.ctx, 'merge', 'PAD-12')).line, /MERGED=no REASON="verdict is ESCALATE"/);

    // The agents write their facts; the gates pass.
    const checks = join(p.records, 'tasks', 'PAD-12', 'checks');
    const put = (name, value) => writeFile(join(checks, name), JSON.stringify(value));
    await put('tests.json', { status: 'pass', passed: 3 });
    await put('acceptance.json', [{ id: 'AC1', result: 'pass' }]);
    await put('suite.json', { status: 'pass' });
    await put('e2e.json', []);
    await put('evidence.json', { video: 'verified', architecture: 'verified', files: 'verified', ci: 'verified' });
    const v2 = await run(p.ctx, 'verify', 'PAD-12');
    assert.equal(v2.line, 'VERDICT=SHIP CHECKS=tasks/PAD-12/checks/verify.md');
    assert.equal((await readState(p.records)).tasks['PAD-12'].verdict, 'SHIP');

    // A PR that moved after verification is not merged.
    p.fake.pr = { ...p.fake.pr, headRefOid: 'f'.repeat(40) };
    assert.match((await run(p.ctx, 'merge', 'PAD-12')).line, /changed after verification/);
    p.fake.pr = { ...p.fake.pr, headRefOid: sha };
    assert.equal((await run(p.ctx, 'merge', 'PAD-12')).line, `MERGED=yes PR=https://github.com/o/r/pull/7 HEAD=${sha.slice(0, 12)}`);
    assert.deepEqual(p.fake.merged, [7]);

    const retired = await run(p.ctx, 'retire', 'PAD-12');
    assert.equal(retired.line, 'TREE=pad-12 RECORD=none DESTROYED=yes');

    const audit = await p.ctx.audit.verify();
    assert.equal(audit.ok, true);
    const types = (await p.ctx.audit.replay({ task: 'PAD-12' })).map((e) => e.event.type);
    assert.deepEqual(types, ['tree.planted', 'tree.briefed', 'gates.verdict', 'gates.verdict', 'pr.merge', 'tree.retired']);

    assert.match((await run(p.ctx, 'status')).line, /^TASKS=1 OPEN=0 GATE=closed$/);
  } finally {
    await removeDir(p.base);
  }
});

test('HUMAN_MERGE needs a named approver', async () => {
  const p = await project();
  try {
    await run(p.ctx, 'init');
    await run(p.ctx, 'plant', 'PAD-13');
    const dir = join(p.records, 'tasks', 'PAD-13', 'checks');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'verify.json'), JSON.stringify({ head: 'a'.repeat(40), verdict: 'HUMAN_MERGE', reasons: [] }));
    p.fake.pr = { number: 9, url: 'u9', headRefOid: 'a'.repeat(40) };
    assert.match((await run(p.ctx, 'merge', 'PAD-13')).line, /needs --approved-by/);
    assert.match((await run(p.ctx, 'merge', 'PAD-13', '--approved-by', 'javier')).line, /^MERGED=yes/);
    assert.equal((await readState(p.records)).tasks['PAD-13'].approved_by, 'javier');
  } finally {
    await removeDir(p.base);
  }
});

test('recycle replaces a tree from the remote branch, and refuses when nothing was pushed', async () => {
  const p = await project();
  try {
    await run(p.ctx, 'init');
    await run(p.ctx, 'plant', 'PAD-14');
    assert.match((await run(p.ctx, 'recycle', 'PAD-14')).line, /RECYCLED=no REASON="branch padakan\/PAD-14 is not on the remote/);
    await p.ctx.gateway.exec('pad-14', 'echo x > x.txt && git add x.txt && git commit -q -m x && git push -q origin HEAD');
    const r = await run(p.ctx, 'recycle', 'PAD-14');
    assert.match(r.line, /^TREE=pad-14 RECYCLED=yes FROM=[0-9a-f]{12}$/);
    assert.equal((await p.ctx.gateway.exec('pad-14', 'cat x.txt')).stdout.trim(), 'x', 'the pushed work is in the new tree');
  } finally {
    await removeDir(p.base);
  }
});

test('doctor prints one line per check and a verdict', async () => {
  const p = await project();
  try {
    await run(p.ctx, 'init');
    const probe = async (cmd) => (cmd === 'gh' ? { ok: false, out: 'not logged in' } : { ok: true, out: `${cmd} 1.0` });
    const d = await doctor(p.ctx, { probe });
    assert.match(d.line, /^DOCTOR=fail FAILED=1 WARN=\d+$/);
    assert.ok(d.details.includes('CHECK gh fail not logged in'));
    assert.ok(d.details.some((l) => /^CHECK provider ok local$/.test(l)));
    assert.ok(d.details.some((l) => /^CHECK settings ok/.test(l)));
  } finally {
    await removeDir(p.base);
  }
});

test('bin/padakan runs a step from the repository and prints its result line last', async () => {
  const p = await project();
  try {
    const env = { PADAKAN_SANDBOX_PROVIDER: 'local' };
    const init = runNode(join(ROOT, 'bin', 'padakan'), ['init'], { cwd: p.repo, env });
    assert.equal(init.code, 0, init.stdout + init.stderr);
    const s = runNode(join(ROOT, 'bin', 'padakan'), ['status'], { cwd: p.repo, env });
    assert.equal(s.stdout.trim().split('\n').pop(), 'TASKS=0 OPEN=0 GATE=closed');
    const bad = runNode(join(ROOT, 'bin', 'padakan'), ['plant', 'bad key'], { cwd: p.repo, env });
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /^ERROR=".*invalid task key/m);
    assert.equal(runNode(join(ROOT, 'bin', 'padakan'), ['nosuch'], { cwd: p.repo, env }).code, 2);
  } finally {
    await removeDir(p.base);
  }
});

test('gate opens and closes the plan window; pause stops tasks', async () => {
  const p = await project();
  try {
    await run(p.ctx, 'init');
    assert.equal((await run(p.ctx, 'gate', 'open')).line, 'GATE=plan');
    assert.equal((await readState(p.records)).gate, 'plan');
    assert.equal((await run(p.ctx, 'gate', 'close')).line, 'GATE=closed');
    assert.equal((await run(p.ctx, 'gate', 'sideways')).code, 1);
    await run(p.ctx, 'plant', 'PAD-20');
    await run(p.ctx, 'plant', 'PAD-21');
    assert.equal((await run(p.ctx, 'pause', 'all')).line, 'PAUSED=2 TREES_STOPPED=0');
    const s = await readState(p.records);
    assert.equal(s.tasks['PAD-20'].status, 'paused');
    assert.equal(s.tasks['PAD-20'].paused_from, 'planted');
  } finally {
    await removeDir(p.base);
  }
});
