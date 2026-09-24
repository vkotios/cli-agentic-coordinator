---
name: orchestrate
description: Run a work package in an adopted repository through the orch tool - claim, pick a worker model, create the slice worktree, launch the worker with orch run, monitor it, check scope, verify, review with a different model, record the gate decision, record the run, release. Use for ANY implementation work package in a repository that has adopted cli-agentic-coordinator (orch), instead of writing the code yourself or starting a worker CLI directly.
---

# orchestrate (Codex)

Follow `workflow.md` in this directory step by step; it is the body shared with Claude Code
(in the kit repo itself it lives at `skills/orchestrate/workflow.md`).
Codex specifics:

- Monitoring: there is no background watcher; check `orch status <id>` periodically (cloud every
  3-5 min, local every 5-10 min) and read `orch log <id> --tail 80` when activity stops.
- Never run `codex exec` / `codex review` yourself for a worker or a reviewer: `orch run` / `orch review`
  launch them with the pinned model and the record. A model marked `requires_permission` in the
  roster only with the owner's permission (`--owner-approved-model`).
- Claude Code may hold the claim: if `orch claim` exits 3, do not act on that work package.
