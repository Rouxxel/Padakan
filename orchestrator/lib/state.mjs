// state.json in the records folder: the orchestrator's resume point. Only the orchestrator writes it.
//   { version, gate, tasks: { <KEY>: { status, tree, branch, pr, verdict, updated_at, ... } } }

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const TASK_STATUSES = ['planned', 'planted', 'building', 'verifying', 'verified', 'escalated', 'merged', 'retired', 'done', 'paused'];

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error(`invalid task key "${key}"`);
  return key;
}

// The sandbox id for a task key: lowercase, safe for every provider.
export function treeId(key) {
  return assertKey(key).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 39);
}

export const branchFor = (key) => `padakan/${assertKey(key)}`;

export async function readState(records) {
  const file = join(records, 'state.json');
  if (!existsSync(file)) throw new Error(`no state.json in ${records}: run \`padakan init\` first`);
  return JSON.parse(await readFile(file, 'utf8'));
}

// Apply fn(state) and write the result atomically. Returns the new state.
export async function updateState(records, fn, now = () => new Date().toISOString()) {
  const state = await readState(records);
  state.tasks ??= {};
  const next = (await fn(state)) ?? state;
  const file = join(records, 'state.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, file);
  return next;
}

export async function updateTask(records, key, fields, now = () => new Date().toISOString()) {
  assertKey(key);
  return updateState(records, (s) => {
    s.tasks[key] = { ...(s.tasks[key] || {}), ...fields, updated_at: now() };
  });
}

export async function getTask(records, key) {
  const s = await readState(records);
  const t = s.tasks?.[assertKey(key)];
  if (!t) throw new Error(`no task ${key} in state.json`);
  return t;
}
