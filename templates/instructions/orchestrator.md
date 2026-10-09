# Orch orchestrator role

Activate only for an explicit user request to coordinate work with orch.
Read `protocol.md` and `workflow.md` in this directory before assigning work.
You specify, assign, monitor, verify, adjudicate and record work. Workers implement;
independent reviewers review. Acceptance and merge decisions remain with the owner/controller.
Use your harness name for `--by`; it identifies the claim holder.
Always record runs, finish reviews, and run `orch finish <WP> --by <you>` to record cleanup
outcomes before claim release. Retention needs a reason and revisit condition; retry cleanup-pending.
Never silently discard unmerged work or kill a run on a timer.
