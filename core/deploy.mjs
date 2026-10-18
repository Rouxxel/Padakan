// Gated deploy: behind a flag, then a canary, then everyone; automatic rollback when the error rate
// passes PADAKAN_SLO_ERROR_RATE during the canary. The gate logic is the same for every target;
// a target is an adapter.
//
// Adapter: { name, flagOn(release), setCanary(release, percent), promote(release), rollback(release, reason), metrics(release) }
//   metrics() -> { error_rate, requests }
//
// Targets: `simulated` (built; state in <records>/deploy/simulated.json), `railway` and `vercel` (to come).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export class DeployError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeployError';
  }
}

// The simulated target: a JSON file that records what a real platform would do. Error rates for the
// canary windows come from `series` (or <records>/deploy/simulated-metrics.json), default 0.
export function simulatedAdapter({ records, series = null }) {
  const dir = join(records, 'deploy');
  const file = join(dir, 'simulated.json');
  const load = async () => (existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { live: null, previous: null, flags: {}, canary: null, history: [] });
  const save = async (s) => {
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(s, null, 2)}\n`);
  };
  let window = 0;
  const metricsSeries = async () => {
    if (series) return series;
    const f = join(dir, 'simulated-metrics.json');
    return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : [];
  };
  return {
    name: 'simulated',
    async flagOn(release) {
      const s = await load();
      s.flags[release.task] = 'on';
      s.history.push({ event: 'flag-on', task: release.task, head: release.head });
      await save(s);
    },
    async setCanary(release, percent) {
      const s = await load();
      s.canary = { task: release.task, head: release.head, percent };
      s.history.push({ event: 'canary', task: release.task, percent });
      await save(s);
    },
    async metrics() {
      const list = await metricsSeries();
      const error_rate = list[window] ?? 0;
      window++;
      return { error_rate, requests: 1000 };
    },
    async promote(release) {
      const s = await load();
      s.previous = s.live;
      s.live = { task: release.task, head: release.head };
      s.canary = null;
      s.history.push({ event: 'promote', task: release.task, head: release.head });
      await save(s);
    },
    async rollback(release, reason) {
      const s = await load();
      s.flags[release.task] = 'off';
      s.canary = null;
      if (s.live?.head === release.head) s.live = s.previous;
      s.history.push({ event: 'rollback', task: release.task, reason });
      await save(s);
    },
  };
}

export function adapterFor(settings, opts) {
  switch (settings.PADAKAN_DEPLOY_TARGET) {
    case 'simulated':
      return simulatedAdapter(opts);
    case 'railway':
    case 'vercel':
      throw new DeployError(`the ${settings.PADAKAN_DEPLOY_TARGET} deploy adapter is not built yet; use PADAKAN_DEPLOY_TARGET=simulated`);
    default:
      throw new DeployError(`unknown deploy target "${settings.PADAKAN_DEPLOY_TARGET}"`);
  }
}

// Run the gated deploy. Returns { outcome: 'promoted' | 'rolled-back', windows: [...], reason? }.
export async function gatedDeploy({ adapter, release, settings, windows = 3, intervalMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const slo = settings.PADAKAN_SLO_ERROR_RATE;
  const percent = settings.PADAKAN_CANARY_PERCENT;
  const observed = [];
  await adapter.flagOn(release);
  await adapter.setCanary(release, percent);
  for (let i = 0; i < windows; i++) {
    if (i && intervalMs) await sleep(intervalMs);
    const m = await adapter.metrics(release);
    observed.push(m);
    if (typeof m.error_rate !== 'number' || Number.isNaN(m.error_rate)) {
      const reason = 'the canary metrics could not be read';
      await adapter.rollback(release, reason);
      return { outcome: 'rolled-back', reason, windows: observed, percent, slo };
    }
    if (m.error_rate > slo) {
      const reason = `error rate ${m.error_rate} above the SLO ${slo} in canary window ${i + 1}`;
      await adapter.rollback(release, reason);
      return { outcome: 'rolled-back', reason, windows: observed, percent, slo };
    }
  }
  await adapter.promote(release);
  return { outcome: 'promoted', windows: observed, percent, slo };
}
