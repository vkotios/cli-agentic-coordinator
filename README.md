# cli-agentic-coordinator

One orchestrator agent (Claude Code or Codex) coordinating **worker coding CLIs** (opencode, vibe,
codex, agy) on Windows. The orchestrator specifies, launches, monitors, reviews and accepts; the workers
write the code. The `orch` tool is the only way work gets launched, and it keeps the record.

What `orch` enforces:

- **One local model at a time.** A machine-wide `local` lane (a named pipe bound atomically) admits exactly
  one run against your local model gateway; a second is refused immediately, never queued. Cloud runs go
  in parallel.
- **Supervised runs.** Each run gets its own git worktree, a record, a keeper process that holds the lane
  and captures the output, and a monitor that reports activity and `suspected_stall`. A stall is advisory:
  orch never kills a run on its own.
- **Scope guard.** `orch scope` compares the changed paths (tracked and untracked) with the handoff's
  allowlist; a run that touched anything else never reaches review.
- **Blinded cross-model review.** `orch review` runs a reviewer in a throwaway detached worktree, refuses a
  reviewer whose canonical model id equals the implementer's, can delete `--blind` files from the copy,
  and afterwards checks that neither the review worktree nor the source repository changed
  (`containment-breach` otherwise).
- **Review gate.** `orch gate record` turns graded findings, your verification and the scope result into
  `converged` / `another-round` / `stop-round-cap` / `escalate-design`.
- **Ledger and rotation.** `orch record` appends one row per run; `orch pick` proposes the next model from
  your roster and that ledger, preferring under-tested models.
- **Guard hook.** A PreToolUse hook for Claude Code and Codex denies direct worker-CLI launches (use
  `orch run`) and a set of destructive commands.

The protocol the orchestrator follows is `ORCHESTRATOR.md`; the step-by-step skill is
`skills/orchestrate/workflow.md`.

## How you use it

You talk to your orchestrator (Claude Code or Codex) in a repository you have adopted, as you normally
would: "add CSV export to the report command", "fix issue 42". The orchestrator does not write the code.
It follows the `orchestrate` skill and drives `orch` (as a CLI or through its MCP tools):

1. **Claim** the work package, so a second orchestrator cannot act on it at the same time.
2. **Plan and slice** it into small handoffs (`templates/handoff.md`): allowed files, anchors, acceptance
   checks. You approve the plan before anything runs.
3. **Pick** a worker model (`orch pick`, rotating through your roster) and **run** it in its own git
   worktree (`orch run`). A log window shows the worker's output; the orchestrator checks `orch status`
   on a schedule instead of waiting.
4. **Check scope**: any file outside the handoff's allowlist sends the run back.
5. **Review** with a different model in a blinded, read-only copy (`orch review`), grade the findings,
   and let the gate decide: converged, another round, or stop and ask you.
6. **Record** the result in the ledger, then merge (or discard) the worktree. Follow-ups that were out of
   scope are filed, not fixed on the side.

You stay in charge of the decisions: plans, merges, anything destructive, and anything the gate
escalates.

## Requirements

- **Windows 10 or 11.** macOS and Linux are not supported yet: every `orch` command stops with a
  "Windows only for now" message on other platforms.
- **Node.js 22 or newer** (developed and tested on Node 24).
- **git** on `PATH`.
- Windows PowerShell 5.1 (ships with Windows). **Windows Terminal** (`wt.exe`) is optional: when present,
  each run gets a read-only log window.
