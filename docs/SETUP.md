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

## Repeatable health checks

After applying setup, run:

```powershell
orch setup health --session C:\private\orch-setup --config C:\private\orch-runtime.json --json
```

MCP exposes `setup_health` with the same `session` and `config` arguments. Both
paths reread current files and executable locations rather than trusting the
initial discovery. They report configuration/retention drift, adoption gaps,
runtime environment overrides, optional routing/adviser/quota policy validation,
roster restrictions and cached subscription telemetry freshness by role.
An unselected configuration is reported explicitly; health does not set `ORCH_CONFIG`.
Executable discovery uses the currently effective runtime configuration and its
environment overrides, not an unselected candidate's executable settings. Policy
checks inspect the supplied candidate and report any environment override names.
Relative environment references resolve from the working directory; relative config
references resolve beside their configuration file. Supply the current private
roster through configuration or `ORCH_ROSTER`. Otherwise roster restrictions are
labeled historical and remain a missing qualification requirement. JSON key order
alone is not configuration drift. `--state-root` is refused: health checks the
session's recorded state location and reports conflicting runtime overrides.
Malformed inputs produce blocked findings with corrective steps; an unsafe path
or invalid session is refused. A successful command means the report was produced,
not that its checks passed: inspect `checks` and each route's `missing` list.

Health is read-only. It runs no harness, login or inference command, reads no
credential store or API key, starts no telemetry collector, and changes no files,
settings, permissions or reservations. Only existing normalized telemetry caches
are read; missing, stale or reset-stale values cannot imply current headroom.
Unknown configuration values and raw error details are excluded from the report.

Routing qualification is labeled as an owner policy declaration. Even a declared
qualified profile with fresh availability remains `installed-but-unqualified`
until authentication, exact model access and role operation are explicitly
verified. Matching fresh access receipts are reported as `subscription-observed`
and `verified`; they describe the recorded observation, not a new login check.
Controller operation is never inferred from child runs. `launchAllowed` is
always false: this diagnostic never grants launch authority or replaces the
normal routing/quota/adviser admission checks. Complete pinned Jev settings can
be validated, but key/provider admission remains unchecked and no paid call occurs.
Access is observed per harness/model/billing route. A controller sharing a verified
child route can show that access observation, while its controller operation stays
unqualified and still prevents controller runtime readiness.

Use health again after relocation, reconfiguration, login changes or model changes.
Resolve reported gaps explicitly; configuration changes still need a fresh setup
preview and approval. A live disposable qualification run is a separate action.

## Explicit access qualification

The first live smoke supports one selected Codex subscription worker and one
selected Vibe subscription reviewer (either harness can take either role).
Other harnesses and billing modes remain unqualified by this smoke. Choose
different canonical models, then write a private request:

```json
{"worker":0,"reviewer":0,"maxAgeSeconds":3600}
```

```powershell
orch setup smoke --session C:\private\orch-setup --config C:\private\orch-runtime.json --request C:\private\smoke.json --json
```

This creates an immutable offer, performs no model call, and changes no owner
repository. It binds the completed session/configuration, selected routes,
current roster, executable bytes and role instructions. Inspect its routes,
private resource paths and bounds before approving. Approval is per offer and
role; write `{"offerHash":"<returned hash>","approve":true,"role":"worker"}`
to a private file, then run:

```powershell
orch setup probe --session C:\private\orch-setup --request C:\private\approved-probe.json --json
```

That exact offer-and-role approval is also the one-run owner model approval used
by `orch run`. Routes marked `ask` and canonical roster models marked
`requires_permission` still need this approval for each probe. Their preferences
and roster flags remain unchanged; the receipt grants no future model permission.

The probe uses normal orch supervision in a new owned Git fixture. Inherited
API-key/auth-token and base-URL/API-base override families are removed from its
child environment, along with orch overrides and Node injection options.
Codex must report a ChatGPT subscription login; Vibe uses saved native sign-in
and refuses API material in its profile dotenv file. No global login/configuration
is changed. Each role has one durable launch attempt and no automatic retry.
If a launch response is lost, inspect the retained state and attempt; a repeated
probe never starts a replacement job. Disabled roster routes remain disabled.
Subscription-login refusals are recorded as `refused`; transport, admission or
identity uncertainty remains `uncertain`. Neither can automatically retry the
same offer/role. An expired unused offer creates no trial fixture.
Configured routing/quota/adviser policies are not silently bypassed: such setups
must use their admitted task path rather than this isolated access smoke.

Inspect the returned worker run through normal `status`/`result` with the offered
state root. After successful exact-model worker proof, approve the same offer
with `role:"reviewer"` and run the probe again. The reviewer uses the existing
detached read-only review machinery. Both models must read a private challenge
from the fixture and return their role-specific response; the challenge is not
supplied in their prompt.
The random fixture directory ID is independent of the challenge, so working
directory metadata cannot reveal the value the models must read.

After the reviewer stops, write `{"offerHash":"<returned hash>"}` and run:

```powershell
orch setup qualify --session C:\private\orch-setup --request C:\private\capture.json --json
orch setup qualification --session C:\private\orch-setup --config C:\private\orch-runtime.json --json
```

Qualify invokes the existing review finalizer without another model call. Active,
failed, substituted or unknown-model runs, changed source, unclean containment or
unremoved review resources cannot produce a successful receipt. The immutable
private receipt binds the full source evidence inventory. Reuse rereads it, the
run/review proofs and unchanged fixture; changed evidence or expired observations
fall back to unqualified. Captured observations can survive unrelated runtime
settings or complete policy references added afterward: health validates those
policies separately. Selected routes, billing, session/resource locations, current
roster, executable bindings and role instructions must still match. Before launch
and initial capture, the offer's complete config bytes remain an exact approval
binding. Use a fresh offer for a new explicit trial. At most
16 offers are retained per session. No retention or maintenance scheduler is enabled.
When all recorded observations have expired, the status summary is `expired`.
Vibe proof also requires the exact assigned alias. A fallback warning involving
that alias, an unknown source or substitution refuses proof. A startup warning
about a different saved-profile alias is retained in the source record and counted
as `otherProfileWarnings`; it does not erase exact assigned-model evidence.

The review worktree is removed by its registered-resource cleanup. The owned
source anchor and run evidence are intentionally retained for receipt validation,
with a reason and explicit disposal/revisit step. If qualification fails, inspect
the attempt/run/review state; finalize an already-stopped review with the existing
review finish command and preserve uncertain resources. No automatic kill, purge,
branch deletion or replacement model call occurs.

MCP exposes `setup_smoke`, `setup_probe`, `setup_qualify` and
`setup_qualification` with the same file-based arguments. Health consumes fresh
matching proof, but keeps task capability, roster permissions, configuration,
adoption and usage requirements separate. `runtime-ready` requires those
requirements too, and still grants no launch permission. A read-only access smoke
does not qualify a model for coding tasks or prove controller orchestration.
