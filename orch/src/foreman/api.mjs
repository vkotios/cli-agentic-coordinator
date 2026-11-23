// The Foreman's engine functions. The CLI, the MCP tools and the web GUI all call these (and,
// through the dispatcher, `runCommand`), so a GUI button runs the same checks as a command.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OrchError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { Store } from './store.mjs';
import { validateItem, isProjectId, PARK_TAGS } from './schema.mjs';

export function openStore(stateRootArg) {
  return Store.open(loadConfig(stateRootArg).stateRoot);
}

function gitTop(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Register a project. The repository must exist and be a git work tree; nothing in it is touched. */
export function addProject(store, { id, repo, defaultBranch = 'main' }, actor) {
  if (!isProjectId(id)) throw new OrchError(`invalid project id "${id}" (lowercase letters, digits, hyphen)`, 'foreman-bad-project');
  if (!repo || !path.isAbsolute(repo) || !fs.existsSync(repo)) throw new OrchError('--repo must be an absolute path to an existing directory', 'foreman-bad-repo');
  if (!gitTop(repo)) throw new OrchError(`${repo} is not inside a git work tree`, 'foreman-bad-repo');
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(defaultBranch)) throw new OrchError(`invalid branch name "${defaultBranch}"`, 'foreman-bad-branch');
  return store.addProject({ id, repo: path.resolve(repo), defaultBranch }, actor);
}

/**
 * Validate and store one work item. Refuses an item that fails the schema (including one
 * with no acceptance check) and reports every problem at once.
 */
export function enqueue(store, raw, actor) {
  const checked = validateItem(raw);
  if (!checked.ok) {
    throw Object.assign(new OrchError(`work item refused:\n  - ${checked.errors.join('\n  - ')}`, 'foreman-bad-item'), { details: checked.errors });
  }
  return store.insertItem(checked.item, actor);
}

/** Park by hand (operator), with a reason. A running item must be cancelled first. */
export function parkItem(store, id, reason, actor, tag = 'operator') {
  if (!reason || !String(reason).trim()) throw new OrchError('parking needs a reason', 'foreman-reason');
  if (!PARK_TAGS.includes(tag)) throw new OrchError(`unknown park tag ${tag}`, 'foreman-park-tag');
  return store.transition(id, 'parked', { actor, reason: String(reason).trim(), parkTag: tag });
}

/** Return a parked or reviewed item to the ready queue; its attempt count is kept. */
export function requeueItem(store, id, actor, reason = 'requeued') {
  return store.transition(id, 'ready', { actor, reason });
}

export function archiveItem(store, id, actor) {
  return store.transition(id, 'archived', { actor, reason: 'archived' });
}

export function summary(store) {
  return {
    counts: store.counts(),
    projects: store.listProjects().map((p) => ({ id: p.id, repo: p.repo, paused: p.paused })),
    goals: store.listGoals().map((g) => ({ id: g.id, project: g.project, status: g.status })),
    pending_checks: store.listChecks({ status: 'pending' }).length,
  };
}
