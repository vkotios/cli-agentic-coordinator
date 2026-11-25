// `orch enqueue` and `orch foreman ...`: thin wrappers over api.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from '../errors.mjs';
import { openStore, addProject, setProjectSetup, enqueue, parkItem, requeueItem, archiveItem, summary, answerCheck, requestCheckNow } from './api.mjs';
import { runForeman } from './daemon.mjs';
import { foremanHolder } from './lock.mjs';
import { readSettings, saveSettings } from './settings.mjs';
import { loadConfig } from '../config.mjs';

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
  if (sub === 'start') {
    // Runs until it is stopped (`orch foreman stop`, Ctrl+C or SIGTERM). One per state root.
    const stopSignal = { stopped: false };
    const stop = () => { stopSignal.stopped = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await runForeman({ stateRoot: args['state-root'] ?? null, once: !!args.once, tickSeconds: args.tick != null ? Number(args.tick) : null, log: (s) => io.log(s), stopSignal });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return { exitCode: 0 };
  }
  const store = openStore(args['state-root']);
  try {
    switch (sub) {
      case 'status': {
        const holder = await foremanHolder(loadConfig(args['state-root']).stateRoot);
        const s = { ...summary(store), running: holder !== null, holder, paused: readSettings(store).paused };
        out(args, io, s, `foreman ${s.running ? `running (pid ${holder.pid})` : 'not running'}${s.paused ? ', paused' : ''}\nitems: ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ')}; projects ${s.projects.length}; goals ${s.goals.length}; pending checks ${s.pending_checks}`);
        return { ...s, exitCode: 0 };
      }
      case 'pause':
      case 'resume': {
        saveSettings(store, { paused: sub === 'pause' }, actor);
        out(args, io, { paused: sub === 'pause' }, sub === 'pause' ? 'paused: running items are finished and watched; nothing new starts' : 'resumed');
        return { paused: sub === 'pause', exitCode: 0 };
      }
      case 'stop': {
        store.kvSet('stop_requested', '1');
        store.event('stop-requested', { actor });
        out(args, io, { stop_requested: true }, 'stop requested: the Foreman exits after its current tick');
        return { stop_requested: true, exitCode: 0 };
      }
      case 'settings': {
        const patch = {};
        for (const key of ['tickSeconds', 'maxConcurrent', 'acceptanceTimeoutSeconds']) if (args[key] !== undefined) patch[key] = Number(args[key]);
        if (args.igmUrl !== undefined) patch.igmUrl = args.igmUrl === 'off' ? null : String(args.igmUrl);
        if (args.progress) patch.progress = JSON.parse(args.progress);
        if (args.defaultRoute) patch.defaultRoute = JSON.parse(args.defaultRoute);
        if (args.purgeIgnored !== undefined) patch.purgeIgnored = JSON.parse(args.purgeIgnored);
        if (Object.keys(patch).length) saveSettings(store, patch, actor);
        const now = readSettings(store);
        out(args, io, now, Object.entries(now).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n'));
        return { ...now, exitCode: 0 };
      }
      case 'project': {
        // `--setup '["npm","ci"]'` is a JSON array (an argv, never a shell string); `none` clears it.
        const setupArgv = (value) => {
          if (value === undefined) return undefined;
          if (value === 'none' || value === 'off') return null;
          try {
            return JSON.parse(value);
          } catch {
            throw new OrchError('--setup must be a JSON array of strings, for example \'["npm","ci"]\' (or none)', 'foreman-bad-setup');
          }
        };
        if (a1 === 'add') {
          const p = addProject(store, { id: args.id, repo: args.repo, defaultBranch: args.branch || 'main', setup: setupArgv(args.setup), setupTimeout: args['setup-timeout'] }, actor);
          out(args, io, p, `project ${p.id} registered (${p.repo})${p.setup ? `; setup: ${p.setup.argv.join(' ')}` : ''}`);
          return { ...p, exitCode: 0 };
        }
        if (a1 === 'update') {
          if (!a2) throw new OrchError('usage: orch foreman project update <id> --setup <json array|none> [--setup-timeout <seconds>]', 'missing-arg');
          if (args.setup === undefined) throw new OrchError('nothing to update: pass --setup <json array|none> [--setup-timeout <seconds>]', 'missing-arg');
          const p = setProjectSetup(store, a2, setupArgv(args.setup), args['setup-timeout'], actor);
          out(args, io, p, p.setup ? `project ${p.id} setup: ${p.setup.argv.join(' ')} (timeout ${p.setup.timeout_s} s)` : `project ${p.id} setup cleared`);
          return { ...p, exitCode: 0 };
        }
        if (a1 === 'list') {
          const list = store.listProjects();
          out(args, io, { projects: list }, list.map((p) => `${p.id}${p.paused ? ' (paused)' : ''}  ${p.repo}${p.setup ? `  setup: ${p.setup.argv.join(' ')}` : ''}`).join('\n') || 'no projects');
          return { projects: list, exitCode: 0 };
        }
        if (a1 === 'pause' || a1 === 'resume') {
          const p = store.setProjectPaused(a2, a1 === 'pause', actor);
          out(args, io, p, `project ${p.id} ${p.paused ? 'paused' : 'resumed'}`);
          return { ...p, exitCode: 0 };
        }
        throw new OrchError('usage: orch foreman project add --id <id> --repo <abs path> [--branch main] [--setup <json array> [--setup-timeout <s>]] | update <id> --setup <json array|none> [--setup-timeout <s>] | list | pause <id> | resume <id>', 'missing-arg');
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
      case 'checks': {
        const checks = store.listChecks({ item: args.item, status: args.status, tier: args.tier ? Number(args.tier) : undefined });
        out(args, io, { checks }, checks.map((c) => `#${c.id}  ${c.status}  ${c.item}  tier ${c.tier}${c.verdict ? '  ' + c.verdict : ''}${c.packet_path ? '  ' + c.packet_path : ''}`).join('\n') || 'no checks');
        return { checks, exitCode: 0 };
      }
      case 'verdict': {
        const c = answerCheck(store, Number(a1), { verdict: args.verdict, reason: args.reason, tag: args.tag ?? null }, actor);
        out(args, io, c, `check #${c.id} answered: ${c.verdict}`);
        return { ...c, exitCode: 0 };
      }
      case 'check-now': {
        const r = requestCheckNow(store, a1, actor);
        out(args, io, r, `a progress check of ${r.item} will run on the next tick`);
        return { ...r, exitCode: 0 };
      }
      case 'park': {
        const item = parkItem(store, a1, args.reason, actor, args.tag || 'operator');
        out(args, io, item, `${item.id} parked`);
        return { ...item, exitCode: 0 };
      }
      case 'accept': {
        const item = store.transition(a1, 'done', { actor, reason: args.note || 'accepted by the operator (merged outside the Foreman)' });
        out(args, io, item, `${item.id} accepted`);
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
        throw new OrchError('usage: orch foreman start [--once] [--tick <s>] | stop | pause | resume | settings | status | checks | verdict <check-id> --verdict <v> --reason <r> | check-now <item> | project ... | goal ... | items | item <id> | park <id> --reason <r> | accept <id> | requeue <id> | archive <id> | edit <id> --priority P1', 'missing-arg');
    }
  } finally {
    store.close();
  }
}
