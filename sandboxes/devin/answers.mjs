// Rule-based replies when a Devin session waits for the user (IMPLEMENTATION-DEVIN-COSTGATE.md A.7).
//
// The provider never escalates by itself: answer() returns either { reply } or { escalate }, plus
// the question it answered, so the orchestrator can decide and write both to the audit trail.

export const REPLIES = {
  approve: 'Approved. Proceed without asking again.',
  conservative: 'Choose the most conservative option, note it in the PR, continue.',
  secret: (name) => `It is available as secret \`${name}\`.`,
  approval: 'Approved, proceed.',
  nudge: 'Continue the task from where you stopped. Do not ask questions; if you cannot continue, finish with blocked set.',
};

// Above this many answers in one session, stop answering and escalate (no endless back and forth).
export const MAX_ANSWERS = 5;

// Secret requests are checked first (the plan lists them second): a message such as "I need the
// STRIPE_KEY to proceed with this plan" must never be answered with a plain approval.
const RULES = [
  { kind: 'secret', test: /\b(secrets?|credentials?|passwords?|tokens?|api[ _-]?keys?|access keys?|[a-z0-9_]+_(key|token|secret)|login|log in|sign[- ]?in)\b/i },
  { kind: 'approve', test: /\b(confirm|approve|approval|sign[- ]?off|ok(ay)? (to|with)|go ahead|proceed)\b[\s\S]*\b(plan|approach|test plan|steps|this)\b|\b(plan|approach|test plan)\b[\s\S]*\b(ok|okay|good|fine|look right|approve|confirm|proceed)\b/i },
  { kind: 'option', test: /\b(which (one|option|approach|way)|should i (use|pick|choose|go with)|option [a-z0-9]\b|prefer|or should)\b/i },
];

// The newest message from Devin (not one we sent), after the last cursor.
export function latestDevinMessage(items = []) {
  return [...items].reverse().find((m) => m.source !== 'user' && typeof m.message === 'string') ?? null;
}

// messages: items from GET …/messages since the handle's cursor.
// handle:   { questions_answered, unknown_questions_answered }
// secrets:  manifest secrets the session may use, as [{ name }] (names only, never values).
// -> { reply, kind, question, handle } | { escalate, kind, question, handle } | { reply: null } when nothing to answer
export function answer(messages, handle = {}, { secrets = [] } = {}) {
  const msg = latestDevinMessage(messages);
  if (!msg) return { reply: null, kind: 'none', question: null, handle: {} };
  const question = msg.message;
  const answered = handle.questions_answered ?? 0;
  const unknown = handle.unknown_questions_answered ?? 0;
  const out = (fields, extra = {}) => ({ question, ...fields, handle: { questions_answered: answered + (fields.reply ? 1 : 0), ...extra } });

  if (answered >= MAX_ANSWERS) return out({ escalate: 'too-many-questions', kind: 'limit' });

  const kind = RULES.find((rule) => rule.test.test(question))?.kind ?? 'unknown';
  if (kind === 'approve') return out({ reply: REPLIES.approve, kind });
  if (kind === 'secret') {
    const hit = secrets.find((s) => s?.name && question.toLowerCase().includes(String(s.name).toLowerCase()));
    return hit ? out({ reply: REPLIES.secret(hit.name), kind }) : out({ escalate: 'missing-secret', kind });
  }
  if (kind === 'option') return out({ reply: REPLIES.conservative, kind });
  if (unknown >= 1) return out({ escalate: 'repeated-question', kind });
  return out({ reply: REPLIES.conservative, kind }, { unknown_questions_answered: unknown + 1 });
}

// waiting_for_approval: reply once, then escalate. inactivity: nudge once, then escalate.
export function onceThenEscalate(kind, handle = {}) {
  const field = kind === 'approval' ? 'approvals_sent' : 'nudges_sent';
  const sent = handle[field] ?? 0;
  if (sent >= 1) return { escalate: kind === 'approval' ? 'approval-requested-again' : 'inactive-again', handle: {} };
  return { reply: kind === 'approval' ? REPLIES.approval : REPLIES.nudge, handle: { [field]: sent + 1 } };
}
