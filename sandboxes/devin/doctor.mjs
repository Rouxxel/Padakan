// Onboarding checks for the Devin provider (IMPLEMENTATION-DEVIN-COSTGATE.md A.11).
// Loaded by orchestrator/doctor.mjs when PADAKAN_SANDBOX_PROVIDER=devin.
// Returns [{ name, ok, level?, detail }]; never prints or returns the API key.

import { createClient as defaultCreateClient, DevinError } from './client.mjs';

export const BUILT_IN_PLATFORMS = ['linux', 'macos', 'windows', 'default'];

const okRow = (name, detail) => ({ name, ok: true, detail });
const failRow = (name, detail) => ({ name, ok: false, level: 'fail', detail });
const warnRow = (name, detail) => ({ name, ok: false, level: 'warn', detail });

export async function doctor(ctx, { createClient = defaultCreateClient, clientOptions = {} } = {}) {
  const s = ctx.settings ?? {};
  const rows = [];
  const key = s.DEVIN_API_KEY;
  const org = s.DEVIN_ORG_ID;

  // 1. the key, then GET /self
  if (!key) rows.push(failRow('api-key', 'DEVIN_API_KEY is not set: create a service user in Devin (Settings > Service users) and put its token in <records>/.env'));
  else if (!key.startsWith('cog_')) rows.push(failRow('api-key', 'DEVIN_API_KEY does not start with cog_: use a service-user token, not a personal session cookie'));

  // 2. the org, then GET /sessions (proves UseDevinSessions)
  if (!org) rows.push(failRow('org', 'DEVIN_ORG_ID is not set: copy it from Settings > Devin API (it starts with org-)'));

  if (key?.startsWith('cog_') && org) {
    let client;
    try {
      client = createClient({ apiUrl: s.DEVIN_API_URL, apiKey: key, orgId: org, ...clientOptions });
    } catch (e) {
      rows.push(failRow('api', e.message));
    }
    if (client) {
      try {
        const me = await client.self();
        const who = me?.service_user_name || me?.service_user_id || me?.principal_type || 'authenticated';
        rows.push(okRow('api-key', `GET /self ok (${who})`));
        if (me?.org_id && me.org_id !== org) rows.push(warnRow('org-match', `the token belongs to ${me.org_id}, but DEVIN_ORG_ID is ${org}`));
      } catch (e) {
        rows.push(failRow('api-key', e instanceof DevinError && e.status === 401 ? 'GET /self returned 401: the token is wrong or revoked' : `GET /self failed: ${e.message}`));
      }
      try {
        // Query parameters per the API reference (first = page size); still to be confirmed on a live call.
        await client.listSessions({ first: 1 });
        rows.push(okRow('sessions', 'GET /sessions ok: the service user has UseDevinSessions'));
      } catch (e) {
        const fix = e instanceof DevinError && e.status === 403
          ? 'GET /sessions returned 403: give the service user the UseDevinSessions permission in this org'
          : e instanceof DevinError && e.status === 404
            ? `GET /sessions returned 404: check DEVIN_ORG_ID (${org})`
            : `GET /sessions failed: ${e.message}`;
        rows.push(failRow('sessions', fix));
      }
    }
  }

  // 3. the platform: built-in labels pass; anything else may be an Outpost pool, checked on the first create
  const platform = s.DEVIN_PLATFORM || 'linux';
  if (BUILT_IN_PLATFORMS.includes(platform.toLowerCase())) rows.push(okRow('platform', platform));
  else rows.push(warnRow('platform', `"${platform}" is not linux, macos or windows; it must be an Outpost pool name. The first session create returns 400 with the valid labels if it is wrong`));

  // 4. recordings depend on an org setting the API cannot read
  rows.push(warnRow('recordings', 'video evidence needs Computer Use enabled in the Devin org settings; without it evidence item 1 falls back to our own Playwright recording or is missing'));

  // 5. the ACU price the cost gate needs
  if (s.PADAKAN_DEVIN_USD_PER_ACU === null || s.PADAKAN_DEVIN_USD_PER_ACU === undefined) {
    rows.push(failRow('acu-price', 'PADAKAN_DEVIN_USD_PER_ACU is not set: the cost gate pauses every Devin session rather than guess a price'));
  } else rows.push(okRow('acu-price', `$${s.PADAKAN_DEVIN_USD_PER_ACU} per ACU`));

  if (s.DEVIN_MAX_ACU) rows.push(okRow('max-acu', `sessions are capped at ${s.DEVIN_MAX_ACU} ACU whatever the budget allows`));
  return rows;
}
