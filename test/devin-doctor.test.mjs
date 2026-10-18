// Onboarding checks for the Devin provider (A.11), against the mock Devin API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockDevin } from './helpers/mock-devin.mjs';
import { ROOT } from './helpers.mjs';
import { doctor } from '../sandboxes/devin/doctor.mjs';
import { loadSettings } from '../orchestrator/lib/env.mjs';

let mock;
before(async () => {
  mock = await startMockDevin();
});
after(() => mock.close());

const settings = (extra = {}) =>
  loadSettings({ exported: { DEVIN_API_URL: mock.apiUrl, DEVIN_API_KEY: mock.apiKey, DEVIN_ORG_ID: mock.orgId, PADAKAN_DEVIN_USD_PER_ACU: '2.25', ...extra } });
const run = (extra) => doctor({ settings: settings(extra) }, { clientOptions: { sleep: async () => {} } });
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));

test('all good: token, permission, platform and price pass; recordings is a reminder', async () => {
  mock.requests.length = 0;
  const r = byName(await run({ DEVIN_MAX_ACU: '20' }));
  assert.equal(r['api-key'].ok, true);
  assert.match(r['api-key'].detail, /GET \/self ok/);
  assert.equal(r.sessions.ok, true);
  assert.equal(r.platform.ok, true);
  assert.deepEqual([r.recordings.ok, r.recordings.level], [false, 'warn']);
  assert.match(r['acu-price'].detail, /\$2\.25 per ACU/);
  assert.equal(r['max-acu'].ok, true);
  const list = mock.requests.find((q) => q.path.endsWith('/sessions') && q.method === 'GET');
  assert.equal(list.query.first, '1', 'the smallest page the API allows');
});

test('missing or malformed settings fail without calling the API', async () => {
  mock.requests.length = 0;
  const r = byName(await doctor({ settings: loadSettings({ exported: {} }) }));
  assert.match(r['api-key'].detail, /DEVIN_API_KEY is not set/);
  assert.match(r.org.detail, /DEVIN_ORG_ID is not set/);
  assert.match(r['acu-price'].detail, /PADAKAN_DEVIN_USD_PER_ACU is not set/);
  assert.equal(mock.requests.length, 0);
  assert.match(byName(await run({ DEVIN_API_KEY: 'abc123' }))['api-key'].detail, /does not start with cog_/);
});

test('401 and 403 become one-line fixes; the key never appears', async () => {
  mock.failNext('GET', '/v3/self', 401);
  mock.failNext('GET', `/v3/organizations/${mock.orgId}/sessions`, 403);
  const rows = await run();
  const r = byName(rows);
  assert.match(r['api-key'].detail, /401: the token is wrong or revoked/);
  assert.match(r.sessions.detail, /403: give the service user the UseDevinSessions permission/);
  assert.ok(!JSON.stringify(rows).includes(mock.apiKey));
});

test('an unknown platform warns (it may be an Outpost pool); an org mismatch warns', async () => {
  const r = byName(await run({ DEVIN_PLATFORM: 'my-pool' }));
  assert.deepEqual([r.platform.ok, r.platform.level], [false, 'warn']);
  const other = await startMockDevin({ orgId: 'org-other' });
  try {
    const rows = await doctor(
      { settings: loadSettings({ exported: { DEVIN_API_URL: other.apiUrl, DEVIN_API_KEY: other.apiKey, DEVIN_ORG_ID: 'org-other', PADAKAN_DEVIN_USD_PER_ACU: '1' } }) },
      { createClient: (o) => ({ self: async () => ({ org_id: 'org-elsewhere' }), listSessions: async () => ({ items: [] }) }) },
    );
    assert.match(byName(rows)['org-match'].detail, /belongs to org-elsewhere, but DEVIN_ORG_ID is org-other/);
  } finally {
    await other.close();
  }
});

test('the blueprint template has no secrets and no repo-level post-build', async () => {
  const text = await readFile(join(ROOT, 'sandboxes', 'devin', 'blueprint.yaml'), 'utf8');
  for (const section of ['initialize:', 'maintenance:', 'knowledge:']) assert.ok(text.includes(`\n${section}`), section);
  assert.doesNotMatch(text, /^post-build:/m);
  assert.doesNotMatch(text, /cog_[A-Za-z0-9]|api[_-]?key\s*[:=]\s*\S/i);
});
