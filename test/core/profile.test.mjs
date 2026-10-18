import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRepo, removeDir, git } from '../helpers/index.mjs';
import { projectProfile } from '../../core/profile.mjs';
import { buildManifest, REGISTRY } from '../../core/resolver.mjs';

test('the profile reads facts from tracked files only', async () => {
  const { base, repo } = await makeRepo('app');
  try {
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { express: '4' } }));
    await writeFile(join(repo, 'src', 'server.mjs'), 'import express from "express"; express().listen(3000);\n');
    await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    await writeFile(join(repo, 'Dockerfile.untracked'), 'FROM x\n');
    git(repo, 'add', 'package.json', 'src', '.github');
    git(repo, 'commit', '-q', '-m', 'app');
    const p = await projectProfile(repo);
    assert.equal(p.signals.http_server, true);
    assert.equal(p.signals.ci, true);
    assert.equal(p.signals.docker, false, 'untracked files are not facts');
    assert.equal(p.signals.ui, false);
    assert.deepEqual(p.package.dependencies, ['express']);
    assert.equal(p.languages['.mjs'], 1);

    await writeFile(join(repo, 'docker-compose.yml'), 'services: {}\n');
    await writeFile(join(repo, 'src', 'App.tsx'), 'export default () => null;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'ui');
    const q = await projectProfile(repo);
    assert.equal(q.signals.docker, true);
    assert.equal(q.signals.ui, true);
  } finally {
    await removeDir(base);
  }
});

test('the resolver may only narrow a target kit, and never drops its keep tools', () => {
  const task = { key: 'PAD-1' };
  const settings = { PADAKAN_SANDBOX_PROVIDER: 'local' };
  const est = [{ step: 'build', unit: 'tokens', low: 1, likely: 2, high: 3 }];
  const m = (proposal) => buildManifest({ task, settings, proposal: { target: 'backend', extra_skills: [], allow_dependencies: [], estimates: est, rationale: 'r', ...proposal } });
  assert.deepEqual(m({ cli: [] }).verify_kit.cli, ['git', 'gh', 'curl'], 'curl is kept for backend; docker tools dropped');
  assert.deepEqual(m({ cli: ['docker compose', 'lighthouse'] }).verify_kit.cli, ['git', 'gh', 'curl', 'docker compose'], 'a tool outside the target kit is never added');
  assert.deepEqual(m({}).verify_kit.cli, ['git', 'gh', ...REGISTRY.targets.backend.cli], 'no answer: the full kit');
  const web = buildManifest({ task, settings, proposal: { target: 'web', extra_skills: [], mcp: [], cli: [], allow_dependencies: [], estimates: est, rationale: 'r' } });
  assert.deepEqual(web.verify_kit.mcp, ['playwright'], 'a web change keeps a browser');
});
