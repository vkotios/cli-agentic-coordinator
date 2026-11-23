# The Foreman

The Foreman is a deterministic dispatcher inside orch. It holds a backlog of **work items** in SQLite, starts them one at a time through orch's own commands, watches them, runs their acceptance checks, and hands finished work to a person or a frontier session. There is no model inside it. It never merges, pushes or deletes.

State lives in `<state root>/foreman/foreman.db`. Run evidence stays in orch's run folders. One Foreman runs per state root (a bound pipe or socket, released by the operating system when the process ends).

## Quick start

```
orch foreman project add --id alpha --repo C:\path\to\repo
orch enqueue --file item.json            # or the `enqueue` MCP tool
orch foreman goal approve g1 --project alpha
orch foreman settings --defaultRoute "{\"cli\":\"opencode\",\"model\":\"igm-local/qwen3.8-flash-next-halogen-flash\"}"
orch foreman start                        # runs until `orch foreman stop`
orch foreman status
```

## A work item

```json
{
  "project": "alpha",
  "title": "Add a parser test",
  "goal_ref": "g1",
  "handoff": "TASK: ...  (the worker's instructions, as in templates/handoff.md)",
  "allowlist": ["test/parser.test.mjs"],
  "acceptance": [{"kind": "command", "argv": ["node", "--test", "test/parser.test.mjs"]}],
  "size": "XS",
  "priority": "P2",
  "latency": "whenever",
  "depends_on": [],
  "route": {"cli": "opencode", "model": "..."}
}
```

`enqueue` refuses an item with no acceptance check, and lists every problem at once. Acceptance kinds are `command` and `validator` (an argv array, never a shell string) and `rubric` (text only, for a person to judge). An item runs only when its `goal_ref` names an **approved** goal; goals are per project and `enqueue` proposes an unknown one.

## What happens to an item

`ready` -> `running` (claim, worktree, `orch run`) -> `verifying` -> `needs-review`, or `parked` with a tag (`spec-ambiguous`, `flaky-test`, `timeout`, `scope-violation`, `capability-wall`, `needs-input`, `check-failed`, `operator`) and a reason.

When the worker has finished, in this order:

1. `orch scope` (tracked and untracked files against the allowlist). A violation parks the item **before anything is run**.
2. A check for **git-ignored files** the worker created outside the allowlist (orch's scope guard cannot see them). Caches in `toleratedIgnored` are ignored. Also parks before anything is run.
3. The acceptance commands, in the worktree, with a reduced environment (no keys or tokens), a time limit and a log cap. A bare program name is resolved through `PATH`, never the worktree.
4. All passed: `needs-review`. The worktree is kept and the claim released. **Reviewing, grading findings and merging stay with a person or a frontier session**: a deterministic daemon cannot grade, and nothing here merges.

A failed run is never retried automatically (orch's rule: a second attempt needs a recorded change). Requeue with `orch foreman requeue <id>` after amending. After you merge a verified item yourself, record it with `orch foreman accept <id>`.

## Trust boundary

An item's `acceptance` argv runs with the Foreman's privileges on the machine, and `handoff` is the worker's prompt. Whoever can call `enqueue` (the MCP server, the CLI, the web GUI) can therefore run commands there, exactly like anyone who can call `orch run`. The gate is who has that access, plus goal approval. `route.flags` (adapter flags that can loosen a worker's own sandbox) is accepted for the test adapter only. There is no per-item approval step; add one before exposing `enqueue` to anything less trusted than your own sessions.

## Progress checks

Every tick (60 s by default) each running item gets **tier-1 signals**: no activity (orch's `suspected_stall`), no change in the worktree for 15 min, the same step three times in a row, test failures repeating (a heuristic), or the size-class time budget passed (XS 15, S 30, M 60 min). A signal only **asks for a check**. Nothing is ever cancelled on a number.

A **tier-2 check** writes a packet (goal, acceptance, allowlist, signals, `git diff --stat`, the last 200 log lines) to `<state root>/foreman/checks/` and waits for a verdict from a frontier session or an executor:

```
orch foreman checks --status pending
orch foreman verdict <check-id> --verdict looping --reason "same edit five times" --by claude-code
```

`progressing` and `unsure` let the run continue (a second `unsure` notes that the next check should ask a different model family). `looping`, `off-track` and `blocked` cancel the run **with your verdict as the recorded reason** and park the item (`capability-wall`, `spec-ambiguous` or `scope-violation`, `needs-input`). At most four checks run per run; after that the next alarm parks the item. A person can ask for a check with `orch foreman check-now <item>`. Re-routing a looping item to a cloud worker is not automatic yet.

## Inference gateway events

Set the gateway URL and keep the control key in an environment variable (the key is never stored):

```
orch foreman settings --igmUrl http://gateway.example:9000        # key: $env:IGM_CONTROL_KEY
```

On each tick the Foreman reads `GET /api/admission/events` with a cursor. An operator abort or drop of a request from `orch/<run-id>` is recorded on the run and asks for an immediate check. It never cancels the run by itself. For the gateway to see the run id, give the opencode provider these headers (the worker environment carries `ORCH_RUN_ID`):

```jsonc
"options": { "headers": { "X-IGM-Priority": "batch", "X-Client-Name": "orch/{env:ORCH_RUN_ID}" } }
```

## Limits in this version

One run at a time by default (`maxConcurrent`); raise it together with `lanes.local.permits`. Dependent items start from the project's default branch, so merge a dependency before accepting it. The tier-2 executor is manual unless one is supplied in code.
