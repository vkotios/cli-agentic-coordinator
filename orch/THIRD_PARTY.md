# Third-party attribution — `orch`

`orch` has **zero runtime dependencies**. Everything it runs on is a Node built-in
(`node:child_process`, `node:fs`, `node:path`, `node:crypto`, `node:net`, `node:test`) plus Windows
programs already on the machine (`powershell.exe`, `taskkill.exe`, `where.exe`, and optionally `wt.exe`).

## Dev dependencies (local to `orch/`, never global)

| package | version | licence | why |
|---|---|---|---|
| `typescript` | ^5.9 | Apache-2.0 | type check only (`tsc --noEmit --checkJs`); there is no build step and no compiled output |
| `@types/node` | ^24 | MIT | type definitions for the Node built-ins used above |
| `@modelcontextprotocol/sdk` | 1.30.1 (exact) | MIT | **test only** - the official MCP client drives `orch mcp` in `test/mcp.test.mjs` (interop proof). The server itself does not import it: `src/mcp.mjs` is a hand-rolled stdio JSON-RPC server with zero runtime dependencies. |

## Code ported from the author's earlier project

`hooks/rules.mjs` (section 2, "DESTRUCTIVE") and the destructive-rule table in
`orch/test/guard.test.mjs` are ported from a guard hook in the author's earlier project (same author,
released here under this repository's MIT licence). Taken: the command-segment split, `argsAfter`,
`dirtyPaths` (fails closed), the `.env` regex, the PowerShell/cmd recursive-delete regexes, the Claude
scratch exemption, and the rules rm -rf, recursive delete, force push, reset --hard, clean -f,
branch -D, stash drop/clear, checkout -- / restore over dirty paths, DROP DATABASE/SCHEMA/TABLE, `.env`
access (commands and file tools), --no-verify; and the matching test cases. Changed: a timeout on every
git call, rule ids, reasons that name the orch command where one exists. Dropped as specific to that
project: a database reset rule, generated-file rules, immutable migrations, a CI gate on PR merges,
"no `git merge` on main", and a hooks-path requirement. The worker-launch rules (section 1) are new.

## Borrowed code

**None.** No source file from Orbit, Taurus, coding-agent-a2a, Hydra, acpx, Runner, VibeAround or
edulelis/opencode-mcp was copied into this repository. Those projects were evaluated as possible
donors; nothing was needed, so nothing was lifted and no licence obligation is incurred beyond the dev
dependencies above.

If code is ever copied, it must be recorded here with project, licence, file and the lines taken.
edulelis/opencode-mcp has no LICENSE file, so it remains **ideas only** and its code must not be copied.

## Ideas used without code (attribution for honesty, not for licence)

- **coding-agent-a2a** (MIT, casabre) — the shape of an idle/activity timer and the
  job-id → status → result → cancel tool surface. Re-implemented from scratch; the specifics here
  (per-lane thresholds, advisory-only stalls, four activity sources) are ours.
- **Hydra** (MIT, jpdlr) — the "record + append-only event log per run" pattern
  (`run.json` + `events.ndjson` here).
- **Orbit** (MIT, xinnaider) — the rule that a Windows prompt goes over stdin rather than argv,
  and `taskkill /F /T /PID` as the cancel path. Both were independently re-verified before being
  adopted.
- **Taurus** (MIT) — the Job Object `KILL_ON_JOB_CLOSE` idea. **Not used:** an experiment refuted it in
  this environment, so the shipping cancel path is `taskkill /T /F` on the recorded root plus a
  re-check of every recorded descendant.

## In-repo provenance

`orch/viewer/tail-view.ps1` is a rewrite of an earlier experiment script by the same author.
