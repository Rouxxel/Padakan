// The CI docs gate for critical features: every features/<area>/<slug>/ folder ships five OKF
// documents and a spec, and its stories, criteria and assertions line up.
//
// Fails a feature when:
//   - feature.md, stories.md, workflow.md, playbook.md or setup.md is missing, or not valid OKF;
//   - tests/<slug>.spec.(ts|js|mjs) is missing;
//   - workflow.md has no diagram (a ```mermaid block or an image);
//   - a story has no criterion, or a criterion belongs to no story
//     (a playbook line that names USn and ACm links criterion m to story n);
//   - a criterion has no labelled assertion in the spec ('ACn: …').
// Type checking the spec is the project's own job (tsc) in the same workflow.
//
// CLI: node core/docs-gate.mjs [features-dir]   one line per problem; exit 1 on any.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFile } from './okf.mjs';

export const DOCS = ['feature.md', 'stories.md', 'workflow.md', 'playbook.md', 'setup.md'];

const ids = (text, prefix) => [...new Set([...text.matchAll(new RegExp(`\\b${prefix}(\\d+)\\b`, 'g'))].map((m) => Number(m[1])))].sort((a, b) => a - b);

// Every folder under root that holds a feature.md, or a playbook.md, counts as a feature.
async function featureDirs(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && (e.name === 'feature.md' || e.name === 'playbook.md'))) {
      out.push(dir);
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'tests') await walk(join(dir, e.name));
  }
  if (existsSync(root)) await walk(root);
  return out.sort();
}

export async function checkFeature(dir, { root = dir } = {}) {
  const problems = [];
  const slug = basename(dir);
  const read = async (f) => (existsSync(join(dir, f)) ? readFile(join(dir, f), 'utf8') : null);

  for (const doc of DOCS) {
    if (!existsSync(join(dir, doc))) {
      problems.push(`${doc} is missing`);
      continue;
    }
    for (const p of await validateFile(join(dir, doc), { root })) problems.push(`${doc}: ${p}`);
  }
  const specName = ['ts', 'js', 'mjs'].map((e) => `tests/${slug}.spec.${e}`).find((f) => existsSync(join(dir, f)));
  if (!specName) problems.push(`tests/${slug}.spec.ts is missing`);

  const workflow = await read('workflow.md');
  if (workflow && !/```mermaid|!\[[^\]]*\]\([^)]+\.(svg|png|jpg|jpeg)\)|<img\s/i.test(workflow)) problems.push('workflow.md has no diagram');

  const stories = await read('stories.md');
  const playbook = await read('playbook.md');
  if (stories && playbook) {
    const storyIds = ids(stories, 'US');
    const criteria = ids(playbook, 'AC');
    if (!storyIds.length) problems.push('stories.md defines no stories (US1…USn)');
    if (!criteria.length) problems.push('playbook.md defines no criteria (AC1…ACn)');
    const owner = new Map();
    for (const line of playbook.split('\n')) {
      const us = ids(line, 'US');
      const acs = ids(line, 'AC');
      if (us.length && acs.length) for (const a of acs) owner.set(a, [...new Set([...(owner.get(a) || []), ...us])]);
    }
    for (const s of storyIds) if (![...owner.values()].some((list) => list.includes(s))) problems.push(`US${s} has no criterion in playbook.md`);
    for (const a of criteria) if (!owner.has(a)) problems.push(`AC${a} belongs to no story`);
    for (const [a, list] of owner) for (const s of list) if (!storyIds.includes(s)) problems.push(`AC${a} names US${s}, which stories.md does not define`);

    if (specName) {
      const spec = await readFile(join(dir, specName), 'utf8');
      const asserted = new Set([...spec.matchAll(/['"`]AC(\d+):/g)].map((m) => Number(m[1])));
      for (const a of criteria) if (!asserted.has(a)) problems.push(`AC${a} has no labelled assertion ('AC${a}: …') in ${specName}`);
    }
  }
  return problems;
}

export async function docsGate(root) {
  const results = [];
  for (const dir of await featureDirs(root)) {
    for (const problem of await checkFeature(dir, { root })) results.push({ feature: relative(root, dir).split(sep).join('/'), problem });
  }
  return { features: (await featureDirs(root)).length, results };
}

async function main([root = 'features']) {
  const { features, results } = await docsGate(root);
  for (const r of results) console.log(`${r.feature}: ${r.problem}`);
  console.log(`DOCS_GATE=${results.length ? 'fail' : 'pass'} FEATURES=${features} PROBLEMS=${results.length}`);
  return results.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
