// Log collector for the monitor loop: read logs, keep the error-like events, and cluster them by a
// fingerprint that ignores what changes between occurrences (timestamps, ids, numbers, paths' line numbers).
//
// Sources (PADAKAN_LOG_SOURCES, comma-separated): `docker` (every running container), a file path, or
// an http(s) URL that serves plain text. Secrets in samples are replaced by their kind.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { secretKinds } from './diffcheck.mjs';

const run = promisify(execFile);

const ERROR_RE = /\b(ERROR|FATAL|CRITICAL|PANIC|SEVERE)\b|\b(Error|Exception)\b[:\s]|Traceback \(most recent call last\)|^panic:|Unhandled|uncaught/i;
const CONTINUATION_RE = /^(\s+|at\s|Caused by:|\.\.\. \d+ more|File ")/;
const LEADING_TS_RE = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/;

// Replace everything that varies between occurrences of the same error.
export function normalize(line) {
  return line
    .replace(LEADING_TS_RE, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/(["'])(?:(?!\1).){1,200}\1/g, '<str>')
    .replace(/:\d+(?::\d+)?\b/g, ':<n>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(event) {
  const head = normalize(event.lines[0]);
  // The first stack frame helps separate two errors with the same message.
  const frame = event.lines.slice(1).find((l) => /^\s*(at |File ")/.test(l));
  return createHash('sha256').update(`${head}\n${frame ? normalize(frame) : ''}`).digest('hex').slice(0, 16);
}

function redactLine(line) {
  const kinds = secretKinds(line);
  return kinds.length ? `[redacted: ${kinds.join(', ')}]` : line;
}

// Split raw text into error events (with their continuation lines).
export function parseEvents(text, source) {
  const events = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) {
      cur = null;
      continue;
    }
    if (cur && CONTINUATION_RE.test(raw)) {
      if (cur.lines.length < 30) cur.lines.push(raw);
      continue;
    }
    cur = null;
    if (ERROR_RE.test(raw)) {
      const ts = (raw.match(LEADING_TS_RE) || [''])[0].replace(/[[\]\s]/g, '') || null;
      cur = { source, ts, lines: [raw] };
      events.push(cur);
    }
  }
  return events;
}

export function cluster(events) {
  const byFp = new Map();
  for (const e of events) {
    const fp = fingerprint(e);
    let c = byFp.get(fp);
    if (!c) {
      const redacted = e.lines.map(redactLine);
      c = { fingerprint: fp, count: 0, first_seen: e.ts, last_seen: e.ts, sources: [], sample: redacted.join('\n'), redacted: redacted.some((l) => l.startsWith('[redacted:')) };
      byFp.set(fp, c);
    }
    c.count++;
    if (e.ts && (!c.first_seen || e.ts < c.first_seen)) c.first_seen = e.ts;
    if (e.ts && (!c.last_seen || e.ts > c.last_seen)) c.last_seen = e.ts;
    if (!c.sources.includes(e.source)) c.sources.push(e.source);
  }
  return [...byFp.values()].sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));
}

// Read every source. `exec` and `fetch` are injectable for tests.
export async function collect({ sources, since = null, exec = (cmd, args) => run(cmd, args, { maxBuffer: 64 * 1024 * 1024 }), fetchFn = globalThis.fetch } = {}) {
  const events = [];
  const errors = [];
  for (const src of sources) {
    try {
      if (src === 'docker') {
        const { stdout } = await exec('docker', ['ps', '--format', '{{.Names}}']);
        for (const name of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
          const args = ['logs', '--timestamps', ...(since ? ['--since', since] : []), name];
          const r = await exec('docker', args);
          events.push(...parseEvents(`${r.stdout}\n${r.stderr || ''}`, `docker:${name}`));
        }
      } else if (/^https?:\/\//.test(src)) {
        const res = await fetchFn(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        events.push(...parseEvents(await res.text(), src));
      } else {
        events.push(...parseEvents(await readFile(src, 'utf8'), `file:${src}`));
      }
    } catch (e) {
      errors.push({ source: src, error: e.message });
    }
  }
  return { clusters: cluster(events), events: events.length, errors };
}
