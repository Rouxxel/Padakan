// A small client for OpenAI-compatible chat completions: Nebius Token Factory by default, or any
// local model server (Ollama, llama.cpp, vLLM) through PADAKAN_DECISION_BASE_URL.
//
// chatJson() asks for JSON that matches a schema, validates it with core/schema.mjs and returns it.
// An invalid answer is a failure (ModelOutputError), never a retry loop. Only 429 and 5xx are retried.
// The API key never appears in an error.

import { validate } from './schema.mjs';

export const RETRY_DELAYS_MS = [1000, 3000, 9000];

export class ModelError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
  }
}

export class ModelOutputError extends Error {
  constructor(message, { problems = [], raw = '' } = {}) {
    super(message);
    this.name = 'ModelOutputError';
    this.problems = problems;
    this.raw = raw.slice(0, 2000);
  }
}

// Who answers the decision models. `auto` keeps the original behaviour: a local or other
// OpenAI-compatible server when PADAKAN_DECISION_BASE_URL is set, Nebius Token Factory otherwise.
export function decisionProvider(settings) {
  const p = settings.PADAKAN_DECISION_PROVIDER || 'auto';
  if (p !== 'auto') return p;
  return settings.PADAKAN_DECISION_BASE_URL ? 'openai-compat' : 'nebius';
}

// Endpoint and key for the decision models, from settings.
export function decisionEndpoint(settings) {
  const provider = decisionProvider(settings);
  if (provider === 'typesafe') return { baseUrl: settings.TYPESAFE_BASE_URL, apiKey: settings.TYPESAFE_API_KEY || '' };
  if (provider === 'openai-compat') return { baseUrl: settings.PADAKAN_DECISION_BASE_URL, apiKey: settings.PADAKAN_DECISION_API_KEY || '' };
  return { baseUrl: settings.NEBIUS_BASE_URL, apiKey: settings.NEBIUS_API_KEY || '' };
}

const KEY_SETTING = { nebius: 'NEBIUS_API_KEY', 'openai-compat': 'PADAKAN_DECISION_API_KEY', typesafe: 'TYPESAFE_API_KEY' };

// The setting that holds the decision model's key, for messages that tell the human what to fill.
export const decisionKeySetting = (settings) => KEY_SETTING[decisionProvider(settings)];

// Why the decision models cannot be called, or null. An OpenAI-compatible server (a local one) may
// need no key; Nebius and TypeSafe always do.
export function decisionProblem(settings) {
  const provider = decisionProvider(settings);
  const { baseUrl, apiKey } = decisionEndpoint(settings);
  if (provider === 'openai-compat') return baseUrl ? null : 'PADAKAN_DECISION_PROVIDER is openai-compat but PADAKAN_DECISION_BASE_URL is empty';
  if (!baseUrl) return `no decision model endpoint: set ${provider === 'typesafe' ? 'TYPESAFE_BASE_URL' : 'NEBIUS_BASE_URL'}`;
  if (!apiKey && provider === 'typesafe') return 'no decision model key: set TYPESAFE_API_KEY in <records>/.env, or choose another PADAKAN_DECISION_PROVIDER';
  if (!apiKey) {
    return 'no decision model key: set NEBIUS_API_KEY in <records>/.env, PADAKAN_DECISION_BASE_URL to use a local model server (Ollama, llama.cpp, vLLM), or PADAKAN_DECISION_PROVIDER=typesafe with TYPESAFE_API_KEY';
  }
  return null;
}

// The model each role uses with the chosen provider: Jev for both roles with typesafe.
export function decisionModel(settings, role) {
  if (decisionProvider(settings) === 'typesafe') return settings.TYPESAFE_MODEL;
  return role === 'triage' ? settings.PADAKAN_TRIAGE_MODEL : settings.PADAKAN_RESOLVER_MODEL;
}

const redact = (text, key) => (key && key.length >= 4 ? String(text).split(key).join('***') : String(text));

