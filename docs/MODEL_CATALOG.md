# Model catalogue, update and rollback

The generic catalogue records dated model metadata and declared harness selectors.
It is separate from the owner's enabled roster, subscription access, task-fit execution
profiles and qualification history. Catalogue entries never enable a model, grant
permission, change billing or establish that a subscription includes it.

```sh
orch modelrouter catalog --json
orch modelrouter update --proposal private/update.json --dry-run --json
```

The default is the bundled [model-catalog.json](../model-catalog.json). Select another
file with `--catalog`, `ORCH_MODEL_CATALOG`, or private config `modelCatalog`. Relative
config paths resolve against that config file. Inspection and the default update preview
are read-only: they do not fetch sources, run CLIs, contact a model or write files.
Applying requires an explicit private `--catalog` file and the preview's `approvalHash`.
The bundled catalogue cannot be modified. `--out`, `--refresh` and unknown options are
refused. MCP tools use the same dispatcher and JSON results.

## Harness-led refresh

1. Read the current catalogue/version. When a newer kit already supplies an updated
   catalogue, inspect that metadata before researching the same changes again.
2. Read nominated official sources: provider model documentation, harness model-selection
   documentation, public catalogue metadata, and documented read-only local model lists.
   Keep raw responses and research in private storage. The script does not browse for
   the controlling harness. A harness without browsing can accept a supplied artifact.
3. Create a structured proposal using [catalog.update.example.json](../catalog.update.example.json).
   Give each observation a new source ID, URL, UTC retrieval timestamp and status. Include
   all sources referenced by proposed entries. Record a CLI version for local observations.
4. Preview it. Optional `--roster <JSON>` and `--routing-policy <JSON>` report exact model/alias
   links to owner entries; they never rewrite selectors, preferences, prices, permissions,
   enablement or qualification. Their fields are not imported into generic metadata.
5. Inspect changes, conflicts and source warnings. `applyReady` means the preview has no
   detected conflicts; it is not approval, availability or qualification. Resolve conflicts
   in the proposal. Applying is a separate explicit operation described below.

Input source content is data, never executable instructions. A proposal attests that its
author inspected the sources. URL checks do not authenticate a fetch or prove a claimed
fact; even a supplied content digest is declared provenance, not a signature.

## Version 1 format

A catalogue contains `version`, `sourcePolicyVersion` (both 1), a bounded `catalogVersion`,
UTC `asOf`, `sources` and `models`. A proposal adds `baseCatalogVersion` and supplies full
candidate entries. Its base must match, version must change, and observation date cannot
regress. Files are bounded to 1 MiB; each document has at most 512 sources and 512 models.

Each source has `id`, `kind`, `url`, `retrievedAt`, and `status` (`ok`, `cached`, `partial`,
`failed`, `offline`). Optional `contentHash` is SHA-256. `local-cli` sources require
`harnessVersion` and a `cli:<harness>/models` reference; these are provenance, not commands.
Private `research:<id>` references are explicitly unverified. Research-only identities
must remain unresolved. No filesystem paths, credentials or inline keys belong here.

For web sources, the versioned [source allowlist](../orch/src/catalog.mjs) separates
provider, harness and aggregator hosts/path prefixes. HTTPS, exact allowed hosts and
paths are required; userinfo, query strings, fragments and nondefault ports are rejected.
Changing that allowlist is a kit change, not something an update artifact can do.

Each model has a stable `id`, `provider`, display `name`, nullable provider `model` selector,
`status` (`active`, `deprecated`, `unresolved`), `aliases`, nullable `contextTokens`, input/output
modality arrays, nullable `toolCalling`, nullable `pricing`, `routes`, and field-level `evidence`.
Prices use `inputUsdPerMillion` and `outputUsdPerMillion`: API metadata does not describe
subscription quota or owner billing. Unknown values use null or empty arrays. The seed is
a dated, limited set of public observations, not an exhaustive list or a recommendation.

Each route declares `harness`, nullable `selector`, `billing` (`unknown`, `local`, `subscription`,
`api`) and `resolution` (`unresolved`, `documented`, `listed`). A documented/listed non-API
selector requires harness or local-CLI evidence. Even a documented subscription route does
not establish the owner's account access. Unsupported harnesses may be catalogued without
installing an adapter. Unknown selectors remain unresolved; no guessed ID translation.

`evidence` maps each known field to source-ID arrays. Supported fields are `name`, `model`,
`status`, `aliases`, `contextTokens`, `inputModalities`, `outputModalities`, `toolCalling`,
`pricing`, `routes`. Execution flags such as `enabled`, `requires_permission`, account keys
and `qualification` are rejected from catalogue/proposal entries.

