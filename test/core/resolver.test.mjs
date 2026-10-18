import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRepo, removeDir } from '../helpers/index.mjs';
import { createModelClient, decisionEndpoint, decisionProblem, decisionKeySetting, extractJson, ModelOutputError, ModelError } from '../../core/models.mjs';
import { buildManifest, proposalSchema, resolve, ResolverError, REGISTRY, availableSkills, MANIFEST_SCHEMA } from '../../core/resolver.mjs';
import { validate } from '../../core/schema.mjs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';
import { buildContext } from '../../orchestrator/lib/context.mjs';
import { STEPS } from '../../orchestrator/steps.mjs';

const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'devin', NEBIUS_API_KEY: 'nb_secret_key_1234' } });

// A fake chat-completions endpoint: returns `content` as the model's answer, after optional failures.
function fakeFetch({ content, failures = [], capture = [] } = {}) {
  let n = 0;
  return async (url, init) => {
    capture.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    const status = failures[n++];
    if (status) return new Response(`error ${status} for key nb_secret_key_1234`, { status });
    return Response.json({ model: 'nvidia/nemotron-3-super-120b-a12b', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 900, completion_tokens: 120 } });
  };
}

const proposal = (over = {}) => ({
  target: 'web',
  extra_skills: ['feature-docs'],
  allow_dependencies: [],
  estimates: [
    { step: 'build', unit: 'acu', low: 4, likely: 8, high: 15 },
    { step: 'video', unit: 'device_minute', low: 1, likely: 2, high: 3 },
    { step: 'suite', unit: 'ci_minute', low: 3, likely: 5, high: 8 },
  ],
  rationale: 'A dashboard change; prove it in the browser.',
  ...over,
});

