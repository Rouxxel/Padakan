// The evidence pack and its report.
//
// buildPack() gathers the four items for a task:
//   video         a recording pulled from the tree (largest .mp4/.webm/.mov under evidence/)
//   architecture  evidence/architecture.md, written by the building agent
//   files         computed from git (base..head), never taken from the agent
//   ci            from the last poll (checks/poll.json)
// Each item is "present" or "missing". Only the verifier, after opening an item at its source,
// marks it "verified" (in checks/evidence.json); this module never does.
//
// renderMarkdown() writes an OKF evidence-report.md; renderHtml() a self-contained page
// (inline CSS, no scripts, no external requests).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const run = promisify(execFile);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
export const ITEMS = ['video', 'architecture', 'files', 'ci'];

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// Files touched between two commits, from git: [{ path, added, deleted, binary }].
export async function filesFromGit(repo, base, head) {
  const { stdout } = await run('git', ['diff', '--numstat', '-M', base, head], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split('\t');
      const binary = a === '-';
      return { path: p.join('\t'), added: binary ? 0 : Number(a), deleted: binary ? 0 : Number(d), binary };
    })
    .sort((x, y) => x.path.localeCompare(y.path));
}

export async function buildPack({ records, key, repo, base, head }) {
  const dir = join(records, 'tasks', key);
  const evidenceDir = join(dir, 'evidence');
  const videos = [];
  for (const f of await walk(evidenceDir)) {
    if (VIDEO_EXT.has(extname(f).toLowerCase())) videos.push({ path: relative(dir, f), bytes: (await stat(f)).size });
  }
  videos.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const video = videos.find((v) => v.bytes > 0) || null;

  const archFile = join(evidenceDir, 'architecture.md');
  const architecture = existsSync(archFile) ? { path: relative(dir, archFile) } : null;

  let files = null;
  if (repo && base && head) {
    try {
      const list = await filesFromGit(repo, base, head);
      files = { list, added: list.reduce((n, f) => n + f.added, 0), deleted: list.reduce((n, f) => n + f.deleted, 0) };
    } catch {
      files = null;
    }
  }

  const pollFile = join(dir, 'checks', 'poll.json');
  const poll = existsSync(pollFile) ? JSON.parse(await readFile(pollFile, 'utf8')) : null;
  const ci = poll && poll.ci && poll.ci !== 'none' ? { status: poll.ci, checks: poll.checks || [], pr: poll.pr?.url || null } : null;

  const items = { video, architecture, files, ci };
  const status = Object.fromEntries(ITEMS.map((k) => [k, items[k] ? 'present' : 'missing']));
  return { task: key, base: base || null, head: head || null, items, status, present: ITEMS.filter((k) => items[k]).length };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (sha) => (sha ? sha.slice(0, 12) : 'none');

export function renderMarkdown(pack, { title = pack.task, now = () => new Date().toISOString(), verdict = null } = {}) {
  const { items, status } = pack;
  const lines = [
    '---',
    'type: Evidence Report',
    `title: ${pack.task} · ${title}`,
    `description: Evidence pack for ${pack.task}, ${pack.present} of 4 items present.`,
    ...(items.ci?.pr ? [`resource: ${items.ci.pr}`] : []),
    'tags: [evidence, report]',
    `task: ${pack.task}`,
    `timestamp: ${now()}`,
    '---',
    '',
    `# ${pack.task} · ${title}`,
    '',
    verdict ? `**Verdict:** ${verdict}` : '**Verdict:** not decided yet (run `padakan verify`).',
    '',
    `Base \`${short(pack.base)}\` · head \`${short(pack.head)}\``,
    '',
    '## Evidence pack',
    '',
    '| # | Item | Status | Where |',
    '|---|---|---|---|',
    `| 1 | Video of the change working | ${status.video} | ${items.video ? `[${items.video.path}](./${items.video.path.replace(/^evidence\//, '')})` : '-'} |`,
    `| 2 | Architecture of the change | ${status.architecture} | ${items.architecture ? `[architecture.md](./architecture.md)` : '-'} |`,
    `| 3 | Files touched or edited | ${status.files} | ${items.files ? `${items.files.list.length} files, +${items.files.added} -${items.files.deleted}, from git` : '-'} |`,
    `| 4 | Tests and CI | ${status.ci} | ${items.ci ? `CI ${items.ci.status}` : '-'} |`,
    '',
    'An item counts only after the verifier has opened it at its source. A missing item stays missing.',
  ];
  if (items.files) {
    lines.push('', '## Files touched', '', 'Generated from git, not written by the agent.', '', '| File | + | - |', '|---|---|---|');
    for (const f of items.files.list) lines.push(`| \`${f.path}\` | ${f.binary ? 'binary' : f.added} | ${f.binary ? '' : f.deleted} |`);
  }
  if (items.ci) {
    lines.push('', '## CI', '', `Status: **${items.ci.status}**${items.ci.pr ? ` · ${items.ci.pr}` : ''}`, '');
    for (const c of items.ci.checks) lines.push(`- ${c.name}: ${c.bucket}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderHtml(pack, { title = pack.task, verdict = null } = {}) {
  const { items, status } = pack;
  const row = (n, label, st, where) => `<tr><td>${n}</td><td>${esc(label)}</td><td class="${st}">${st}</td><td>${where}</td></tr>`;
  const files = items.files
    ? items.files.list.map((f) => `<tr><td class="mono">${esc(f.path)}</td><td class="add">${f.binary ? 'binary' : `+${f.added}`}</td><td class="del">${f.binary ? '' : `-${f.deleted}`}</td></tr>`).join('')
    : '';
  const video = items.video
    ? `<video controls preload="metadata" src="./${esc(items.video.path.replace(/^evidence\//, ''))}"></video>`
    : '<p class="missing">No video was recorded.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pack.task)} · evidence</title>
<style>
:root{--bg:#f8fafc;--fg:#0f172a;--muted:#475569;--line:#e2e8f0;--card:#fff;--ok:#16a34a;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--fg:#e5e7eb;--muted:#94a3b8;--line:#243049;--card:#121a2b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-left))}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}
.meta{color:var(--muted);font-size:13px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line)}th{font-size:12px;text-transform:uppercase;color:var(--muted)}
.present{color:var(--ok);font-weight:700}.missing{color:var(--bad);font-weight:700}.add{color:var(--ok)}.del{color:var(--bad)}
video{width:100%;border-radius:10px;background:#000}
</style></head>
<body><main>
<h1>${esc(pack.task)} · ${esc(title)}</h1>
<p class="meta">Base <span class="mono">${esc(short(pack.base))}</span> · head <span class="mono">${esc(short(pack.head))}</span> · ${pack.present} of 4 items present · verdict: ${esc(verdict || 'not decided yet')}</p>
<h2>Evidence pack</h2>
<table><tr><th>#</th><th>Item</th><th>Status</th><th>Where</th></tr>
${row(1, 'Video of the change working', status.video, items.video ? `<span class="mono">${esc(items.video.path)}</span>` : '-')}
${row(2, 'Architecture of the change', status.architecture, items.architecture ? '<span class="mono">architecture.md</span>' : '-')}
${row(3, 'Files touched or edited', status.files, items.files ? `${items.files.list.length} files from git` : '-')}
${row(4, 'Tests and CI', status.ci, items.ci ? `CI ${esc(items.ci.status)}` : '-')}
</table>
<h2>Video</h2>${video}
<h2>Files touched</h2>${items.files ? `<table><tr><th>File</th><th>+</th><th>-</th></tr>${files}</table>` : '<p class="missing">Not computed.</p>'}
<p class="meta">An item counts only after the verifier has opened it at its source. Generated by Padakan.</p>
</main></body></html>
`;
}
