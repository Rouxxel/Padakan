import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient, DevinError, redact, RETRY_DELAYS_MS } from '../sandboxes/devin/client.mjs';
import { startMockDevin } from './helpers/mock-devin.mjs';
import { tempDir, removeDir } from './helpers.mjs';

let mock;
let sleeps;
const client = (o = {}) =>
  createClient({ apiUrl: mock.apiUrl, apiKey: mock.apiKey, orgId: mock.orgId, sleep: async (ms) => sleeps.push(ms), random: () => 0.5, ...o });

before(async () => {
  mock = await startMockDevin();
});
after(() => mock.close());
const reset = () => {
  sleeps = [];
  mock.requests.length = 0;
};

test('P1 (client part) createSession sends the body as given, with auth only in the header', async () => {
  reset();
  const body = { prompt: 'do PAD-12', repos: ['o/r'], tags: ['padakan', 'task:PAD-12'], max_acu_limit: 7, resumable: true, bypass_approval: true };
  const s = await client().createSession(body);
  assert.match(s.session_id, /^devin-/);
  const req = mock.requests.at(-1);
  assert.equal(req.method, 'POST');
  assert.equal(req.path, `/v3/organizations/${mock.orgId}/sessions`);
  assert.deepEqual(req.body, body);
  assert.equal(req.headers.authorization, `Bearer ${mock.apiKey}`);
  assert.ok(!req.raw.toString().includes(mock.apiKey), 'key must not be in the body');
});

test('client covers every endpoint in the plan', async () => {
  reset();
  const c = client();
  assert.equal((await c.self()).principal_type, 'service_user');
  const { session_id: id } = await c.createSession({ prompt: 'x', tags: ['padakan'] });
  assert.equal((await c.getSession(id)).session_id, id);
  assert.equal((await c.listSessions({ tags: ['padakan'], first: 1 })).items.length >= 1, true);
  const listReq = mock.requests.at(-1);
  assert.deepEqual(listReq.queryAll.getAll('tags'), ['padakan']);
  await c.sendMessage(id, 'hello');
  assert.deepEqual(mock.requests.at(-1).body, { message: 'hello' });
  mock.devinSays(id, 'question?');
  const msgs = await c.listMessages(id);
  assert.equal(msgs.items.length, 2);
  assert.equal((await c.listMessages(id, { after: msgs.end_cursor })).items.length, 0);
  const up = await c.uploadAttachment({ name: 'brief.md', content: '# brief' });
  assert.match(up.url, /brief\.md$/);
  assert.match(mock.uploads.at(-1).contentType, /^multipart\/form-data/);
  assert.match(mock.uploads.at(-1).raw.toString(), /name="file"; filename="brief.md"/);
  assert.deepEqual((await c.appendTags(id, ['run:r-1'])).tags, ['padakan', 'run:r-1']);
  assert.equal((await c.archiveSession(id)).is_archived, true);
  assert.deepEqual((await c.listAttachments(id)).items, []);
  await c.terminateSession(id, { archive: true });
  assert.equal(mock.requests.at(-1).method, 'DELETE');
  assert.equal(mock.requests.at(-1).query.archive, 'true');
});

test('P2 retries 429 and 503, honours Retry-After, gives up after 4 retries', async () => {
  reset();
  const s = await client().createSession({ prompt: 'p' });
  mock.failNext('GET', `/v3/organizations/${mock.orgId}/sessions/${s.session_id}`, 429, { headers: { 'Retry-After': '3' } });
  mock.failNext('GET', `/v3/organizations/${mock.orgId}/sessions/${s.session_id}`, 503);
  sleeps = [];
  assert.equal((await client().getSession(s.session_id)).session_id, s.session_id);
  assert.deepEqual(sleeps, [3000, RETRY_DELAYS_MS[1]]);

  reset();
  for (let i = 0; i < 5; i++) mock.failNext('GET', '/v3/self', 500);
  await assert.rejects(client().self(), (e) => e instanceof DevinError && e.status === 500);
  assert.equal(mock.requests.length, 5, 'one try plus 4 retries');
  assert.deepEqual(sleeps, RETRY_DELAYS_MS);
});

