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
  const skills = [...new Set([...registry.always.skills, ...kit.skills, ...proposal.extra_skills, ...(settings.ENTIRE_ENABLED ? ['entire-context'] : [])])].sort();
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
  const { system, user } = buildPrompt({ task, prd, settings, registry });
  const model = settings.PADAKAN_RESOLVER_MODEL;
  const { data, usage } = await client.chatJson({ model, system, user, schema: proposalSchema(registry), name: 'capability_manifest' });
  const manifest = buildManifest({ task, proposal: data, settings, registry, skillsAvailable, model, now });
  return { manifest, usage };
}

// One line for the orchestrator.
export function resultLine(path, manifest) {
  const build = manifest.estimates.find((e) => e.step === 'build');
  return `MANIFEST=${path} TARGET=${manifest.target} PLATFORM=${manifest.platform} COST_HIGH=${build.high}${build.unit} REQUIRED=${manifest.estimates.filter((e) => e.required).length} OPTIONAL=${manifest.estimates.filter((e) => !e.required).length}`;
}
