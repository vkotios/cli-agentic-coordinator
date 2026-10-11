# Shared subscription telemetry

The `usage` CLI command and MCP tool expose one service for Claude Code, Codex, OpenCode, Vibe and
other controllers. A harness is not a billing pool. Routes to different models or harnesses that use
the same subscription reference one pool; a local model has no subscription observation unless an
owner explicitly configures a corresponding pool. Queries do not require or transfer a WP claim.

## Configure pools and bindings

Copy `usage.config.example.json` to a private location and reference it with `usageConfig` in
`orch.config.json`, `ORCH_USAGE_CONFIG`, or `orch usage --config <file>`. All configuration is opt-in.
Use opaque aliases for pool, account and workspace IDs, not email addresses or credentials. Bind
each controller, worker and reviewer route to its actual pool. `--role` selects configured bindings;
`--pool` selects one configured pool. Unconfigured accounts are never discovered automatically.
Configuration files must resolve to regular files no larger than 1 MiB; explicitly chosen symlinks
and hardlinks are supported for read-only configuration. Cache records retain stricter ownership checks.

Configuration version is `1`, with at most eight pools and 64 bindings. Every pool has `id`,
`provider`, `account`, `workspace`, `billing: "subscription"`, and a `collector`. Each binding has
`id`, `role` (`controller`, `worker` or `reviewer`), `harness`, optional `model`, and `pool`.
Use one canonical workspace alias consistently. Repeated provider/account fingerprints in that
workspace are rejected even when the owner supplied different account aliases.
CodexBar account-level pools additionally share their cache and reject duplication across workspace
aliases; only an account/workspace-verifying JSON helper can supply independently scoped pools.

`minRefreshSeconds` defaults to 60 (10–3600); `staleAfterSeconds` defaults to 300 and cannot be
shorter than the refresh interval (maximum 86400). Explicit refresh respects cooldown, including
after failure and across processes. Refreshes for the same pool share an exclusive lock. An
interrupted or changed lock is protected for inspection; orch does not automatically take it over.
The cache holds only the latest normalized observation and latest attempt for each configured pool.
Changing a helper/profile/version invalidates its old observation but preserves the cooldown.

## CodexBar collector

