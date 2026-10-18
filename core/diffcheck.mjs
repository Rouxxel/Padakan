// Diff inspection: deterministic checks on a change. No model is involved.
//
// Checks, each { name, pass, detail }:
//   size          lines added + deleted ≤ PADAKAN_MAX_DIFF_LINES
//   files         files changed ≤ PADAKAN_MAX_DIFF_FILES
//   protected     no changed path matches PADAKAN_PROTECTED_PATHS
//   secrets       no added line matches a secret pattern (reported by file:line and kind, never by value)
//   dependencies  no dependency manifest or lockfile changes, unless the task manifest allows that file
//
// Same input, byte-identical output.
//
// CLI: node core/diffcheck.mjs <base> [head] [--repo <dir>] [--allow <path>]...
//      prints the JSON result; exits 1 when any check fails.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from '../orchestrator/lib/env.mjs';

const run = promisify(execFile);

export const DEPENDENCY_FILES = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'setup.py', 'setup.cfg',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.lockfile', 'pom.xml',
  'Podfile', 'Podfile.lock', 'Package.swift', 'Package.resolved', 'pubspec.yaml', 'pubspec.lock', 'mix.exs', 'mix.lock',
];
const DEPENDENCY_RE = /^requirements[\w.-]*\.txt$/;

export const SECRET_PATTERNS = [
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['llm-api-key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['devin-token', /\b(?:cog|apk(?:_user)?)_[A-Za-z0-9]{16,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];
const GENERIC = /(?:api[_-]?key|secret|token|passw(?:or)?d|auth)[\w.-]*\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/i;

function entropy(s) {
  const counts = {};
  for (const c of s) counts[c] = (counts[c] || 0) + 1;
  return Object.values(counts).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

// Glob → RegExp. `**` crosses folders, `*` and `?` do not; a trailing "/" means "this folder and everything in it".
export function globToRegExp(glob) {
  const g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) return new RegExp(`^${escapeGlob(g)}`);
  return new RegExp(`^${escapeGlob(g)}$`);
}
function escapeGlob(g) {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      out += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += g[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

// Parse `git diff --unified=0 -M` output into files with added lines and counts.
export function parseDiff(text) {
  const files = [];
  let cur = null;
  let newLine = 0;
  const unq = (p) => (p.startsWith('"') ? JSON.parse(p) : p);
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/);
      cur = { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : null, added: 0, deleted: 0, binary: false, addedLines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') cur.path = unq(p).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') cur.oldPath = unq(p).replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('rename to ')) cur.path = line.slice(10);
    else if (line.startsWith('Binary files ')) cur.binary = true;
    else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = m ? Number(m[1]) : 0;
    } else if (line.startsWith('+')) {
      cur.added++;
      cur.addedLines.push({ line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) cur.deleted++;
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function scanSecrets(files) {
  const hits = [];
  for (const f of files) {
    for (const { line, text } of f.addedLines) {
      for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) hits.push({ file: f.path, line, kind });
      const g = text.match(GENERIC);
      if (g && entropy(g[1]) >= 3.5 && !SECRET_PATTERNS.some(([, re]) => re.test(text))) hits.push({ file: f.path, line, kind: 'generic-secret' });
    }
  }
  return hits;
}

const isDependencyFile = (p) => DEPENDENCY_FILES.includes(basename(p)) || DEPENDENCY_RE.test(basename(p));

// Inspect an already-parsed list of files. limits: { maxLines, maxFiles, protectedPaths, allowDependencies }.
export function inspectFiles(files, { maxLines, maxFiles, protectedPaths = [], allowDependencies = [] }) {
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const touched = [...new Set(files.flatMap((f) => [f.path, f.oldPath].filter(Boolean)))].sort();
  const globs = protectedPaths.map((g) => [g, globToRegExp(g)]);
  const protectedHits = touched.flatMap((p) => globs.filter(([, re]) => re.test(p)).map(([g]) => `${p} (${g})`));
  const secrets = scanSecrets(files);
  const allowed = (p) => allowDependencies.some((a) => a === p || a === basename(p));
  const deps = files.map((f) => f.path).filter(isDependencyFile);
  const blockedDeps = deps.filter((p) => !allowed(p));

  const checks = [
    { name: 'size', pass: maxLines == null || lines <= maxLines, detail: `${lines} lines changed (limit ${maxLines ?? 'none'})` },
    { name: 'files', pass: maxFiles == null || files.length <= maxFiles, detail: `${files.length} files changed (limit ${maxFiles ?? 'none'})` },
    { name: 'protected', pass: protectedHits.length === 0, detail: protectedHits.length ? `protected paths touched: ${protectedHits.join(', ')}` : 'no protected paths touched' },
    {
      name: 'secrets',
      pass: secrets.length === 0,
      detail: secrets.length ? `possible secrets added: ${secrets.map((s) => `${s.file}:${s.line} (${s.kind})`).join(', ')}` : 'no secrets added',
    },
    {
      name: 'dependencies',
      pass: blockedDeps.length === 0,
      detail: blockedDeps.length
        ? `dependency files changed: ${blockedDeps.join(', ')}`
        : deps.length
          ? `dependency files changed, allowed by the task manifest: ${deps.join(', ')}`
          : 'no dependency changes',
    },
  ];
  return { pass: checks.every((c) => c.pass), lines, files: files.map((f) => f.path), checks };
}

export async function diffText(repo, base, head = 'HEAD') {
  const { stdout } = await run('git', ['diff', '--no-color', '--no-ext-diff', '--unified=0', '-M', `${base}`, `${head}`, '--'], {
    cwd: repo,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

// Inspect the change between two refs, with limits from settings (PADAKAN_MAX_DIFF_*, PADAKAN_PROTECTED_PATHS).
export async function inspect({ repo, base, head = 'HEAD', settings, allowDependencies = [] }) {
  const files = parseDiff(await diffText(repo, base, head));
  return inspectFiles(files, {
    maxLines: settings.PADAKAN_MAX_DIFF_LINES,
    maxFiles: settings.PADAKAN_MAX_DIFF_FILES,
    protectedPaths: settings.PADAKAN_PROTECTED_PATHS,
    allowDependencies,
  });
}

async function main(argv) {
  const args = { repo: process.cwd(), allow: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = argv[++i];
    else if (argv[i] === '--allow') args.allow.push(argv[++i]);
    else pos.push(argv[i]);
  }
  if (!pos[0]) {
    console.error('usage: node core/diffcheck.mjs <base> [head] [--repo <dir>] [--allow <path>]...');
    return 2;
  }
  const result = await inspect({ repo: args.repo, base: pos[0], head: pos[1] || 'HEAD', settings: loadSettings(), allowDependencies: args.allow });
  console.log(JSON.stringify(result, null, 2));
  return result.pass ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
