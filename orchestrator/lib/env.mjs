// Padakan settings: every setting is an environment variable.
//
// One table (SETTINGS) is the only schema. Load order, first value wins:
//   1. the exported environment (a one-off override)
//   2. <records>/.env  (this project; survives plugin updates)
//   3. the plugin .env (machine-wide defaults)
// then the table's default.
//
// Validation fails loudly, naming the key: unknown keys in a .env file, unknown PADAKAN_* keys in the
// exported environment, bad enum values, numbers that are not numbers. Secret values never appear in
// describe() output or in an error message.
//
// CLI: `node orchestrator/lib/env.mjs --example` prints .env.example from the table.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const S = (key, group, def, type, desc, extra = {}) => ({ key, group, default: def, type, desc, ...extra });
const NOT_NONE = (v) => v !== undefined && v !== '';

export const SETTINGS = [
  // General
  S('PADAKAN_LANGUAGE', 'General', 'en', 'string', 'Language of briefs, reports and specs.'),
  S('PADAKAN_RECORDS_NAME', 'General', '{repo}-padakan', 'string', 'Name of the records folder next to the repo; {repo} is replaced by the repo folder name.'),
  S('PADAKAN_RECORDS_DIR', 'General', '', 'path', 'Absolute path of the records folder; overrides PADAKAN_RECORDS_NAME.'),
  S('PADAKAN_TRACKER', 'General', 'github', 'enum', 'Where tasks are filed: github (GitHub Issues on the origin repository, through gh), linear, or none (state.json only).', { values: ['linear', 'github', 'none'] }),
  S('LINEAR_API_KEY', 'General', '', 'string', 'Linear API key, when PADAKAN_TRACKER=linear. Orchestrator only; trees never get it.', { secret: true }),

  // Terminal and driver
  S('PADAKAN_TERMINAL', 'Terminal and driver', 'herdr', 'enum', 'Terminal for the orchestrator and for non-Devin trees.', { values: ['herdr', 'none'] }),
  S('PADAKAN_DRIVER', 'Terminal and driver', 'herdr', 'enum', 'How a non-Devin tree agent is driven: herdr, or headless for CI.', { values: ['herdr', 'headless'] }),
  S('HERDR_SESSION_PREFIX', 'Terminal and driver', 'padakan', 'string', 'Prefix of herdr workspace names.'),

  // Sandboxes
  S('PADAKAN_SANDBOX_PROVIDER', 'Sandboxes', 'devin', 'enum', 'Where trees run.', { values: ['devin', 'daytona', 'local'] }),
  S('PADAKAN_MAX_TREES', 'Sandboxes', '3', 'int', 'Trees running at once.', { min: 1 }),
  S('DAYTONA_API_KEY', 'Sandboxes', '', 'string', 'Daytona API key.', { secret: true }),
  S('DAYTONA_API_URL', 'Sandboxes', 'https://app.daytona.io/api', 'url', 'Daytona API base URL.'),
  S('DAYTONA_TARGET', 'Sandboxes', 'eu', 'enum', 'Daytona region.', { values: ['eu', 'us'] }),
  S('DAYTONA_SNAPSHOT', 'Sandboxes', 'padakan-base', 'string', 'Snapshot baked from sandboxes/daytona/snapshot/.'),
  S('DAYTONA_CPU', 'Sandboxes', '2', 'int', 'vCPU per sandbox, fixed at bake time.', { min: 1 }),
  S('DAYTONA_MEMORY', 'Sandboxes', '4', 'int', 'GB of memory per sandbox, fixed at bake time.', { min: 1 }),
  S('DAYTONA_DISK', 'Sandboxes', '10', 'int', 'GB of disk per sandbox, fixed at bake time.', { min: 1 }),
  S('DAYTONA_AUTO_STOP', 'Sandboxes', '15', 'int', 'Idle minutes before a sandbox stops.', { min: 0 }),
  S('DAYTONA_AUTO_DELETE', 'Sandboxes', '1440', 'int', 'Minutes after stopping before a sandbox is deleted.', { min: 0 }),

  // Agents and models
  S('PADAKAN_HARNESS', 'Agents and models', 'claude', 'enum', 'Agent inside a non-Devin tree.', { values: ['claude', 'devin', 'openai-compat'] }),
  S('PADAKAN_TREE_MODEL', 'Agents and models', 'claude-sonnet-5-5', 'string', 'Model the tree agent runs.'),
  S('CLAUDE_CODE_OAUTH_TOKEN', 'Agents and models', '', 'string', 'Tree login from `claude setup-token`.', { secret: true }),
  S('CLAUDE_CODE_OAUTH_FALLBACK_TOKEN', 'Agents and models', '', 'string', 'Second account, used when the first is rate-limited.', { secret: true }),
  S('NEBIUS_API_KEY', 'Agents and models', '', 'string', 'Nebius Token Factory API key.', { secret: true }),
  S('NEBIUS_BASE_URL', 'Agents and models', 'https://api.tokenfactory.nebius.com/v1/', 'url', 'Nebius Token Factory base URL (OpenAI-compatible).'),
  S('PADAKAN_TRIAGE_MODEL', 'Agents and models', 'nvidia/nemotron-3-super-120b-a12b', 'string', 'Model that triages monitor clusters.'),
  S('PADAKAN_RESOLVER_MODEL', 'Agents and models', 'nvidia/nemotron-3-super-120b-a12b', 'string', 'Model that writes capability manifests.'),
  S('PADAKAN_BUILDER_MODEL', 'Agents and models', '', 'string', 'Model for the openai-compat harness.'),
  S('PADAKAN_DECISION_BASE_URL', 'Agents and models', '', 'url', 'OpenAI-compatible endpoint for the decision models (resolver, triage). Empty uses NEBIUS_BASE_URL; set it to use a local model server (Ollama, llama.cpp, vLLM).'),
  S('PADAKAN_DECISION_API_KEY', 'Agents and models', '', 'string', 'API key for PADAKAN_DECISION_BASE_URL. Empty uses NEBIUS_API_KEY; a local server may need none.', { secret: true }),
  S('DEVIN_API_URL', 'Agents and models', 'https://api.devin.ai/v3', 'url', 'Devin API base URL.'),
  S('DEVIN_API_KEY', 'Agents and models', '', 'string', 'Devin service-user token (cog_…), needs UseDevinSessions.', { secret: true }),
  S('DEVIN_ORG_ID', 'Agents and models', '', 'string', 'Devin organization id (org-…).'),
  S('DEVIN_MAX_ACU', 'Agents and models', '', 'int', "Hard ceiling for any session's max_acu_limit; the cost gate sets the actual value.", { min: 1 }),
  S('DEVIN_PLATFORM', 'Agents and models', 'linux', 'string', 'linux, macos, windows, or an Outpost pool name; the resolver can override per task.'),
  S('DEVIN_MODE', 'Agents and models', '', 'string', 'Optional devin_mode (normal, fast, lite, ultra, fusion); empty uses the org default; affects cost.'),
  S('DEVIN_BYPASS_APPROVAL', 'Agents and models', 'true', 'bool', 'No approval prompts inside sessions.'),
  S('DEVIN_PLAYBOOK_ID', 'Agents and models', '', 'string', "Optional playbook with Padakan's standing instructions."),
  S('DEVIN_POLL_SECONDS', 'Agents and models', '30', 'int', 'How often a session is polled.', { min: 5 }),
  S('DEVIN_CONTINUATION_MIN_ACU', 'Agents and models', '2', 'int', 'Smallest raise worth a continuation session (raiseBudget).', { min: 1 }),

  // Git
  S('GH_TOKEN_SOURCE', 'Git', 'host', 'enum', "GitHub token for trees: host (gh auth token) or pat (GH_PAT).", { values: ['host', 'pat'] }),
  S('GH_PAT', 'Git', '', 'string', 'Fine-grained token: Contents RW, Pull requests RW, Metadata R.', { secret: true }),
  S('GIT_AUTHOR_NAME', 'Git', '', 'string', 'Commit identity for trees.', { required: true }),
  S('GIT_AUTHOR_EMAIL', 'Git', '', 'string', 'Commit email for trees (registered on GitHub).', { required: true }),

  // Context
  S('ENTIRE_ENABLED', 'Context', 'false', 'bool', 'Use Entire: session capture and the local code graph.'),
  S('ENTIRE_SEARCH', 'Context', 'off', 'enum', 'on once the human connects the repo to Entire at the plan gate.', { values: ['on', 'off'] }),
  S('ENTIRE_REPO', 'Context', '', 'string', 'owner/repo as published on Entire.'),

  // Gates
  S('PADAKAN_PROTECTED_PATHS', 'Gates', '.github/,infra/,**/*.lock', 'list', 'Paths diff inspection refuses (comma-separated globs).'),
  S('PADAKAN_MAX_DIFF_LINES', 'Gates', '60', 'int', 'Most lines a change may touch.', { min: 1 }),
  S('PADAKAN_MAX_DIFF_FILES', 'Gates', '3', 'int', 'Most files a change may touch.', { min: 1 }),

  // Cost
  S('PADAKAN_BUDGET_RUN_USD', 'Cost', '', 'number', 'Budget cap per run; empty means no cap.', { min: 0 }),
  S('PADAKAN_BUDGET_TASK_USD', 'Cost', '', 'number', 'Budget cap per task; empty means no cap.', { min: 0 }),
  S('PADAKAN_BUDGET_STEP_USD', 'Cost', '', 'number', 'Budget cap per step; empty means no cap.', { min: 0 }),
  S('PADAKAN_DEVIN_USD_PER_ACU', 'Cost', '', 'number', "The team's real Devin ACU price. Required with the devin provider; the gate pauses rather than guess.", {
    min: 0,
    requiredWhen: (v) => v.PADAKAN_SANDBOX_PROVIDER === 'devin',
  }),

  // Monitor
  S('PADAKAN_WATCH_INTERVAL_MIN', 'Monitor', '15', 'int', 'Minutes between monitor ticks.', { min: 1 }),
  S('PADAKAN_LOG_SOURCES', 'Monitor', 'docker', 'list', 'Log sources: docker, file paths or URLs (comma-separated).'),

  // Deploy
  S('PADAKAN_DEPLOY_TARGET', 'Deploy', 'simulated', 'enum', 'Where gated deploys go.', { values: ['simulated', 'railway', 'vercel'] }),
  S('PADAKAN_CANARY_PERCENT', 'Deploy', '10', 'int', 'Share of traffic on the canary.', { min: 1, max: 100 }),
  S('PADAKAN_SLO_ERROR_RATE', 'Deploy', '0.01', 'number', 'Error rate that triggers rollback during the canary.', { min: 0, max: 1 }),
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const OWN_PREFIXES = ['PADAKAN_'];

export class SettingsError extends Error {
  constructor(problems) {
    super(`Invalid Padakan settings:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'SettingsError';
    this.problems = problems;
  }
}

// Parse a .env file: KEY=VALUE lines, # comments, optional `export `, single or double quotes.
// An inline # starts a comment only after whitespace in an unquoted value.
export function parseEnv(text, source = '.env') {
  const out = {};
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) {
      problems.push(`${source}:${i + 1}: not a KEY=VALUE line`);
      return;
    }
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q));
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  });
  if (problems.length) throw new SettingsError(problems);
  return out;
}

function readEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8'), path);
}

function convert(spec, raw, problems) {
  const name = spec.key;
  if (raw === '' || raw === undefined) return spec.type === 'list' ? [] : null;
  switch (spec.type) {
    case 'string':
    case 'path':
      return raw;
    case 'url':
      if (!/^https?:\/\//.test(raw)) problems.push(`${name}: expected an http(s) URL`);
      return raw;
    case 'enum':
      if (!spec.values.includes(raw)) problems.push(`${name}: "${spec.secret ? '***' : raw}" is not one of ${spec.values.join(', ')}`);
      return raw;
    case 'bool':
      if (raw !== 'true' && raw !== 'false') problems.push(`${name}: expected true or false`);
      return raw === 'true';
    case 'list':
      return raw.split(',').map((x) => x.trim()).filter(Boolean);
    case 'int':
    case 'number': {
      const n = Number(raw);
      const ok = raw.trim() !== '' && Number.isFinite(n) && (spec.type === 'number' || Number.isInteger(n));
      if (!ok) {
        problems.push(`${name}: expected ${spec.type === 'int' ? 'a whole number' : 'a number'}`);
        return null;
      }
      if (spec.min !== undefined && n < spec.min) problems.push(`${name}: must be at least ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) problems.push(`${name}: must be at most ${spec.max}`);
      return n;
    }
    default:
      throw new Error(`unknown setting type ${spec.type}`);
  }
}

