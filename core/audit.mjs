// The audit trail: <records>/audit/chain.jsonl, append-only, hash-chained and signed.
//
// Each line is one entry:
//   { seq, ts, prev, event, hash, sig }
//   hash = sha256(canonical JSON of { seq, ts, prev, event })
//   sig  = HMAC-SHA256(key, hash)          key: <records>/audit/.key (32 random bytes, mode 600)
//   prev = hash of the previous entry ("0" × 64 for the first)
//
// <records>/audit/head.json holds the last { seq, hash } with its own signature, so deleting the
// newest entries is caught as well as editing or removing one in the middle.
//
// Appends take a lock (an exclusive mkdir), so concurrent writers never interleave or fork the chain.
// The orchestrator is the only writer; agents never call append().
//
// CLI: node core/audit.mjs verify <records-dir>
//      node core/audit.mjs replay <records-dir> <task>

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir, rmdir, rename, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from '../orchestrator/lib/records.mjs';

export const GENESIS = '0'.repeat(64);

// Canonical JSON: object keys sorted at every level, so the same entry always hashes the same.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest('hex');
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function entryHash({ seq, ts, prev, event }) {
  return sha256(canonical({ seq, ts, prev, event }));
}

export function openAudit(recordsDir, { now = () => new Date().toISOString(), log = true } = {}) {
  const dir = join(recordsDir, 'audit');
  const chainFile = join(dir, 'chain.jsonl');
  const headFile = join(dir, 'head.json');
  const keyFile = join(dir, '.key');
  const lockDir = join(dir, '.lock');
  let key = null;

  async function getKey() {
    if (key) return key;
    await mkdir(dir, { recursive: true });
    if (!existsSync(keyFile)) {
      try {
        await writeFile(keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    await chmod(keyFile, 0o600);
    // Another process may have created the file and not written it yet: wait for the full key.
    for (let i = 0; i < 200; i++) {
      const hex = (await readFile(keyFile, 'utf8')).trim();
      if (hex.length === 64) return (key = Buffer.from(hex, 'hex'));
      await sleep(5);
    }
    throw new Error(`audit key ${keyFile} is incomplete`);
  }

  async function lock(timeoutMs = 10_000) {
    const start = Date.now();
    for (;;) {
      try {
        await mkdir(lockDir);
        return;
      } catch (e) {
        // Windows answers EPERM (or EACCES/EBUSY) while another process is removing the lock dir.
        if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        if (Date.now() - start > timeoutMs) throw new Error(`audit lock held for over ${timeoutMs} ms: ${lockDir}`);
        await sleep(5 + Math.random() * 10);
      }
    }
  }
  const unlock = () => rmdir(lockDir).catch(() => {});

  async function readLines() {
    if (!existsSync(chainFile)) return [];
    return (await readFile(chainFile, 'utf8')).split('\n').filter(Boolean);
  }

  async function readHead() {
    if (!existsSync(headFile)) return null;
    return JSON.parse(await readFile(headFile, 'utf8'));
  }

  // Append one event. `event` is any JSON object; by convention { type, task?, summary?, ... }.
  // A `summary` is also written as one line to the human-readable log.md.
  async function append(event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('an audit event needs a string "type"');
    const k = await getKey();
    await lock();
    let entry;
    try {
      const head = await readHead();
      const seq = head ? head.seq + 1 : 1;
      const prev = head ? head.hash : GENESIS;
      const base = { seq, ts: now(), prev, event };
      const hash = entryHash(base);
      entry = { ...base, hash, sig: hmac(k, hash) };
      await appendFile(chainFile, `${JSON.stringify(entry)}\n`);
      const newHead = { seq, hash };
      const tmp = `${headFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ ...newHead, sig: hmac(k, canonical(newHead)) }));
      await rename(tmp, headFile);
    } finally {
      await unlock();
    }
    if (log && event.summary) await appendLog(recordsDir, `${event.task ? `${event.task} · ` : ''}${event.summary}`).catch(() => {});
    return entry;
  }

  // Recompute every hash and signature and the chain links. Returns { ok, count, broken? }.
  async function verify() {
    const k = await getKey();
    const lines = await readLines();
    let prev = GENESIS;
    let lastHash = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      const at = i + 1;
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        return { ok: false, count: lines.length, broken: { line: at, reason: 'not valid JSON' } };
      }
      if (e.seq !== at) return { ok: false, count: lines.length, broken: { line: at, reason: `expected seq ${at}, found ${e.seq}` } };
      if (e.prev !== prev) return { ok: false, count: lines.length, broken: { line: at, reason: 'prev does not match the previous entry' } };
      const hash = entryHash(e);
      if (!sameHex(hash, e.hash)) return { ok: false, count: lines.length, broken: { line: at, reason: 'hash does not match the content' } };
      if (!sameHex(hmac(k, e.hash), e.sig)) return { ok: false, count: lines.length, broken: { line: at, reason: 'signature does not match' } };
      prev = e.hash;
      lastHash = e.hash;
    }
    const head = await readHead();
    if (lines.length === 0 && !head) return { ok: true, count: 0 };
    if (!head) return { ok: false, count: lines.length, broken: { line: lines.length, reason: 'head.json is missing' } };
    if (!sameHex(hmac(k, canonical({ seq: head.seq, hash: head.hash })), head.sig)) {
      return { ok: false, count: lines.length, broken: { line: lines.length, reason: 'head.json signature does not match' } };
    }
    if (head.seq !== lines.length || head.hash !== lastHash) {
      return { ok: false, count: lines.length, broken: { line: lines.length, reason: `head says ${head.seq} entries, chain has ${lines.length}` } };
    }
    return { ok: true, count: lines.length };
  }

  // The entries for one task, in order (or every entry when no task is given).
  async function replay({ task } = {}) {
    const entries = (await readLines()).map((l) => JSON.parse(l));
    return task ? entries.filter((e) => e.event && e.event.task === task) : entries;
  }

  return { append, verify, replay, files: { chainFile, headFile, keyFile } };
}

async function main([cmd, recordsDir, task]) {
  if (!cmd || !recordsDir || !['verify', 'replay'].includes(cmd)) {
    console.error('usage: node core/audit.mjs verify <records-dir> | replay <records-dir> <task>');
    return 2;
  }
  const audit = openAudit(recordsDir, { log: false });
  if (cmd === 'verify') {
    const r = await audit.verify();
    console.log(r.ok ? `AUDIT=ok ENTRIES=${r.count}` : `AUDIT=broken LINE=${r.broken.line} REASON="${r.broken.reason}"`);
    return r.ok ? 0 : 1;
  }
  for (const e of await audit.replay({ task })) console.log(`${e.seq}\t${e.ts}\t${e.event.type}\t${e.event.summary || ''}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
