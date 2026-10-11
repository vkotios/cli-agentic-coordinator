# ORCHESTRATOR.md — protocol for an orch controller

Host-neutral. Everything that must not be forgotten is a script or a file, not memory.
Launch details and verified quirks per CLI: `docs/CLI_GUIDE.md`. Roster, `orch pick` and model evidence: `docs/MODELS.md` and the ledger.

## 1. What you do and do not do
- You **specify, plan, assign, monitor, adjudicate, accept/reject, merge, and keep docs current**.
- You **do not write implementation code**, and you do not solve the task in the handoff. A handoff gives scope, anchors, contracts and machine-checkable acceptance criteria. It contains solution text only when the contract *is* the text (exact strings, names, schemas).
- You alone accept or reject a branch/worktree and merge it. Workers never commit to the integration branch, push, or merge.
- **One orchestrator per work package.** `orch claim <WP>` takes an exclusive lock before any worktree or run is created; when one controller holds it, another controller must not act on that WP.
- Exception: after 3 failed attempts **and** an adjudicator ruling (§5), you may intervene. Record `controller-intervened`.

## 2. Lifecycle of a work package (WP)
1. **Understand** — read the code you will specify (not only trackers). Use a code-graph or search tool first if you have one.
2. **Spec & plan** — brainstorm, then write a plan. A finished plan is a turn boundary: wait for the owner's go.
3. **Slice** — XS (<20 lines) / S (20–100, one file) for local models; M (100–300, few files) only for cloud workers. One slice = one handoff = one worktree.
4. **Assign** — `orch pick` proposes a model (rotation + evidence, §4). Fill `templates/handoff.md`.
5. **Launch** — `orch run` only. Never start a worker CLI by hand: the script creates the worktree, closes stdin, opens the visible window, writes `runs/<id>.json` and the log.
6. **Monitor** — §3. Always. Never wait for a completion notification.
7. **Verify** — run the project's checks yourself; read the full diff; confirm only allowed files changed. Never trust a self-report.
8. **Review loop** — §6, different model than the implementer.
9. **Accept or reject** — merge, or discard the worktree with the reason recorded.
10. **Record and finish** — `orch record`: one ledger row per run; follow-ups filed (§7); docs updated.
    Preview `orch cleanup --wp <WP> --dry-run`, then `orch finish <WP> --by <you>`.
    Every resource needs a removed, cleanup-pending, or intentionally retained outcome. Retention needs
    a reason and revisit condition in `--retain <decisions.json>`. Finish writes the receipt before
    releasing the claim. Retry failed cleanup explicitly; never discard uncertain or unmerged work.

## 3. Monitoring (mandatory for every run, local and cloud)
- If subscription telemetry is configured, run `orch usage --refresh --json` at WP start, before
  assignments, at normal status checkpoints and after results (MCP: `usage`, `refresh: true`). Inspect
  both controller and child-route pool bindings. Model/harness aliases sharing a subscription share
  headroom. Preserve unknown/stale/reset-stale values and collector errors; this telemetry step does
  not change admission, billing mode or an existing run. `orch usage --json` reads the cache only.
- If quota policy is enabled, also inspect `orch quota --refresh --json`. Use the explicitly
  qualified capability group in `pick`, `run` and `review`, with `--size` for forecast costs.
  Allocate useful work across equivalent subscription pools; warn/checkpoint when low and defer
  if none is usable. Running jobs continue. Launch atomically rechecks/reserves the chosen route;
  it never substitutes a controller or changes billing. See `docs/QUOTA.md` for reserves, shared
  holds and uncertainty. Use `--quota-purpose retry` only for an authorized retry.
- Within **90 s** of launch: `orch status <id>` must show a live process and first log activity. If not: failed launch — read the log, fix the cause, record it. Do not blind-retry.
- Then check on a schedule (Claude Code: Monitor on the run log plus a ScheduleWakeup fallback; Codex, OpenCode and Vibe: periodic `orch status`). Interval 3–5 min cloud, 5–10 min local. Qualify the controller's ability to perform these checks in its configured tool profile.
- **Judge activity, not speed.** A slow local run that is producing steps is healthy. Do not set short timeouts on local models.
- Activity = the latest of: worker output, its log file, a structured event, a file change in the worktree. No real activity for 6 min (local: 10 min during model load) → the run is reported `suspected_stall`. Known dead-but-looks-alive signatures are in `docs/CLI_GUIDE.md`.
- **A stall is advisory. Nothing kills a run automatically.** You inspect, then decide. Before stopping a run, say why. A run stopped without a verdict is `inconclusive-timeout`, not a model failure. "Exit 0 with empty output" is a failure, not a success.
- Local gateway runs **one model at a time**: never launch two local runs concurrently; batch slices per model to avoid reloads. Cloud runs may go in parallel with a local run.
- Close the worker's window when its run has ended and its record is written.

