# Open questions for the owner

Decisions the orchestrator may not take (ORCHESTRATOR section 7). Each entry names the decision, the options and what is blocked.

## OQ-1: how much continuity evidence should `orch cleanup --reverify` demand for ordinary worktrees?

Raised 2026-11-24 by the wp-reboot-identity reviews (muse round 1, agy slice review of s4). Status: open.

`--reverify` adopts the current stamps of a worktree resource record when path, root, git registration, branch, admin directory and common
directory still verify. For a **review** resource it also requires the registered HEAD to equal the recorded baseline (added in r1). For an
ordinary **implementation** worktree there is no equivalent signal: if the worktree was deleted and another one was created at the same path on
the same branch name in the same repository, every check passes and the new directory's stamps are adopted. A later `cleanup --apply` or `finish`
would then treat it as the recorded resource. The dirty-tree and unmerged-content checks of `cleanup --apply` still run, and `--reverify` needs
the work package's authority plus an explicit operator command, so this is bounded, but it is weaker than "the identity is verified as the one
recorded".

Options:
1. Keep as is. The operator's explicit assertion is the design; document it (done in docs/CLI_GUIDE.md).
2. Require that the recorded `baseline` is an ancestor of the worktree's HEAD (`git merge-base --is-ancestor`). Cheap; stops an unrelated
   replacement but not a recreation from the same branch.
3. Also record the worktree HEAD whenever orch last verifies the resource and require it to be an ancestor of (or equal to) the current HEAD.
   Stronger; needs a new record field and writes on each verification.
4. Require a second confirmation flag when the diff includes an inode or birth-time change (not just a device change).

Blocked by this: nothing. `--reverify` ships with option 1 plus the review HEAD check.
