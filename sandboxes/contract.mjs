// The sandbox provider contract, shared by the gateway and every provider.
//
// A provider module exports:
//   name          string, the folder name under sandboxes/
//   capabilities  array of the verbs it implements (subset of VERBS)
//   one async function per declared verb:
//     create(ctx, id, opts)        -> fields for the new handle (at least { state })
//     <verb>(ctx, handle, ...args) -> a result object; `result.handle` (optional) holds handle fields to update
//   where ctx = { settings, records, repo } and `handle` is the stored handle (read-only for the provider).
//
// Providers never write handles, the audit trail or the cost ledger. The gateway writes the handle;
// the orchestrator writes the rest.

export const VERBS = [
  'create', 'bootstrap', 'seed', 'exec', 'push', 'pull', 'brief', 'attach', 'url', 'status', 'poll',
  'message', 'pause', 'resume', 'spend', 'raiseBudget', 'evidence', 'retire', 'destroy',
];

// Tree states a provider may report. `provisioning` is set by the gateway while create() runs.
export const STATES = ['provisioning', 'ready', 'working', 'waiting', 'paused', 'done', 'failed', 'gone'];
export const LIVE_STATES = ['provisioning', 'ready', 'working', 'waiting', 'paused'];

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

// File names that look like credentials. push() refuses them.
export const SECRET_FILE_RE = /(^|[\\/])(\.env(\..*)?|.*credentials.*\.json|.*-key\.json|storageState\.json|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.pem|\.netrc|\.npmrc)$/i;

export class UnsupportedVerb extends Error {
  constructor(provider, verb) {
    super(`the ${provider} provider does not support "${verb}"`);
    this.name = 'UnsupportedVerb';
    this.provider = provider;
    this.verb = verb;
  }
}

export class SandboxError extends Error {
  constructor(message, { code = 'SANDBOX_ERROR' } = {}) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

export function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new SandboxError(`invalid sandbox id "${id}" (lowercase letters, digits and dashes, at most 39 characters)`, { code: 'BAD_ID' });
  }
  return id;
}

// Check a provider module against the contract. Returns a list of problems (empty when valid).
export function checkProvider(mod, expectedName) {
  const problems = [];
  if (typeof mod.name !== 'string') problems.push('missing export: name');
  if (expectedName && mod.name !== expectedName) problems.push(`name "${mod.name}" does not match folder "${expectedName}"`);
  if (!Array.isArray(mod.capabilities)) problems.push('missing export: capabilities (array)');
  else {
    for (const v of mod.capabilities) {
      if (!VERBS.includes(v)) problems.push(`unknown verb in capabilities: ${v}`);
      else if (typeof mod[v] !== 'function') problems.push(`declares "${v}" but does not export it as a function`);
    }
    for (const v of ['create', 'status', 'destroy']) if (!mod.capabilities.includes(v)) problems.push(`must support "${v}"`);
  }
  return problems;
}

// Values of secret settings that must never appear in a handle.
export function secretValues(settings, specs) {
  return specs.filter((s) => s.secret).map((s) => settings?.[s.key]).filter((v) => typeof v === 'string' && v.length >= 4);
}

export function findSecret(value, secrets) {
  const text = JSON.stringify(value);
  return secrets.find((s) => text.includes(s)) || null;
}
