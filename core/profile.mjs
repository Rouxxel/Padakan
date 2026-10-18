// The project profile: deterministic facts about the repository that the capability resolver uses to
// choose a task's tools (MCP servers, CLIs, skills). Read from git-tracked files only; nothing is run.
//
// projectProfile(repo) -> { languages: {ext: count}, signals: {...}, files: [...], package: { scripts, dependencies } | null }

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

const run = promisify(execFile);

const UI_EXT = new Set(['.html', '.jsx', '.tsx', '.vue', '.svelte', '.css', '.scss', '.astro']);
const MARKERS = {
  docker: /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/,
  playwright: /(^|\/)playwright\.config\.(js|ts|mjs|cjs)$/,
  ios: /\.(xcodeproj|xcworkspace)\/|(^|\/)Package\.swift$|\.swift$/,
  android: /(^|\/)(build\.gradle(\.kts)?|AndroidManifest\.xml)$/,
  ci: /^\.github\/workflows\/.+\.ya?ml$/,
  python: /(^|\/)(requirements\.txt|pyproject\.toml)$/,
  go: /(^|\/)go\.mod$/,
  rust: /(^|\/)Cargo\.toml$/,
  database: /(^|\/)(migrations?\/|schema\.prisma$|.*\.sql$)/,
};

export async function projectProfile(repo) {
  let files = [];
  try {
    files = (await run('git', ['ls-files'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
  } catch {
    return { languages: {}, signals: {}, files: [], package: null };
  }
  const languages = {};
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (ext) languages[ext] = (languages[ext] || 0) + 1;
  }
  const signals = Object.fromEntries(Object.entries(MARKERS).map(([k, re]) => [k, files.some((f) => re.test(f))]));
  signals.ui = files.some((f) => UI_EXT.has(extname(f).toLowerCase()));
  signals.http_server = false;

  let pkg = null;
  if (files.includes('package.json')) {
    try {
      const json = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
      const deps = Object.keys({ ...(json.dependencies || {}), ...(json.devDependencies || {}) });
      pkg = { scripts: json.scripts || {}, dependencies: deps.slice(0, 60) };
      if (deps.some((d) => ['@playwright/test', 'playwright'].includes(d))) signals.playwright = true;
      if (deps.some((d) => ['react', 'vue', 'svelte', 'next', 'nuxt', '@angular/core', 'vite'].includes(d))) signals.ui = true;
    } catch {
      // an unreadable package.json is simply not a fact
    }
  }
  // A Node HTTP server without a framework still serves requests: look for createServer / listen in sources.
  const sources = files.filter((f) => /\.(mjs|cjs|js|ts)$/.test(f) && !/(^|\/)(test|tests|__tests__)\//.test(f)).slice(0, 200);
  for (const f of sources) {
    try {
      if (/createServer\(|\.listen\(|express\(|fastify\(|Hono\(/.test(await readFile(join(repo, f), 'utf8'))) {
        signals.http_server = true;
        break;
      }
    } catch {
      // unreadable file
    }
  }
  const top = [...new Set(files.map((f) => (f.includes('/') ? `${f.split('/')[0]}/` : basename(f))))].slice(0, 40);
  return { languages, signals, files: top, package: pkg };
}
