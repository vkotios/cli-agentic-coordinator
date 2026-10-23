# Worker CLI guide

How `orch` launches, watches and traps each supported worker CLI on Windows, and the quirks that
shaped it. Every quirk carries the CLI version it was observed on. CLIs change quickly: re-check a
quirk after upgrading, and record new ones here.

Legend: **verified** = observed on the stated version on Windows 11 with Node 24.
**unverified** = from documentation or research, not confirmed by a run.

Helper ancestry is an observation, not an OS sandbox. Parent PIDs can be reused,
so the monitor checks creation order against the recorded worker identity and,
after exit, its keeper-recorded lifetime. Older unrelated branches are excluded.
Missing identities or timestamps remain unknown: status distinguishes uncertain
helper candidates from verified live escapes, and an unknown helper audit cannot
qualify a route or authorize retirement. Helpers are never killed by monitoring
and never affect lane admission. Explicit cancellation retains its documented
identity-checked tree-termination behaviour.

Common to all workers:

- Workers are started only through `orch run` / `orch review`. Never start one by hand: the guard hook
  denies the direct forms, and a hand-started worker has no record, no lane and no monitor.
- Each run happens in a dedicated git worktree (a throwaway **detached** worktree for reviews).
- The prompt is delivered from a file (stdin handle or argv, per CLI), never typed into a shell.
- Every worker must be **installed and logged in by you** before orch can use it. orch never installs,
  updates or authenticates a CLI.
- Argument vectors are built in Node with `shell: false`. Never launch a worker through a shell command
  string: Git Bash (MSYS) rewrites switches such as `/d /s /c` into paths, and PowerShell 5.1 has no `&&`.

## How orch finds each CLI

| CLI | Override | Lookup order when no override is set |
|---|---|---|
| opencode | `ORCH_OPENCODE_EXE` or `exe.opencode` in `orch.config.json` | `opencode.exe` on `PATH`; then the npm global prefix (every `PATH` directory holding the `opencode.cmd` shim, `npm_config_prefix`, `%APPDATA%\npm`) + `node_modules\opencode-ai\bin\opencode.exe` |
| codex | `ORCH_CODEX_EXE` or `exe.codex` | `codex.exe` on `PATH` |
| agy | `ORCH_AGY_EXE` or `exe.agy` | `agy.exe` on `PATH` |
| vibe | `ORCH_VIBE_EXE` or `exe.vibe` | `vibe.exe` on `PATH`; then `%USERPROFILE%\.local\bin\vibe.exe` |

| copilot | `ORCH_COPILOT_EXE` or `exe.copilot` | `copilot.exe` on `PATH`; then `%LOCALAPPDATA%\GitHubCopilotCLI\copilot.exe` |
| muse | `ORCH_MUSE_EXE` or `exe.muse` | versioned native binary from `.muse-version` beside `muse.cmd`; automatic lookup skips unverified `muse.exe` wrappers |
| aider | `ORCH_AIDER_EXE` or `exe.aider` | `aider` (or `aider.exe`) on `PATH` |

A CLI that cannot be found is a clear `cli-not-found` error naming the override to set. The `.cmd`
shims npm installs are deliberately **not** accepted (see opencode below).

## opencode (local models through an OpenAI-compatible gateway)

- Observed on **1.18.31**.
- **orch spawns the real `opencode.exe` directly, never the `opencode.cmd` shim** (verified). With
  `cmd.exe` in the chain, killing the wrapper left the subtree it started running, so containment was
  lost. With the direct `.exe` the tree is `node -> opencode.exe`.
- Node 24 refuses to spawn a `.cmd` file with `shell: false` (`EINVAL`) (verified).
- **Never pass a prompt as argv through a `.cmd` shim** (verified): it was truncated at the first newline
  (5208 bytes became 74, exit 0, no error), `%VAR%` was expanded, and the command line capped near 8 KB.
- **opencode takes its project directory from the inherited `PWD` variable, not from the spawn
  directory** (verified: a worker wrote outside its worktree). orch passes `--dir <worktree>` **and**
  forces `PWD` in the child environment, then checks the `bootstrapping directory=` / session line in
  the run's own `stderr.log`.
