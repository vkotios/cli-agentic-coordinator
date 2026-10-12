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

No source file from Orbit, Taurus, coding-agent-a2a, Hydra, acpx, Runner, VibeAround or
edulelis/opencode-mcp was copied into this repository. Those projects were evaluated as possible
donors; nothing was needed, so nothing was lifted and no licence obligation is incurred beyond the dev
dependencies above.

If code is ever copied, it must be recorded here with project, licence, file and the lines taken.
edulelis/opencode-mcp has no LICENSE file, so it remains **ideas only** and its code must not be copied.

### CodexBar subscription contract adaptations

`src/subscription-collectors.mjs` narrowly adapts provider request/field contracts from
[steipete/CodexBar v0.74.0](https://github.com/steipete/CodexBar/tree/c2f22ccf8751efc8fe697bfe4714769107965274),
commit `c2f22ccf8751efc8fe697bfe4714769107965274`, MIT:

- `Sources/CodexBarCore/Providers/Cursor/CursorStatusProbe+UsageSummary.swift`: individual included
  allowance cents, percentage fields, billing-cycle reset and separate on-demand spend.
- `Sources/CodexBarCore/Providers/Copilot/CopilotUsageFetcher.swift` and
  `Sources/CodexBarCore/CopilotUsageModels.swift`:
  request headers, premium/chat quota fields, unlimited/zero-entitlement placeholders and one credit counter.
  The added identity verification uses GitHub's supported REST version `2022-11-28` separately
  from the upstream internal Copilot quota API version.
- `Sources/CodexBarCore/Resources/Plugins/muse.ts`: device-token subscription endpoint, active-subscription
  checks and session/weekly quota fields; minted inference keys and payment metadata are discarded.

These are fresh Node implementations, not verbatim source copies. No upstream credential manager,
account discovery/fallback, team selector, UI, entitlement inference or dependency is bundled.
The upstream notice is retained for these narrow adaptations:

```text
MIT License

Copyright (c) 2026 Peter Steinberger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

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
