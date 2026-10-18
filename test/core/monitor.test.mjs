import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRepo, removeDir, tempDir } from '../helpers/index.mjs';
import { parseEvents, cluster, fingerprint, normalize, collect } from '../../core/collect-logs.mjs';
import { triage, route, CATEGORIES } from '../../core/triage.mjs';
import { validateFile } from '../../core/okf.mjs';
import { loadSettings } from '../../orchestrator/lib/env.mjs';
import { buildContext } from '../../orchestrator/lib/context.mjs';
import { STEPS } from '../../orchestrator/steps.mjs';
import { readState } from '../../orchestrator/lib/state.mjs';

const LOG = `2026-10-18T10:00:01Z INFO server started on :3000
2026-10-18T10:00:05Z ERROR TypeError: Cannot read properties of undefined (reading 'total') in order 8f14e45f-ceea-467f-a9f0-0f2d3e5c1a11
    at renderTotals (/app/src/cart.js:42:17)
    at handler (/app/src/routes.js:10:3)
2026-10-18T10:01:07Z ERROR TypeError: Cannot read properties of undefined (reading 'total') in order 1c383cd3-0b46-4c7e-b0e1-6a2a1d2c9e77
    at renderTotals (/app/src/cart.js:42:17)
    at handler (/app/src/routes.js:10:3)
2026-10-18T10:02:00Z WARN slow query 1200ms
2026-10-18T10:03:00Z ERROR upstream payments returned 503 after 3 retries
2026-10-18T10:04:00Z ERROR auth failed for token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8
`;

describe('collector', () => {
  test('keeps error events with their stack lines, drops info and warnings', () => {
    const ev = parseEvents(LOG, 'file:app.log');
    assert.equal(ev.length, 4);
    assert.equal(ev[0].lines.length, 3);
    assert.equal(ev[0].ts, '2026-10-18T10:00:05Z');
  });

  test('AC1: the same error with different timestamps and ids shares one fingerprint', () => {
    const ev = parseEvents(LOG, 'file:app.log');
    assert.equal(fingerprint(ev[0]), fingerprint(ev[1]));
    assert.notEqual(fingerprint(ev[0]), fingerprint(ev[2]));
    const c = cluster(ev);
    assert.equal(c.length, 3);
    assert.equal(c[0].count, 2);
    assert.equal(c[0].first_seen, '2026-10-18T10:00:05Z');
    assert.equal(c[0].last_seen, '2026-10-18T10:01:07Z');
    assert.equal(normalize("order 42 at 10.0.0.1:8080 'x' 0xdeadbeef"), 'order <n> at <ip> <str> <hex>');
  });

  test('a secret in a log line is redacted in the sample and flagged', () => {
    const c = cluster(parseEvents(LOG, 'f'));
    const s = c.find((x) => x.redacted);
    assert.ok(s);
    assert.match(s.sample, /\[redacted: github-token\]/);
    assert.ok(!JSON.stringify(c).includes('ghp_A1b2'));
  });

  test('sources: files and URLs; a failing source is reported, not fatal', async () => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir, 'a.log'), LOG);
      const fetchFn = async () => new Response('2026-10-18T11:00:00Z ERROR boom\n');
      const r = await collect({ sources: [join(dir, 'a.log'), 'https://logs.example/app', join(dir, 'missing.log')], fetchFn });
      assert.equal(r.events, 5);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0].source, /missing\.log$/);
    } finally {
      await removeDir(dir);
    }
  });

  test('docker: every running container is read with timestamps and --since', async () => {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args[0] === 'ps') return { stdout: 'web\nworker\n' };
      return { stdout: args.at(-1) === 'web' ? '2026-10-18T10:00:00Z ERROR crash\n' : '', stderr: '' };
    };
    const r = await collect({ sources: ['docker'], since: '2026-10-18T09:45:00Z', exec });
    assert.equal(r.events, 1);
    assert.ok(calls.includes('docker logs --timestamps --since 2026-10-18T09:45:00Z web'));
  });
});

