# orchestrate - the shared body (Claude Code and Codex)

The why of every step: `{{KIT}}/ORCHESTRATOR.md`. Worker launch details: `{{KIT}}/docs/CLI_GUIDE.md`.
Below, `orch` means `node "{{KIT}}/orch/bin/orch.mjs"` (in the kit repo itself, `{{KIT}}` is the repo root).
The same commands exist as MCP tools of the `orch` server (`orch mcp`): run, status, result, log_tail,
cancel, wait_lane, claim, release, claims, worktree_create, worktree_list, scope, review, review_finish,
gate_record, gate_status, record, pick. `--by` is `claude-code` or `codex` (whoever you are).

Never start opencode / vibe / agy / codex exec / copilot -p yourself: the guard hook denies it. Never write
implementation code yourself. A guard or hook that blocks you is a stop condition.
The guard reads command TEXT: it stops the direct forms and the common wrappers, but it cannot see a launch
from a script file, an alias or function, or a variable set in an earlier command. It prevents accidents; it
is not a sandbox - the rule above is yours to keep, not the guard's.

## Sequence for one work package (WP) and one slice

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
   ScheduleWakeup fallback; Codex: periodic `orch status <id>`. A `suspected_stall` is advisory: inspect
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
13. **Release** - `orch release <WP> --by <you>`. Remove the slice worktree only through
    `orch worktree remove <id>` after the merge.
