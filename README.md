# cli-agentic-coordinator

One orchestrator agent in your chosen harness coordinating **worker coding CLIs** (opencode, vibe,
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
- **Guard hook.** The hook handler denies direct worker-CLI launches (use `orch run`) and a set of
  destructive commands when the host invokes it. Adoption prepares Claude/Codex hook configurations;
  enforcement depends on the installed host's hook API and trust settings.

The protocol the orchestrator follows is `ORCHESTRATOR.md`; the step-by-step skill is
`skills/orchestrate/workflow.md`.

## How you use it

You talk to your orchestrator in a repository you have adopted, as you normally
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
- An orchestrator host: **Claude Code**, **Codex**, **OpenCode** or **Vibe**, with the native
  instructions and tools configured. Qualify the controller lifecycle on your installed harness,
  model and profile; instruction adoption and claim support alone do not establish readiness.
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
3. **Adopt a repository.** This appends an orch bootstrap to the selected harness instruction files
   and installs shared role instructions. By default it also installs the Claude/Codex skills and
   hook configurations, Claude read-only subagents and a project `.mcp.json`:

   ```powershell
   node orch\bin\orch.mjs adopt --repo C:\path\to\your-repo --dry-run   # show the plan, write nothing
   node orch\bin\orch.mjs adopt --repo C:\path\to\your-repo
   # Select only the harnesses you want; repeat --harness to combine them:
   node orch\bin\orch.mjs adopt --repo C:\path\to\your-repo --harness opencode --harness vibe
   ```

   Existing UTF-8 instructions (including BOM and line endings) are preserved byte for byte outside
   the managed block. `--update` replaces only an unchanged orch-owned block or copied file;
   owner edits inside the block conflict. All conflicts are previewed before writing. A late disk
   failure reports completed writes and records their ownership when the manifest can still be written;
   rerun adoption to resume. A block identical to the current kit can recover its missing or stale
   ownership record without rewriting the instruction file; other unowned blocks remain conflicts.
   Creates publish a complete temporary file exclusively. Adoption is not a transaction across all files.

   Codex uses an existing `AGENTS.override.md` before `AGENTS.md`, then configured fallback names.
   OpenCode preserves an existing `CLAUDE.md` fallback; OpenCode/Vibe select the nearest native
   entrypoint when adopting from a subdirectory. Custom discovery can be declared with
   `--instruction-file codex=TEAM.md`; supply `--codex-config <file>` for effective Codex discovery
   settings. Instruction targets cannot be adoption's own payload or JSON configuration files.
   Unresolved configuration, instruction truncation and Vibe folder trust are reported as
   partial readiness. Instructions prepared, hooks configured and live qualification are separate
   states: the existing Codex hook configuration is not a claim of enforcement on your installed version.

   Ask your chosen harness to coordinate with orch to activate the controller role. Workers and
   reviewers receive their own role packets in private run prompts, even when their worktrees lack
   ignored adoption files. The original handoff is preserved; run records hash it separately from the
   full delivered prompt. Review role delivery remains guidance, not a security sandbox.

   Review the generated files before committing anything in the adopted repository. Root bootstrap
   pointers are portable; `.orch-adopt.json`, merged hook/MCP settings and rendered workflow copies
   contain installation paths. Keep those machine-specific files private or adapt them to your team's
   setup. Adoption never changes global configuration.
4. **Register the MCP server** (adopt prints these with your real path; it never runs them):

   ```powershell
   claude mcp add --scope user orch -- node "C:/path/to/cli-agentic-coordinator/orch/bin/orch.mjs" mcp
   codex mcp add orch -- node "C:/path/to/cli-agentic-coordinator/orch/bin/orch.mjs" mcp
   ```

   In Claude Code, approve the project `.mcp.json` when asked. Verify hook support and trust separately
   for your installed harness; adoption does not establish enforcement.
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
| queue driver worker model (only `orch/tools/queue-driver.mjs`, see `docs/QUEUE_DRIVER.md`) | `queueDriver.model` | `ORCH_QUEUE_MODEL` (flag `--model`) | none: required by the queue driver |
| queue driver handoff files | `queueDriver.handoffDir` | `ORCH_QUEUE_HANDOFF_DIR` | `<state root>\queue-handoffs` |

Notes:

- The review root must be a neutral place: orch refuses one under the temp directory, a path that looks
  like a scratch or temp folder, or one inside the repository under review.
- The lane itself is a per-user named pipe, derived from your account (not from any setting), so the
  exclusion is machine-wide whatever the lane directory. Use the same `laneRoot` for every orch invocation
  anyway, so `orch wait-lane` and `orch gc` see the holder file.
- `<state root>/config.json` can tune the lane thresholds (`lanes.local.quietSeconds`, `stallSeconds`,
  ...) and polling; the defaults are in `orch/src/config.mjs`.

## Cleanup and finalization

After recording every run and finishing reviews, preview the owned resources and close the package:

```powershell
orch cleanup --wp <WP> --dry-run
orch finish <WP> --by <holder>
```

`finish` checks dispositions, reviews and acceptance gates, records resource decisions, then releases
the claim. A failed removal is reported as `cleanup-pending`; repeat `finish` or explicitly run
`orch cleanup --wp <WP> --apply --by <holder>`. Finished review findings stay unchanged during retries.
If a retry reports `retained`, supply an explicit retention decision; the package's logical closure
stays recorded. Use `cleanup --dry-run` for previews: `finish` rejects `--dry-run`, `--force` and
`--delete-branch`.

Cleanup protects active or uncertain processes, modified/untracked/ignored content, unmerged commits,
changed worktree identities and foreign resources. Incident review worktrees remain available as evidence.
To intentionally keep resources, supply `--retain <decisions.json>` with an array such as
`[{"id":"<resource-id>","reason":"investigation","revisit":"after investigation"}]`.
Missing ownership evidence is a reason for inspection, never a deletion permit. Interrupted operation
locks require inspection and are not taken over automatically. Direct `release` is an operator action;
it does not perform package finalization.

Implementation branches stay separate from directory cleanup. An explicit `worktree remove --force`
can discard content but cannot bypass ownership or process checks. Review prompts and receipts are
retained as audit evidence; this cleanup command does not implement age-based log retention or create
scratch repositories. External scratch repositories are outside automatic cleanup ownership.

## Transcript retention

Storage maintenance is separate from worktree cleanup and `orch gc` (lane housekeeping).
It is **disabled by default**. Preview without writing or deleting anything:

```powershell
orch maintain --dry-run --json
```

To opt in, add a `retention` object to `<state-root>/config.json`, preserving its other settings:

```json
{
  "retention": {
    "mode": "manual",
    "successDays": 30,
    "otherDays": 90,
    "maxRuns": 20,
    "maxBytes": 67108864,
    "maxMs": 2000,
    "minIntervalMs": 3600000
  }
}
```

These are examples to select, not an installed policy. `manual` runs only on explicit
`orch maintain --apply`; `on-use` also runs bounded maintenance before later launches and after
successful package finalization. It does not clean installations while orch is unused.
`disabled` prevents automatic collection. Read-only status, result, log and preview calls never collect.
Malformed settings refuse collection and leave ordinary launches/finalization available with a
maintenance warning. Budgets are checked between operations; a single filesystem operation can
exceed the time budget. `next_after` allows manual continuation with `--after <id>`; on-use resumes
its inventory automatically. Budget-limited runs are `deferred`, with `deferred_bytes` included in
`eligible_bytes` and separated from safety-protected storage. Do not combine `--run` with `--after`.
Protected bytes can exceed the budget without being deleted. Collection and enrollment enforce an
8 MiB payload limit, including files that grow during a read. Larger payloads remain intact with a
read-limit reason; this first collector does not provide streaming retirement of larger logs.

Successful retention applies to completed, accepted runs; all other terminal dispositions use
`otherDays`. Age starts at the later terminal/package closure time. Runs need a durable disposition,
finished package, resolved gates/reviews and confirmed process quiescence. Active or uncertain runs,
reopened packages, incomplete cleanup, containment incidents and investigation pins remain protected.
Only stdout, stderr and the run's prompt copy are eligible. Compact final messages (up to 64 KiB,
with an explicit truncation flag), requested/actual model evidence, run/process records, reviews,
gates, routing ledger and cleanup receipts remain. `result` reads the compact answer after collection;
`status` and `log` distinguish purged transcripts from empty or unexpectedly missing output.
An invalid compact receipt reports an integrity error. Verified original transcripts remain readable;
absent output never falls back to invalid compact evidence. Preserved keeper/events logs remain
readable independently of transcript receipts.

