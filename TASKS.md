# TASKS

Follow-ups filed under ORCHESTRATOR §7. Each ends in exactly one place before its source WP closes.

## Status after wp-reboot-identity (2026-11-24)

| FU | State |
|---|---|
| FU-1 worktrees lack helper and node_modules | open (pick option 1, 2 or 3) |
| FU-2 argon not in roster; agy model not machine-verifiable | open |
| FU-3 retention quiescence requires exactly `gone` | open |
| FU-4 finish live-match negative test | done in s2 |
| FU-5 other modules strict stamps | done: s5a retention, s5b archive/metadata/commands, s5c setup |
| FU-6 partial-removal strictness in resources.mjs | open |
| FU-7 untested deletion-guard permutations and negative legs | open |
| FU-8 docs for the dev-only rule; commands.mjs import placement | docs done in s4; import placement open |
| FU-9 redundant source-directory check in --reverify | open, Low |
| FU-10 lanepipe strict dev, blocked_by on non-identity blocks, MCP error shape | open, Low |

## FU-1: fresh orch worktrees lack gitignored build artifacts, so tests misreport

Found 2026-11-20 during wp-reboot-identity s1 verification. Not fixed in that WP.

Worktrees made by `orch worktree create` contain tracked files only. Two gitignored artifacts that the
test suite needs exist only in the main checkout:

- `orch/native/darwin-processes` (compiled macOS helper, built from `darwin-processes.c`). Without it
  `readProcessTable` returns `null` on macOS, and tests that read the real process table fail with
  `Cannot read properties of null`.
- `orch/node_modules`. Without it `src/task-cases.mjs` cannot import `typescript`, and
  `test/task-p04d.test.mjs` fails 10 of 10 with `api.offerTask is not a function`, because the test
  swallows the import error (`.catch(()=>({}))`). The same file passes 10 of 10 on main.

Effects: a worker told to run tests in its worktree gets misleading failures, and a controller can
misread them as regressions. A `node_modules` symlink is not matched by the `.gitignore` pattern, so it
shows up as untracked and trips the scope guard unless removed.

Options to decide:

1. `orch worktree create` provisions both (build or copy the helper, symlink or install `node_modules`) and
   makes sure neither shows up as untracked.
2. The handoff template names the exact commands that work in a worktree and the checks that cannot run
   there (`you cannot run this; the orchestrator verifies`).
3. Make `test/task-p04d.test.mjs` fail loudly on an import error instead of swallowing it.

Document the chosen behaviour in `docs/CLI_GUIDE.md` the same day.

## FU-2: gemini-4-argon-medium is not in the roster

`agy models` lists `gemini-4-argon-medium` (also argon high/low and the hydrogen variants); `orch/roster.json`
only has `gemini-4-neon-medium`. Owner asked to use argon medium as a reviewer on 2026-11-20.

FU-2 update (2026-11-20, corrected): `orch review --reviewer agy --model gemini-4-argon-medium` is accepted by orch.
agy logs `Model ID <id> not in local config, defaulting to CCPA` / `Model resolved via default` for EVERY print-mode
run, including the roster-confirmed `gemini-4-neon-medium` runs, because agy has no local model list (print mode
logs `Auth mode is unspecified, skipping fetchAvailableModels`). That line is not evidence the model was swapped.
The model that was selected shows up in `Propagating selected model override to backend: label="Gemini 4 Argon
(Medium)"` in the run's `agy.log`, and orch records `model_actual: null` for all agy runs (adapter cannot read
it). Remaining gap: orch cannot machine-verify an agy model, so reviewer-differs-from-implementer rests on the
requested id plus that log line. Probe 2026-11-20 (a one-word-prompt probe run, `--model "Gemini 4 Argon (Medium)"`,
one-word prompt): the display-label form logs the identical `not in local config, defaulting to CCPA` line and the
same `label="Gemini 4 Argon (Medium)"` propagation as the slug form, so passing the display name changes nothing
observable and the warning is unconditional. Open: add argon to `orch/roster.json` (it is accepted without a roster entry
today) and have the agy adapter record the `label=` line as the actual model.

## FU-3: retention quiescence still requires exactly `gone` (from wp-reboot-identity s1 review, Low)

