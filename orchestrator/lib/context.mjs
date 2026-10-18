// Everything a lifecycle step needs, built once: settings, the records folder, the repository,
// the sandbox gateway, the audit trail and the GitHub effects. Tests pass overrides.

import { loadContext } from './records.mjs';
import { openGateway } from '../../sandboxes/index.mjs';
import { openAudit } from '../../core/audit.mjs';
import { createGithub } from './github.mjs';

export function buildContext({ cwd = process.cwd(), exported = process.env, base = null, overrides = {} } = {}) {
  const ctx = base || loadContext({ cwd, exported });
  const gateway = overrides.gateway || openGateway({ settings: ctx.settings, records: ctx.records, repo: ctx.repo }, { providers: overrides.providers || {} });
  return {
    ...ctx,
    gateway,
    audit: overrides.audit || openAudit(ctx.records),
    github: overrides.github || createGithub(),
    now: overrides.now || (() => new Date().toISOString()),
  };
}