New runs record creation ownership automatically. Old runs remain inventory-only until explicitly
inspected and enrolled, one run at a time:

```powershell
orch maintain --enroll <id> --by <operator> --reason "verified historical run"
orch maintain --pin <id> --by <operator> --reason "investigation"
orch maintain --unpin <id> --by <operator> --reason "investigation closed"
orch maintain --apply
```

Enrollment also explicitly finalizes a terminal standalone run, including an already owned new run,
which still needs its ledger disposition. Original creation evidence is preserved, and repeating
finalization does not reset its retention clock. Enrollment does not change package closure or bypass safety/age checks. With retention
disabled, `--apply --run <id> --by <operator> --reason <text>` explicitly selects that one verified run
for immediate collection; the receipt records operator, reason, time and overridden policy before
deletion and preserves this original authority on retries. Enabled policies enforce their configured ages.
Interrupted collection keeps compact evidence and retries only unchanged, individually recorded
files. Uncertain locks require inspection; nothing takes them over automatically. Active-log
rotation and an installed scheduler are not included here.
The MCP `maintain` tool exposes the same preview, enrollment, pin and apply controls.

## Original metadata retention

Original run folders, keeper/monitor logs and finished review records have a separate opt-in.
Transcript retention must finish before a run folder can retire. The default maintenance kind
remains `transcripts`; use `--kind metadata` to inspect or collect original records, or `--kind all`
to share the existing item, byte and time budgets across both classes.
`--review` selects only metadata and cannot be combined with `--kind all` or `transcripts`.
Preview evaluates future-owned records without writing seals and marks them `would_auto_seal`;
its age, safety and budget checks also apply to the prospective seal. Scope checks should be
completed before metadata enrollment; changed or newly added evidence protects a sealed record.

