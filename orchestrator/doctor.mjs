// doctor: check every setting and tool before anything runs, and print what was found verbatim.
// One line per check, `CHECK <name> ok|warn|fail <detail>`, then `DOCTOR=ok|fail FAILED=n WARN=n`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkProvider } from '../sandboxes/contract.mjs';

const run = promisify(execFile);
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');

async function defaultProbe(cmd, args) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 20_000 });
    return { ok: true, out: `${stdout}${stderr}`.trim().split('\n')[0] };
  } catch (e) {
    return { ok: false, out: e.code === 'ENOENT' ? 'not installed' : `${e.stderr || e.message}`.trim().split('\n')[0] };
  }
}

export async function doctor(ctx, { probe = defaultProbe } = {}) {
  const results = [];
  const add = (name, level, detail) => results.push({ name, level, detail });
  const s = ctx.settings;

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22 ? 'ok' : 'fail', `v${process.versions.node}${major >= 22 ? '' : ' (needs 22+)'}`);

  const missing = s.missing();
  add('settings', missing.length ? 'fail' : 'ok', missing.length ? `missing: ${missing.join(', ')}` : 'all required settings set');

  add('records', existsSync(join(ctx.records, 'state.json')) ? 'ok' : 'fail', existsSync(join(ctx.records, 'state.json')) ? ctx.records : `${ctx.records} not initialised (padakan init)`);

  const git = await probe('git', ['--version']);
  add('git', git.ok ? 'ok' : 'fail', git.out);
  const gh = await probe('gh', ['auth', 'status']);
  add('gh', gh.ok ? 'ok' : 'fail', gh.ok ? 'authenticated' : gh.out);

  const providerFile = join(PLUGIN, 'sandboxes', s.PADAKAN_SANDBOX_PROVIDER, 'provider.mjs');
  if (!existsSync(providerFile)) add('provider', 'fail', `${s.PADAKAN_SANDBOX_PROVIDER}: not built yet (${providerFile})`);
  else {
    try {
      const problems = checkProvider(await import(pathToFileURL(providerFile).href), s.PADAKAN_SANDBOX_PROVIDER);
      add('provider', problems.length ? 'fail' : 'ok', problems.length ? problems.join('; ') : s.PADAKAN_SANDBOX_PROVIDER);
    } catch (e) {
      add('provider', 'fail', `${s.PADAKAN_SANDBOX_PROVIDER}: ${e.message}`);
    }
    const providerDoctor = join(PLUGIN, 'sandboxes', s.PADAKAN_SANDBOX_PROVIDER, 'doctor.mjs');
    if (existsSync(providerDoctor)) {
      try {
        const mod = await import(pathToFileURL(providerDoctor).href);
        for (const r of (await mod.doctor(ctx)) || []) add(`${s.PADAKAN_SANDBOX_PROVIDER}.${r.name}`, r.ok ? 'ok' : r.level || 'fail', r.detail || '');
      } catch (e) {
        add(`${s.PADAKAN_SANDBOX_PROVIDER}.doctor`, 'fail', e.message);
      }
    }
  }

  if (s.PADAKAN_TERMINAL === 'herdr') {
    const h = await probe('herdr', ['--version']);
    add('herdr', h.ok ? 'ok' : 'warn', h.ok ? h.out : `${h.out} (needed to watch non-Devin trees)`);
  }
  if (s.ENTIRE_ENABLED) {
    const e = await probe('entire', ['--version']);
    add('entire', e.ok ? 'ok' : 'fail', e.out);
  }
  const claude = await probe('claude', ['--version']);
  add('claude', claude.ok ? 'ok' : 'warn', claude.out);

  const failed = results.filter((r) => r.level === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  return {
    line: `DOCTOR=${failed ? 'fail' : 'ok'} FAILED=${failed} WARN=${warned}`,
    code: failed ? 1 : 0,
    details: results.map((r) => `CHECK ${r.name} ${r.level} ${r.detail}`),
  };
}
