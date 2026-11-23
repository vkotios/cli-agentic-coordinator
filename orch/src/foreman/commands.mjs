// `orch enqueue` and `orch foreman ...`: thin wrappers over api.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from '../errors.mjs';
import { openStore, addProject, enqueue, parkItem, requeueItem, archiveItem, summary } from './api.mjs';

function actorOf(args) {
  const by = args.by;
  return typeof by === 'string' && by.trim() ? by.trim().slice(0, 60) : 'cli';
}

function out(args, io, obj, text) {
  io.log(args.json ? JSON.stringify(obj, null, 2) : text);
  return obj;
}

function readItem(args) {
  let text;
  if (typeof args.item === 'string') text = args.item;
  else if (typeof args.file === 'string') {
    const file = path.resolve(args.file);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new OrchError(`--file does not exist: ${file}`, 'foreman-bad-item');
    text = fs.readFileSync(file, 'utf8');
  } else throw new OrchError('usage: orch enqueue --file <item.json> | --item <json>', 'missing-arg');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OrchError(`the item is not valid JSON (${error.message})`, 'foreman-bad-item');
  }
}

export async function cmdEnqueue(args, io = console) {
  const store = openStore(args['state-root']);
  try {
    const item = enqueue(store, readItem(args), actorOf(args));
    const view = { id: item.id, state: item.state, project: item.project, priority: item.priority, depends_on: item.depends_on, goal_ref: item.goal_ref };
    const note = item.goal_ref ? '' : ' (no goal_ref: it will not run until it is given an approved goal)';
    out(args, io, view, `enqueued ${item.id} (${item.state})${note}`);
    return { ...view, exitCode: 0 };
  } catch (error) {
    if (error.code === 'foreman-bad-item') {
      const errors = /** @type {any} */ (error).details || [error.message];
      io.log(args.json ? JSON.stringify({ refused: true, errors }, null, 2) : error.message);
      return { refused: true, errors, exitCode: 2 };
    }
    throw error;
  } finally {
    store.close();
  }
}

export async function cmdForeman(args, io = console) {
  const [sub, a1, a2] = args._;
  const actor = actorOf(args);
  const store = openStore(args['state-root']);
  try {
    switch (sub) {
      case 'status': {
        const s = summary(store);
        out(args, io, s, `items: ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ')}; projects ${s.projects.length}; goals ${s.goals.length}; pending checks ${s.pending_checks}`);
        return { ...s, exitCode: 0 };
      }
      case 'project': {
        if (a1 === 'add') {
          const p = addProject(store, { id: args.id, repo: args.repo, defaultBranch: args.branch || 'main' }, actor);
          out(args, io, p, `project ${p.id} registered (${p.repo})`);
          return { ...p, exitCode: 0 };
        }
        if (a1 === 'list') {
          const list = store.listProjects();
          out(args, io, { projects: list }, list.map((p) => `${p.id}${p.paused ? ' (paused)' : ''}  ${p.repo}`).join('\n') || 'no projects');
          return { projects: list, exitCode: 0 };
        }
        if (a1 === 'pause' || a1 === 'resume') {
          const p = store.setProjectPaused(a2, a1 === 'pause', actor);
          out(args, io, p, `project ${p.id} ${p.paused ? 'paused' : 'resumed'}`);
          return { ...p, exitCode: 0 };
        }
        throw new OrchError('usage: orch foreman project add --id <id> --repo <abs path> [--branch main] | list | pause <id> | resume <id>', 'missing-arg');
      }
      case 'goal': {
        if (a1 === 'list') {
          const goals = store.listGoals(args.project);
          out(args, io, { goals }, goals.map((g) => `${g.id}  ${g.status}  ${g.project}  ${g.text}`).join('\n') || 'no goals');
          return { goals, exitCode: 0 };
        }
        if (a1 === 'approve' || a1 === 'retire') {
          if (!args.project) throw new OrchError('--project <id> is required (goal ids are per project)', 'missing-arg');
          const g = store.setGoalStatus(args.project, a2, a1 === 'approve' ? 'approved' : 'retired', actor, args.text);
          out(args, io, g, `goal ${g.project}/${g.id} ${g.status}`);
          return { ...g, exitCode: 0 };
        }
        throw new OrchError('usage: orch foreman goal list [--project <id>] | approve <id> --project <p> [--text <t>] | retire <id> --project <p>', 'missing-arg');
      }
      case 'items': {
        const items = store.listItems({ project: args.project, state: args.state }).map(({ spec, ...rest }) => rest);
        out(args, io, { items }, items.map((i) => `${i.id}  ${i.state}${i.park_tag ? ':' + i.park_tag : ''}  ${i.priority}  ${i.title}`).join('\n') || 'no items');
        return { items, exitCode: 0 };
      }
      case 'item': {
        const item = store.getItem(a1);
        if (!item) throw new OrchError(`no such item: ${a1}`, 'foreman-no-item');
        const view = { ...item, events: store.events({ item: a1, limit: 50 }), checks: store.listChecks({ item: a1 }) };
        out(args, io, view, `${item.id}  ${item.state}  ${item.priority}  ${item.title}`);
        return { ...view, exitCode: 0 };
      }
      case 'park': {
        const item = parkItem(store, a1, args.reason, actor, args.tag || 'operator');
        out(args, io, item, `${item.id} parked`);
        return { ...item, exitCode: 0 };
      }
      case 'requeue': {
        const item = requeueItem(store, a1, actor);
        out(args, io, item, `${item.id} is ready again`);
        return { ...item, exitCode: 0 };
      }
      case 'archive': {
        const item = archiveItem(store, a1, actor);
        out(args, io, item, `${item.id} archived`);
        return { ...item, exitCode: 0 };
      }
      case 'edit': {
        const fields = {};
        if (args.priority) fields.priority = args.priority;
        if (args.latency) fields.latency = args.latency;
        if (args.pause !== undefined) fields.paused = args.pause !== 'false';
        const item = store.updateItem(a1, fields, actor);
        out(args, io, item, `${item.id} updated`);
        return { ...item, exitCode: 0 };
      }
      default:
        throw new OrchError('usage: orch foreman status | project ... | goal ... | items | item <id> | park <id> --reason <r> | requeue <id> | archive <id> | edit <id> --priority P1', 'missing-arg');
    }
  } finally {
    store.close();
  }
}