- `--print-logs` is required: it puts the session-creation line and the progress lines into the run's
  own stderr, which is the heartbeat (verified). stdout carries only the final message, in one chunk at
  exit (verified), so it is useless as a heartbeat.
- Permissions in the opencode config must be `allow` / `deny` only: `ask` hangs a headless run (verified).
- On 1.18.31, `write`/`edit` grants match worktree-relative paths, although the tools accept absolute
  file paths (verified). A sibling inputs directory needs an edit grant such as `../inputs/*` as well
  as a scoped `external_directory` grant in the permission config; an absolute edit pattern does not
  authorize those writes.
- Declare custom provider model `limit.context` and `limit.output` to match the gateway. A controller
  on 1.18.31 with undeclared limits hit `ContextOverflowError` before delegation (verified).
  Declaring limits or enabling compaction alone does not prove recovery; confirm with a completed live run.
- An `agent=compaction` step on a 27B model cost about 16 minutes and lost context (verified). Treat it
  as "task too big for this model", not as progress.
- A local gateway usually serves **one model at a time**: never run two local workers at once (orch's
  `local` lane enforces this machine-wide), batch slices per model, and set opencode's `small_model` to the
  same model as the agent (a different one forces a reload).
- Adding `$schema` during native configuration loading changed the scoped controller config on
  1.18.31 and caused its integrity check to refuse MCP startup (verified). Generated controller
  profiles include `$schema` before hashing; a model-free native MCP connection then left the
  configuration unchanged.
- Scoped local controller profiles disable the built-in `title` agent. On 1.18.31 a background title
  request overlapped the main request; the main request hit HTTP 409 conflicts and internal retries
  (verified). A single outer CLI launch does not mean one inference request or no provider retries.
  Native agent listing verifies the disabled title profile; a completed trial is still required for
  controller qualification.
- Do not mix deprecated agent `tools` flags with the scoped controller permission allowlist on
  1.18.31. Its legacy normalization can append the wildcard denial after the MCP tool allowance
  and hide that tool (verified with native effective rules). Generated profiles use permission
  rules alone: default deny followed by the one approved MCP tool.
- A plugin that bootstraps a large skill set hung opencode on Windows (verified on 1.18.31). Keep worker
  agents lean: MCP off, a small skill list.
- Cancel: `taskkill /PID <recorded root> /T /F` removed the whole tree with no orphans, and the gateway
  served a new request a second later (verified). orch only ever kills a recorded, identity-checked pid,
  never by image name.
- Slow is normal for local models. Judge steps, not minutes.

## vibe (Mistral)

- Observed on **2.25.4**.
- Launch (verified): `vibe.exe -p --workdir <wt> --auto-approve --trust --max-turns N --max-price X
  --output streaming` with the prompt on stdin. `--max-turns`, `--max-price` and `--output` exist only in
  `-p` mode.
- **vibe decodes stdin as cp1252, not UTF-8** (verified): non-ASCII arrives as mojibake; ASCII is exact.
  orch refuses a non-ASCII handoff for vibe unless `--allow-non-ascii` is given.
- **vibe crashes on non-cp1252 output** (verified on 2.25.8): a model reply containing e.g. `→` (U+2192)
  killed runs with `'charmap' codec can't encode character` on stderr (exit 1), or ended them with exit 0
  mid-task and nothing edited. orch's vibe adapter therefore sets `PYTHONIOENCODING=utf-8` and
  `PYTHONUTF8=1` in the worker environment (verified: `A → B — C` printed, exit 0). If you start vibe
  yourself outside orch, set both variables too.
- **Session layout changed in 2.25.8** (verified): sessions live in `~/.vibe/logs/session/unified/<id>/`;
  `meta.json` has `working_directory` and `config: null`; the model actually used is
  `session_metadata.active_model` in the latest `generations/<n>/runtime-state.json`. The older
  `session_*/meta.json` layout is no longer written. orch reads both layouts and resolves the alias
  through the worktree's `.vibe/config.toml` (the `[[models]]` table orch wrote).