// Load and validate settings.
//   exported:       the exported environment (defaults to process.env)
//   recordsEnvFile: path of <records>/.env (optional)
//   pluginEnvFile:  path of the plugin .env (optional)
// Returns a frozen object: typed values by key, plus non-enumerable helpers source(), missing(), describe().
export function loadSettings({ exported = process.env, recordsEnvFile, pluginEnvFile } = {}) {
  const problems = [];
  const files = [
    ['records .env', recordsEnvFile],
    ['plugin .env', pluginEnvFile],
  ].map(([label, path]) => {
    let values = {};
    try {
      values = readEnvFile(path);
    } catch (e) {
      if (e instanceof SettingsError) problems.push(...e.problems);
      else throw e;
    }
    for (const key of Object.keys(values)) {
      if (!BY_KEY.has(key)) problems.push(`${key}: unknown setting in ${label} (${path})`);
    }
    return { label, values };
  });

  for (const key of Object.keys(exported)) {
    if (OWN_PREFIXES.some((p) => key.startsWith(p)) && !BY_KEY.has(key)) problems.push(`${key}: unknown setting in the exported environment`);
  }

  const raw = {};
  const sources = {};
  for (const spec of SETTINGS) {
    if (exported[spec.key] !== undefined) {
      raw[spec.key] = exported[spec.key];
      sources[spec.key] = 'exported';
      continue;
    }
    const hit = files.find((f) => f.values[spec.key] !== undefined);
    if (hit) {
      raw[spec.key] = hit.values[spec.key];
      sources[spec.key] = hit.label;
    } else {
      raw[spec.key] = spec.default;
      sources[spec.key] = 'default';
    }
  }

  const values = {};
  for (const spec of SETTINGS) values[spec.key] = convert(spec, raw[spec.key], problems);
  if (problems.length) throw new SettingsError(problems);

  Object.defineProperties(values, {
    source: { value: (key) => sources[key] },
    missing: {
      value: () =>
        SETTINGS.filter((s) => (s.required || (s.requiredWhen && s.requiredWhen(values))) && !NOT_NONE(raw[s.key])).map((s) => s.key),
    },
    describe: { value: () => describe(values, sources) },
  });
  return Object.freeze(values);
}

