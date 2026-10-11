# orchestrate - the shared controller workflow

Activate only when the user asks you to coordinate work with orch. An orch-launched implementer
or reviewer follows its role packet, not this controller workflow. Keep owner/project rules in force.

The why of every step: `{{KIT}}/ORCHESTRATOR.md`. Worker launch details: `{{KIT}}/docs/CLI_GUIDE.md`.
Below, `orch` means `node "{{KIT}}/orch/bin/orch.mjs"` (in the kit repo itself, `{{KIT}}` is the repo root).
The same commands exist as MCP tools of the `orch` server (`orch mcp`): run, status, result, log_tail,
cancel, wait_lane, claim, release, claims, worktree_create, worktree_list, scope, review, review_finish,
gate_record, gate_status, record, pick, cleanup, finish, usage. Supported claim identities are `claude-code`, `codex`,
`opencode`, `vibe`, and `owner`; the same identity must hold and release the claim. Controller readiness
requires live qualification with the adopted repository's configured models and tool permissions;
preparing instructions alone does not establish end-to-end controller support.

Never start opencode / vibe / agy / codex exec / copilot -p yourself: use `orch run` or `orch review`.
The guard hook denies direct launches only when the installed host invokes it. Never write
implementation code yourself. A guard or hook that blocks you is a stop condition.
The guard reads command TEXT: it stops the direct forms and the common wrappers, but it cannot see a launch
from a script file, an alias or function, or a variable set in an earlier command. It prevents accidents; it
is not a sandbox - the rule above is yours to keep, not the guard's.

## Sequence for one work package (WP) and one slice

When subscription usage is configured, refresh with `orch usage --refresh --json` (MCP `usage`,
`refresh: true`) at WP start, before new assignments, during normal status checkpoints and after
results. Include your controller pool and worker/reviewer pools; aliases of one subscription share
the same observation. Respect the collector cooldown and keep unknown, stale and reset-stale values
as uncertainty. Usage telemetry does not change admission, billing or any running job.

1. **Claim** - `orch claim <WP> --by <you> --note "<what>"`. Exit 3 = someone else holds it: stop.
2. **Pick** - `orch pick --workload implement --size XS|S|M`. Use the proposal unless you record a reason.
3. **Worktree** - `orch worktree create --repo <repo> --wp <WP> --slice <s> --by <you>`
   (prints the worktree path, branch `orch/<wp>/<s>` and the baseline commit).
4. **Handoff** - fill `{{KIT}}/templates/handoff.md` into a file outside the worktree. Scope, anchors,
   contracts, machine-checkable acceptance; an `ALLOW:` block listing every path the worker may change.
5. **Run** - `orch run --cli <cli> --model <id> --dir <worktree> --handoff <file> --wp <WP> --slice <s>
   --by <you> --size <XS|S|M> [--allow <path>]...`. Exit 3 = lane busy (nothing started):
   `orch wait-lane --lane local --timeout 60`, then retry. Never two local runs at once.
6. **Monitor** - within 90 s `orch status <id>` must show a live worker and first activity; if not, it is a
   failed launch: read `orch log <id> --tail 80`, fix the cause, record it. Then keep checking
   (cloud every 3-5 min, local every 5-10 min) - Claude Code: a Monitor on the run's stderr log plus a
   ScheduleWakeup fallback; Codex, OpenCode and Vibe: periodic `orch status <id>`. Qualify this monitoring
   ability in the controller's configured tool profile. A `suspected_stall` is advisory: inspect
   first; `orch cancel <id>` only with a stated reason.
7. **Result + scope** - `orch result <id>`; then `orch scope <id>` (fail = a path outside the allowlist:
   the run goes back, it never reaches review).
8. **Verify** - run the repository's own checks yourself in the worktree and read the full diff. Never trust
   the worker's report. Commit the slice in the worktree when it passes.
9. **Review** - `orch pick --workload review --size <s> --for-run <id>`, then fill
   `{{KIT}}/templates/review-prompt.md` (use `{{WORKTREE}}` for the path) and
   `orch review --run <id> --ref <commit> --reviewer <cli> --model <other model> --prompt <file> --by <you>`
   (with `--no-wait` it returns at launch; then, after the reviewer run ended,
   `orch review --finish <review-id> --by <you>`. MCP: `review` always returns at launch; call
   `review_finish` with `review_id=<review-id>` and `by=<you>` - `by` is required for a work package).
   The reviewer is never the implementer's model (orch refuses it).
10. **Grade + gate** - grade every finding High/Medium/Low, in-scope or not, confirmed/refuted/unverifiable
    (confirm every High against the code), write them as JSON and
    `orch gate record --wp <WP> --slice <s> --round <n> --findings <file> --verification pass|fail
    --scope-run <id> --by <you>`. `orch gate status --wp <WP> --slice <s>` shows the decision.
11. **Fix round or accept** - `another-round`: a corrected handoff to a worker (step 5), never your own
    edit. `stop-round-cap` / `escalate-design`: stop and go to the owner. `converged`: merge (you alone).
12. **Record** - `orch record <run-id> --disposition accepted|accepted-with-fixes|rejected|blocked|inconclusive-timeout|failed-launch
    --attempt <n> --notes "<quirks>"` for every run (implementer and reviewer). File every follow-up
    (TASKS.md / docs/OPEN_QUESTIONS.md / `orch record --notes`) before closing.
13. **Cleanup and finish** - preview `orch cleanup --wp <WP> --dry-run`, then
    `orch finish <WP> --by <you>`. It requires recorded dispositions and completed reviews;
    accepted implementation needs a converged gate and a clean independent review. Every resource
    has an explicit cleanup result. To keep resources, pass `--retain <decisions.json>` containing
    `[{"id":"<resource-id>","reason":"<why>","revisit":"<when to reconsider>"}]`.
    Finish records the result before releasing the claim. `cleanup-pending` needs an explicit retry
    of `finish` or `cleanup --wp <WP> --apply --by <you>`; findings are not rewritten.
    Active/uncertain processes block closure. Dirty, ignored, unmerged and incident work is preserved.
    Audit prompt packages are retained for the configured evidence-retention policy. Legacy resources
    without confirmed ownership require inspection. `release` remains an explicit operator action;
    it does not replace normal finalization or clean resources.