describe('model client', () => {
  test('decision endpoint: Nebius by default, a local server when PADAKAN_DECISION_BASE_URL is set', () => {
    assert.deepEqual(decisionEndpoint(settings), { baseUrl: 'https://api.tokenfactory.nebius.com/v1/', apiKey: 'nb_secret_key_1234' });
    const local = loadSettings({ exported: { PADAKAN_DECISION_BASE_URL: 'http://localhost:11434/v1', NEBIUS_API_KEY: 'nb_x_1234' } });
    assert.deepEqual(decisionEndpoint(local), { baseUrl: 'http://localhost:11434/v1', apiKey: '' }, 'a local server does not get the Nebius key');
  });

  test('asks for schema-shaped JSON and validates the answer', async () => {
    const capture = [];
    const client = createModelClient({ baseUrl: 'https://api.example/v1/', apiKey: 'k_1234', fetch: fakeFetch({ content: { a: 1 }, capture }) });
    const r = await client.chatJson({ model: 'm', system: 's', user: 'u', schema: { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } } });
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(capture[0].url, 'https://api.example/v1/chat/completions');
    assert.equal(capture[0].init.headers.Authorization, 'Bearer k_1234');
    assert.equal(capture[0].init.body.response_format.type, 'json_schema');
    assert.equal(capture[0].init.body.temperature, 0);
  });

  test('AC1: invalid output is a failure, not a retry', async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return Response.json({ choices: [{ message: { content: '{"a":"not a number"}' } }] });
    };
    const client = createModelClient({ baseUrl: 'http://x/v1', fetch });
    await assert.rejects(client.chatJson({ model: 'm', system: 's', user: 'u', schema: { type: 'object', properties: { a: { type: 'integer' } } } }), ModelOutputError);
    assert.equal(calls, 1);
    const prose = createModelClient({ baseUrl: 'http://x/v1', fetch: async () => Response.json({ choices: [{ message: { content: 'I think web.' } }] }) });
    await assert.rejects(prose.chatJson({ model: 'm', system: 's', user: 'u', schema: { type: 'object' } }), /did not return JSON/);
  });

  test('429 and 5xx are retried; other errors are not, and never show the key', async () => {
    const sleeps = [];
    const client = createModelClient({ baseUrl: 'http://x/v1', apiKey: 'nb_secret_key_1234', fetch: fakeFetch({ content: { ok: true }, failures: [429, 503] }), sleep: async (ms) => sleeps.push(ms) });
    assert.deepEqual((await client.chatJson({ model: 'm', system: 's', user: 'u', schema: { type: 'object' } })).data, { ok: true });
    assert.equal(sleeps.length, 2);
    const bad = createModelClient({ baseUrl: 'http://x/v1', apiKey: 'nb_secret_key_1234', fetch: fakeFetch({ failures: [401] }), sleep: async () => {} });
    await assert.rejects(bad.chatJson({ model: 'm', system: 's', user: 'u', schema: { type: 'object' } }), (e) => e instanceof ModelError && e.status === 401 && !e.message.includes('nb_secret_key_1234'));
  });

  test('a missing decision key is named before any call; a 401 names the setting', async () => {
    const none = loadSettings({ exported: {} });
    assert.match(decisionProblem(none), /NEBIUS_API_KEY.*PADAKAN_DECISION_BASE_URL/);
    assert.equal(decisionKeySetting(none), 'NEBIUS_API_KEY');
    assert.equal(decisionProblem(settings), null);
    const local = loadSettings({ exported: { PADAKAN_DECISION_BASE_URL: 'http://localhost:11434/v1' } });
    assert.equal(decisionProblem(local), null, 'a local server may need no key');
    assert.equal(decisionKeySetting(local), 'PADAKAN_DECISION_API_KEY');

    let calls = 0;
    const ctx = buildContext({ base: { settings: none, records: '/nonexistent', repo: null }, overrides: { audit: {}, github: {} } });
    const fetchSpy = globalThis.fetch;
    globalThis.fetch = async () => { calls++; return Response.json({}); };
    try {
      assert.throws(() => ctx.models(), (e) => e instanceof ModelError && /NEBIUS_API_KEY/.test(e.message));
    } finally {
      globalThis.fetch = fetchSpy;
    }
    assert.equal(calls, 0, 'no HTTP call without a key');

    const bad = createModelClient({ baseUrl: 'http://x/v1', apiKey: 'nb_secret_key_1234', keySetting: 'NEBIUS_API_KEY', fetch: fakeFetch({ failures: [401] }), sleep: async () => {} });
    await assert.rejects(bad.chatJson({ model: 'm', system: 's', user: 'u', schema: { type: 'object' } }), (e) => /returned 401 \(check NEBIUS_API_KEY in <records>\/\.env\)/.test(e.message) && !e.message.includes('nb_secret_key_1234'));
  });

  test('JSON inside a code fence is accepted', () => {
    assert.deepEqual(extractJson('Here:\n```json\n{"a": 2}\n```'), { a: 2 });
  });
});

