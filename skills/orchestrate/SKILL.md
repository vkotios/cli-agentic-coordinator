---
name: orchestrate
description: Run a work package in an adopted repository through the orch tool - claim, pick a worker model, create the slice worktree, launch the worker with orch run, monitor it, check scope, verify, review with a different model, record the gate decision, record the run, release. Use for ANY implementation work package in a repository that has adopted cli-agentic-coordinator (orch), instead of writing the code yourself or starting a worker CLI directly.
---

# orchestrate (Claude Code)

Follow `workflow.md` in this directory step by step; it is the body shared with Codex.
Claude Code specifics:

- Monitoring: after `orch run`, arm the Monitor tool on the run's stderr log
  (`orch result <id> --json` prints the paths) and a ScheduleWakeup fallback; on a session resume run
  `orch status --all` and re-arm.
- Research goes to the `researcher` subagent; escalation reviews (ORCHESTRATOR section 6 only) to
  `escalation-reviewer`, then `escalation-reviewer-opus`.
- Every subagent prompt carries: "Do not delete, move or overwrite anything outside the files you were
  asked to produce. On any obstacle: stop and report."
