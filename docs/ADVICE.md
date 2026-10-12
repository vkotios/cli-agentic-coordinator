# Optional Jev routing advice

Jev can suggest a choice among the final ties from [task-fit routing](ROUTING.md).
The default remains deterministic routing. Advice requires all three: an explicitly
enabled private adviser policy, its referenced OpenRouter API key, and `pick --advice`.
Key presence alone does not enable it. `run` and `review` never call Jev.
Worker and reviewer subscription billing remains governed by the selected execution profile.
The optional adviser itself uses the OpenRouter API and can incur API charges.

Copy [advice.config.example.json](../advice.config.example.json) to private storage. It is
disabled and its numbers are illustrative limits, not a pricing recommendation. Select it
with `--advice-policy`, `ORCH_ADVICE_POLICY`, or private config `advicePolicy`. Relative
`stateRoot` resolves against the policy file's directory. A minimal disabled policy is
`{"version":1,"enabled":false}`. Credentials belong only in the environment variable named
by `keyEnv`; inline keys and endpoint overrides are rejected.

```sh
orch pick --workload implement --size S --routing-policy private/routing.json \
  --task private/task.json --advice-policy private/advice.json --advice --json
```

MCP `pick` accepts the same options (`advice: true`). Normal cached picks remain read-only.
An explicit advice pick can contact OpenRouter and write private accounting even without
`refresh`; telemetry refresh is independent. Advice options on other commands are rejected.
`shadow` records a recommendation while keeping
the current deterministic result. `assist` can apply a revalidated tie-break to the proposal.
Carry its exact `profile` and launch selectors to `run`/`review`; launch still rechecks its
own task, availability, independence, permissions and atomic quota admission.

Only normally qualified task-fit profiles can enter the adviser shortlist. It preserves
the best reviewer-family tier, quota eligibility and reset-cycle pacing tier, owner
cost/latency preference, and least-recorded-use exploration tier. It cannot introduce models,
lower requirements, restore exhausted subscriptions, grant permissions, change accounts or
transfer a running controller. C0, qualification trials, unavailable/deferred decisions and
single-choice shortlists skip provider contact.

Requests use OpenRouter's [typed Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request),
with opaque choices `c1` through `cN` and `abstain`. Sent fields are task type, required class,
slice size, risk, context allowance, number of required tools and modalities; candidate
descriptors are supported classes/risks/modalities, context allowance, tool count and declared
cost/latency ranks. No code, transcript, free-form task text, model/harness identities, account
IDs, private capability IDs or qualification evidence is included. This deliberately limits
the information available to Jev; live recommendation utility has not been qualified.

The policy requires a versioned Jev request model and exact dated `responseModel`. Confirm
the provider's current supported pin before enabling; the example is not a moving latest alias.
Only TypeSafe is allowed, provider fallback is disabled, and prompt/completion prices are
capped in dollars per million tokens. Responses must match the exact snapshot, provider,
typed choice and bounded token/cost usage. Abstention, invalid/outside choices, snapshot drift,
HTTP errors, redirects, missing credentials and timeout fall back to deterministic routing.
The full deadline covers key preflight, one decision attempt and response streaming. There
are no automatic retries. Request size is at most 16 KiB with 2–32 candidates; each response
is at most 64 KiB. Request timeout must be 25–5000 ms.

Before the paid request, `GET https://openrouter.ai/api/v1/key` must confirm a dedicated,
finite, positive, nonresetting key credit limit no greater than `maxSpendUsd`, and remaining
credit at least `reservePerRequestUsd`. Unlimited or resetting keys refuse advice. Orch
never creates or changes keys or their provider limits. Key/account setup remains an explicit
owner action. See [OpenRouter limits](https://openrouter.ai/docs/api/reference/limits).

Private accounting uses an atomic operation lock and one file per key fingerprint under
`stateRoot/adviser`. `maxRequests` caps paid attempts, including failed attempts; it must be
1–100000. `maxSpendUsd` is a declared lifetime budget of up to $100. A positive per-request
reservation must fit that budget before any contact. Known cost settles the reservation;
failed paid attempts retain it. Missing/unverifiable cost or cost above the reservation
blocks subsequent requests pending owner inspection. A changed financial/model contract,
corrupt/linked state, unexpected edits or a busy/interrupted lock refuses advice safely.
There is no automatic reset, lock takeover, history deletion or retry.

All repos and policy aliases using one key must use the **same private `stateRoot` and
financial/model contract** to share local request/spend accounting. Separate roots or machines
cannot share those local counters; the dedicated provider key's lifetime limit remains the
global backstop. Do not erase or move accounting to replenish a budget. The reservation is
an estimate, and local price/reservation controls do not guarantee a hard per-invoice ceiling;
provider credit enforcement remains external.

The bounded state file holds lifetime counters and only the latest compact receipt. Receipts
include status/reason, initial deterministic profile, suggested profile, whether applied,
pinned model for accepted advice and `paidAttempt` (null when accounting is unavailable;
inspect private state rather than assuming no charge). Paid attempts include a request ID/hash;
preflight refusals do not. Readable accounting supplies aggregate budget, including on limit
refusals; early disabled/unconfigured/unreadable-state refusals omit it. Accepted suggestions
also include token/cost usage. The stored latest receipt represents the last contact attempt;
limit refusals do not rewrite it. Raw requests, responses, keys and provider error text are not
retained. Consumers should inspect `advice` in JSON; plain text continues to print the pick.
Installing or copying the example changes no owner policy and makes no live request.