Add `"metadata": { "enabled": true, "successDays": 90, "otherDays": 180 }` inside the
existing `retention` configuration to select separate metadata ages. Omission disables metadata
collection. Successful metadata means a completed, accepted run or a finished review with outcome
`reviewed`; other terminal outcomes use `otherDays`. Package age starts at the later terminal or
closure time; explicit standalone enrollment starts its finalization clock. Future orch-owned
records can seal after recorded finalization; older runs and reviews require explicit enrollment:

```powershell
orch maintain --kind metadata --dry-run --json
orch maintain --kind metadata --enroll <run-or-review-id> --by <operator> --reason "verified record"
orch maintain --kind metadata --apply --run <run-id> --json
orch maintain --kind metadata --apply --review <review-id> --json
orch maintain --kind all --apply --json
```

Pins and unpins also accept review IDs. A disabled policy permits a scoped run/review override only
with `--by` and `--reason`; its durable journal preserves the original operator authority on retries.
Enabled metadata policies enforce their configured ages. On-use maintenance resumes each inventory
and alternates which class goes first, including when the item budget is one.

Retirement first publishes immutable compact evidence, capped at 256 KiB per entry, and an exact
file journal. Event-log hashes stream in bounded chunks and stop at the time budget. Oversized
required evidence, incomplete hashes, active/reopened packages, unresolved reviews/gates, uncertain
processes, pins, pending resource cleanup, foreign files, subdirectories, links and locks preserve
originals with a reason. Unlinks require unchanged physical identity and contents; directory removal
uses nonrecursive `rmdir`. Interrupted removal stays pending, and uncertain locks require inspection.

`list`, `status`, `result`, scope/gate lookup, routing identity checks, review finalization and
resource cleanup read validated compact records after originals are gone. Matching live logs remain
readable during partial retirement. Corrupt or missing compact evidence reports an integrity error
and blocks cleanup. Retired IDs cannot restart or recreate their folder. Unknown actual models stay
unknown; final answers keep the 64 KiB cap and truncation flag.
`list` reports damaged records individually so healthy rows remain visible; mutating workflows
and cleanup continue to require a fully readable dependency inventory.

This reduces original storage, without setting a global storage ceiling. Compact records and their
ownership/journal evidence, routing ledger, gates, closures and resource receipts still accumulate.
It removes neither worktrees nor provider session caches and installs no scheduler.

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

Before a release, run `node orch/tools/release-scan.mjs`: it scans exactly the files git would commit
(`git ls-files --cached --others --exclude-standard`; git-ignored files such as `orch.config.json` or
`orch/.state/` are not scanned) for personal data, machine-specific paths, private ids and secret
patterns (exit 0 = clean). Outside a git work tree it falls back to walking the whole directory and says so.

## License

MIT, see `LICENSE`. Third-party notices: `orch/THIRD_PARTY.md`.