// Pull a JSON object out of a model answer: plain JSON, or JSON inside a ``` fence.
export function extractJson(content) {
  const text = String(content ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

// POST JSON with the retry policy: 429 and 5xx retried with backoff, anything else fails at once.
function poster({ url, apiKey, keySetting, fetchFn, sleep, delays }) {
  return async function post(body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (attempt < delays.length) {
          await sleep(delays[attempt]);
          continue;
        }
        throw new ModelError(`model endpoint unreachable: ${redact(e.message, apiKey)}`);
      }
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      const text = await res.text().catch(() => '');
      const hint = (res.status === 401 || res.status === 403) && keySetting ? ` (check ${keySetting} in <records>/.env)` : '';
      throw new ModelError(`model endpoint returned ${res.status}${hint}: ${redact(text.slice(0, 300), apiKey)}`, { status: res.status });
    }
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createModelClient({ baseUrl, apiKey = '', keySetting = null, fetch: fetchFn = globalThis.fetch, sleep = defaultSleep, delays = RETRY_DELAYS_MS } = {}) {
  if (!baseUrl) throw new ModelError('no decision model endpoint (set NEBIUS_BASE_URL or PADAKAN_DECISION_BASE_URL)');
  const post = poster({ url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`, apiKey, keySetting, fetchFn, sleep, delays });

  // Ask for JSON matching `schema`. Returns { data, usage, model }.
  async function chatJson({ model, system, user, schema, name = 'answer', temperature = 0 }) {
    const body = {
      model,
      temperature,
      messages: [
        { role: 'system', content: `${system}\n\nAnswer with one JSON object only, matching this JSON Schema:\n${JSON.stringify(schema)}` },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } },
    };
    const json = await post(body);
    const content = json?.choices?.[0]?.message?.content ?? '';
    let data;
    try {
      data = extractJson(content);
    } catch {
      throw new ModelOutputError('the model did not return JSON', { raw: content });
    }
    const problems = validate(schema, data);
    if (problems.length) throw new ModelOutputError(`the model's JSON does not match the schema: ${problems.slice(0, 5).join('; ')}`, { problems, raw: content });
    return { data, usage: json.usage || null, model: json.model || model };
  }

  return { kind: 'chat', chatJson };
}

// A System One client (TypeSafe Jev): one `state`, a map of typed questions (choice, noul, score),
// answers with calibrated probabilities. It never generates free text, so callers ask questions
// instead of asking for JSON. Every question must come back with an answer of its own type.
export function createSystemOneClient({ baseUrl, apiKey = '', model = 'jev-latest', keySetting = 'TYPESAFE_API_KEY', fetch: fetchFn = globalThis.fetch, sleep = defaultSleep, delays = RETRY_DELAYS_MS } = {}) {
  if (!baseUrl) throw new ModelError('no System One endpoint (set TYPESAFE_BASE_URL)');
  const post = poster({ url: `${baseUrl.replace(/\/+$/, '')}/systemone`, apiKey, keySetting, fetchFn, sleep, delays });

  async function systemOne({ state, questions }) {
    const json = await post({ model, state, questions });
    const answers = json?.answers ?? {};
    const problems = [];
    for (const [id, q] of Object.entries(questions)) {
      const a = answers[id];
      if (!a || a.type !== q.type) problems.push(`${id}: no ${q.type} answer`);
      else if (q.type === 'choice' && !(a.choice in q.criteria)) problems.push(`${id}: "${a.choice}" is not an option`);
      else if (q.type === 'noul' && typeof a.noul !== 'number') problems.push(`${id}: no probability`);
      else if (q.type === 'score' && typeof a.probabilities !== 'object') problems.push(`${id}: no probabilities`);
    }
    if (problems.length) throw new ModelOutputError(`the System One answer is incomplete: ${problems.slice(0, 5).join('; ')}`, { problems, raw: JSON.stringify(json).slice(0, 2000) });
    return { answers, usage: json.usage || null, model: json.model || model };
  }

  return { kind: 'systemone', model, systemOne };
}

// The decision client the settings ask for. Fails before any HTTP call when a key is missing.
export function createDecisionClient(settings, opts = {}) {
  const problem = decisionProblem(settings);
  if (problem) throw new ModelError(problem);
  const endpoint = { ...decisionEndpoint(settings), keySetting: decisionKeySetting(settings), ...opts };
  if (decisionProvider(settings) === 'typesafe') return createSystemOneClient({ ...endpoint, model: settings.TYPESAFE_MODEL });
  return createModelClient(endpoint);
}
