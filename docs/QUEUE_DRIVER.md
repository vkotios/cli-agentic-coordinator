# Queue driver (`orch/tools/queue-driver.mjs`)

The queue driver runs a plan folder's task backlog unattended, end to end: one
`orch run --cli vibe` per task, `orch status` polling, a checks round, one repair
round when needed, and one commit per task. You point it at a worktree and a
plan, and it either finishes the backlog or stops at the first task that cannot
be trusted.

It is a generic kit tool. Nothing about your project is hard-coded: the worktree,
the plan folder, the model, the check commands and the forbidden paths are all
command-line options.

```
node orch/tools/queue-driver.mjs --wt <worktree> --plan <dir> --checks <file> --model <id> [options]
node orch/tools/queue-driver.mjs --help
```

## Quick start

A Node project (tests + typecheck):

```
node orch/tools/queue-driver.mjs \
  --wt <your repo>/.worktrees/backlog \
  --plan docs/plans/backlog \
  --checks docs/plans/backlog/checks.json \
  --model <vibe model id> \
  --forbid '^package(-lock)?\.json$' --forbid '^\.env'
```

with `checks.json`:

```json
{
  "test": ["node", "--test"],
  "extra": [["npm", "run", "typecheck"]],
  "cwd": "."
}
```

A Python project (pytest + ruff + mypy, tests importing from `src/`):

```json
{
  "test": ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"],
  "extra": [["python", "-m", "ruff", "check", "src", "tests"], ["python", "-m", "mypy", "src"]],
  "cwd": ".",
  "env": { "PYTHONPATH": "src" }
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `--wt PATH` | (required) | The worktree the tasks edit. All git and check commands run here. |
| `--plan DIR` | (required) | The plan folder, absolute or relative to `--wt`. |
| `--checks FILE` | none | The checks file (below). Without it tasks are committed unverified. |
| `--model ID` | (required) | The worker model passed to `orch run`. Without the flag, `ORCH_QUEUE_MODEL` or `queueDriver.model` in `orch.config.json` is used; there is no built-in default. |
| `--cli NAME` | `vibe` | The worker CLI. Only `vibe` is supported; others are rejected. |
| `--forbid REGEX` | (none) | A changed path matching REGEX stops the queue, uncommitted. Repeatable. |
| `--stall-minutes N` | `20` | A worker with no activity for N minutes is cancelled as stalled. |
| `--from ID` | start | Start the queue at task ID (inclusive). |
| `--only ID` | all | Run only task ID. |
| `--dry-run` | off | Print the selected tasks and every command; no orch calls, no commits. |
| `--help` | | Print the usage text. |

## The plan folder

```
<plan>/
  COMMON.md   prepended to every task handoff (role rules, hard rules, report format)
  TASKS.md    the task sections
  RUNLOG.md   appended by the driver as the queue runs (created on first start)
```

`TASKS.md` is a sequence of sections. A section opens with a `##### <ID>` line
(the ID is a single token) and carries:

- a `TASK <ID>: <title>` line (the title; the ID is used when the line is absent),
- a `TESTS: <paths>` line: space-separated test paths appended to the checks
  file's `test` command. `TESTS: (<anything>)` means the task has no test
  command; only the `extra` checks run for it.

Text before the first `#####` section (a heading, notes) is ignored.

## The checks file

A JSON object; every key is optional, unknown keys are rejected:

| Key | Shape | Meaning |
|---|---|---|
| `test` | `["cmd", "arg", ...]` | Runs with the task's TESTS paths appended. Required when any task lists TESTS paths. |
| `extra` | `[["cmd", "arg", ...], ...]` | Runs for every task (lint, typecheck, ...). |
| `cwd` | `"dir"` | Working directory for every check command, relative to the worktree. Default `.`. |
| `env` | `{"KEY": "value"}` | Extra environment for every check command (e.g. `PYTHONPATH`). |

A task's checks pass when every command exits 0. The exit code and the tail of
each command's output go into the RUNLOG and into the repair handoff.

## What a run does, per task

1. Launch `orch run --cli vibe --model <model> --dir <wt> --handoff <file> --no-window --json`
   with `COMMON.md` + the task section as the handoff, then poll `orch status`
   every 30 s until the run completes or fails.
2. Stop the whole queue if the worker fell back to another model
   (`model_mismatch` in the status, or no `model_actual` recorded together with a
   `falling back` line written since the launch in `vibe.log` in the vibe log
   directory: `ORCH_VIBE_LOG_DIR` / `vibeLogDir`, default `%USERPROFILE%\.vibe\logs`).
3. Stop if a changed path matches any `--forbid` regex (left uncommitted).
4. Run the checks. If they fail or the worker failed, run one repair round: the
   same handoff plus the check output, then the checks again.
5. Append the task report to `<plan>/RUNLOG.md` (worker status, checks verdict,
   changed files, check output, worker report tail).
6. Stop if the task produced no file changes. Otherwise `git add -A` (excluding
   `.vibe`) and commit `feat(<ID>): <title>` with the run id and the checks verdict.
7. Stop after two consecutive tasks with failing checks.

Changed paths are `git status --porcelain --untracked-files=all` minus `.vibe/`
(the worker's session files) and minus the plan folder (COMMON.md / TASKS.md /
RUNLOG.md) - the driver's own bookkeeping is not "the task's work".

## Stop conditions and exit codes

| Exit | Meaning |
|---|---|
| 0 | The queue finished (or `--help` / `--dry-run` printed). |
| 1 | The queue stopped itself: model fallback, forbidden path, stall, no file changes, failed commit, two consecutive failing tasks. The reason is in RUNLOG.md. |
| 2 | Operator error: bad options, missing plan files, unreadable checks file, unknown task id. |

## Safety notes

- The driver deletes `MISTRAL_API_KEY` from its own environment (and so from every
  worker it starts) at startup: with that variable set, vibe bills the API key
  instead of the vibe CLI plan's own allowance.
- Handoff files are written to `<state root>/queue-handoffs/handoff-<ID>-a1.md`
  (override: `ORCH_QUEUE_HANDOFF_DIR` or `queueDriver.handoffDir` in
  `orch.config.json`) and forced to ASCII - vibe decodes non-ASCII stdin as mojibake.
- `--dry-run` makes no orch calls, no git calls and no commits; it only reads the
  plan and the checks file and prints what it would do.
- Only `--cli vibe` is supported. The fallback detection and the vibe.log check
  are vibe-specific; adding another CLI means adding its section in
  `docs/CLI_GUIDE.md` and its fallback signature here.

## Tests

`orch/test/queuedriver.test.mjs` unit-tests the exported pure helpers (option
parsing, task parsing and selection, checks parsing and command building,
changed-path filtering, forbidden matching) and drives `--dry-run` through
`main()` with an injected spawn that records every call. Run it with:

```
cd orch && node --test --test-concurrency=1 --test-force-exit test/queuedriver.test.mjs
```
