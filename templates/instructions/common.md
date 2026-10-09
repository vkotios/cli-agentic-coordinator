# Orch common guidance

Keep the repository's owner instructions, nested scope rules and the user's request in force.
If the assigned role conflicts with those instructions, stop and report the conflict.
Using orch does not grant permission to delete data, change global configuration, push or merge.
Read the role selected by the user request or by the orch launch packet. A repository bootstrap
does not make every agent an orchestrator. Worker and reviewer packets are self-contained;
ignored adoption files need not be present in their worktrees.

For orchestration, resolve the installed kit from the repository's private `.orch-adopt.json`
`kit` field. Invoke `node "<kit>/orch/bin/orch.mjs" <command>` when MCP is unavailable.
Do not assume global registration; adoption only prints suggested registration commands.
