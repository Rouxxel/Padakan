// Triage: a decision model sorts each log cluster into one of eight categories with a severity and a
// confidence; deterministic rules then set the route. Security and anything uncertain go to a human.

export const CATEGORIES = ['code-defect', 'performance', 'infra-config', 'security', 'external-dependency', 'data', 'noise', 'unknown'];
export const ROUTES = {
  'code-defect': 'task',
  performance: 'task-escalate',
  'infra-config': 'human',
  security: 'human',
  'external-dependency': 'watch',
  data: 'human',
  noise: 'drop',
  unknown: 'human',
};
export const MIN_CONFIDENCE = 0.6;

export const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fingerprint', 'category', 'severity', 'fixable', 'confidence', 'summary'],
        additionalProperties: false,
        properties: {
          fingerprint: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          fixable: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0 },
          summary: { type: 'string' },
        },
      },
    },
  },
};

// Deterministic route for one model verdict.
export function route(item, cluster = {}) {
  let category = item.category;
  const reasons = [];
  if (cluster.redacted && category !== 'security') {
    category = 'security';
    reasons.push('a secret appeared in the logs');
  }
  if (item.confidence < MIN_CONFIDENCE && category !== 'security') {
    category = 'unknown';
    reasons.push(`confidence ${item.confidence} below ${MIN_CONFIDENCE}`);
  }
  let r = ROUTES[category];
  if (r === 'task' && !item.fixable) {
    r = 'human';
    reasons.push('not fixable by an agent');
  }
  return { ...item, category, route: r, reasons };
}

export async function triage({ clusters, client, model, now = () => new Date().toISOString() }) {
  if (!clusters.length) return { items: [], usage: null };
  const system = [
    'You triage production error clusters for an autonomous development system.',
    `Categories: ${CATEGORIES.join(', ')}. Severity P0 (outage) to P3 (cosmetic).`,
    '"fixable" is true only when a small, localized code change in this repository could fix it.',
    'When unsure, use "unknown" with a low confidence; a human will look at it.',
  ].join(' ');
  const user = clusters
    .map((c) => `fingerprint ${c.fingerprint} · ${c.count} occurrences · sources ${c.sources.join(', ')}\n${c.sample.slice(0, 1500)}`)
    .join('\n\n---\n\n');
  const { data, usage } = await client.chatJson({ model, system, user, schema: TRIAGE_SCHEMA, name: 'triage' });
  const byFp = new Map(clusters.map((c) => [c.fingerprint, c]));
  const items = [];
  for (const c of clusters) {
    const verdict = data.items.find((i) => i.fingerprint === c.fingerprint);
    // A cluster the model skipped is unknown, never dropped.
    const item = verdict || { fingerprint: c.fingerprint, category: 'unknown', severity: 'P2', fixable: false, confidence: 0, summary: 'not triaged by the model' };
    items.push({ ...route(item, byFp.get(c.fingerprint)), count: c.count, at: now() });
  }
  return { items, usage };
}
