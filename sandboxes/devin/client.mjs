// HTTP client for the Devin API v3. Zero dependencies.
//
// Settings come from the caller (orchestrator/lib/env.mjs), never from process.env here.
// The API key is sent only to the API origin and is redacted from every error.
// Retries 429, 5xx and network failures with exponential backoff and jitter, honouring Retry-After.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const MAX_RETRY_AFTER_MS = 60_000;

export class DevinError extends Error {
  constructor({ status, title, detail, path, method, body }) {
    super(`Devin API ${method} ${path} -> ${status || 'network error'}${title ? ` ${title}` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'DevinError';
    Object.assign(this, { status, title, detail, path, method, body });
  }
}

// Replace every secret (and anything shaped like a Devin token) in a string.
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out.replace(/cog_[A-Za-z0-9_\-]+/g, 'cog_***');
}

function retryAfterMs(header, now = Date.now()) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs * 1000), MAX_RETRY_AFTER_MS);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS) : null;
}

const retryable = (status) => status === 0 || status === 429 || status >= 500;

function toQuery(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    for (const item of [].concat(v)) q.append(k, String(item));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function createClient({
  apiUrl = 'https://api.devin.ai/v3',
  apiKey,
  orgId,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  timeoutMs = 30_000,
} = {}) {
  if (!apiKey) throw new Error('Devin client needs DEVIN_API_KEY');
  if (!orgId) throw new Error('Devin client needs DEVIN_ORG_ID');
  const base = apiUrl.replace(/\/+$/, '');
  const apiOrigin = new URL(base).origin;
  const org = `/organizations/${encodeURIComponent(orgId)}`;
  const secrets = [apiKey];
  const clean = (s) => redact(s, secrets);

  async function request(method, path, { json, form, query, raw = false } = {}) {
    const url = `${base}${path}${toQuery(query)}`;
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) body = form;

    for (let attempt = 0; ; attempt++) {
      let res;
      let status = 0;
      let networkError = null;
      try {
        res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
        status = res.status;
      } catch (e) {
        networkError = e;
      }
      if (res?.ok) {
        if (raw) return res;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
      if (retryable(status) && attempt < RETRY_DELAYS_MS.length) {
        const wait = retryAfterMs(res?.headers?.get('retry-after')) ?? RETRY_DELAYS_MS[attempt] * (0.75 + random() * 0.5);
        await sleep(wait);
        continue;
      }
      if (networkError) {
        throw new DevinError({ status: 0, method, path, title: networkError.name, detail: clean(networkError.message) });
      }
      const text = clean(await res.text().catch(() => ''));
      let problem = {};
      try {
        problem = JSON.parse(text);
      } catch {}
      const detail = typeof problem.detail === 'string' ? problem.detail : problem.detail ? JSON.stringify(problem.detail) : text.slice(0, 2000);
      throw new DevinError({ status, method, path, title: clean(problem.title ?? res.statusText ?? ''), detail: clean(detail), body: text });
    }
  }

  const s = (id) => `${org}/sessions/${encodeURIComponent(id)}`;

  return {
    self: () => request('GET', '/self'),
    createSession: (body) => request('POST', `${org}/sessions`, { json: body }),
    getSession: (id) => request('GET', s(id)),
    // Filters: tags, is_archived, session_ids, repo_names, ...; pagination: first, after.
    listSessions: (query = {}) => request('GET', `${org}/sessions`, { query }),
    listMessages: (id, { after, first } = {}) => request('GET', `${s(id)}/messages`, { query: { after, first } }),
    sendMessage: (id, message, { attachmentUrls } = {}) =>
      request('POST', `${s(id)}/messages`, { json: attachmentUrls?.length ? { message, attachment_urls: attachmentUrls } : { message } }),
    listAttachments: (id) => request('GET', `${s(id)}/attachments`),
    // file: { name, content: Buffer | string, type? } -> { attachment_id, name, url }
    uploadAttachment: ({ name, content, type = 'application/octet-stream' }) => {
      const form = new FormData();
      form.append('file', new Blob([content], { type }), name);
      return request('POST', `${org}/attachments`, { form });
    },
    archiveSession: (id) => request('POST', `${s(id)}/archive`),
    terminateSession: (id, { archive = false } = {}) => request('DELETE', s(id), { query: archive ? { archive: true } : {} }),
    appendTags: (id, tags) => request('POST', `${s(id)}/tags`, { json: { tags } }),

    // Download an attachment URL to a file. The API key is sent only when the URL is on the API's
    // own origin; presigned URLs on other hosts get no credentials.
    async download(url, dest) {
      const sameOrigin = new URL(url).origin === apiOrigin;
      let res;
      try {
        res = await fetchImpl(url, { headers: sameOrigin ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(timeoutMs * 4) });
      } catch (e) {
        throw new DevinError({ status: 0, method: 'GET', path: '<attachment>', title: e.name, detail: clean(e.message) });
      }
      if (!res.ok) throw new DevinError({ status: res.status, method: 'GET', path: '<attachment>', title: clean(res.statusText) });
      const bytes = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
      return { path: dest, bytes: bytes.length };
    },
  };
}
