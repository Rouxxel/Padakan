// The capability resolver: a decision model chooses a task's target, extra skills, allowed
// dependency files and cost estimates; deterministic code then builds the manifest from the registry.
// The model cannot add a tool that is not in registry/capabilities.json, cannot mark a required step
// optional, and cannot pick a platform the target cannot run on. The human is not asked.
//
// resolve({ task, prd, settings, client, registry?, skillsAvailable? }) -> manifest (schemas/manifest.json)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './schema.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY = JSON.parse(readFileSync(join(PLUGIN, 'registry', 'capabilities.json'), 'utf8'));
export const MANIFEST_SCHEMA = JSON.parse(readFileSync(join(PLUGIN, 'schemas', 'manifest.json'), 'utf8'));

export class ResolverError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResolverError';
  }
}

export function availableSkills(dir = join(PLUGIN, 'skills')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// What the model must answer.
export function proposalSchema(registry = REGISTRY) {
  return {
    type: 'object',
    required: ['target', 'extra_skills', 'allow_dependencies', 'estimates', 'rationale'],
    additionalProperties: false,
    properties: {
      target: { type: 'string', enum: Object.keys(registry.targets) },
      extra_skills: { type: 'array', items: { type: 'string', enum: registry.optional_skills } },
      allow_dependencies: { type: 'array', items: { type: 'string' } },
      estimates: {
        type: 'array',
        items: {
          type: 'object',
          required: ['step', 'unit', 'low', 'likely', 'high'],
          additionalProperties: false,
          properties: {
            step: { type: 'string', enum: Object.keys(registry.steps) },
            unit: { type: 'string', pattern: '^[a-z0-9:._/-]+$' },
            low: { type: 'number', minimum: 0 },
            likely: { type: 'number', minimum: 0 },
            high: { type: 'number', minimum: 0 },
          },
        },
      },
      rationale: { type: 'string' },
    },
  };
}

export function buildPrompt({ task, prd, settings, registry = REGISTRY }) {
  const system = [
    'You are the capability resolver of Padakan, an autonomous development system.',
    'For one task you choose: the target (web, ios, android or backend), extra skills from the optional list,',
    'dependency files the task legitimately needs to change (usually none), and cost estimates per step as ranges.',
    `Estimate the build step in "${settings.PADAKAN_SANDBOX_PROVIDER === 'devin' ? 'acu' : 'tokens'}" units; CI in "ci_minute"; device probes in "device_minute".`,
    'Be conservative: allow a dependency file only when the task cannot be done without changing it.',
    `Registry: ${JSON.stringify({ targets: Object.keys(registry.targets), optional_skills: registry.optional_skills, steps: Object.keys(registry.steps) })}`,
  ].join(' ');
  const user = [`Task ${task.key}: ${task.title || ''}`, task.description || '', task.criteria ? `Acceptance criteria:\n${task.criteria}` : '', prd ? `PRD (tech stack and architecture):\n${prd.slice(0, 6000)}` : '']
    .filter(Boolean)
    .join('\n\n');
  return { system, user };
}

// Deterministic: turn a validated proposal into the manifest. Throws ResolverError on anything off-registry.
export function buildManifest({ task, proposal, settings, registry = REGISTRY, skillsAvailable = availableSkills(), model = 'unknown', now = () => new Date().toISOString() }) {
  const kit = registry.targets[proposal.target];
  if (!kit) throw new ResolverError(`unknown target "${proposal.target}"`);
  // Platform: what the target needs. Devin's default platform applies only where the target allows it.
  // A Linux target may run on a Devin Outpost pool named in DEVIN_PLATFORM; other targets need their own platform.
  const pool = settings.PADAKAN_SANDBOX_PROVIDER === 'devin' && settings.DEVIN_PLATFORM && !['linux', 'macos', 'windows'].includes(settings.DEVIN_PLATFORM);
  const platform = kit.platform === 'linux' && pool ? settings.DEVIN_PLATFORM : kit.platform;
  // entire-context only when Entire is on, whatever the model proposed.
  const extra = proposal.extra_skills.filter((x) => x !== 'entire-context' || settings.ENTIRE_ENABLED);
  const skills = [...new Set([...registry.always.skills, ...kit.skills, ...extra, ...(settings.ENTIRE_ENABLED ? ['entire-context'] : [])])].sort();
  const missingSkills = skills.filter((s) => !skillsAvailable.includes(s));
  if (missingSkills.length) throw new ResolverError(`skills not shipped with the plugin: ${missingSkills.join(', ')}`);

  const seen = new Set();
  const estimates = proposal.estimates.map((e) => {
    if (seen.has(e.step)) throw new ResolverError(`two estimates for step "${e.step}"`);
    seen.add(e.step);
    if (!(e.low <= e.likely && e.likely <= e.high)) throw new ResolverError(`estimate for "${e.step}" needs low <= likely <= high`);
    return { ...e, required: !!registry.steps[e.step]?.required };
  });
  if (!seen.has('build')) throw new ResolverError('no estimate for the "build" step');

  const manifest = {
    task: task.key,
    target: proposal.target,
    platform,
    verify_kit: { mcp: [...kit.mcp], cli: [...registry.always.cli, ...kit.cli] },
    skills,
    allowDependencies: [...new Set(proposal.allow_dependencies)].sort(),
    estimates: estimates.sort((a, b) => a.step.localeCompare(b.step)),
    rationale: proposal.rationale,
    resolved_by: model,
    resolved_at: now(),
  };
  const problems = validate(MANIFEST_SCHEMA, manifest);
  if (problems.length) throw new ResolverError(`manifest is invalid: ${problems.join('; ')}`);
  return manifest;
}

export async function resolve({ task, prd = '', settings, client, registry = REGISTRY, skillsAvailable, now }) {
  if (client.kind === 'systemone') {
    const { proposal, usage, model } = await systemOneProposal({ task, prd, settings, client, registry });
    return { manifest: buildManifest({ task, proposal, settings, registry, skillsAvailable, model, now }), usage };
  }
  const { system, user } = buildPrompt({ task, prd, settings, registry });
  const model = settings.PADAKAN_RESOLVER_MODEL;
  const { data, usage } = await client.chatJson({ model, system, user, schema: proposalSchema(registry), name: 'capability_manifest' });
  const manifest = buildManifest({ task, proposal: data, settings, registry, skillsAvailable, model, now });
  return { manifest, usage };
}

// ── System One (TypeSafe Jev): the same proposal, asked as typed questions ─────────────────────

const TARGET_MEANING = {
  web: 'a change a user sees in a web browser (pages, components, styles, client-side behaviour)',
  ios: 'an iPhone or iPad app (Swift, Xcode)',
  android: 'an Android app (Kotlin, Gradle)',
  backend: 'server, API, CLI, library or data code with no user interface of its own',
};
const SKILL_QUESTION = {
  'entire-context': 'Would this task benefit from searching past agent sessions and the code graph to understand why existing code is the way it is?',
  'feature-docs': 'Does this task create or substantially change a critical user-facing feature that needs its own feature documents?',
  'triage-categories': 'Does this task involve sorting or classifying production errors or logs?',
  'cost-gate': 'Does this task involve estimating, tracking or reporting spend?',
};
const STEP_QUESTION = {
  video: 'Should the change be proven with a screen recording of the app?',
  'device-probe': 'Does proving this change need a real or emulated mobile device?',
  'browser-matrix': 'Does this change need checking across several browsers?',
  'e2e-staging': 'Does this change touch a critical end-to-end flow that should be run on staging?',
};
// Cost buckets per unit: Jev rates a step on this ladder and the range comes from its probabilities.
export const BUCKETS = {
  tokens: [50_000, 150_000, 400_000, 1_000_000, 2_500_000],
  acu: [1, 3, 6, 12, 25],
  ci_minute: [1, 3, 8, 20, 45],
  device_minute: [1, 3, 8, 20, 45],
};
const DEVICE_STEPS = new Set(['video', 'device-probe']);

export function stepUnit(step, settings) {
  if (step === 'build') return settings.PADAKAN_SANDBOX_PROVIDER === 'devin' ? 'acu' : 'tokens';
  return DEVICE_STEPS.has(step) ? 'device_minute' : 'ci_minute';
}

// low / likely / high: the buckets where the cumulative probability first reaches 10 %, 50 % and 90 %.
export function rangeFromScore(probabilities, buckets) {
  const p = buckets.map((_, i) => Number(probabilities?.[String(i)] ?? 0));
  const total = p.reduce((a, b) => a + b, 0) || 1;
  const at = (q) => {
    let acc = 0;
    for (let i = 0; i < p.length; i++) {
      acc += p[i] / total;
      if (acc >= q - 1e-9) return buckets[i];
    }
    return buckets.at(-1);
  };
  return { low: at(0.1), likely: at(0.5), high: at(0.9) };
}

export function systemOneQuestions({ settings, registry = REGISTRY }) {
  const questions = {
    target: {
      type: 'choice',
      instructions: 'Which kind of software does `task` change? Use `prd` for the tech stack.',
      criteria: Object.fromEntries(Object.keys(registry.targets).map((t) => [t, TARGET_MEANING[t] || null])),
    },
  };
  for (const skill of registry.optional_skills) {
    if (skill === 'entire-context') continue; // added by buildManifest when ENTIRE_ENABLED, never chosen
    questions[`skill:${skill}`] = { type: 'noul', instructions: SKILL_QUESTION[skill] || `Does this task need the ${skill} skill?` };
  }
  for (const [step, { required }] of Object.entries(registry.steps)) {
    if (!required) questions[`step:${step}`] = { type: 'noul', instructions: STEP_QUESTION[step] || `Does this task need the optional "${step}" step?` };
    const unit = stepUnit(step, settings);
    questions[`cost:${step}`] = {
      type: 'score',
      instructions: `How much ${unit === 'tokens' ? 'agent work (model tokens)' : unit === 'acu' ? 'agent work (Devin ACUs)' : unit === 'device_minute' ? 'device time (minutes)' : 'CI time (minutes)'} will the "${step}" step of this task take?`,
      criteria: BUCKETS[unit].map((v) => `about ${v.toLocaleString('en-US')} ${unit}`),
    };
  }
  return questions;
}

export async function systemOneProposal({ task, prd = '', settings, client, registry = REGISTRY }) {
  const state = {
    task: { key: task.key, title: task.title || '', description: task.description || '', acceptance_criteria: task.criteria || '' },
    prd: prd.slice(0, 12_000),
  };
  const { answers, usage, model } = await client.systemOne({ state, questions: systemOneQuestions({ settings, registry }) });
  const extra = registry.optional_skills.filter((s) => answers[`skill:${s}`]?.noul >= 0.5);
  const steps = Object.entries(registry.steps).filter(([step, { required }]) => required || answers[`step:${step}`].noul >= 0.5).map(([step]) => step);
  const estimates = steps.map((step) => {
    const unit = stepUnit(step, settings);
    return { step, unit, ...rangeFromScore(answers[`cost:${step}`].probabilities, BUCKETS[unit]) };
  });
  const t = answers.target;
  const rationale = [
    `System One (${model}): target ${t.choice} at confidence ${Number(t.confidence ?? 0).toFixed(2)}`,
    extra.length ? `extra skills ${extra.join(', ')}` : 'no extra skills',
    `optional steps ${steps.filter((s) => !registry.steps[s].required).join(', ') || 'none'}`,
    'no dependency changes allowed (a System One model cannot name files)',
  ].join('; ');
  return { proposal: { target: t.choice, extra_skills: extra, allow_dependencies: [], estimates, rationale }, usage, model };
}

// One line for the orchestrator.
export function resultLine(path, manifest) {
  const build = manifest.estimates.find((e) => e.step === 'build');
  return `MANIFEST=${path} TARGET=${manifest.target} PLATFORM=${manifest.platform} COST_HIGH=${build.high}${build.unit} REQUIRED=${manifest.estimates.filter((e) => e.required).length} OPTIONAL=${manifest.estimates.filter((e) => !e.required).length}`;
}
