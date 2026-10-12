# Resumable setup conversation

`orch setup` records onboarding choices for Claude Code, Codex, OpenCode or Vibe.
It returns one structured question at a time. A controlling harness can ask the
user the question and submit their answer, or a terminal user can edit an answer
file. MCP tools never prompt on stdin.

The question flow produces **intent only**. A separate exact-preview approval
can apply private configuration and optionally adopt controller instructions.
Setup does not install a CLI, log in, read credentials, launch a model, purge
existing records, enroll historical data or install a scheduler.

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
an apply command. Use the separate preview/apply stage below to make supported
configuration choices effective. Reading the proposal leaves owner files unchanged.

MCP exposes the same conversation as `setup_start`, `setup_status`, `setup_answer`
and `setup_proposal`, with the same explicit session and answer-file arguments.
The common MCP state root does not change the setup session's lock or storage.

## Preview and explicitly apply

Choose a private runtime configuration file outside the target repository and
session evidence, outside managed state and review directories. State,
review and session directories must not overlap. The preview writes only private
session evidence and returns the exact `previewHash` to approve.

```powershell
orch setup preview --session C:\private\orch-setup --config C:\private\repo-orch.json --adopt --json
```

`--adopt` selects the current controller's repository instructions, skills and
supported hooks/MCP entries. Existing owner instruction text is preserved and the
managed block is appended. `--update` requires `--adopt` and refreshes only unchanged
owned adoption payloads. Existing conflicting or stale adoption items block setup.
Global registration commands are never executed.

Inspect `configChanges`, `stateChanges`, adoption items, conflicts and per-role
readiness. Existing configuration keys and unrelated state settings are preserved;
different existing settings are conflicts, even if a new answer requests them.
Resolve reconfiguration separately and preview again. There is no force overwrite.
Disabled owner-roster routes and explicit permission requirements remain blocked;
`permission: "allowed"` is a preference and grants no model access.

Apply supports the chosen `stateRoot`, `reviewRoot`, optional `usageConfig` reference
and `setupPreferences`. Usage configuration is not opened or executed. Explicitly
enabled retention maps transcript days to both successful/other transcript ages
and run days to both metadata ages, using bounded existing maintenance defaults.
Disabled retention is written explicitly. Existing different retention settings
block apply. This activates future maintenance policy only when this configuration
is selected; setup itself performs no collection, deletion or legacy enrollment.

Routes and router choices remain preferences. Setup does not invent task capability
profiles, qualify models, change the roster or create a Jev policy. Complete those
separate policy/access checks before using deterministic task-fit routing or Jev.
The preview's `deferred` field explains these remaining steps.

Save the approval in a private JSON file:

```json
{"previewHash":"<exact hash returned by preview>","approve":true}
```

```powershell
orch setup apply --session C:\private\orch-setup --approval C:\private\setup-approval.json --json
orch setup receipt --session C:\private\orch-setup --preview <previewHash> --json
```

Apply rechecks the session, repository binding, configuration and adoption inputs.
A changed input requires a fresh preview and approval. Setup records an immutable
attempt before any target mutation. Multi-file apply can be partial: inspect the
receipt and completed writes, then preview the current files before continuing.
It does not roll back owner files. An interrupted attempt cannot reuse its old
approval. Completed replay verifies installed bytes and performs no writes;
later owner edits require a fresh preview. Each preview, attempt and receipt directory
is bounded to 64 entries, including retained temporary or unknown files. Inspect
uncertain evidence and create a new private session when full; setup never deletes
those files or takes over stale locks automatically.

Select the resulting private config explicitly through `ORCH_CONFIG` when running
orch. Setup does not modify environment variables or global configuration. Existing
environment overrides take precedence. Installed CLI discovery is the earlier
session observation; authentication, current model access and qualification remain
unchecked. MCP exposes `setup_preview`, `setup_apply` and `setup_receipt` with the
same implementation and explicit file arguments.