test('P2 does not retry 400, 401, 403, 404', async () => {
  for (const status of [400, 401, 403, 404]) {
    reset();
    mock.failNext('GET', '/v3/self', status);
    await assert.rejects(client().self(), (e) => e.status === status);
    assert.equal(mock.requests.length, 1, `no retry on ${status}`);
    assert.deepEqual(sleeps, []);
  }
});

test('errors carry the ProblemDetail and the 400 body as is', async () => {
  reset();
  const body = { title: 'Bad Request', status: 400, detail: 'Unknown platform "mac". Available: linux, macos, windows, pool-a' };
  mock.failNext('POST', `/v3/organizations/${mock.orgId}/sessions`, 400, { body });
  const err = await client().createSession({ prompt: 'p', platform: 'mac' }).catch((e) => e);
  assert.ok(err instanceof DevinError);
  assert.equal(err.title, 'Bad Request');
  assert.match(err.detail, /Available: linux, macos, windows, pool-a/);
  assert.deepEqual(JSON.parse(err.body), body);
});

test('network failures are retried, then reported without the key', async () => {
  reset();
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new TypeError(`fetch failed for ${mock.apiKey}`);
  };
  const err = await client({ fetch: failing }).self().catch((e) => e);
  assert.equal(calls, 5);
  assert.equal(err.status, 0);
  assert.ok(!err.message.includes(mock.apiKey));
});

test('P3 the API key never appears in errors or downloaded files', async () => {
  reset();
  const leaky = { title: `Denied for ${mock.apiKey}`, status: 403, detail: `token ${mock.apiKey} lacks UseDevinSessions; also cog_other_token` };
  mock.failNext('GET', '/v3/self', 403, { body: leaky });
  const err = await client().self().catch((e) => e);
  for (const text of [err.message, err.title, err.detail, err.body, String(err.stack)]) {
    assert.ok(!text.includes(mock.apiKey), `key leaked in: ${text}`);
    assert.ok(!text.includes('cog_other_token'));
  }

  const dir = await tempDir();
  try {
    const { session_id: id } = await client().createSession({ prompt: 'p' });
    const att = mock.addAttachment(id, 'run.mp4', 'VIDEO');
    await client().download(att.url, join(dir, 'evidence', 'run.mp4'));
    for (const f of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (f.isFile()) assert.ok(!(await readFile(join(f.parentPath ?? f.path, f.name), 'utf8')).includes(mock.apiKey));
    }
  } finally {
    await removeDir(dir);
  }
});

test('download sends the key only to the API origin', async () => {
  reset();
  const other = await startMockDevin({ apiKey: 'cog_other' });
  const dir = await tempDir();
  try {
    const { session_id: id } = await client().createSession({ prompt: 'p' });
    const same = mock.addAttachment(id, 'a.mp4', 'A');
    const foreign = other.serveFile('/files/b.mp4', 'BB');
    const r1 = await client().download(same.url, join(dir, 'a.mp4'));
    assert.equal(mock.requests.at(-1).headers.authorization, `Bearer ${mock.apiKey}`);
    const r2 = await client().download(foreign, join(dir, 'b.mp4'));
    assert.equal(other.requests.at(-1).headers.authorization, undefined);
    assert.deepEqual([r1.bytes, r2.bytes], [1, 2]);
    assert.equal(await readFile(join(dir, 'b.mp4'), 'utf8'), 'BB');
  } finally {
    await other.close();
    await removeDir(dir);
  }
});

test('redact and constructor checks', () => {
  assert.equal(redact('a cog_abc-123 b secret123', ['secret123']), 'a cog_*** b ***');
  assert.throws(() => createClient({ orgId: 'o' }), /DEVIN_API_KEY/);
  assert.throws(() => createClient({ apiKey: 'k' }), /DEVIN_ORG_ID/);
});
