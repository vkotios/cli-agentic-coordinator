# Subscription allocation and admission

Quota policy is optional and disabled unless `quotaPolicy` in the private orch config,
`ORCH_QUOTA_POLICY`, or `--quota-policy` selects a file. Existing usage telemetry and
ledger routing work without it. Every controller uses the same CLI/MCP service.

Configure account-bound subscription observations first ([usage setup](USAGE.md)), then
copy [the policy example](../quota.config.example.json) to private storage and replace
its illustrative rules. Its `usageConfig` path selects the telemetry configuration;
`stateRoot` is a **single shared quota store** used by every repository and controller
spending these accounts. Paths resolve relative to the policy file. Keep account
configuration, state, forecasts and routing decisions out of public commits.

Each policy pool names an existing usage pool. Windows declare their original unit,
controller/review/retry reserves and a low-headroom warning threshold. Each route binds
an exact existing usage binding, including role, harness and model, to an explicit
capability group and positive XS/S/M forecasts for every applicable window. A group
means the owner has qualified those routes for equivalent work; orch does not infer
ability from a model name or family. Telemetry support alone does not provide an orch
launch adapter. Controller bindings can still be monitored without a launch adapter.
For mixed rosters, optional `localRoutes` entries explicitly name `cli`, `model`, `role`
and `capability` for an unmetered local adapter. They spend no subscription quota and
remain available when cloud observations/shared reservation state are unavailable.
They still pass roster/reviewer checks and the existing serial lane guard. A cloud
adapter cannot be declared unmetered, and an unqualified local is never an automatic
capability downgrade. Installing policy does not infer local route declarations.
The selected launch profile must use the same subscription account as its telemetry
binding. Orch does not discover, switch or repair inference authentication.

Every applicable quota window must have a rule or an explicit `ignore` explanation.
Replace example ignores with actual blocking rules for session, weekly, monthly and
model-specific limits. Rules may have `models` scope; observations' model scopes also
apply. A different model/harness on one account shares the same pool. Duplicate billing
aliases are rejected; do not create separate stores to manufacture quota. Spend,
purchased-credit balances and local estimates are never included allowance. A reported
quota in credits is usable in its own unit even if its denominator is unknown.

```sh
orch quota --refresh --json
orch pick --workload implement --size S --capability scoped-coding --refresh --json
orch run --cli codex --model chosen-model --dir worktree --handoff handoff.md \
  --size S --capability scoped-coding
orch pick --workload review --size S --for-run RUN --capability scoped-review --json
orch review --run RUN --reviewer vibe --model other-model --prompt review.md \
  --size S --capability scoped-review --by CONTROLLER
```

MCP `quota`, `pick`, `run` and `review` accept the same options. Cached quota/pick reads
do not mutate anything; `--refresh` runs bounded telemetry helpers and can reconcile
finished holds. Inspect controller warnings at work-package start, before assignments,
at ordinary checkpoints and after results. Low controller headroom means save a durable
checkpoint/handoff; it does not transfer a claim or replace the controller.

Roster workload/size/permission rules, independent reviewers and failure exclusions
come first. Within eligible capability groups, allocation favors useful work in pools
behind their reset-cycle spending pace. For each blocking window, pacing deficit is
elapsed fraction of its reported cycle minus estimated consumed fraction (including
outstanding holds). The smallest deficit is the route's bottleneck. Review-family
preference remains ahead of pacing; existing rotation breaks ties. Missing reset,
duration or denominator means unknown pacing and a warning. If an eligible pool in the
preferred review-family tier is unpaced, existing rotation applies across that tier so
unknown cycle metadata does not starve a subscription with known headroom. No cycle or
capacity is invented. There are no jobs created simply
to spend unused quota.

Normal work leaves controller, review and retry reserves. Reviews can use review
reserve; `--quota-purpose retry` lets an explicitly authorized retry use retry reserve.
Controller reserve remains protected for child launches. All numbers are native-unit
**forecasts**, not measured consumption or hard billing caps; size/model/context can
change real consumption. Configure conservative forecasts and revise them from evidence.
Holds may temporarily double-count consumption already reported for an active run.

Unknown/stale/reset-stale, failed or incompatible telemetry defers that route. `pick`
explains every exclusion, window, forecast, reserve, hold and warning; if a qualified
alternative is usable, it proposes it. If none is usable, defer new launches. `run` and
`review` recheck the chosen route and reserve it atomically before adapter preflight or
keeper start. A direct refusal reports `quota-deferred` and directs the controller to
`pick`; it never silently changes the harness/model of an existing handoff. Running jobs
continue. Billing modes, overages, API fallback and controller claims are unchanged.

Reservations live in `quota/reservations.json` below the shared store, bounded to 256
holds and 256 KiB. A shared operation lock serializes admission across processes;
provider refresh happens before that lock. Forecasts remain held across crashes,
uncertain launches, resets and policy changes.
All controllers must agree on each pool's window, model scope and protected-reserve
contract. A differing contract defers that pool while earlier holds remain; changing
an ignore rule cannot hide a peer controller's unfinished consumption.
A definite pre-keeper launch failure releases its own hold. Otherwise release requires keeper completion/closed-stream
evidence (or an explicit keeper refusal before spawn), and fresh compatible telemetry
observed after completion. A terminal status alone is insufficient. Compact run evidence
retains the quota decision and forecast provenance.

Corrupt, linked, oversized or incompatible state defers admission instead of discarding
holds. An interrupted lock is never automatically taken over. Inspect the recorded run,
keeper and any remote activity before an operator repairs state; preserve evidence and
never kill unrelated processes or clear holds just because a timeout/reset elapsed.
No daemon or installed scheduled maintenance is needed. Enabling policy is an owner
configuration decision; installation does not activate it.
