// The sandbox gateway. Every orchestrator step talks to sandboxes through here, never to a provider
// directly. It owns the handles in <records>/sandboxes/<id>.json:
//   - create() claims the handle first and deletes it if the provider fails;
//   - later verbs load the handle, use the provider recorded in it, and merge `result.handle` back;
//   - undeclared verbs throw UnsupportedVerb;
//   - PADAKAN_MAX_TREES is enforced by counting live handles;
//   - a handle that would contain a secret value is refused.

import { readFile, writeFile, readdir, rm, mkdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SETTINGS } from '../orchestrator/lib/env.mjs';
import { validate } from '../core/schema.mjs';
import { VERBS, LIVE_STATES, UnsupportedVerb, SandboxError, assertId, checkProvider, secretValues, findSecret } from './contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLE_SCHEMA = JSON.parse(readFileSync(join(HERE, '..', 'schemas', 'sandbox-handle.json'), 'utf8'));

async function loadProviderModule(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new SandboxError(`invalid provider name "${name}"`);
  const file = join(HERE, name, 'provider.mjs');
  if (!existsSync(file)) throw new SandboxError(`no sandbox provider "${name}" (expected ${file})`, { code: 'NO_PROVIDER' });
  const mod = await import(pathToFileURL(file).href);
  const problems = checkProvider(mod, name);
  if (problems.length) throw new SandboxError(`provider "${name}" breaks the contract: ${problems.join('; ')}`, { code: 'BAD_PROVIDER' });
  return mod;
}

// ctx: { settings, records, repo }. `providers` maps name -> module, to inject fakes in tests.
export function openGateway(ctx, { providers = {}, now = () => new Date().toISOString() } = {}) {
  const { settings, records } = ctx;
  if (!records) throw new Error('the gateway needs the records folder');
  const dir = join(records, 'sandboxes');
  const secrets = secretValues(settings, SETTINGS);
  const cache = new Map(Object.entries(providers));

  const provider = async (name) => {
    if (!cache.has(name)) cache.set(name, await loadProviderModule(name));
    return cache.get(name);
  };
  const handlePath = (id) => join(dir, `${assertId(id)}.json`);

  async function writeHandle(handle) {
    const leaked = findSecret(handle, secrets);
    if (leaked) throw new SandboxError(`refusing to write handle ${handle.id}: it contains the value of a secret setting`, { code: 'SECRET_IN_HANDLE' });
    const errors = validate(HANDLE_SCHEMA, handle);
    if (errors.length) throw new SandboxError(`invalid handle ${handle.id}: ${errors.join('; ')}`, { code: 'BAD_HANDLE' });
    const path = handlePath(handle.id);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(handle, null, 2)}\n`);
    // Windows refuses to replace a file another handle has open (EPERM/EACCES/EBUSY): retry briefly.
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, path);
        break;
      } catch (e) {
        if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 10 * (i + 1)));
      }
    }
    return handle;
  }

  async function get(id) {
    const path = handlePath(id);
    if (!existsSync(path)) throw new SandboxError(`no sandbox "${id}"`, { code: 'NOT_FOUND' });
    return JSON.parse(await readFile(path, 'utf8'));
  }

  async function list() {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(await readFile(join(dir, f), 'utf8')));
      } catch {
        // a half-written or foreign file is not a handle
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function create(id, opts = {}) {
    assertId(id);
    const name = opts.provider || settings?.PADAKAN_SANDBOX_PROVIDER;
    if (!name) throw new SandboxError('no sandbox provider selected (PADAKAN_SANDBOX_PROVIDER)');
    const mod = await provider(name);
    await mkdir(dir, { recursive: true });

    const max = settings?.PADAKAN_MAX_TREES;
    if (max) {
      const live = (await list()).filter((h) => LIVE_STATES.includes(h.state));
      if (live.length >= max) throw new SandboxError(`PADAKAN_MAX_TREES is ${max} and ${live.length} trees are live`, { code: 'MAX_TREES' });
    }

    // Claim the handle before anything is spent; a second create with the same id fails here.
    const claim = { id, provider: name, state: 'provisioning', created_at: now(), ...(opts.task ? { task: opts.task } : {}) };
    try {
      await writeFile(handlePath(id), `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') throw new SandboxError(`sandbox "${id}" already exists`, { code: 'EXISTS' });
      throw e;
    }
    try {
      const fields = (await mod.create(ctx, id, opts)) || {};
      const { id: _i, provider: _p, created_at: _c, ...rest } = fields;
      return await writeHandle({ ...claim, state: 'ready', ...rest, updated_at: now() });
    } catch (e) {
      await rm(handlePath(id), { force: true });
      throw e;
    }
  }

  // Any other verb: load the handle, check the capability, call, merge `result.handle`.
  async function call(verb, id, ...args) {
    if (!VERBS.includes(verb) || verb === 'create') throw new SandboxError(`unknown verb "${verb}"`);
    const handle = await get(id);
    const mod = await provider(handle.provider);
    if (!mod.capabilities.includes(verb)) throw new UnsupportedVerb(handle.provider, verb);
    const result = (await mod[verb](ctx, Object.freeze({ ...handle }), ...args)) ?? {};
    // destroy, and retire when it ends the tree, remove the handle.
    if (result.destroyed === true) {
      await rm(handlePath(id), { force: true });
      return result;
    }
    if (result.handle && typeof result.handle === 'object') {
      const { id: _i, provider: _p, created_at: _c, ...rest } = result.handle;
      await writeHandle({ ...handle, ...rest, updated_at: now() });
    }
    return result;
  }

  const supports = async (id, verb) => (await provider((await get(id)).provider)).capabilities.includes(verb);

  const api = { create, get, list, call, supports };
  for (const verb of VERBS) if (verb !== 'create') api[verb] = (id, ...args) => call(verb, id, ...args);
  return api;
}