describe('triage', () => {
  const fakeClient = (items) => ({ chatJson: async () => ({ data: { items }, usage: { prompt_tokens: 1 } }) });

  test('AC2: security and unknown always go to a human; low confidence becomes unknown', () => {
    assert.equal(route({ category: 'security', fixable: true, confidence: 0.99 }).route, 'human');
    assert.equal(route({ category: 'unknown', fixable: true, confidence: 0.99 }).route, 'human');
    const low = route({ category: 'code-defect', fixable: true, confidence: 0.3 });
    assert.equal(low.category, 'unknown');
    assert.equal(low.route, 'human');
    assert.equal(route({ category: 'code-defect', fixable: true, confidence: 0.9 }, { redacted: true }).route, 'human', 'a leaked secret is a security issue');
    assert.equal(route({ category: 'code-defect', fixable: false, confidence: 0.9 }).route, 'human');
    assert.equal(route({ category: 'noise', fixable: false, confidence: 0.9 }).route, 'drop');
    assert.equal(route({ category: 'external-dependency', fixable: false, confidence: 0.9 }).route, 'watch');
    assert.equal(CATEGORIES.length, 8);
  });

  test('a cluster the model skipped is unknown, never dropped', async () => {
    const clusters = [{ fingerprint: 'aaaa', count: 1, sources: ['x'], sample: 'ERROR x' }];
    const { items } = await triage({ clusters, client: fakeClient([]), model: 'm' });
    assert.equal(items[0].category, 'unknown');
    assert.equal(items[0].route, 'human');
  });
});

describe('padakan tick', () => {
  test('AC3: opens one task per fixable fingerprint, never a duplicate; writes an OKF report', async () => {
    const env = await makeRepo('shop');
    try {
      const log = join(env.base, 'app.log');
      await writeFile(log, LOG);
      const records = join(env.parent, 'shop-padakan');
      const settings = loadSettings({ exported: { PADAKAN_SANDBOX_PROVIDER: 'local', PADAKAN_LOG_SOURCES: log } });
      const clusters = cluster(parseEvents(LOG, `file:${log}`));
      const [cart, payments, secret] = [clusters.find((c) => c.count === 2), clusters.find((c) => /503/.test(c.sample)), clusters.find((c) => c.redacted)];
      const models = () => ({
        chatJson: async () => ({
          data: {
            items: [
              { fingerprint: cart.fingerprint, category: 'code-defect', severity: 'P1', fixable: true, confidence: 0.9, summary: 'cart totals crash on empty order' },
              { fingerprint: payments.fingerprint, category: 'external-dependency', severity: 'P2', fixable: false, confidence: 0.8, summary: 'payments provider 503' },
              { fingerprint: secret.fingerprint, category: 'code-defect', severity: 'P1', fixable: true, confidence: 0.9, summary: 'auth error' },
            ],
          },
          usage: null,
        }),
      });
      let clock = Date.parse('2026-10-18T12:00:00Z');
      const ctx = buildContext({ base: { settings, records, repo: env.repo }, overrides: { models, now: () => new Date((clock += 1000)).toISOString() } });
      await STEPS.init(ctx);

      const first = await STEPS.tick(ctx, []);
      const key = `MON-${cart.fingerprint.slice(0, 8)}`;
      assert.match(first.line, new RegExp(`^CLUSTERS=3 FIXABLE=${key} HUMAN=1 DROPPED=0 REPORT=monitor/\\d{8}T\\d{6}Z/report\\.md$`));
      const s = await readState(records);
      assert.equal(s.tasks[key].status, 'planned');
      assert.equal(s.tasks[key].fingerprint, cart.fingerprint);
      assert.ok(s.monitor.last_tick);

      const report = first.line.match(/REPORT=(\S+)/)[1];
      assert.deepEqual(await validateFile(join(records, report)), []);
      assert.match(await readFile(join(records, report), 'utf8'), /a secret appeared in the logs/);

      const second = await STEPS.tick(ctx, []);
      assert.match(second.line, /^CLUSTERS=3 FIXABLE=none HUMAN=1/, 'the open task is not opened twice');
      assert.equal(Object.keys((await readState(records)).tasks).length, 1);
      assert.equal((await ctx.audit.verify()).ok, true);
    } finally {
      await removeDir(env.base);
    }
  });
});