// A printable view with secrets masked: one line per setting, `KEY=value  (source)`.
export function describe(values, sources = {}) {
  return SETTINGS.map((s) => {
    const v = values[s.key];
    let shown;
    if (s.secret) shown = v ? '***' : '';
    else if (Array.isArray(v)) shown = v.join(',');
    else shown = v === null || v === undefined ? '' : String(v);
    return `${s.key}=${shown}${sources[s.key] ? `  (${sources[s.key]})` : ''}`;
  }).join('\n');
}

// .env.example, generated from SETTINGS so the two can never drift.
export function renderExample() {
  const lines = [
    '# Padakan settings. Copy to <repo>-padakan/.env (per project) or to the plugin .env (machine-wide).',
    '# Load order, first value wins: exported environment, then <records>/.env, then the plugin .env, then the default shown here.',
    '# Never put values in this file; it is committed.',
  ];
  let group = null;
  for (const s of SETTINGS) {
    if (s.group !== group) {
      group = s.group;
      lines.push('', `# ── ${group} ${'─'.repeat(Math.max(0, 60 - group.length))}`);
    }
    const notes = [s.desc];
    if (s.values) notes.push(`One of: ${s.values.join(', ')}.`);
    if (s.required) notes.push('Required.');
    if (s.requiredWhen) notes.push('Required in some setups (see description).');
    if (s.secret) notes.push('Secret.');
    lines.push(`# ${notes.join(' ')}`);
    lines.push(`${s.key}=${s.secret ? '' : s.default}`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--example') {
  process.stdout.write(renderExample());
}
