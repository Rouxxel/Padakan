// Open Knowledge Format (OKF v0.1) validator.
//
// An OKF document is markdown with YAML frontmatter; `type` is the only field OKF requires.
// Padakan documents (the default profile) also carry title, description, tags and timestamp.
// Relative markdown links must resolve; a link starting with "/" resolves from the bundle root.
//
// Template mode accepts placeholder values such as `<YYYY-MM-DDTHH:MM:SSZ>` in place of real ones.
//
// CLI: node core/okf.mjs [--template] [--profile okf|padakan] <file-or-dir>...
//      prints one line per problem and exits 1 when there is any.

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PADAKAN_FIELDS = ['title', 'description', 'tags', 'timestamp'];
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const PLACEHOLDER = /^<[^<>]+>$/;

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

// Parse the YAML subset OKF frontmatter uses: `key: scalar`, `key: [a, b]`, and block lists (`key:` then `- item`).
// Comments after a scalar (` # ...`) are dropped. Nested maps are kept as raw text.
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { data: null, body: text, problems: ['no frontmatter (a document must start with ---)'] };
  const data = {};
  const problems = [];
  let listKey = null;
  m[1].split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && listKey) {
      data[listKey].push(unquote(item[1]));
      return;
    }
    if (/^\s/.test(line)) return; // nested content: not interpreted
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) {
      problems.push(`frontmatter line ${i + 2}: not "key: value"`);
      return;
    }
    const [, key, rawValue] = kv;
    const value = rawValue.replace(/\s+#.*$/, '');
    listKey = null;
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else if (value.trim().startsWith('[') && value.trim().endsWith(']')) {
      const inner = value.trim().slice(1, -1).trim();
      data[key] = inner ? inner.split(',').map(unquote) : [];
    } else {
      data[key] = unquote(value);
    }
  });
  return { data, body: text.slice(m[0].length), problems };
}

// Markdown links outside code: [text](target). Returns targets.
export function linksIn(body) {
  const withoutCode = body.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
  const out = [];
  for (const m of withoutCode.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  return out;
}

const isExternal = (t) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#') || t.startsWith('//');

// Validate one document's text. `file` and `root` enable link checks.
export function validateText(text, { file = null, root = null, profile = 'padakan', template = false } = {}) {
  const { data, body, problems } = parseFrontmatter(text);
  if (!data) return problems;
  const isEmpty = (v) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  if (isEmpty(data.type)) problems.push('missing required field: type');
  if (profile === 'padakan') {
    for (const f of PADAKAN_FIELDS) if (isEmpty(data[f])) problems.push(`missing field: ${f}`);
  }
  if (data.timestamp !== undefined && !isEmpty(data.timestamp)) {
    const ts = String(data.timestamp);
    if (!(ISO.test(ts) || (template && PLACEHOLDER.test(ts)))) problems.push(`timestamp is not ISO 8601: ${ts}`);
  }
  if (data.tags !== undefined && !Array.isArray(data.tags)) problems.push('tags must be a list');

  if (file) {
    for (const target of linksIn(body)) {
      if (isExternal(target)) continue;
      if (template && /[<>{}]/.test(target)) continue;
      const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
      if (!path) continue;
      let abs;
      if (path.startsWith('/')) {
        if (!root) continue; // bundle-root link with no known root
        abs = join(root, path);
      } else {
        abs = resolve(dirname(file), path);
      }
      if (root && (relative(root, abs).startsWith('..') || isAbsolute(relative(root, abs)))) {
        problems.push(`link leaves the bundle: ${target}`);
      } else if (!existsSync(abs)) {
        problems.push(`broken link: ${target}`);
      }
    }
  }
  return problems;
}

export async function validateFile(file, opts = {}) {
  const text = await readFile(file, 'utf8');
  return validateText(text, { ...opts, file: resolve(file) });
}

async function* markdownFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(p);
    else if (entry.name.endsWith('.md')) yield p;
  }
}

// Validate every .md file under a bundle directory. Returns [{ file, problem }].
export async function validateBundle(dir, opts = {}) {
  const root = resolve(dir);
  const results = [];
  for await (const file of markdownFiles(root)) {
    for (const problem of await validateFile(file, { ...opts, root })) results.push({ file, problem });
  }
  return results;
}

async function main(argv) {
  const opts = { profile: 'padakan', template: false };
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--template') opts.template = true;
    else if (argv[i] === '--profile') opts.profile = argv[++i];
    else paths.push(argv[i]);
  }
  if (!paths.length) {
    console.error('usage: node core/okf.mjs [--template] [--profile okf|padakan] <file-or-dir>...');
    return 2;
  }
  let bad = 0;
  for (const p of paths) {
    const results = (await stat(p)).isDirectory()
      ? await validateBundle(p, opts)
      : (await validateFile(p, opts)).map((problem) => ({ file: resolve(p), problem }));
    for (const r of results) {
      bad++;
      console.log(`${relative(process.cwd(), r.file).split(sep).join('/')}: ${r.problem}`);
    }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
