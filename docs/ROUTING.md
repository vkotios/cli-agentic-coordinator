# Task-fit routing

The optional deterministic router uses explicit task requirements and qualified execution
profiles. It is disabled unless `--routing-policy`, `ORCH_ROUTING_POLICY` or private config
`routingPolicy` selects a file. With it disabled, existing roster/quota routing remains usable.
Installing orch or copying the disabled example does not qualify or enable models.

Start with [routing.config.example.json](../routing.config.example.json) and
[task.example.json](../task.example.json). Keep your policy, account references, tasks and
evidence in private storage. `--task` names a JSON file; MCP uses the same options.

A profile binds an exact model, existing harness adapter/version, worker or reviewer role,
account, and local/subscription billing. An adapter must already support launches; telemetry
coverage alone does not supply an adapter. The account ID of a subscription profile must match
its P08 quota pool. The actual authenticated launch profile must use that account; the router
does not discover or switch credentials, verify the installed version, change reasoning/tool
settings, enable overages or select API billing. Its version/tools/context declarations must
describe the configuration you qualified, rather than a model's advertised capabilities.
Optional `launch` declares `agent`, `effort` and ordered extra `flags` (default null/null/empty).
Pass matching launch options explicitly; a changed selector refuses the bound profile rather
than inheriting its qualification. Global CLI settings still require owner validation.
Distinct account profiles behind the same model/harness/role cannot be selected unambiguously
by current adapters, so those duplicate execution routes are rejected.

Qualification is an explicit owner declaration with an evidence reference. Availability must
be available and checked within positive `availabilityMaxAgeMinutes` (at most 10080 minutes); unknown, stale
or future timestamps are excluded. The router does not probe providers on its own. Normal
selection requires qualified profiles. Explicit `--routing-mode qualification` permits a
trial/unqualified profile through task-fit checks; it does not enable disabled profiles or
relax permissions, independence, account, quota or scope rules. Record trial results before
changing a qualification declaration. No included example claims model suitability.

Task complexity (`C0`–`C4`) is separate from slice size (`XS`, `S`, `M`). Requirements include
type, risk, context tokens, tools, modalities and an explicit capability group. A class label
alone does not prove equal capability. Supported types and minimum classes are:

| Types | Minimum class |
|---|---|
| format | C0 |
| triage | C1 |
| helper, integration, review | C2 |
| feature, refactor, visual, build, migration, auth | C3 |
| race, architecture | C4 |

Migration, auth, race and architecture are always critical; callers cannot lower their risk.
Critical reviews need C4 support and a different known roster family, as well as a different
canonical model. Local models retain the XS/S limit. C0 returns `action-required`: there is
no automatic shell/tool executor or unrecorded model launch in this router.

```sh
orch pick --workload implement --size S --routing-policy private/routing.json \
  --task private/task.json --json
orch run --cli opencode --model localai/chosen-model --dir worktree --handoff handoff.md \
  --routing-policy private/routing.json --task private/task.json --profile chosen-profile
```

`review` accepts these routing options too; `pick --workload review` still needs `--for-run`.
Enabled policy requires a task on each selection/launch and an exact profile on launches.
The task supplies size/capability; conflicting explicit flags are refused. Subscription routes
require configured, compatible [quota policy](QUOTA.md).
Under enabled quota policy, local profiles also require an explicit matching `localRoutes`
declaration; task qualification alone does not opt them out of the quota policy's route checks.
Cached selection does not refresh telemetry; use `pick --refresh` for bounded collection.
Launch rechecks the fixed profile and
P08 atomically refreshes/rechecks/reserves subscription headroom before adapter preflight.
A refused direct launch never silently changes the selected profile or transfers a controller.

Selection first preserves roster workload/size/permission/reviewer/failure exclusions, then
filters for task-specific fit, qualification and availability. Review family preference remains
ahead of pacing, with critical independence mandatory. Quota distribution applies only among
the remaining acceptable routes, preserving controller/review/retry reserves. Owner `cost` or
`latency` preference breaks quota ties; default `rotation` preserves existing exploration.
Cost/latency ranks (0–100, lower preferred) are declared tie preferences, not billing estimates
or measured performance scores. Pacing and reserves remain native-unit P08 forecasts.

JSON reports the selected profile, policy/catalog versions, qualification evidence, task,
candidate exclusions and quota window decisions. Outcomes distinguish `no-eligible-route`,
`availability-unknown`, `quota-deferred` and `action-required`; null selection returns exit 3.
Launch refusals report `routing-deferred` (exit 2). Run records retain compact routing provenance
after metadata retirement. Running jobs and existing controller claims are unchanged.

Jev suggestions, automatic catalog refresh and new harness adapters are separate features.