describe('capability resolver', () => {
  test('AC2: web, iOS, Android and backend manifests come from the registry', () => {
    for (const target of ['web', 'ios', 'android', 'backend']) {
      const m = buildManifest({ task: { key: 'PAD-1' }, proposal: proposal({ target, extra_skills: [] }), settings, model: 'm' });
      assert.equal(m.target, target);
      assert.deepEqual(m.verify_kit.mcp, REGISTRY.targets[target].mcp);
      assert.ok(m.skills.includes(`verify-${target}`));
      assert.deepEqual(validate(MANIFEST_SCHEMA, m), []);
    }
    assert.equal(buildManifest({ task: { key: 'PAD-1' }, proposal: proposal({ target: 'ios' }), settings }).platform, 'macos');
    assert.equal(buildManifest({ task: { key: 'PAD-1' }, proposal: proposal({ target: 'web' }), settings }).platform, 'linux');
  });

  test('required steps are set by the registry, not by the model', () => {
    const m = buildManifest({ task: { key: 'PAD-1' }, proposal: proposal(), settings });
    const req = Object.fromEntries(m.estimates.map((e) => [e.step, e.required]));
    assert.deepEqual(req, { build: true, suite: true, video: false });
  });

  test('off-registry or inconsistent proposals are refused', () => {
    assert.throws(() => buildManifest({ task: { key: 'P' }, proposal: proposal({ target: 'desktop' }), settings }), ResolverError);
    assert.throws(() => buildManifest({ task: { key: 'P' }, proposal: proposal({ estimates: [{ step: 'build', unit: 'acu', low: 9, likely: 5, high: 10 }] }), settings }), /low <= likely <= high/);
    assert.throws(() => buildManifest({ task: { key: 'P' }, proposal: proposal({ estimates: [{ step: 'video', unit: 'x', low: 1, likely: 1, high: 1 }] }), settings }), /no estimate for the "build" step/);
    assert.throws(() => buildManifest({ task: { key: 'P' }, proposal: proposal(), settings, skillsAvailable: ['okf'] }), /skills not shipped/);
    // The proposal schema itself refuses invented skills and steps.
    assert.ok(validate(proposalSchema(), proposal({ extra_skills: ['hack-the-planet'] })).length > 0);
  });

  test('a Linux target may use a Devin Outpost pool', () => {
    const pool = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'devin', DEVIN_PLATFORM: 'gpu-pool' } });
    assert.equal(buildManifest({ task: { key: 'P' }, proposal: proposal({ target: 'backend' }), settings: pool }).platform, 'gpu-pool');
    assert.equal(buildManifest({ task: { key: 'P' }, proposal: proposal({ target: 'ios' }), settings: pool }).platform, 'macos');
  });

  test('AC3: resolve() uses the resolver model, Nemotron by default', async () => {
    const capture = [];
    const client = createModelClient({ ...decisionEndpoint(settings), fetch: fakeFetch({ content: proposal(), capture }) });
    const { manifest, usage } = await resolve({ task: { key: 'PAD-2', title: 'CSV export' }, prd: 'Stack: React, Node.', settings, client });
    assert.equal(capture[0].init.body.model, 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal(manifest.resolved_by, 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal(usage.prompt_tokens, 900);
  });

  test('padakan resolve writes the manifest and audits it, without asking anyone', async () => {
    const env = await makeRepo('shop');
    try {
      const records = join(env.parent, 'shop-padakan');
      const client = createModelClient({ baseUrl: 'http://local/v1', fetch: fakeFetch({ content: proposal({ target: 'android' }) }) });
      const ctx = buildContext({ base: { settings, records, repo: env.repo }, overrides: { models: () => client } });
      await STEPS.init(ctx);
      await writeFile(join(records, 'state.json'), JSON.stringify({ version: 1, tasks: { 'PAD-3': { status: 'planned', title: 'Offline mode' } } }));
      await mkdir(join(records, 'plan'), { recursive: true });
      await writeFile(join(records, 'plan', 'prd.md'), '# PRD\nKotlin app.');
      const r = await STEPS.resolve(ctx, ['PAD-3']);
      assert.match(r.line, /^MANIFEST=tasks\/PAD-3\/manifest\.json TARGET=android PLATFORM=linux COST_HIGH=15acu REQUIRED=2 OPTIONAL=1$/);
      const m = JSON.parse(await readFile(join(records, 'tasks', 'PAD-3', 'manifest.json'), 'utf8'));
      assert.deepEqual(m.verify_kit.mcp, ['androidbuild']);
      assert.equal((await ctx.audit.replay({ task: 'PAD-3' }))[0].event.type, 'manifest.resolved');
    } finally {
      await removeDir(env.base);
    }
  });

  test('every skill the registry names ships with the plugin', () => {
    const skills = availableSkills();
    const named = [...REGISTRY.always.skills, ...REGISTRY.optional_skills, ...Object.values(REGISTRY.targets).flatMap((t) => t.skills)];
    for (const s of named) assert.ok(skills.includes(s), s);
  });
});

