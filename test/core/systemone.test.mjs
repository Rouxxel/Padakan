import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSystemOneClient, createDecisionClient, decisionProvider, decisionEndpoint, decisionProblem,
  decisionKeySetting, decisionModel, ModelError, ModelOutputError,
} from '../../core/models.mjs';
import { resolve, rangeFromScore, systemOneQuestions, BUCKETS, REGISTRY } from '../../core/resolver.mjs';
import { triage } from '../../core/triage.mjs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';

const KEY = 'apikey_test_typesafe_1234';
const typesafe = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'local', PADAKAN_DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: KEY } });

// A fake System One endpoint. `pick(id, question)` returns the answer for one question; the default
// picks the first choice, says no to every yes/no question and puts all the weight on the second bucket.
function fakeSystemOne({ pick = () => null, capture = [], drop = [], failures = [] } = {}) {
  let n = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    capture.push({ url, headers: init.headers, body });
    const status = failures[n++];
    if (status) return new Response(`denied for ${KEY}`, { status });
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (drop.includes(id)) continue;
      const a = pick(id, q);
      if (a) answers[id] = { type: q.type, ...a };
      else if (q.type === 'choice') answers[id] = { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.9 };
      else if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.1 };
      else answers[id] = { type: 'score', probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])) };
    }
    return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 500, output_tokens: 40 } });
  };
}

describe('decision providers', () => {
  test('auto picks openai-compat with a base URL, nebius otherwise; typesafe is explicit', () => {
    assert.equal(decisionProvider(loadSettings({ exported: {} })), 'nebius');
    assert.equal(decisionProvider(loadSettings({ exported: { PADAKAN_DECISION_BASE_URL: 'http://localhost:11434/v1' } })), 'openai-compat');
    assert.equal(decisionProvider(typesafe), 'typesafe');
    assert.deepEqual(decisionEndpoint(typesafe), { baseUrl: 'https://api.typesafe.ai/v1', apiKey: KEY });
    assert.equal(decisionKeySetting(typesafe), 'TYPESAFE_API_KEY');
    assert.equal(decisionModel(typesafe, 'resolver'), 'jev-latest');
    assert.equal(decisionModel(typesafe, 'triage'), 'jev-latest');
    assert.equal(decisionModel(loadSettings({ exported: {} }), 'triage'), 'nvidia/nemotron-3-super-120b-a12b');
  });

  test('each provider names its own missing key, before any call', () => {
    const noKey = loadSettings({ exported: { PADAKAN_DECISION_PROVIDER: 'typesafe' } });
    assert.match(decisionProblem(noKey), /TYPESAFE_API_KEY/);
    assert.throws(() => createDecisionClient(noKey), (e) => e instanceof ModelError && /TYPESAFE_API_KEY/.test(e.message));
    assert.match(decisionProblem(loadSettings({ exported: { PADAKAN_DECISION_PROVIDER: 'openai-compat' } })), /PADAKAN_DECISION_BASE_URL is empty/);
    assert.match(decisionProblem(loadSettings({ exported: {} })), /NEBIUS_API_KEY.*TYPESAFE_API_KEY/);
    assert.equal(decisionProblem(typesafe), null);
    assert.equal(createDecisionClient(typesafe, { fetch: fakeSystemOne() }).kind, 'systemone');
    assert.equal(createDecisionClient(loadSettings({ exported: { NEBIUS_API_KEY: 'nb_1234' } })).kind, 'chat');
  });
});

