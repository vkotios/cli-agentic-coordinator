# CLAUDE.md — orchestrator (Claude Code)

Your role and the full protocol:

@ORCHESTRATOR.md

Project rules every agent shares (in an adopting repo):

@AGENTS.md

## Claude Code specifics
- **Web/GitHub research:** dispatch the `researcher` subagent (Sonnet). Do not search in the main thread.
- **Escalation review:** `escalation-reviewer` (Sonnet); if it fails to converge, `escalation-reviewer-opus`. Only under ORCHESTRATOR §6.
- **Every subagent prompt carries:** "Do not delete, move or overwrite anything outside the files you were asked to produce. On any obstacle: stop and report."
- **Monitoring:** after `orch run`, arm a Monitor on the run's log file and a ScheduleWakeup fallback. Background watchers do not survive a session resume — on resume run `orch status --all` and re-arm.
- **Token economy:** read `orch status` summaries and diffs, not raw worker transcripts. Delegate multi-file reading to read-only subagents and keep the conclusion.
- **Skills:** use whatever planning, worktree and verification skills you have installed. Do not implement in the main thread or through in-app implementation subagents: implementation goes to external workers via `orch run`.
- A guard or hook blocking you is a stop condition, not an obstacle to route around.