Reuse an installed, pinned [CodexBar CLI](https://github.com/steipete/CodexBar/blob/main/docs/cli.md);
orch does not bundle or install it. `collector.kind: "codexbar"` supports subscription-only
`claude`/`codex` with `source: "oauth"` and `mistral` with `source: "web"`.
Configure `command` (an executable path), optional `args` (runner arguments), `version`,
`accountFingerprint`, optional `env` and `timeoutMs`. Relative executable paths resolve against
the usage configuration. Shell shims are rejected; invoke a real executable or a configured
runner. For example, a Linux runner can supply `env HOME=/private/collector-profile codexbar`
before the arguments that orch appends. Orch first checks `--version` against the pin, then runs
the following within the same timeout budget:

```text
usage --provider <configured-provider> --source <oauth|web> --format json --json-only
```

The runtime/helper and its credential profile must already be configured. Linux Mistral requires
manual session cookies in its private CodexBar configuration, including `ory_session_*` and
`csrftoken`; automatic browser import is not a Windows/Linux transport. Keep profiles isolated from
the coding harness's saved login so any collector token refresh affects only its designated copy.
An account fingerprint for this adapter is SHA-256 of the trimmed, lowercase account email reported
by CodexBar. Missing or mismatched identity, provider, version or source rejects the observation.
Some OAuth releases omit identity from CLI quota output. In that case use an attested JSON helper
that independently verifies the account using the same subscription credential; do not infer
identity from a successful quota request. Releases without an embedded JSON version use the
independently checked CLI version.
This fingerprint comparison is internal; emails and raw identities never enter the usage cache.
This adapter covers account-level windows; use an attested JSON helper for workspace-specific pools.

Only quota windows are imported. Claude/Codex preserve primary, secondary, tertiary and named
windows, including missing values. Mistral imports only `mistral-monthly-plan`, the separate Vibe
allowance. Mistral's API primary window, spend, balances and credit history never become Vibe quota.
An absent Vibe window gives unknown headroom, even when API usage collection succeeded.

## External JSON collector

`collector.kind: "json"` connects a scoped helper to the same contract. This is the reuse boundary
for Cursor, Meta Muse Code, GitHub Copilot and other subscription collectors. It proves contract
compatibility, not host/account qualification for every provider. The owner chooses and pins the
helper; orch does not blindly import another project's account discovery, credential fallback,
scoring or inference-key behavior.

The helper receives one JSON object on closed stdin, with `version: 1`, configured `pool`,
`provider`, `account`, `workspace`, `billing`, `accountFingerprint` and `sourceVersion`.
It must verify the actual credential/account/workspace binding and return exactly one observation
for that pool. `accountFingerprint` must be a lowercase SHA-256 binding fingerprint; its derivation
belongs to the helper's provider-specific account check. Never just echo a requested identity without
checking the actual account. The response is:

```json
{
  "version": 1,
  "observations": [{
    "pool": "coding-subscription",
    "provider": "copilot",
    "account": "personal",
    "workspace": "default",
    "billing": "subscription",
    "accountFingerprint": "<verified SHA-256 binding fingerprint>",
    "sourceVersion": "1.0.0",
    "observedAt": "2026-01-10T12:00:00Z",
    "windows": [{
      "id": "premium-requests",
      "kind": "quota",
      "unit": "requests",
      "used": 12,
      "remaining": null,
      "limit": null,
      "resetsAt": null,
      "durationMinutes": null,
      "models": []
    }]
  }]
}
```

All envelope bindings and `sourceVersion` must match configuration. Unknown fields are discarded
before persistence or output. Up to 32 windows preserve their original units (`percent`, `tokens`,
`requests`, `seconds`, `currency`, `credits`) and kinds (`quota`, `spend`, `credits`, `estimate`). Currency
windows require a three-letter `currency` code. Optional `models` scope a window to named routes.
Reported seat credits also retain the original `credits` unit. Unknown remaining, denominator or
reset values stay null; no universal percentage is invented.
The CodexBar adapter and bundled subscription helper derive the complementary value of reported
percentages. External JSON observations are preserved without orch inventing a missing remainder.
Reported consumption above 100% is retained with zero remaining headroom; it does not imply
additional capacity. Copilot remaining percentages above 100% are rejected because their
complement would imply negative consumption.
Neither a spend window nor a local token estimate is authoritative remaining subscription capacity.

## Cursor, Copilot and Muse subscription helper

The bundled `orch/tools/subscription-collector.mjs` is a Node 22+ JSON collector for explicit
account-level subscriptions. It runs on Windows, Linux and macOS without WSL, Docker or a daemon.
It does not log in, discover credentials, import browser databases, change billing or run inference.
Configure an external JSON pool with `workspace: "account"` and the absolute Node executable:

```json
{
  "kind": "json",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/orch/tools/subscription-collector.mjs", "--profile", "/private/profiles/usage.json"],
  "version": "1.0.0",
  "accountFingerprint": "<verified SHA-256 binding fingerprint>",
  "timeoutMs": 30000
}
```

The private profile is `{"version":1,"provider":"copilot","credentialFile":"session.json"}`.
That credential file, resolved relative to the profile, contains
`{"credential":"<subscription login credential>"}`. Protect both using owner-only permissions and
keep them outside public commits. Each file is a read-only input limited to 64 KiB. The helper never
copies or refreshes saved CLI auth, and never accepts an environment key as a fallback.
Profile selection must match the requested provider. The complete HTTP chain is bounded to 20 seconds,
with no retries, redirects or bodies above 1 MiB. Failures emit a generic category. Orch applies its
normal binding, cache, concurrency and cooldown rules. An explicit subscription credential may be
used for telemetry/auth HTTP requests; this never changes the inference billing mode.

| Provider | Selected credential and binding | Reported telemetry and qualification prerequisite |
|---|---|---|
| Cursor | cursor.com session Cookie header; `/api/auth/me` verifies email | `/api/usage-summary` individual included allowance in USD (source cents converted to dollars), reported model percentages, billing-cycle reset. On-demand stays `spend`; shared-team quota is never substituted. Requires a valid selected session and matching email fingerprint. |
| GitHub Copilot | GitHub OAuth `gho_`/`ghu_` login; `/user` verifies numeric account ID | `/copilot_internal/user` premium/chat request counts and reported percentages. Missing denominators/resets remain unknown; unlimited/zero-entitlement placeholders do not imply headroom. Seat credits retain unit `credits`, unknown ceiling; duplicate chat credits are not summed. Requires selected public GitHub subscription OAuth login, not a PAT or inference key. Enterprise hosts require a separately attested helper. |
| Meta Muse Code | Muse device login `dca:`; response verifies email and active subscription | `/muse-code/key` session and weekly quota; returned inference key/payment metadata discarded. Missing `subs_usage` remains unknown; no browser/team fallback. Requires active device login and matching email fingerprint. Browser-team quota requires a separate account/team-verifying helper. |

Cursor and Muse fingerprints are SHA-256 of the trimmed, lowercase email obtained using the same
credential. Copilot uses SHA-256 of `github.com:<numeric user ID>`. Account checks precede Cursor/Copilot
quota reads; Muse verifies identity in its single subscription response. Mismatches and workspace-specific
queries fail closed. An installed coding CLI alone does not establish subscription/account access.
Transport/schema regressions cover these helpers; qualify live access separately on the selected host.
Cursor's explicit zero included entitlement does not establish free-tier capacity: reported percentages
retain their consumption values with unknown remaining allowance and denominator. Copilot's identity
read uses REST version `2022-11-28`, independently of its internal quota API header. Copilot windows
with `token_based_billing` use AI credits; legacy windows retain request units. A per-window billing
flag takes precedence over the account flag. Reported credit usage is retained once, with no
invented denominator for placeholder seats. Muse can omit
`subs_usage` while its current session window is idle; an active subscription then retains unknown
quota counters until the provider reports them.

The parsing follows pinned [CodexBar v0.74.0](https://github.com/steipete/CodexBar/tree/v0.74.0)
provider contracts, with narrow adaptations attributed in [THIRD_PARTY.md](../orch/THIRD_PARTY.md).
CodexBar's credential manager, automatic fallback, UI and inferred denominators are not imported.

## Other subscription collector paths

Existing collectors can use the external JSON contract when a scoped helper verifies the selected
account/workspace and pins the installed version. These CodexBar IDs are concrete source candidates,
not host/account qualification or permission to automate an offer. Each needs an installed collector
and subscription login plus account/workspace attestation. API spend/credits remain distinct from quota.
The source inventory uses [CodexBar commit 6e118bdb](https://github.com/steipete/CodexBar/tree/6e118bdb5782707bfb0dfd0453d3483e3b216cd0);
verify support in the actual installed version rather than assuming every candidate exists in v0.74.0.

| Offer | Collector candidate / remaining prerequisite |
|---|---|
| ChatGPT/Codex; Claude Code; Mistral Vibe | `codex`, `claude`, `mistral`; adapters above, explicit subscription profiles |
| ChatGPT Free/Go desktop | No quota collector identified; remain unknown |
| Google Antigravity | `antigravity`; selected Google subscription/session |
| AWS Kiro | `kiro`; selected Kiro subscription login |
| Amazon Q Developer Pro; Google Jules | No quota collector identified; remain unknown |
| Devin / Windsurf transition | `devin` or `windsurf`; select actual billed service/account; separate pools |
| JetBrains AI / Junie | `jetbrains`; selected account/workspace subscription |
| Augment / Auggie | `augment`; selected subscription login |
| Qoder | `qoder`; selected subscription login |
| Grok / Grok Build | `grok`; selected subscription session |
| Z.ai GLM Coding Plan | `zai`; coding-plan login/quota, not general API balance |
| Kimi Code membership | `kimi`; coding membership login |
| MiniMax M Plan | `minimax`; selected subscription/coding plan |
| Alibaba Coding Plan | `alibaba-coding-plan`; selected coding plan |
| Alibaba Token Plan | `alibaba-token-plan`; selected token plan; retain reported units |
| OpenCode Go | `opencodego`; selected Go subscription/workspace; external-provider pools stay separate |
| Synthetic packs | `synthetic`; selected subscription pack |
| Factory Droid | `factory`; selected subscription and included allowance |
| Warp / Oz | `warp`; selected subscription workspace |
| NanoGPT subscription | No quota collector identified; remain unknown |
| Kilo Pass | `kilo`; selected Pass account/workspace |
| Chutes subscription | `chutes`; selected subscription |
| Amp | `amp`; selected subscription and included allowance |
| Command Code GOAT / Max | `command-code`; selected subscription login |
| Ollama Cloud | `ollama`; selected cloud subscription; local inference is a separate route |

Cursor, Copilot and Muse use the bundled helper above. Other candidates still need a scoped JSON
projection; orch does not claim runtime-qualified adapters for them. Missing quota or binding stays
unknown. This inventory enables no providers, installs no software and grants no routing eligibility.

## Refresh and privacy boundaries

Refresh uses at most four concurrent helpers, each with a 15-second default timeout (100–30000 ms),
and at most 1 MiB total stdout/stderr per invocation. Helpers run without a shell; configured arguments cannot
contain credential flags or override the pinned CodexBar source/provider. Inherited keys, tokens,
cookies, credential-location variables and common runtime-injection variables are removed.
Only ordinary OS runtime, locale and home/profile paths are inherited. Explicit profile environment fields
are limited to `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
`XDG_CONFIG_HOME` and `SSL_CERT_FILE`; never put credential values in them or in arguments.

Helpers must perform telemetry/auth reads only, never inference, account switching, purchases or
overage changes. Linux/remote runners must bound their own remote work and clean up temporary auth:
ending a Windows runner does not prove its remote process ended. Orch bounds its response, checks
Windows process identity before stopping an owned telemetry process, and marks uncertain cleanup
`cleanup-pending`; another refresh for that pool is prevented until an operator resolves the record.
Worker and controller model jobs are untouched.

For `refresh-busy` or `cleanup-pending` that persists after an interrupted request, inspect the
pool's hashed cache/lock record under `<state root>/usage`. Verify the recorded process and any
remote runner work have ended before archiving the lock or clearing `error.cleanupPending` in
the cache. Keep the last observation and attempt time. Never resolve an uncertain identity by
killing an unrelated process or automatically removing the record.

Cache files under `<state root>/usage` contain normalized observations, original times, a configuration
fingerprint and redacted error categories. Raw helper output, stderr, credential documents, emails
and executable/profile paths are not saved or printed. Corrupt, oversized, linked or changed cache
records are protected. A failed refresh keeps applicable prior evidence with its original age and a
separate error. Pool freshness describes observation age; inspect each window's own freshness and
unknown values before judging headroom. An expired reset is `reset-stale`, never assumed replenished.

Controllers should refresh enabled pools at WP start, before assigning new work, at normal status
checkpoints, and after results. Check both the controller and child-route bindings. This command
collects evidence; it does not enforce reserves, choose alternatives, defer launches or replace a
controller. Running work continues even when quota is low or telemetry fails.
