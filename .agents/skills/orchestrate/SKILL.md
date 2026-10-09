---
name: orchestrate
description: Use when the user asks you to coordinate a work package with orch in an adopted repository and you are its controller. Do not activate for an orch-launched implementer or reviewer, or for development of the kit itself.
---

# orchestrate (Codex)

Activate only for the controller role. Keep owner/project rules in force and report conflicts.
An orch launch packet assigns workers and reviewers their roles; this skill does not reassign them.

Follow `workflow.md` in this directory step by step; it is the body shared with Claude Code
(in the kit repo itself it lives at `skills/orchestrate/workflow.md`).
Codex specifics:

- Monitoring: there is no background watcher; check `orch status <id>` periodically (cloud every
  3-5 min, local every 5-10 min) and read `orch log <id> --tail 80` when activity stops.
- Never run `codex exec` / `codex review` yourself for a worker or a reviewer: `orch run` / `orch review`
  launch them with the pinned model and the record. A model marked `requires_permission` in the
  roster only with the owner's permission (`--owner-approved-model`).
- Claude Code may hold the claim: if `orch claim` exits 3, do not act on that work package.