describe('System One client', () => {
  test('posts state, model and questions to /systemone with the key', async () => {
    const capture = [];
    const client = createSystemOneClient({ baseUrl: 'https://api.typesafe.ai/v1/', apiKey: KEY, model: 'jev-latest', fetch: fakeSystemOne({ capture }) });
    const r = await client.systemOne({ state: { a: 1 }, questions: { q: { type: 'noul', instructions: 'Is it?' } } });
    assert.equal(capture[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(capture[0].headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(capture[0].body, { model: 'jev-latest', state: { a: 1 }, questions: { q: { type: 'noul', instructions: 'Is it?' } } });
    assert.equal(r.answers.q.noul, 0.1);
    assert.equal(r.model, 'jev-1.13.0');
  });

  test('an answer missing or of the wrong kind is a failure; a 401 names the key setting and hides the key', async () => {
    const missing = createSystemOneClient({ baseUrl: 'http://x/v1', apiKey: KEY, fetch: fakeSystemOne({ drop: ['q'] }) });
    await assert.rejects(missing.systemOne({ state: 's', questions: { q: { type: 'noul', instructions: 'i' } } }), ModelOutputError);
    const offList = createSystemOneClient({ baseUrl: 'http://x/v1', apiKey: KEY, fetch: fakeSystemOne({ pick: () => ({ choice: 'zzz' }) }) });
    await assert.rejects(offList.systemOne({ state: 's', questions: { c: { type: 'choice', instructions: 'i', criteria: { a: null } } } }), /not an option/);
    const denied = createSystemOneClient({ baseUrl: 'http://x/v1', apiKey: KEY, fetch: fakeSystemOne({ failures: [401] }), sleep: async () => {} });
    await assert.rejects(denied.systemOne({ state: 's', questions: {} }), (e) => /401 \(check TYPESAFE_API_KEY/.test(e.message) && !e.message.includes(KEY));
  });
});

describe('the resolver on System One', () => {
  test('ranges come from the 10th, 50th and 90th percentile of the bucket probabilities', () => {
    const b = [1, 3, 8, 20, 45];
    assert.deepEqual(rangeFromScore({ 0: 0, 1: 1, 2: 0, 3: 0, 4: 0 }, b), { low: 3, likely: 3, high: 3 });
    assert.deepEqual(rangeFromScore({ 0: 0.05, 1: 0.5, 2: 0.3, 3: 0.15, 4: 0 }, b), { low: 3, likely: 3, high: 20 });
    assert.deepEqual(rangeFromScore({ 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2 }, b), { low: 1, likely: 8, high: 45 });
  });

  test('asks one typed question per decision and builds a valid manifest', async () => {
    const capture = [];
    const pick = (id) => {
      if (id === 'target') return { choice: 'web', confidence: 0.97 };
      if (id === 'skill:feature-docs' || id === 'step:video' || id === 'cli:npm' || id === 'mcp:chrome-devtools') return { noul: 0.8 };
      if (id === 'cost:build') return { probabilities: { 0: 0, 1: 0.2, 2: 0.6, 3: 0.2, 4: 0 } };
      return null;
    };
    const client = createDecisionClient(typesafe, { fetch: fakeSystemOne({ pick, capture }) });
    const { manifest, usage } = await resolve({ task: { key: 'PAD-2', title: 'Discount codes', criteria: 'AC1 …' }, prd: 'Node 22', settings: typesafe, client });

    const q = capture[0].body.questions;
    assert.equal(q.target.type, 'choice');
    assert.deepEqual(Object.keys(q.target.criteria), Object.keys(REGISTRY.targets));
    for (const s of REGISTRY.optional_skills.filter((x) => x !== 'entire-context')) assert.equal(q[`skill:${s}`].type, 'noul');
    assert.equal(q['skill:entire-context'], undefined, 'entire-context is never chosen by the model');
    for (const [step, { required }] of Object.entries(REGISTRY.steps)) {
      assert.equal(q[`cost:${step}`].type, 'score');
      assert.equal(!!q[`step:${step}`], !required, `only optional steps get a yes/no question (${step})`);
    }
    assert.equal(capture[0].body.state.task.key, 'PAD-2');
    for (const t of ['playwright', 'chrome-devtools']) assert.equal(q[`mcp:${t}`].type, 'noul');
    for (const t of ['curl', 'docker compose', 'npm']) assert.equal(q[`cli:${t}`].type, 'noul');

    assert.equal(manifest.target, 'web');
    assert.ok(manifest.skills.includes('feature-docs') && !manifest.skills.includes('cost-gate'));
    assert.deepEqual(manifest.allowDependencies, []);
    assert.deepEqual(manifest.verify_kit, { mcp: ['playwright', 'chrome-devtools'], cli: ['git', 'gh', 'npm'] }, 'tools Jev said yes to, plus the target keep tools');
    const build = manifest.estimates.find((e) => e.step === 'build');
    assert.deepEqual([build.unit, build.low, build.likely, build.high], ['tokens', BUCKETS.tokens[1], BUCKETS.tokens[2], BUCKETS.tokens[3]]);
    assert.ok(manifest.estimates.some((e) => e.step === 'video' && e.unit === 'device_minute' && !e.required));
    assert.ok(!manifest.estimates.some((e) => e.step === 'browser-matrix'));
    assert.equal(manifest.resolved_by, 'jev-1.13.0');
    assert.match(manifest.rationale, /target web at confidence 0\.97/);
    assert.equal(usage.input_tokens, 500);
  });

  test('build is estimated in ACUs on Devin', () => {
    const q = systemOneQuestions({ settings: { ...typesafe, PADAKAN_SANDBOX_PROVIDER: 'devin' } });
    assert.match(q['cost:build'].criteria[0], /acu$/);
  });
});

describe('triage on System One', () => {
  test('one request per cluster; confidence is the category confidence; routing stays deterministic', async () => {
    const capture = [];
    const pick = (id, q) => {
      if (id === 'category') return { choice: 'code-defect', confidence: 0.93 };
      if (id === 'severity') return { choice: 'P1', confidence: 0.8 };
      if (id === 'fixable') return { noul: 0.7 };
      return null;
    };
    const client = createDecisionClient(typesafe, { fetch: fakeSystemOne({ pick, capture }) });
    const clusters = [
      { fingerprint: 'a', count: 3, sources: ['server'], sample: 'TypeError: x is undefined\n  at total' },
      { fingerprint: 'b', count: 1, sources: ['server'], sample: 'TypeError again' },
    ];
    const { items } = await triage({ clusters, client });
    assert.equal(capture.length, 2);
    assert.equal(capture[0].body.state.fingerprint, 'a');
    assert.deepEqual(
      { category: items[0].category, severity: items[0].severity, fixable: items[0].fixable, confidence: items[0].confidence, route: items[0].route },
      { category: 'code-defect', severity: 'P1', fixable: true, confidence: 0.93, route: 'task' },
    );
    assert.match(items[0].summary, /^code-defect: TypeError: x is undefined$/);

    const unsure = createDecisionClient(typesafe, { fetch: fakeSystemOne({ pick: (id) => (id === 'category' ? { choice: 'code-defect', confidence: 0.4 } : null) }) });
    const low = await triage({ clusters: clusters.slice(0, 1), client: unsure });
    assert.equal(low.items[0].category, 'unknown', 'low confidence goes to a human');
    assert.equal(low.items[0].route, 'human');
  });
});
