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

// Endpoint and key for the decision models, from settings.
export function decisionEndpoint(settings) {
  const baseUrl = settings.PADAKAN_DECISION_BASE_URL || settings.NEBIUS_BASE_URL;
  const apiKey = settings.PADAKAN_DECISION_BASE_URL ? settings.PADAKAN_DECISION_API_KEY || '' : settings.NEBIUS_API_KEY || '';
  return { baseUrl, apiKey };
}

const redact = (text, key) => (key && key.length >= 4 ? String(text).split(key).join('***') : String(text));

// Pull a JSON object out of a model answer: plain JSON, or JSON inside a ``` fence.
export function extractJson(content) {
  const text = String(content ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

export function createModelClient({ baseUrl, apiKey = '', fetch: fetchFn = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delays = RETRY_DELAYS_MS } = {}) {
  if (!baseUrl) throw new ModelError('no decision model endpoint (set NEBIUS_BASE_URL or PADAKAN_DECISION_BASE_URL)');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  async function post(body) {
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
      throw new ModelError(`model endpoint returned ${res.status}: ${redact(text.slice(0, 300), apiKey)}`, { status: res.status });
    }
  }

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

  return { chatJson };
}
