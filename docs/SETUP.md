# Resumable setup conversation

`orch setup` records onboarding choices for Claude Code, Codex, OpenCode or Vibe.
It returns one structured question at a time. A controlling harness can ask the
user the question and submit their answer, or a terminal user can edit an answer
file. MCP tools never prompt on stdin.

This first setup flow produces **intent only**. It does not apply configuration,
adopt a repository, install a CLI, log in, read credentials, launch a model,
activate retention or install a scheduler. Existing manual configuration and
`orch adopt --dry-run` remain available separately.

## Start and resume

Use an existing Git repository and an explicit private session directory outside
that repository. Keep the directory out of every public commit and restrict its
access to your account: it contains local paths and your chosen models. Setup
does not grant new permissions or change directory ACLs.

```powershell
orch setup start --repo C:\path\to\your-repo --harness codex --session C:\private\orch-setup --json
orch setup status --session C:\private\orch-setup --json
```

`start` detects executable availability with bounded local path checks. It does
not execute the harnesses or verify authentication, model access or orchestration
ability. Installed routes remain `installed-but-unqualified`; missing executables
are `blocked`. Generic catalogue choices are suggestions, never enabled or
qualified models. The shipped generic catalogue is read by default; `--catalog <JSON>`
selects another explicitly supplied catalogue. An owner `--roster <JSON>` is read
only when explicitly supplied. Owner roster permission requirements and disabled
choices remain visible; the roster is not edited.

Rerunning `start` with the same repository, controlling harness and session resumes
at the next unanswered question. It preserves discovery and accepted answers.
Omit `--catalog` and `--roster` when resuming; repeating those source options is
refused so discovery cannot silently change. New input sources require a new session.
A different repository or harness,
replaced repository identity, linked path or corrupt record is refused.

## Answer the questions

Each response includes `revision`, `nextQuestion.id`, a prompt and an answer
schema. Save a private JSON file with those exact revision/question values and
the user's answer. For example, the first answer can be:

```json
{
  "expectedRevision": 0,
  "questionId": "routes",
  "answer": {
    "controller": {"harness": "codex", "model": "example-controller", "billing": "subscription", "permission": "ask"},
    "workers": [{"harness": "vibe", "model": "example-coder", "billing": "subscription", "permission": "ask"}],
    "reviewers": [{"harness": "codex", "model": "example-reviewer", "billing": "subscription", "permission": "ask"}]
  }
}
```

Replace the example models with exact selectors you can use. The controller must
match the harness selected at start. Worker/reviewer choices use existing launch
adapters: Codex, OpenCode, Vibe or agy. Merely selecting a model, billing mode or
`permission: "allowed"` does not authorize or launch it. Review independence,
actual access and qualification still need verification before real work.

```powershell
orch setup answer --session C:\private\orch-setup --answers C:\private\answer.json --json
```

Submit the next answer using the returned revision and question ID:

| Question | Accepted choices |
|---|---|
| `routes` | Exact controller, worker and reviewer harness/model/billing/permission choices. |
| `router` | `{"mode":"deterministic"}`, or `jev-shadow` / `jev-assist` with `keyEnv` and a positive `budgetUsd` at most 10. The variable name is a reference; never submit a key. |
| `usage` | `{"enabled":false}`, or `{"enabled":true,"configFile":"C:\\private\\usage.json"}`. This records a reference and does not read account telemetry. |
| `resources` | Absolute private `stateRoot` and distinct `reviewRoot` outside the target repo, plus `"cleanup":"retain-unmerged"`. Finalization remains mandatory and uncertain, dirty or unmerged work is preserved. |
| `retention` | `{"enabled":false}`, or enabled with `mode` (`manual` / `on-use`), `transcriptDays` and `runDays`, each 1–3650. These are preferences, not an activated policy. |

Answers are immutable and accepted under one session lock. A stale revision or
concurrent losing submission cannot overwrite progress. Read status before
retrying. There are five bounded answer records, each at most 64 KiB, chained to
the session header. Status and proposal are read-only. Keep uncertain records for
inspection; the flow does not promise recovery from a power loss or remove stale
locks automatically. To revise earlier choices, create a new private session.

## Inspect the completed intent

```powershell
orch setup proposal --session C:\private\orch-setup --json
```

After all five answers, the proposal contains `intentOnly: true`,
`applyAvailable: false`, `activation: false`, the accepted choices and readiness
for the selected routes. It is not a configuration file and cannot be passed to
an apply command. A separate preview/apply onboarding stage is still required to
make these choices effective. Existing owner files remain unchanged.

MCP exposes the same conversation as `setup_start`, `setup_status`, `setup_answer`
and `setup_proposal`, with the same explicit session and answer-file arguments.
The common MCP state root does not change the setup session's lock or storage.
