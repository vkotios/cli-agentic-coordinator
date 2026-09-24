# AGENTS.md — {{PROJECT NAME}} ({{STACK, one line}})

Rules for every coding agent. Hard limit: 60 lines. Details live in `/docs`.

## Never (stop and report instead)
- Never touch files outside the list in your handoff. Never explore the repository beyond it.
- Never delete, move or overwrite a file you did not create in this task.
- Never run: `git commit/push/merge/rebase/reset/checkout/restore/stash/clean`, package installs, database or deploy commands. The orchestrator does these.
- Never read or write `.env*` or any secrets file.
- Never edit generated files or applied migrations: {{LIST}}.
- Never add a dependency.
- Never claim something works unless you ran the check and saw it pass.
{{PROJECT INVARIANTS — max 6 bullets}}

## Before editing
1. Read the handoff fully. Read only the files it lists.
2. Open the "mirror" file named in the handoff and follow its patterns. Do not invent new ones.
3. Read the tests for the code you touch.

## While editing
- Smallest change that meets the acceptance criteria. Reuse existing code.
- No speculative abstractions, no unrelated rewrites. Keep validation, error handling and security.

## If blocked or a decision is needed
Stop. Output a line starting with `NEEDS-DECISION:` — what you found, the options, the risks. Do not guess.

## Verify (exact commands)
```
{{CHECK COMMANDS, e.g. typecheck / lint / unit tests}}
```
A command that finds nothing may exit non-zero (`grep`, `--check` formatters). That is not an environment failure.

## Report (always, even if you ran out of turns)
1. What changed, per file.
2. Commands run, with raw output.
3. What you did NOT verify.
4. Follow-ups you noticed but did not do (do not do them).

## Tools
- Codebase questions: if the repository has a code graph or index tool, query it before grepping.
- Library docs: a documentation lookup tool, only if your agent has one enabled.
