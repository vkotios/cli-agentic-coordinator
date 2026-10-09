---
name: orchestrate
description: Use when the user asks you to coordinate a work package with orch in an adopted repository and you are its controller. Do not activate for an orch-launched implementer or reviewer, or for development of the kit itself.
---

# orchestrate (Claude Code)

Activate only for the controller role. Keep owner/project rules in force and report conflicts.
An orch launch packet assigns workers and reviewers their roles; this skill does not reassign them.

Follow `workflow.md` in this directory step by step; it is the body shared with Codex.
Claude Code specifics:

- Monitoring: after `orch run`, arm the Monitor tool on the run's stderr log
  (`orch result <id> --json` prints the paths) and a ScheduleWakeup fallback; on a session resume run
  `orch status --all` and re-arm.
- Research goes to the `researcher` subagent; escalation reviews (ORCHESTRATOR section 6 only) to
  `escalation-reviewer`, then `escalation-reviewer-opus`.
- Every subagent prompt carries: "Do not delete, move or overwrite anything outside the files you were
  asked to produce. On any obstacle: stop and report."