- An orchestrator host: **Claude Code** and/or **Codex**.
- At least one supported worker CLI, **installed and logged in by you** (orch never installs or
  authenticates anything):

  | CLI | used for | notes |
  |---|---|---|
  | [opencode](https://opencode.ai) | local models through an OpenAI-compatible gateway (llama.cpp, llama-swap, LocalAI, ...) | npm package `opencode-ai`; orch launches the real `opencode.exe`, not the `.cmd` shim |
  | vibe (Mistral) | cloud implementer / reviewer | the model is selected through the worktree's `.vibe/config.toml` |
  | codex (OpenAI) | cloud implementer / reviewer | `codex exec`, model always pinned |
  | agy (Gemini) | cloud reviewer | print mode, plan mode |

  GitHub Copilot CLI is recognised by the guard but has no orch adapter yet. Per-CLI details and verified
  quirks: `docs/CLI_GUIDE.md`.

## Install

```powershell
git clone https://github.com/vkotios/cli-agentic-coordinator.git
cd cli-agentic-coordinator\orch
npm ci
node bin\orch.mjs --help
```

`orch` has no runtime dependencies; `npm ci` installs only the type checker and the MCP client used by
the tests. Optionally make `orch` a command, for example in your PowerShell profile:

```powershell
function orch { node "C:\path\to\cli-agentic-coordinator\orch\bin\orch.mjs" @args }
```

## Quick start

1. **Configure (optional).** Everything has a default (see below). To change one, copy
   `orch.config.example.json` to `orch.config.json` and edit it, or set the environment variables.
2. **Create your roster.** Copy `orch/roster.example.json` to `orch/roster.json` and list the models you
   can actually launch (`docs/MODELS.md`). `orch pick` needs it.
3. **Adopt a repository.** This installs the guard hook, the orchestrate skill (Claude Code and Codex), the
   read-only subagents and a project `.mcp.json` into the repository you want to work on:

   ```powershell
   node orch\bin\orch.mjs adopt --repo C:\path\to\your-repo --dry-run   # show the plan, write nothing
   node orch\bin\orch.mjs adopt --repo C:\path\to\your-repo
   ```

   adopt never deletes, refuses to overwrite files it did not write, and records what it wrote in
   `.orch-adopt.json` (`--update` later replaces only its own unchanged files). Commit the result in
   that repository yourself.
4. **Register the MCP server** (adopt prints these with your real path; it never runs them):

   ```powershell
   claude mcp add --scope user orch -- node "C:/path/to/cli-agentic-coordinator/orch/bin/orch.mjs" mcp
   codex mcp add orch -- node "C:/path/to/cli-agentic-coordinator/orch/bin/orch.mjs" mcp
   ```

   In Claude Code, approve the project `.mcp.json` when asked; in Codex, trust the hook once.
5. **First run.** Write a handoff from `templates/handoff.md`, then:

   ```powershell
   orch claim WP-01 --by claude-code
   orch worktree create --repo C:\path\to\your-repo --wp WP-01 --slice s1 --by claude-code
   orch run --cli opencode --model localai/example-coder-30b --dir <worktree printed above> --handoff C:\path\to\handoff.txt --wp WP-01 --slice s1 --by claude-code --size XS
   orch status <run id>
   ```

   In practice the orchestrator does all of this for you through the `orchestrate` skill or the MCP tools.

## Configuration

Every setting is resolved in this order: **command-line flag** (where one exists) > **environment
variable** > **`orch.config.json`** > **default**. `orch.config.json` lives at the repository root (or
at the path in `ORCH_CONFIG`, which must then exist), is optional and git-ignored; relative paths in it
resolve against the directory the file is in. An invalid file is an error, never silently ignored.
`orch.config.example.json` lists every key.

| setting | config key | environment | default |
|---|---|---|---|
| state root (runs, claims, reviews records, ledger) | `stateRoot` | `ORCH_STATE_ROOT` (flag `--state-root`) | `orch/.state` |
| lane directory (advisory lane holder files) | `laneRoot` | `ORCH_LANE_HOME` | `orch/.lane` |
| review root (throwaway review worktrees) | `reviewRoot` | `ORCH_REVIEW_ROOT` (flag `--review-root`) | `%LOCALAPPDATA%\cli-agentic-coordinator\reviews` |
| roster | `roster` | `ORCH_ROSTER` (flag `--roster`) | `orch/roster.json` |
| ledger | `ledger` | `ORCH_LEDGER` (flag `--ledger`) | `<state root>/ledger.jsonl` |
| local gateway URL (only `orch/tools/bench-gateway.mjs` uses it) | `gatewayUrl` | `ORCH_GATEWAY_URL` (flag `--gateway`) | none: required by the benchmark |
| benchmark model list | `bench.models` | - (flag `--models`) | none: required by the benchmark |
| opencode / codex / agy / vibe executable | `exe.opencode`, `exe.codex`, `exe.agy`, `exe.vibe` | `ORCH_OPENCODE_EXE`, `ORCH_CODEX_EXE`, `ORCH_AGY_EXE`, `ORCH_VIBE_EXE` | found on `PATH` / the npm global prefix at run time |
| Windows Terminal / PowerShell for the log window | `exe.wt`, `exe.powershell` | `ORCH_WT_EXE`, `ORCH_PS_EXE` | `wt.exe`, `powershell.exe` |
| codex session rollouts (model attribution) | `codexSessionsDir` | `ORCH_CODEX_SESSIONS` | `$CODEX_HOME\sessions`, else `%USERPROFILE%\.codex\sessions` |
| vibe logs | `vibeLogDir` | `ORCH_VIBE_LOG_DIR` | `%USERPROFILE%\.vibe\logs` |

Notes:

- The review root must be a neutral place: orch refuses one under the temp directory, a path that looks
  like a scratch or temp folder, or one inside the repository under review.
- The lane itself is a per-user named pipe, derived from your account (not from any setting), so the
  exclusion is machine-wide whatever the lane directory. Use the same `laneRoot` for every orch invocation
  anyway, so `orch wait-lane` and `orch gc` see the holder file.
- `<state root>/config.json` can tune the lane thresholds (`lanes.local.quietSeconds`, `stallSeconds`,
  ...) and polling; the defaults are in `orch/src/config.mjs`.

## Limitations

- **Windows only for now.** Named pipes, `taskkill`, the process-table snapshots and the PowerShell log
  viewer are Windows mechanisms.
- **The guard reads command text; it is not a sandbox.** It stops the direct forms and the common wrappers
  of a worker launch or a destructive command, but not a launch from a script file, an alias or function,
  or a variable set in an earlier command. It prevents accidents.
- **Containment was measured inside Claude Code's process tree.** Tree kill and escaped-helper discovery
  were verified with runs started from Claude Code sessions; other hosts are expected to behave the same
  but are less exercised.
- **Model attribution may be `unknown`.** orch records the model a worker says it used, from the worker's
  own output, and records `unknown` rather than the requested id when the evidence is missing or ambiguous
  (for example agy's silent default model, or codex `--json` runs without a bindable session rollout).
- The worker CLIs change quickly; the verified quirks in `docs/CLI_GUIDE.md` carry the version they were
  seen on.

## Security notes

- **Worker CLIs run with auto-approve flags** (`--auto-approve`, `--dangerously-skip-permissions`,
  `--sandbox workspace-write`, opencode `allow` permissions). They can run arbitrary commands as you. That
  is why every run happens in a dedicated git worktree and why reviews are checked for containment
  afterwards. Treat a worktree as something a model may have damaged.
- **Never point orch at a repository with secrets in its working tree** (keys, `.env` files with real
  values, credentials). A worker can read everything in its worktree and send it to its model provider.
  The guard denies `.env` access by the orchestrator's own tools, not by the workers.
- orch never installs, updates or logs in to a CLI and never runs the global `claude mcp add` /
  `codex mcp add` registration itself; it prints the commands.
- Run the test suite (`npm test` in `orch/`) after upgrading Node or a worker CLI.

## Development

```powershell
cd orch
npm ci
npm run typecheck
npm test
```

The suite uses a fake worker and never needs a real worker CLI. It exercises real process trees,
pipes and kill paths, so it comes in two sizes, switched by one variable:

- `npm test` - the fast default: every test runs, and the process-level stress tests (lane contention,
  keeper death, monitor kill, cancel, wait-lane, claim race, ledger concurrency) run their scenario once.
- `npm run test:stress` - the same tests at their full repetition counts (20x for most); about
  25 minutes. Run it after changing the lane, keeper, monitor, cancel or claim code.

The switch is `ORCH_TEST_REPS`: unset = 1 (or the full counts when started as `npm run test:stress`),
`stress` = full counts, a number = that many repetitions. CI runs typecheck + `npm test` on every push
and pull request; the stress suite runs only when started by hand (Actions > test > Run workflow).

Tests write under `orch/.state-test`, the lane directory (test lanes only) and the OS temp directory,
and remove what they created.

Before a release, run `node orch/tools/release-scan.mjs`: it scans the tree for personal data,
machine-specific paths, private ids and secret patterns (exit 0 = clean).

## License

MIT, see `LICENSE`. Third-party notices: `orch/THIRD_PARTY.md`.