`orch/src/retention.mjs:227` (`inspectQuiescence`) checks `verifyIdentity(...).verdict !== 'gone'`. After s1, an old-boot
pid absent from the table is `gone`, but an old-boot monitor/keeper pid that a new process now occupies returns
`mismatch/boot-changed`. `dependentRunBlock` (finish) treats that as exited; retention/`orch maintain` still blocks
with `monitor or keeper process live or uncertain`. Decide whether to share one "recorded process has exited"
predicate between the two callers.

## FU-4: finish test lacks a live-match negative case (from wp-reboot-identity s1 review, Low)

`orch/test/cleanup-p02.test.mjs` 'finish handles old-boot and reused monitor identities' covers absent-old-boot,
present-old-boot and present-reused, but not a same-boot live match
(`['present-live', process.pid, current, false]`). A regression that let `match` through the gate would pass.
Small; can ride along with s2 or s3 if it touches the same test file.

## FU-5: other modules keep their own strict dev:ino:birthtime stamps (from wp-reboot-identity s2 review, Medium, follow-up)

Same root cause as the worktree-reuse bug, different modules. After a macOS reboot (`st_dev` changes) these compare
stored stamps with strict equality, so pre-reboot evidence can fail verification:

- `orch/src/retention.mjs` (own `stamp`/`stampAsync`, ~lines 42, 105, 153-165): `owned` doc `state_identity`, `runs_identity`,
  `dir_identity`, `reviews_identity`.
- `orch/src/archive.mjs` (`identity`/`stamp`, lines 18-19, validate ~73) and `orch/src/metadata.mjs` (~41, 164, 221):
  compact archive evidence `original.identity`, `files[key]`.
- `orch/src/setup.mjs:20-21,167` (Low): `repoIdentity` binding of a setup session; resuming a pre-reboot session fails with
  `Setup repository identity changed`.
- `orch/src/catalog-store.mjs:16` uses `birthtimeMs`; not reviewed.

Verified by reading that the strict comparisons exist. NOT verified end to end: that `orch status|result|log|maintain` for a
pre-reboot run actually fails. Suggested shape: one shared stamp helper (`sameStamp` from s2, moved out of resources.mjs) used
by all comparators, with the same "dev-only difference verifies, caller persists the refresh" rule; reproduce first by
rewriting the dev field in a retention/archive fixture. Owner decision: fold into wp-reboot-identity or a new WP.

## FU-6: partial-removal branch in inspectIdentity still strict (from wp-reboot-identity s2 review, Low)

`orch/src/resources.mjs` `inspectIdentity`: `stamp(r.path) === r.identity.path && inspectPartialRemoval(...)` and the
snapshot comparisons in `inspectPartialRemoval` / `remainingSnapshotMatches` keep strict equality (s2 handoff said to leave
them). A half-removed worktree recorded before a reboot will not be recognised as a partial removal afterwards.

FU-6 update (s5b reviews, 2026-11-23): both reviewers confirmed by reading that the strict comparisons are wider than first noted:
`resources.mjs` ~83-84 (`remainingSnapshotMatches`), ~100 and ~105 (`removePartialFiles`, before unlink/rmdir) and ~212 (`inspectIdentity` partial branch).
Effect after a reboot: a half-removed worktree is refused with `registration changed, locked, or shared` or `resource-content-changed`,
cleanup retains it and blocks transcript/metadata retirement for the package. Fails closed (retain), but one operation accepts evidence
that a later one rejects. Graded Medium, follow-up (s2 handoff said to leave these strict). Fix together with the unlink-guard tests.

## FU-7: untested deletion-guard permutations in retention (from wp-reboot-identity s5a round-2 reviews, Low)

Both round-2 reviewers (agy argon, muse-spark) found no defect, only gaps that all fail closed:

- the second pre-unlink check (`retention.mjs` ~348, 'artifact changed during collection') is never isolated from the first (~345);
  no test swaps the file between the two;
- a malformed persisted stamp (hand-edited owned/receipt doc) is only unit-tested via stampsMatch, never through a retention path;
- a live file replaced after planRun passes, combined with a changed dev, is untested (existing swap tests never vary dev);
- a changed birthtime on a resumed partial receipt (the receipt test loops dev and ino only);
- createSnapshot's negative path (~311) is shadowed by planRun failing first on the same fixture.

Several need fs mocking to swap a file mid-operation. Pair with FU-6 (resources.mjs partial-removal strictness) when someone next
touches retention tests.

