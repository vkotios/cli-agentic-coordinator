# Model catalogue and update preview

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
config paths resolve against that config file. Both commands are read-only: they do
not fetch sources, run CLIs, contact a model, write files or apply updates. `--apply`,
`--out`, `--refresh` and unknown options are refused. Application, snapshots and
rollback are a subsequent feature. MCP `modelrouter_catalog` and `modelrouter_update`
use the same dispatcher and JSON results.

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
   in the proposal. There is no application operation in this slice.

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
