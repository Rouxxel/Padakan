// Session prompts for the Devin provider (IMPLEMENTATION-DEVIN-COSTGATE.md A.6).
// Pure functions: no settings are read here and no secret value is ever passed in.

const TASK_RE = /^[A-Z]+-[0-9]+$/;

export const branchFor = (task) => `padakan/${task}`;

function need(task) {
  if (!TASK_RE.test(task ?? '')) throw new Error(`task key must look like PAD-12, got "${task}"`);
  return task;
}

// task: 'PAD-12'; repo: 'owner/repo'; briefName: the uploaded brief's file name; base: base branch;
// protectedPaths: array of globs.
export function renderPrompt({ task, repo, briefName, base = 'main', protectedPaths = [] }) {
  need(task);
  const paths = protectedPaths.length ? protectedPaths.join(', ') : '(none listed)';
  return [
    `You are working on task ${task} in ${repo}. The full brief is attached (${briefName}).`,
    'Rules:',
    '- Never ask questions. If something is unclear, choose the conservative option, write the choice in',
    '  the PR description, and continue. If you truly cannot continue, finish with blocked set.',
    `- Work on branch ${branchFor(task)}. Open exactly one PR against ${base}. No AI attribution in commits.`,
    `- Do not touch: ${paths}. Do not add or change dependencies unless the brief allows it.`,
    '- After opening the PR, test the change end to end with a screen recording (testing mode) following',
    '  the acceptance criteria in the brief, and attach the recording.',
    '- Finish by calling structured output with the report described in the schema.',
  ].join('\n');
}

// Prepended to the normal prompt when raiseBudget starts a continuation session.
export function renderContinuation({ task, prUrl, ...rest }) {
  need(task);
  const pr = prUrl ? `the open PR ${prUrl}` : 'the open PR for this branch';
  return [
    `This continues task ${task}. A previous session stopped at its budget cap. Do not start over:`,
    `check out branch ${branchFor(task)} from the remote, read ${pr} and its description,`,
    'and continue from there. Push to the same branch and update the same PR.',
    '',
    renderPrompt({ task, ...rest }),
  ].join('\n');
}

export function renderRetireMessage({ task }) {
  need(task);
  return [
    `Task ${task} is finished. Fill the "record" field of the structured output with seven sections:`,
    'what_changed, files, architecture, seams, next_step, misreadings (what a reader will get wrong), open',
    '(what is still open). Keep the other fields as they are, then call structured output again with is_final=true.',
  ].join('\n');
}

export function renderBriefMessage({ task, briefName }) {
  need(task);
  return `Updated brief for ${task} is attached (${briefName}). Follow it from now on; the rules above still hold.`;
}
