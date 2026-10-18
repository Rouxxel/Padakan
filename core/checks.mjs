// The agents' facts for verify: read tasks/<KEY>/checks/*.json, validate each against
// schemas/checks.json, and work out from the manifest what this task must prove.
//
// readChecks({ dir, manifest }) -> { input: { taskTests, acceptance, suite, e2e, evidence, requires }, invalid, notes }
// A missing file stays undefined (the gates escalate on it); an invalid file is reported in `invalid`
// and also left undefined. Nothing here decides the verdict: core/gates.mjs does.

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './schema.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CHECK_SCHEMAS = JSON.parse(readFileSync(join(PLUGIN, 'schemas', 'checks.json'), 'utf8'));
const UI_TARGETS = ['web', 'ios', 'android'];

// What the task must prove, from its manifest. No manifest: everything (the strict default).
export function requirements(manifest) {
  if (!manifest || !manifest.target) return { video: true, e2e: true };
  const steps = new Set((manifest.estimates || []).map((e) => e.step));
  return {
    video: UI_TARGETS.includes(manifest.target) || steps.has('video'),
    e2e: steps.has('e2e-staging'),
  };
}

async function readJson(file) {
  if (!existsSync(file)) return { missing: true };
  try {
    return { value: JSON.parse(await readFile(file, 'utf8')) };
  } catch (e) {
    return { error: `not valid JSON (${e.message.split('\n')[0]})` };
  }
}

export async function readChecks({ dir, manifest = null }) {
  const invalid = [];
  const notes = [];
  const files = {};
  for (const name of Object.keys(CHECK_SCHEMAS).filter((k) => k.endsWith('.json'))) {
    const r = await readJson(join(dir, name));
    if (r.missing) continue;
    if (r.error) {
      invalid.push(`checks/${name}: ${r.error}`);
      continue;
    }
    let value = r.value;
    // The acceptance-tester may write both lists in one file: { acceptance: [...], e2e: [...] }.
    if (name === 'acceptance.json' && value && !Array.isArray(value) && Array.isArray(value.acceptance)) {
      if (Array.isArray(value.e2e) && files['e2e.json'] === undefined && !existsSync(join(dir, 'e2e.json'))) files['e2e.json'] = value.e2e;
      value = value.acceptance;
    }
    const problems = validate(CHECK_SCHEMAS[name], value);
    if (problems.length) {
      invalid.push(...problems.slice(0, 3).map((p) => `checks/${name}: ${p.replace(/^\$/, 'value')}`));
      continue;
    }
    files[name] = value;
  }
  const requires = requirements(manifest);
  let e2e = files['e2e.json'];
  if (e2e === undefined && !requires.e2e && !invalid.some((i) => i.startsWith('checks/e2e.json'))) {
    e2e = [];
    notes.push('no e2e step in the manifest: no end-to-end spec applies');
  }
  if (!requires.video) notes.push(`target ${manifest.target} with no video step: video is not required`);
  return {
    input: { taskTests: files['tests.json'], acceptance: files['acceptance.json'], suite: files['suite.json'], e2e, evidence: files['evidence.json'], requires },
    invalid,
    notes,
  };
}
