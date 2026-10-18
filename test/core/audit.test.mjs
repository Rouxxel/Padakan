import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, tempDir, removeDir, runNode } from '../helpers/index.mjs';
import { openAudit, canonical, GENESIS } from '../../core/audit.mjs';
import { init } from '../../orchestrator/lib/records.mjs';

async function withRecords(fn) {
  const dir = join(await tempDir(), 'shop-padakan');
  await init(dir);
  try {
    return await fn(dir);
  } finally {
    await removeDir(join(dir, '..'));
  }
}

async function seed(audit, n = 5) {
  for (let i = 1; i <= n; i++) await audit.append({ type: 'step', task: i % 2 ? 'PAD-1' : 'PAD-2', summary: `step ${i}` });
}

const lines = async (file) => (await readFile(file, 'utf8')).split('\n').filter(Boolean);

test('canonical JSON sorts keys at every level', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
});

test('entries chain from genesis, verify passes, and the key is private', async () => {
  await withRecords(async (dir) => {
    const audit = openAudit(dir);
    const first = await audit.append({ type: 'plan.approved', summary: 'plan approved' });
    assert.equal(first.seq, 1);
    assert.equal(first.prev, GENESIS);
    const second = await audit.append({ type: 'tree.planted', task: 'PAD-12' });
    assert.equal(second.prev, first.hash);
    assert.deepEqual(await audit.verify(), { ok: true, count: 2 });
    assert.equal((await stat(audit.files.keyFile)).mode & 0o777, 0o600);
    assert.match(await readFile(join(dir, 'log.md'), 'utf8'), /· plan approved\n/);
  });
});

test('AC1: changing any field of any entry breaks verify at that entry', async () => {
  for (const mutate of [
    (e) => (e.event.summary = 'rewritten'),
    (e) => (e.ts = '2020-01-01T00:00:00Z'),
    (e) => (e.event.extra = 1),
    (e) => (e.sig = e.sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))),
  ]) {
    await withRecords(async (dir) => {
      const audit = openAudit(dir, { log: false });
      await seed(audit);
      const ls = await lines(audit.files.chainFile);
      const e = JSON.parse(ls[2]);
      mutate(e);
      ls[2] = JSON.stringify(e);
      await writeFile(audit.files.chainFile, `${ls.join('\n')}\n`);
      const r = await audit.verify();
      assert.equal(r.ok, false);
      assert.equal(r.broken.line, 3);
    });
  }
});

test('a rewritten entry with a recomputed hash still fails, because of the signature', async () => {
  await withRecords(async (dir) => {
    const audit = openAudit(dir, { log: false });
    await seed(audit);
    const { entryHash } = await import('../../core/audit.mjs');
    const ls = await lines(audit.files.chainFile);
    const e = JSON.parse(ls[4]);
    e.event.summary = 'forged';
    e.hash = entryHash(e);
    ls[4] = JSON.stringify(e);
    await writeFile(audit.files.chainFile, `${ls.join('\n')}\n`);
    const r = await audit.verify();
    assert.deepEqual(r.broken, { line: 5, reason: 'signature does not match' });
  });
});

test('AC2: deleting an entry breaks verify, including the newest one', async () => {
  await withRecords(async (dir) => {
    const audit = openAudit(dir, { log: false });
    await seed(audit);
    const ls = await lines(audit.files.chainFile);
    await writeFile(audit.files.chainFile, `${[...ls.slice(0, 2), ...ls.slice(3)].join('\n')}\n`);
    assert.equal((await audit.verify()).ok, false);
    await writeFile(audit.files.chainFile, `${ls.slice(0, 4).join('\n')}\n`);
    const r = await audit.verify();
    assert.equal(r.ok, false);
    assert.match(r.broken.reason, /head says 5 entries, chain has 4/);
  });
});

test('AC3: concurrent appends never interleave or fork the chain', async () => {
  await withRecords(async (dir) => {
    const audit = openAudit(dir, { log: false });
    await Promise.all(Array.from({ length: 25 }, (_, i) => audit.append({ type: 'step', n: i })));
    // And from separate processes, which share only the files.
    const script = `import { openAudit } from ${JSON.stringify(join(ROOT, 'core', 'audit.mjs'))};
      const a = openAudit(${JSON.stringify(dir)}, { log: false });
      for (let i = 0; i < 10; i++) await a.append({ type: 'proc', pid: process.pid, i });`;
    await Promise.all(
      [1, 2, 3].map(
        () =>
          new Promise((res, rej) => {
            const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
            p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`child exited ${code}`))));
          }),
      ),
    );
    assert.deepEqual(await audit.verify(), { ok: true, count: 55 });
    for (const l of await lines(audit.files.chainFile)) JSON.parse(l);
  });
});

test('replay returns one task in order; the CLI verifies and replays', async () => {
  await withRecords(async (dir) => {
    const audit = openAudit(dir, { log: false });
    await seed(audit, 6);
    const r = await audit.replay({ task: 'PAD-2' });
    assert.deepEqual(r.map((e) => e.seq), [2, 4, 6]);
    const v = runNode(join(ROOT, 'core', 'audit.mjs'), ['verify', dir]);
    assert.equal(v.code, 0);
    assert.equal(v.stdout.trim(), 'AUDIT=ok ENTRIES=6');
    const rp = runNode(join(ROOT, 'core', 'audit.mjs'), ['replay', dir, 'PAD-1']);
    assert.equal(rp.stdout.trim().split('\n').length, 3);
  });
});

test('an event needs a type', async () => {
  await withRecords(async (dir) => {
    await assert.rejects(openAudit(dir).append({ task: 'x' }), /needs a string "type"/);
  });
});