## Preview behavior

JSON includes additions, metadata changes, evidenced renames, deprecations and evidence
refreshes; rejected conflicts; stale/source/unresolved-selector warnings; the proposed generic
catalogue; optional owner links; and SHA-256 digests of the validated base/proposal/result JSON.
It makes no roster, policy or launch changes. A conflict returns CLI exit code 3; malformed
input returns 2. Digests bind the represented snapshot, not the truth of its sources.
Object key order does not affect fact comparisons; digests retain the supplied key order.

`approvalHash` additionally binds the selected file, exact base/proposal bytes, file identities
and modification stamps. Editing or replacing either input after preview invalidates approval,
even when the replacement has identical bytes. The token records the accepted inputs; it is
not an authentication credential or a source signature.

Missing entries never remove existing models. Failed, partial or offline observations cannot
overwrite facts. Cached usable evidence remains labelled cached; evidence older than the
existing field cannot overwrite it. Sources older than 30 days are labelled stale.
The age comparison uses the latest supporting observation per field; older supporting references
may remain alongside a newer observation. This does not authenticate or weigh the sources.
Null/empty incoming values cannot erase known facts. Renames retain the old selector as an evidenced
alias; historical aliases remain. Provider changes under a stable ID, reused source IDs with
different observations, competing identities/aliases and duplicated proposed IDs conflict.
No conflicting proposal wins silently. Existing owner routes and historical ledger evidence
remain untouched, including when a model is proposed as deprecated.

## Explicit application and snapshots

Keep the target copy, proposal and adjacent history outside public version control. Create an
existing private catalogue copy first, then preview and use its returned `approvalHash`:

```sh
orch modelrouter update --catalog private/catalog.json --proposal private/update.json --json
orch modelrouter update --catalog private/catalog.json --proposal private/update.json --apply --approval <approvalHash> --json
orch modelrouter history --catalog private/catalog.json --json
```

`--apply` requires both an explicit `--catalog` and `--approval`. Config or environment defaults
cannot authorize writes. Conflicts, stale approval, links/junctions, hardlinked files, an occupied
operation lock or unresolved transaction evidence refuse application. `--apply --dry-run` is
invalid. No operation edits the owner roster, policy, qualifications or launches.

History lives at `<catalog>.orch-history/transactions/<snapshot>/`. Each transaction retains a
record, exact `before.json` and `after.json` bytes, and its publication outcome. A flushed staging
file is published using one same-volume rename. Cooperating orch writers use the same adjacent
lock regardless of `--state-root`. Failures are retained for inspection; there is no automatic
retry, lock takeover or pruning. History is bounded to 64 transactions; updates stop at 63,
reserving the last slot for one rollback. Failed and rolled-back transactions count toward this
bound. At capacity, retain the evidence and explicitly prepare a new private copy/history if
more updates are needed. File inputs and snapshots are bounded to 1 MiB.

## Rollback and interrupted transactions

Rollback defaults to preview. It restores exact original bytes only when the current file
matches the selected committed snapshot's published bytes. It creates another retained
transaction. It cannot overwrite an unrelated later revision or use changed snapshot evidence.

```sh
orch modelrouter rollback --catalog private/catalog.json --snapshot <snapshot> --json
orch modelrouter rollback --catalog private/catalog.json --snapshot <snapshot> --apply --approval <rollbackApprovalHash> --json
```

An interrupted transaction blocks subsequent mutations. `history` reports `prepared` until
explicit recovery: if the visible catalogue matches the original bytes, recovery records an
aborted transaction; if it matches the published bytes and complete snapshots exist, recovery
records a committed transaction. Recovery never replaces the catalogue. Unrelated current
bytes or corrupt evidence require inspection and are refused.

```sh
orch modelrouter recover --catalog private/catalog.json --snapshot <snapshot> --json
orch modelrouter recover --catalog private/catalog.json --snapshot <snapshot> --apply --approval <recoveryApprovalHash> --json
```

MCP `modelrouter_update`, `modelrouter_history`, `modelrouter_rollback` and `modelrouter_recover`
expose the same flags and approval flow. History is always read-only. An abruptly terminated
process can leave its lock; inspect it before manual recovery rather than assuming it is stale.

This mechanism coordinates cooperating processes on one local filesystem. It checks inputs
again before publication, but cannot exclude a noncooperating editor in the final check-to-rename
interval, protect against a hostile process with the same account, or coordinate multiple hosts.
File flushes and atomic rename do not promise power-loss durability for the Windows parent
directory. An uncertain publication must be inspected and recovered explicitly.