FU-7 update (s5b reviews, Low, test gaps; the orchestrator's mutation check kills all 16 sites, these are negative legs only):
- `retirement-p03c.test.mjs:77` owned-review auto-seal loops parts `[0, 1]`, so no birthtime (part 2) case for `metadata.mjs:165-167`.
- `archive.mjs:74` (`entry.state_identity`): only the dev-accepted case is tested; an ino or birthtime change on `state_identity` is not (the reader test mutates `entry.original.identity` only).
- `metadata.mjs:203/278` (`seal.original.identity`) has no ino/birthtime negative case; the sealed-device test mutates only `files['run.json']` for parts 1 and 2.
- re-enroll (`metadata.mjs:181`) has dev and ino cases but no birthtime case.

## FU-8: the dev-only tolerance is undocumented, and one import is misplaced (from wp-reboot-identity s5b reviews, Low)

- No doc states the rule (only `st_dev` may differ across reboots; ino/birthtime mismatch still refuses; stored stamps and seals are never rewritten),
  so an operator who sees `archive-changed` or `retirement-unowned` after a reboot cannot tell replacement from renumbering. Add a short section to
  `docs/CLI_GUIDE.md` (ORCHESTRATOR section 8). Natural moment: with slice 4 (`orch cleanup --reverify`), which needs the same explanation.
- `orch/src/commands.mjs:1332`: `import { stampsMatch } from './stamp.mjs'` sits at the end of the file. Works (ESM hoists imports), style only. Move it to the import block when someone next edits that file.

## FU-9: `--reverify` source-directory check is redundant (from wp-reboot-identity s4, Low)

`orch/src/resources.mjs` `inspectReverification` check 'source directory path' (`samePath(r.common_dir, resolvedPath(r.common_dir))`) cannot be
tripped independently: a symlinked stored `common_dir` also fails the later 'common directory path' comparison, so removing it changes no outcome
(mutation check 2026-11-23: survives; worker reported UNREACHABLE). Keep as defence in depth or delete; decide when next touching that function.

## FU-10: findings from the combined review of s3+s4+s5c that are not fixed in this WP (2026-11-23)

- Low, `orch/src/lanepipe.mjs:81` (`recoverLinuxSocket`): `owner.dev !== String(socket.dev)` compares a persisted `dev` strictly. If `/tmp/.orch-<uid>`
  survives a reboot and `st_dev` changed, `orch gc` and `orch monitor` return `state: 'unknown'` and will not unlink the dead-boot orphan socket
  (fails closed). Same family as FU-5/FU-6; decide whether to use `stampsMatch`-style tolerance there.
- Low, `cleanup.mjs` `cmdFinish`: some blocks still carry no `blocked_by`: `run inventory unreadable` (~line 142), `run <id> not terminal` (~147),
  and the legacy/foreign resource retain (`cleanup.mjs:28`). Not identity/process-liveness checks; decide whether `blocked_by` should widen to them.
- Low, `--reverify` TOCTOU: an out-of-band `git worktree` change between inspection and save is not serialized (orch holders are). Adoption is only
  of the stamps already verified a moment earlier and a later `cleanup --apply` re-inspects; accepted risk, documented here.
- Low, MCP `cleanup` without `wp` and without `reverify` now fails with the CLI's `missing-arg` instead of the MCP layer's `invalid-arguments`
  (the `required: ['wp']` entry was dropped so `--reverify` can be called alone). Check automation that matches the old error shape.

FU-10 update (slice-scoped reviews of s3, s4, s5b, s5c, 2026-11-24; all Low, filed, not fixed):
- `processBlock` labels every `dependentRunBlock` failure `process-liveness`, including unreadable run inventory or incomplete retirement; `blocked_by.resource`
  is omitted when the blocking run is a review run without `scope.worktree_id`; in human output the blocked-by line prints at the top level and again per resource.
- `--reverify`: stray positionals and unknown flags are ignored; a repeat reverify overwrites `reverified_*` (audit trail of the first adoption is lost);
  a record with a non-string `path` throws a TypeError instead of an OrchError; negative paths (flag combinations, missing resource, closed-package authority,
  text output) untested; top-level usage text (`orch/bin/orch.mjs`, README) does not mention `--reverify`.
- Owner decision filed separately: docs/OPEN_QUESTIONS.md OQ-1 (continuity evidence for ordinary worktrees).