- `--output streaming` is NDJSON, one object per event about a second apart: a first-class heartbeat
  (verified).
- **Turn cap signature** (verified): exit 1, empty stdout (even with `--output json`), and stderr contains
  `<vibe_stop_event>Turn limit of N reached</vibe_stop_event>`. Hitting the cap prints no report.
- **There is no `--model` flag** (verified). The worktree's `.vibe/config.toml` must declare and select
  the model: top-level `active_model = "<alias>"` first, then a `[[models]]` block with `name`,
  `provider` and `alias`. An undeclared model **silently falls back** to the default. orch merges its
  declaration into that file and keeps every other key.
- The session `meta.json` records the alias, not the model; resolve it through `config.models[alias].name`.
  `config.routed_default_model` is vibe's routing default, **not** the model used (verified).
- Non-zero exits of commands the model runs count as failed tool calls and burn turns (verified): name
  the commands that may legitimately exit non-zero in the handoff.
- **A read-only prompt does not make vibe read-only** (verified on 2.25.4): a reviewer left its worktree,
  searched the whole drive and attempted `git commit`. Restrict tools with `--enabled-tools` (tool names
  seen in the stream: `read_file`, `bash`, `write_file`, `edit`; the exact list is unverified), always
  review in a throwaway detached worktree, and check `git status` / `git reflog` of the worktree **and** of
  the source repository afterwards. `orch review` does these checks.
- `system_prompt_id` is unreliable on Windows (unverified): paste role rules into the prompt.
- For an orchestrator, use the `vibe` claim identity consistently through claim, delegation,
  review and finish. Native instruction discovery and a complete controller lifecycle require
  separate qualification; claim support alone does not establish either.
- A headless controller needs a tool profile that can write its handoffs and reports. Enabling
  only `bash` and `read_file` is insufficient: file writes are denied, and shell redirection may
  request approval even when bash permission is `always` (observed on 2.26.0). Enable `write_file`
  with a path allowlist for the controller's input directory; keep implementation edits delegated
  to orch workers. A shell permission does not provide filesystem containment.
- On 2.26.0, `read_file` permission `always` still requests approval for files outside the
  workdir (verified). Grant the exact handoff/state paths explicitly. For nested paths, use Vibe's
  directory grants; an absolute `*` or `**` pattern does not recursively cover them.
  Shell variable expansion and file redirection can also request approval. Literal orch
  commands and scoped file tools avoid those unnecessary prompts.
- Verify the active account before a live launch. On 2.26.0, an inherited `MISTRAL_API_KEY` takes
  precedence over saved sign-in and can select an API account instead of a subscription (verified).
  When using saved subscription sign-in, discard an unintended inherited key in the child
  environment and confirm the account plan; changing the model config does not change billing.
- Review containment accepts an ignored adapter-written config only while its recorded hash
  still matches. A changed config or additional ignored output remains a containment breach;
  do not use blinding or a broad ignore exemption to hide it.
- On 2.26.0, `--max-price` uses token usage and configured model prices as a session stopping threshold
  (documented; live stopping behavior unverified).
  It does not establish the provider's billing mode or the remaining subscription allowance, and
  a turn can exceed the threshold before the next check. Select turn/token limits and quota
  handling appropriate to the configured account; do not classify every Vibe route as metered.

## agy (Gemini)

- Observed on **1.2.5**.
- Launch (verified): `agy.exe --model <model> --mode plan --dangerously-skip-permissions
  --print-timeout <t> --log-file <run dir>\agy.log -p <prompt>`, from a throwaway detached worktree only.
  The skip-permissions flag is required headless; allow-rules were ignored (upstream bug).
- **Never `--sandbox`** (verified): it hangs on the first shell command, and combined with the flag above
  it is bypassed anyway. orch refuses `--flag --sandbox`.
- The prompt goes on argv to the real `.exe`: direct `.exe` argv survived multi-line prompts of 32 000
  characters (verified). Windows caps a whole command line at 32 767 characters, so orch refuses a prompt
  that cannot fit rather than truncate it. stdin is an empty file, so the prompt is never delivered twice.
