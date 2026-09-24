# Models: the roster, `orch pick`, and benchmarking a local gateway

## The roster

`orch pick` proposes a worker model from **your** roster: a JSON file listing the models your machine
can actually launch. It is personal (which CLIs you have, which accounts you pay for, which local models
your gateway serves), so it is not in the repository:

```powershell
Copy-Item orch\roster.example.json orch\roster.json
notepad orch\roster.json
```

Location: `orch/roster.json`, or the path in `ORCH_ROSTER`, or `"roster"` in `orch.config.json`
(see the README for the precedence). The file is git-ignored. When it is missing, `orch pick` stops with
an error telling you to create it; `orch review` still works (it only uses the roster for model families,
and falls back to the leading letters of the model id).

Shape:

```json
{
  "models": [
    { "cli": "opencode", "model": "localai/example-coder-30b", "family": "example-coder",
      "lane": "local", "workloads": ["implement", "review"], "cost_class": "local-free",
      "playbook_note": "XS/S edits and tests" }
  ]
}
```

| field | required | meaning |
|---|---|---|
| `cli` | yes | the orch adapter that launches it: `opencode`, `vibe`, `codex` or `agy` |
| `model` | yes | the id passed to the CLI (`--model`); for opencode, `provider/model` as in your opencode config |
| `family` | recommended | model family; a reviewer from the implementer's family is ranked last. Without it, the family is the leading letters of the id (`gpt-oss-120b` -> `gpt`) |
| `lane` | yes | `local` (a model on your gateway: strictly one run at a time, XS/S slices only) or `cloud` |
| `workloads` | yes | which of `implement` / `review` pick may propose it for; `[]` = listed but never proposed |
| `requires_permission` | no | `true`: never proposed by pick, and `orch run` refuses it unless `--owner-approved-model` is given (use it for very expensive models) |
| `cost_class` | no | free text shown in the pick result (`local-free`, `subscription`, `metered`, ...) |
| `playbook_note` | no | free text for you |

Only list models an orch adapter can launch. Models reached another way (for example the Claude
escalation subagents) do not belong in the roster.

**Model ids.** Use ids the CLI itself resolves. Two known traps, both verified (see `docs/CLI_GUIDE.md`):
vibe has no `--model` flag (orch writes the declaration into the worktree's `.vibe/config.toml`), and agy
silently falls back to a default model when an id is not in its local config; orch then records the model
used as `unknown`.

**Canonical ids.** orch compares models by canonical id: the provider prefix and letter case are dropped,
so `localai/Example-Coder-30B` and `example-coder-30b` are the same model. The reviewer can never be the
implementer's model, whichever CLI serves it.

## How `orch pick` chooses

`orch pick --workload implement|review --size XS|S|M [--for-run <implementer run>]` is deterministic
given the roster and the ledger (`<state root>/ledger.jsonl`, written by `orch record`).

For each roster entry, in order, a model is **excluded** when:

1. `workloads` does not contain the workload;
2. `requires_permission` is true;
3. `lane` is `local` and the size is `M` (local models get XS/S slices only);
4. for a review: it is the implementer's own model (canonical id);
5. the ledger holds two or more failures (`rejected`, `failed-launch`) of that model for that workload.
   `blocked` (quota, infrastructure) and `inconclusive-timeout` are not model failures.

The remaining candidates are ranked by:

1. for a review, a model from a **different family** than the implementer first;
2. **fewest recorded runs** for that workload (the rotation rule: do not settle on a model because it
   worked once; under-tested models get suitable real slices);
3. roster order (your tie-break: put the model you prefer first).

A review pick needs `--for-run` so the implementer's model is known. The output names the pick, the
reason, every candidate with its counts, and every excluded model with the reason. Exit code 3 means
no suited model. Using a different model than the pick is allowed; record why in `orch record --notes`.

## Benchmarking a local gateway

`orch/tools/bench-gateway.mjs` measures each model on an OpenAI-compatible gateway (llama.cpp server,
llama-swap, LocalAI, and similar), **one model at a time and sequential requests only**, so it never
makes your gateway hold two models at once. Per model it sends the same short code-review prompt twice:
request 1 is cold (includes the model load), request 2 is warm.

The gateway URL and the model list are **required**; there is no default:

```powershell
node orch\tools\bench-gateway.mjs --gateway http://10.0.0.2:8080/v1 --models example-coder-30b,example-reasoner-120b --out bench-results.json
```

or put them in `orch.config.json` (`"gatewayUrl"` and `"bench": { "models": [...] }`) or set
`ORCH_GATEWAY_URL`. Options: `--max-tokens <n>` (default 400), `--timeout-s <s>` per request
(default 900).

Output: one JSON line per model while it runs, the full results in `--out`, and at the end a table
(load seconds, warm generation tokens/s, warm wall time, whether the answer finished within the token
cap) plus roster lines you can paste into `orch/roster.json` and edit. When the gateway reports
llama.cpp `timings`, those are used; otherwise wall-clock time and `usage`.

Reading the numbers: reasoning models spend output tokens thinking, so their time to an answer is
longer than tokens/s suggests; `finish_reason = length` means the answer did not fit in the cap. Batch
slices per model: every model switch costs the load time again. A single trial is a rough guide, not a
ranking; the ledger (what actually happened on your slices) is the evidence that matters.
