// Shared helpers for the sandbox tests: a project with a bare remote and initialised records,
// and an in-memory provider that proves the gateway works for any provider.
import { join } from 'node:path';
import { makeRepo, git } from './index.mjs';
import { init } from '../../orchestrator/lib/records.mjs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';

// A minimal in-memory provider: proves the gateway works for any provider, not only local.
export function fakeProvider({ failCreate = false, leak = null } = {}) {
  const trees = new Map();
  return {
    name: 'fake',
    capabilities: ['create', 'status', 'message', 'destroy'],
    async create(ctx, id) {
      if (failCreate) throw new Error('provider exploded');
      trees.set(id, []);
      return { state: 'working', session_id: `sess-${id}`, ...(leak ? { note: leak } : {}) };
    },
    async status(ctx, h) {
      return { state: trees.has(h.id) ? h.state : 'gone' };
    },
    async message(ctx, h, text) {
      trees.get(h.id).push(text);
      return { ok: true, handle: { questions_answered: (h.questions_answered || 0) + 1 } };
    },
    async destroy(ctx, h) {
      trees.delete(h.id);
      return { destroyed: true };
    },
  };
}


export async function setup({ withRemote = true, env = {} } = {}) {
  const { base, repo, parent } = await makeRepo('shop');
  if (withRemote) {
    const remote = join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  }
  const records = join(parent, 'shop-padakan');
  await init(records);
  const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'local', PADAKAN_MAX_TREES: '3', ...env } });
  return { base, repo, records, ctx: { settings, records, repo } };
}

