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

const CATEGORY_MEANING = {
  'code-defect': 'a bug in this repository\'s code',
  performance: 'slowness, timeouts or resource exhaustion',
  'infra-config': 'infrastructure, deployment or configuration',
  security: 'a security problem: leaked secrets, injection, unauthorised access',
  'external-dependency': 'a third-party service or library failing',
  data: 'bad or inconsistent data',
  noise: 'expected or harmless log noise',
  unknown: 'not clear from the logs',
};

// System One (TypeSafe Jev): one request per cluster; confidence is Jev's own category confidence.
async function systemOneTriage(clusters, client) {
  const verdicts = [];
  let input = 0;
  for (const c of clusters) {
    const { answers, usage } = await client.systemOne({
      state: { fingerprint: c.fingerprint, occurrences: c.count, sources: c.sources, sample: c.sample.slice(0, 4000) },
      questions: {
        category: { type: 'choice', instructions: 'What kind of production problem does `sample` show?', criteria: CATEGORY_MEANING },
        severity: { type: 'choice', instructions: 'How severe is it?', criteria: { P0: 'outage', P1: 'a major feature broken', P2: 'degraded or partial', P3: 'cosmetic' } },
        fixable: { type: 'noul', instructions: 'Could a small, localized code change in this repository fix it?' },
      },
    });
    input += usage?.input_tokens || 0;
    const firstLine = c.sample.split('\n').find((l) => l.trim()) || '';
    verdicts.push({
      fingerprint: c.fingerprint,
      category: answers.category.choice,
      severity: answers.severity.choice,
      fixable: answers.fixable.noul >= 0.5,
      confidence: Number(answers.category.confidence ?? 0),
      summary: `${answers.category.choice}: ${firstLine.trim().slice(0, 160)}`,
    });
  }
  return { data: { items: verdicts }, usage: { input_tokens: input } };
}

export async function triage({ clusters, client, model, now = () => new Date().toISOString() }) {
  if (!clusters.length) return { items: [], usage: null };
  if (client.kind === 'systemone') return finish(clusters, await systemOneTriage(clusters, client), now);
  const system = [
    'You triage production error clusters for an autonomous development system.',
    `Categories: ${CATEGORIES.join(', ')}. Severity P0 (outage) to P3 (cosmetic).`,
    '"fixable" is true only when a small, localized code change in this repository could fix it.',
    'When unsure, use "unknown" with a low confidence; a human will look at it.',
  ].join(' ');
  const user = clusters
    .map((c) => `fingerprint ${c.fingerprint} · ${c.count} occurrences · sources ${c.sources.join(', ')}\n${c.sample.slice(0, 1500)}`)
    .join('\n\n---\n\n');
  return finish(clusters, await client.chatJson({ model, system, user, schema: TRIAGE_SCHEMA, name: 'triage' }), now);
}

function finish(clusters, { data, usage }, now) {
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