## 4. Choosing a worker
When task-fit routing is configured, supply `--task <JSON>` to `pick` and carry its exact
`--profile` to `run`/`review`. Describe task complexity separately from slice size, and include
context/tools/modalities and risk. Critical reviews require C4 and a different known family.
Inspect routing exclusions and quota decisions; do not lower requirements to use spare capacity.
Use qualification mode only for an explicitly intended trial. See `docs/ROUTING.md`.

| Workload | First choice | Notes |
|---|---|---|
| XS/S mechanical, tests, scoped edits | local models via opencode | rotate across models; slow is fine |
| S/M multi-file mechanical, docs | vibe | verify provider and subscription/API account before launch |
| S/M needing a strong model, or after local+vibe failed | Codex | expensive models only with the owner's permission (`requires_permission` in the roster) |
| Whole-branch review | agy (Gemini) or vibe | never the implementer's model |
| Task-level review | any other model, local allowed if file list is small | |
| Escalation review | Claude Sonnet, then Opus (subagents) | only when reviews fail to converge or root cause is not found |
- **Rotation rule:** do not reuse a model just because it worked. Untested/under-tested models get suitable real slices. `orch pick` enforces this from the ledger; override only with a recorded reason.
- A profile claims only what the ledger shows. Everything else is `untested`.

## 5. Attempts and failure adjudication
- Max **3 attempts** per slice. Attempt 2 requires a recorded change (handoff, context or infrastructure). Attempt 3 requires a materially corrected handoff or a different model.
- After attempt 3: stop. Dispatch an adjudicator on a different model to classify the cause: model / handoff / infrastructure-guard / architecture. Act on the ruling; record it.
- Checklist before blaming the model: exact files named? anchor file to mirror? signatures pasted? acceptance checks runnable by the worker? guard blocking something the handoff requires?

## 6. Review loop and convergence
- Reviewer ≠ implementer, compared by **canonical model id**, not by CLI (the same model behind two CLIs is the same model). Script-enforced. Prefer a different model family. Security-sensitive diffs get two reviewers from different families.
- **Scope guard (script, before any review):** changed paths = `git diff --name-only <baseline>` plus untracked files; every path must be in the handoff's allowed list, otherwise the run is rejected or sent back — it never reaches review.
- Review is **blind** (no prior findings, no round number) and **read-only** in a throwaway detached worktree; the worktree must be clean afterwards, then removed.
- You grade every finding: **High** (contradicts spec/owner decision; security, privacy, data loss; breaks behaviour) / **Medium** (wrong but contained; required test missing; misleading doc) / **Low**.
- **In scope** only if it traces to this WP's spec, the project invariants, or code this diff changed. Everything else is filed (§7), never fixed here. This is the guard against scope expansion.
- Confirm every High against the code (read it; run something where possible) before it becomes work: `confirmed` / `refuted` / `unverifiable`. Reviewers never instruct implementers directly.
- **Converged** = a round with no in-scope High or Medium **and** your own verification passed **and** the scope guard passed. You decide this from the record; never ask a model whether it has converged. Lows: fix if cheap, else file; they never trigger a round.
- Limits: max 3 rounds (a 4th only for an in-scope High). Same area failing two rounds running = design problem → stop, go to the owner. Re-raised refuted findings do not count. Suspected reviewer loop → one round on another reviewer model.
- Escalation: Sonnet when two reviewer models disagree or root cause is unknown after adjudication; Opus when Sonnet does not converge either.

## 7. Follow-up accounting
Every finding/discovery ends in exactly one place before the WP closes: fixed in scope · `TASKS.md` (new WP) · `docs/OPEN_QUESTIONS.md` (owner decision) · the ledger via `orch record --notes` (workflow/model observation). The final review confirms nothing was dropped.

## 8. Documentation duty
Workers succeed or fail on the docs. After every WP: keep orch-owned instructions concise and true;
preserve existing owner instructions rather than shortening them to meet a line-count convention.
Update only orch-owned regions; report edits inside them as conflicts. `/docs` matches the code as
merged; `docs/CLI_GUIDE.md` is updated with every new CLI quirk the same day it is found.

## 9. Stop and ask the owner
Destructive or structural operations (plan → approval → execute once → read back); a guard blocks something you believe is needed; design-level review failure; anything spending money beyond a set cap.