- Heartbeat: the per-run `--log-file`, **ignoring keepalive lines** (model-list and code-assist pings from
  `http_helpers.go`, token refresh from `browser.go`, `quota_manager`). `streamGenerateContent` requests
  are real activity. Dead signature (verified): an auto-approve line at step N, then only keepalives, then
  empty output.
- **Model attribution** (verified on 1.2.5): when the requested id is not in agy's local config it logs
  `Model ID <id> not in local config, defaulting to ...` / `Model resolved via default` and still logs
  `Resolving model <id>` afterwards. orch then records the model used as `unknown`, never the requested id.
  Find a model id agy really knows before its ledger rows mean anything.
- agy logged `Failed to resolve GeminiDir ".gemini": must be an absolute path` and fell back to its
  default directory (verified, harmless).
- **The workspace is a starting directory, not a fence** (verified): a reviewer started in a worktree
  listed a nearby real repository. Keep review worktrees under a neutral path (orch's review root), name
  the absolute path to review in the prompt, and check nearby repositories afterwards.
- It will not ask questions in this mode: the prompt must be self-contained.
- "Exit 0 with empty output" happens (upstream issue: print mode can return an empty success on large
  prompts, unverified) and is always treated as a failure.
- A third-party telemetry plugin hook broke tool calls on Windows (verified on 1.2.5). Keep such hooks
  disabled and re-check after every agy update.

## codex (implementer, reviewer, or alternative orchestrator)

- Observed on **0.154.0**; native Windows controller, implementer and reviewer roles also verified on
  **0.156.1**.
- Launch: `codex.exe exec --cd <worktree> --sandbox workspace-write --json -m <model>
  -c model_reasoning_effort=<e> -` with the prompt on stdin; reviews use `--sandbox read-only`.
  On 0.156.1, native session records confirmed `workspace-write` for implementation and `read-only`
  for review; the review worktree remained clean. Broader sandbox enforcement is not qualified here.
- **Native Windows needs a configured sandbox implementation** (verified on 0.156.1). Preserve the
  existing `[windows] sandbox` selection. With no selection, `--ignore-user-config` can leave a
  requested `workspace-write` session read-only. Check the effective native permissions before
  dispatch; a requested launch flag alone does not prove write access.
- **Controllers may need reviewed host access for orch supervision** (verified on 0.156.1). Inside
  the Windows sandbox, the real account lookup can fail with `uv_os_get_passwd returned ENOMEM`;
  orch then refuses to derive a lane identifier. Request per-command approved host execution for
  orch supervisor commands and protected Git operations when needed. Keep implementation and
  review sandboxes separate, preserve approval review, and stop on rejection. Do not replace the
  real account lookup with environment values or disable rules to get past this guard.
- **Always pin the model** (verified): an unpinned launch silently uses the model in
  `~/.codex/config.toml`. orch requires `--model` and passes the effort explicitly on every launch, because
  a user config can carry conflicting values. Models marked `requires_permission` in the roster are never
  proposed by `orch pick`, and `orch run` needs `--owner-approved-model` for them.
- `--json` puts incremental JSONL events on stdout: a good heartbeat (verified). With `--json`, the
  `model:` header is missing; stderr can still carry warnings (verified on 0.156.1). orch reads this run's own
  session rollout under `$CODEX_HOME/sessions` (or `~/.codex/sessions`), bound by thread id and working
  directory, and records `unknown` when the binding is ambiguous.
- **Quota signature** (verified): exit 1, `{"type":"error"}` / `{"type":"turn.failed"}` with a message
  starting `You've hit your usage limit.` plus a reset time. Recorded as `blocked`, not as a model failure.
- Launched through a PowerShell 5.1 pipeline, codex's stderr is wrapped as `NativeCommandError` records
  and written UTF-16 (verified, cosmetic). Launch from Node to avoid it.
- codex reads `AGENTS.md` natively.

## copilot (GitHub Copilot CLI)

- Worker and reviewer adapter: `orch run --cli copilot --model <selector>` and
  `orch review --reviewer copilot --model <selector>`. Direct worker `copilot -p`
  bypasses orch and is denied; an exact-approved scoped controller trial uses its own native runner.
- Observed on **1.0.86**: a Microsoft Store install lives under
  `%LOCALAPPDATA%\GitHubCopilotCLI\copilot.exe` and is a fallback when it is not yet on `PATH`.
- Launches the native executable directly with JSONL, a bounded prompt argument, empty stdin,
  explicit model, no updates/remote export and a per-run usage file. Shell metacharacters remain
  argument data; no command wrapper is used. Extra flags and custom agents are refused.
- Saved native GitHub authentication is used. BYOK/provider and GitHub-token environment overrides,
  including enterprise tokens and GitHub host/config-directory/API-URL redirects, are excluded
  from worker and reviewer child environments with case-insensitive name matching. Parent
  environment and saved authentication files are preserved. A sign-in available only through an
  excluded redirect may require signing in through the CLI's normal configuration location.
  Orch does not buy credits or change account/overage preferences. Subscription quotas and
  provider billing remain subject to the selected account's existing plan.
- Reviewer tools are restricted to `view`, `glob` and `grep`; implementation also permits file
  edits and shell tools. This is a tool restriction, not a filesystem sandbox. Existing detached
  review containment and cleanup checks remain authoritative.
- A pinned model is never silently replaced. `--model auto` is allowed only when explicitly
  requested and without `--effort`; Auto is excluded from exact-model task-fit profiles.
- Actual model attribution uses successful native model-call pairs and main-agent usage counters.
  A selected/default model or a subagent's model alone is not evidence. Ambiguity stays unknown.
- `--max-turns` and `--max-price` are refused: autopilot continuations and AI credits do not mean
  model turns or a dollar budget. Native usage metrics remain metadata until explicit retirement.
- Never script inline completions (against GitHub's acceptable-use terms).
- Scoped controller qualification uses only the owned `orch-controller_step` MCP
  tool, an explicit subscription selector, and native call/result evidence. Auto
  preserves the observed model separately from its selector. This profile does not
  grant general controller admission. Separate `orch adopt --harness copilot`
  wiring uses root `AGENTS.md` and project `.mcp.json`; native trust and custom-agent
  instruction opt-in remain owner checks. See [repository adoption](SETUP.md#copilot-and-muse-repository-adoption).

## muse (Meta Muse Code)

- Worker/reviewer adapter uses `muse exec` with JSONL, prompt file, explicit model and workspace.
  Select the real `.exe` with `ORCH_MUSE_EXE` / `exe.muse`, or let orch resolve the installed
  `.muse-version` marker beside `muse.cmd`. The updater/login launcher is never spawned.
- Saved device-code OAuth provenance at the official Meta endpoint is required. Environment
  API-key/base-URL overrides and raw transport tracing are excluded. No ordinary API key fallback,
  account change, subscription upgrade or credential write is performed. The provider verifies
  current subscription entitlement; local provenance alone does not prove current access.
- Workspace trust loads existing project rules for both roles. Review additionally disables
  shell execution and file writes. Web/reminder tools are disabled; native session worktrees and
  duplicate session logs are disabled. The detached review audit still checks containment.
- `--max-turns` maps to a positive `--max-model-steps`; `--max-price` is not supported.
- Model attribution binds the native `run.model.configured` fact to the same completed main run
  and Meta provider. It reports the runtime model, not independent backend model verification.
  Unknown or contradictory facts remain unknown. Final output comes only from completed runs.
- Extra CLI/config flags and custom agents are refused. Native stdout/stderr and compact orch
  records provide evidence; this worker adapter does not itself qualify a controller
  or task capability. A separately approved scoped controller trial uses the native
  `mcp__orch__controller_step` tool, the CLI's saved device sign-in location and
  bound runtime/tool evidence. Shell/writes and foreign personal context are disabled;
  other tool profiles remain unqualified. Separate `orch adopt --harness muse`
  preserves native fallback instructions and merges owned project MCP wiring,
  without trust grants or native launches. See [repository adoption](SETUP.md#copilot-and-muse-repository-adoption).

## aider (implementer)

- Worker adapter only: `orch run --cli aider --model <selector>`. Aider is a BYOK/API-key CLI: you
  install it and configure provider keys yourself; orch never touches credentials or billing.
- Verified once: aider 0.86.2, an OpenAI-compatible local gateway (`--model openai/<id>` with
  `OPENAI_API_BASE` / `OPENAI_API_KEY` in the environment), one small two-file edit. Other models,
  providers and larger tasks are **unverified**; the flag set comes from the official options reference.
- Credentials and the API base are read from aider's own environment; orch passes the parent
  environment through and never sets them.
- Headless one-shot launch: `--message-file <handoff>` delivers the prompt from a file (never argv),
  `--yes-always` for an unattended run, empty stdin so the prompt is never delivered twice.
- The model is always pinned with `--model`; aider's config default is never trusted. Extra flags
  that orch owns (prompt, model, git, verification, effort) are refused on `--flag`.
- git stays with orch: `--no-auto-commits` and `--no-dirty-commits` so the worker never commits
  inside the run worktree. `--no-auto-lint` / `--no-auto-test`: verification belongs to orch's
  review flow, not a hidden shell command.
- The reviewer role is refused: aider has no read-only confinement and applies edits under
  `--yes-always`. Use another CLI for `orch review`.
- Model attribution is unknown: one-shot output names no served model, so the record never claims
  the requested model as the model used.
- Streaming stays on; captured stdout is the heartbeat and the final message. `--no-pretty` keeps
  ANSI escapes out of the record. Reasoning models print a THINKING block before an ANSWER block;
  the final message keeps the ANSWER block only (the full output stays in the stdout log).
- Aider writes scratch files into the git root, and the scope guard counts untracked files. The chat,
  input and LLM history files are therefore redirected into the run folder (`aider-chat-history.md`,
  `aider-input-history`, `aider-llm-history.log`). The repo-map cache `.aider.tags.cache.v4/` cannot
  be relocated, so a run with an allowlist (`--allow` or an `ALLOW:` block) turns the map off
  (`--map-tokens 0`) and passes each allowed file with `--file=<path>`: aider sees and edits exactly
  the allowed files. A run with no allowlist has no scope check, keeps the default repo map and leaves
  `.aider.tags.cache.v4/` in the worktree. Allowlist entries must be exact repo-relative file paths.

## Claude escalation reviewers

- The subagents `escalation-reviewer` (Sonnet) and `escalation-reviewer-opus` (Opus) are read-only
  (Read, Grep, Glob) and use `templates/review-prompt.md`. They run inside Claude Code, not through orch,
  and only under `ORCHESTRATOR.md` section 6.

## Queue driver (unattended backlog runs over orch)

- `orch/tools/queue-driver.mjs` runs a plan folder's task backlog end to end: one `orch run --cli vibe`
  per task, `orch status` polling, one repair round on failed checks, a commit per task, everything
  appended to `<plan>/RUNLOG.md`.
- Generic tool: worktree, plan folder, model, checks commands and forbidden paths are all options
  (`--wt`, `--plan`, `--checks`, `--model`, `--cli`, `--forbid`, `--stall-minutes`, `--from`, `--only`,
  `--dry-run`). The model has no built-in default (`--model`, `ORCH_QUEUE_MODEL` or `queueDriver.model`).
  Manual and examples: `docs/QUEUE_DRIVER.md`; unit tests: `orch/test/queuedriver.test.mjs`.
- It deletes `MISTRAL_API_KEY` before starting (with it set, vibe bills that API key instead of the CLI
  plan's allowance) and stops the whole queue on a model fallback, a forbidden path, a stall, a task with
  no changes, a failed commit, or two consecutive tasks with failing checks.

Muse installation markers accept `major.minor.patch-Rrevision[.revision]` (case-insensitive R). Other formats require an explicit native executable override; orch does not guess or run the updater.

Native repository-controller evidence uses the complete structured tool result, including its exact offer/request proof. Copilot display text can be joined or truncated; it is not a substitute for its separate structured result. Text-only transports receive the same complete structured data without a duplicate human-readable output. A malformed structured channel is refused, even when display text looks valid.

Read-only access trial reviewers use the exact review root recorded in their offer. A default directory cannot substitute for the owned trial directory.
