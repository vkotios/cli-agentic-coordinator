# Worker CLI guide

How `orch` launches, watches and traps each supported worker CLI on Windows, and the quirks that
shaped it. Every quirk carries the CLI version it was observed on. CLIs change quickly: re-check a
quirk after upgrading, and record new ones here.

Legend: **verified** = observed on the stated version on Windows 11 with Node 24.
**unverified** = from documentation or research, not confirmed by a run.

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
- An `agent=compaction` step on a 27B model cost about 16 minutes and lost context (verified). Treat it
  as "task too big for this model", not as progress.
- A local gateway usually serves **one model at a time**: never run two local workers at once (orch's
  `local` lane enforces this machine-wide), batch slices per model, and set opencode's `small_model` to the
  same model as the agent (a different one forces a reload).
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

- Observed on **0.154.0**.
- Launch: `codex.exe exec --cd <worktree> --sandbox workspace-write --json -m <model>
  -c model_reasoning_effort=<e> -` with the prompt on stdin; reviews use `--sandbox read-only`.
  Windows sandbox behaviour itself is unverified.
- **Always pin the model** (verified): an unpinned launch silently uses the model in
  `~/.codex/config.toml`. orch requires `--model` and passes the effort explicitly on every launch, because
  a user config can carry conflicting values. Models marked `requires_permission` in the roster are never
  proposed by `orch pick`, and `orch run` needs `--owner-approved-model` for them.
- `--json` puts incremental JSONL events on stdout: a good heartbeat (verified). With `--json`, codex
  writes **nothing** on stderr, so the `model:` header is missing (verified); orch then reads this run's own
  session rollout under `$CODEX_HOME/sessions` (or `~/.codex/sessions`), bound by thread id and working
  directory, and records `unknown` when the binding is ambiguous.
- **Quota signature** (verified): exit 1, `{"type":"error"}` / `{"type":"turn.failed"}` with a message
  starting `You've hit your usage limit.` plus a reset time. Recorded as `blocked`, not as a model failure.
- Launched through a PowerShell 5.1 pipeline, codex's stderr is wrapped as `NativeCommandError` records
  and written UTF-16 (verified, cosmetic). Launch from Node to avoid it.
- codex reads `AGENTS.md` natively.

## copilot (GitHub Copilot CLI)

- No orch adapter yet: the guard denies direct `copilot -p` launches, and `orch run` cannot start it.
- Observed on **1.0.86**: a Microsoft Store install lives under
  `%LOCALAPPDATA%\GitHubCopilotCLI\copilot.exe` and may need a new shell before it is on `PATH`.
- Flags seen in `--help` (not run): `-p`, `--no-ask-user`, `--silent`, `--output-format json`, `--model`,
  `--max-ai-credits`, `--usage-output-file`, `--log-dir`, `--allow-tool`, `--deny-tool`.
- Never script inline completions (against GitHub's acceptable-use terms).

## Claude escalation reviewers

- The subagents `escalation-reviewer` (Sonnet) and `escalation-reviewer-opus` (Opus) are read-only
  (Read, Grep, Glob) and use `templates/review-prompt.md`. They run inside Claude Code, not through orch,
  and only under `ORCHESTRATOR.md` section 6.
