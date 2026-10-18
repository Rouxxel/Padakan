// The effects Padakan trusts: what is on the remote and on GitHub, read with git and gh.
// Each function is small so steps can be tested with an injected fake.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const out = async (cmd, args, cwd) => (await run(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();

export function createGithub({ exec = out } = {}) {
  return {
    // The sha of a branch on origin, or null when it does not exist there.
    async remoteBranch(repo, branch) {
      const line = await exec('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repo).catch(() => '');
      return line ? line.split(/\s+/)[0] : null;
    },
    // Commits on origin/<branch> that are not in base.
    async commitsAhead(repo, base, branch) {
      await exec('git', ['fetch', '-q', 'origin', branch], repo).catch(() => {});
      const n = await exec('git', ['rev-list', '--count', `${base}..origin/${branch}`], repo).catch(() => '0');
      return Number(n) || 0;
    },
    // The newest PR for a branch: { number, url, state, headRefOid } or null.
    async prForBranch(repo, branch) {
      const json = await exec('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,state,headRefOid'], repo).catch(() => '[]');
      const list = JSON.parse(json || '[]');
      return list[0] || null;
    },
    // CI for a PR: 'pass' | 'fail' | 'pending' | 'none'.
    async prChecks(repo, number) {
      const json = await exec('gh', ['pr', 'checks', String(number), '--json', 'name,bucket'], repo).catch((e) => (e.stdout ? e.stdout : '[]'));
      const checks = JSON.parse(json || '[]');
      if (!checks.length) return { ci: 'none', checks: [] };
      const buckets = checks.map((c) => c.bucket);
      const ci = buckets.includes('fail') || buckets.includes('cancel') ? 'fail' : buckets.includes('pending') ? 'pending' : 'pass';
      return { ci, checks };
    },
    async mergePr(repo, number) {
      await exec('gh', ['pr', 'merge', String(number), '--squash', '--delete-branch'], repo);
      return { merged: true };
    },
  };
}
