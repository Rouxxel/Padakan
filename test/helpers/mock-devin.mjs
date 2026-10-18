// A local stand-in for the Devin API v3 (node:http, zero dependencies).
//
// Serves the endpoints sandboxes/devin/client.mjs uses, under /v3. Every request is recorded
// (method, path, query, headers, body) so tests can assert on exactly what was sent.
// Tests drive it through the returned object: queue failures, edit sessions, add messages and
// attachments, and serve files for download.

import { createServer } from 'node:http';

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const problem = (res, status, title, detail, headers) => json(res, status, { type: 'about:blank', title, status, detail }, headers);

export async function startMockDevin({ orgId = 'org-test', apiKey = 'cog_test_key' } = {}) {
  const requests = [];
  const sessions = new Map();
  const messages = new Map(); // session_id -> [{event_id, message, source, created_at}]
  const attachments = new Map(); // session_id -> [{attachment_id, name, url}]
  const uploads = [];
  const files = new Map(); // path -> Buffer
  const failures = []; // [{ match(method, path), status, headers, body }]
  let seq = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const entry = { method: req.method, path, query: Object.fromEntries(url.searchParams), queryAll: url.searchParams, headers: req.headers, raw };
    const ctype = req.headers['content-type'] ?? '';
    if (ctype.startsWith('application/json') && raw.length) entry.body = JSON.parse(raw.toString('utf8'));
    requests.push(entry);

    if (files.has(path)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(files.get(path));
    }

    const f = failures.findIndex((x) => x.match(req.method, path));
    if (f >= 0) {
      const [fail] = failures.splice(f, 1);
      if (fail.body !== undefined) return json(res, fail.status, fail.body, fail.headers);
      return problem(res, fail.status, fail.title ?? 'Mock failure', fail.detail ?? `queued ${fail.status}`, fail.headers);
    }

    if (req.headers.authorization !== `Bearer ${apiKey}`) return problem(res, 401, 'Unauthorized', 'bad token');
    if (path === '/v3/self') return json(res, 200, { principal_type: 'service_user', service_user_id: 'su-1', org_id: orgId });

    const prefix = `/v3/organizations/${orgId}`;
    if (!path.startsWith(prefix)) return problem(res, 404, 'Not Found', path);
    const rest = path.slice(prefix.length);
    let m;

    if (rest === '/attachments' && req.method === 'POST') {
      const name = /filename="([^"]+)"/.exec(raw.toString('latin1'))?.[1] ?? 'file';
      const att = { attachment_id: `att-${++seq}`, name, url: `https://attachments.example/${seq}/${name}` };
      uploads.push({ ...att, raw, contentType: ctype });
      return json(res, 200, att);
    }
    if (rest === '/sessions' && req.method === 'POST') {
      const body = entry.body ?? {};
      if (!body.prompt) return problem(res, 422, 'Unprocessable Content', 'prompt is required');
      const id = `devin-${++seq}`;
      const session = {
        session_id: id, url: `https://app.devin.ai/sessions/${id}`, status: 'new', status_detail: null,
        tags: body.tags ?? [], org_id: orgId, created_at: Date.now(), updated_at: Date.now(),
        acus_consumed: 0, pull_requests: [], structured_output: null, is_archived: false, request: body,
      };
      sessions.set(id, session);
      messages.set(id, []);
      attachments.set(id, []);
      return json(res, 200, session);
    }
    if (rest === '/sessions' && req.method === 'GET') {
      let items = [...sessions.values()];
      const tags = url.searchParams.getAll('tags');
      if (tags.length) items = items.filter((s) => tags.every((t) => s.tags.includes(t)));
      if (url.searchParams.has('is_archived')) items = items.filter((s) => String(s.is_archived) === url.searchParams.get('is_archived'));
      return json(res, 200, { items, total: items.length, has_next_page: false, end_cursor: null });
    }
    if ((m = rest.match(/^\/sessions\/([^/]+)(\/[a-z]+)?$/))) {
      const [, id, sub = ''] = m;
      const s = sessions.get(decodeURIComponent(id));
      if (!s) return problem(res, 404, 'Not Found', `session ${id}`);
      if (!sub && req.method === 'GET') return json(res, 200, s);
      if (!sub && req.method === 'DELETE') {
        s.status = 'exit';
        s.terminated = true;
        if (url.searchParams.get('archive') === 'true') s.is_archived = true;
        return json(res, 200, s);
      }
      if (sub === '/messages' && req.method === 'POST') {
        if (s.terminated) return problem(res, 409, 'Conflict', 'session terminated');
        const msg = { event_id: `ev-${++seq}`, message: entry.body?.message, source: 'user', origin: 'api', created_at: Date.now() };
        messages.get(s.session_id).push(msg);
        if (s.status === 'suspended') s.status = 'running';
        return json(res, 200, s);
      }
      if (sub === '/messages' && req.method === 'GET') {
        const list = messages.get(s.session_id);
        const after = url.searchParams.get('after');
        const start = after ? list.findIndex((x) => x.event_id === after) + 1 : 0;
        const items = list.slice(start);
        return json(res, 200, { items, total: list.length, has_next_page: false, end_cursor: items.at(-1)?.event_id ?? after });
      }
      if (sub === '/attachments' && req.method === 'GET') return json(res, 200, { items: attachments.get(s.session_id) });
      if (sub === '/archive' && req.method === 'POST') {
        s.is_archived = true;
        if (s.status === 'running') {
          s.status = 'suspended';
          s.status_detail = 'user_request';
        }
        return json(res, 200, s);
      }
      if (sub === '/tags' && req.method === 'POST') {
        s.tags = [...new Set([...s.tags, ...(entry.body?.tags ?? [])])];
        return json(res, 200, { tags: s.tags });
      }
    }
    return problem(res, 404, 'Not Found', `${req.method} ${path}`);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    apiUrl: `${origin}/v3`,
    orgId,
    apiKey,
    requests,
    sessions,
    uploads,
    // Queue a failure for the next request matching method and path (path may be a RegExp).
    failNext(method, path, status, opts = {}) {
      const match = (mm, pp) => mm === method && (path instanceof RegExp ? path.test(pp) : pp === path);
      failures.push({ match, status, ...opts });
    },
    update(id, fields) {
      Object.assign(sessions.get(id), fields, { updated_at: Date.now() });
    },
    // A message from Devin (source "devin"), as when it asks a question.
    devinSays(id, message) {
      messages.get(id).push({ event_id: `ev-${++seq}`, message, source: 'devin', origin: 'devin', created_at: Date.now() });
    },
    messagesOf: (id) => messages.get(id),
    addAttachment(id, name, content, { host = origin } = {}) {
      const path = `/files/${++seq}/${name}`;
      files.set(path, Buffer.from(content));
      const att = { attachment_id: `att-${seq}`, name, url: `${host}${path}` };
      attachments.get(id).push(att);
      return att;
    },
    serveFile(path, content) {
      files.set(path, Buffer.from(content));
      return `${origin}${path}`;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
