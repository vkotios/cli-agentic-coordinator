{{ROLE RULES — paste roles/reviewer.md here verbatim; do not rely on the CLI loading it}}

REPOSITORY: {{one line: what it is, stack}}
PROJECT RULES THAT APPLY: {{paste the "Never" list and invariants from AGENTS.md}}
Take as long as you need. Correctness matters more than speed.

CONTEXT (read first)
- Spec: {{SPEC_PATH}}   Plan: {{PLAN_PATH}}
- Intended behaviour decided by the owner: {{paste the decisions this work implements}}

WHAT TO REVIEW
{{exact git range, e.g. `git diff <base>..<head>`, and the focus files}}

REQUIRED REVIEW PASSES — one output section each
Pass 1 — Behaviour: logic that contradicts the spec or the owner's decisions, traced per scenario.
Pass 2 — Security and privacy: access widening, secrets, injection, personal data exposure.
Pass 3 — Concurrency and runtime: races, ordering, code that will error at runtime.
Pass 4 — Data completeness: for every new or changed state, type, field or event, list EVERY consumer in the repo (code, queries, types, UI, seeds, tests, jobs) and say for each whether it handles the change. List what you checked, not only what is broken.
Pass 5 — Tests: for each scenario and each negative/permission path, name the covering test or state it is untested.
Pass 6 — Documentation and tracking: statements in docs, AGENTS.md, TASKS.md, spec and plan that are now false or missing; references to files that do not exist.
Pass 7 — Configuration and tooling: do permissions, hooks and guards enforce what their docs claim? ("not in scope" if none changed.)
{{PROJECT-SPECIFIC PASS, optional}}

OUTPUT
Per pass: findings with severity, file:line, what is wrong, a concrete failure scenario, confidence, IN-SCOPE or FOLLOW-UP.
Then one combined list, most severe first.

REMINDER (restated on purpose): read-only; review only {{range}}; every finding needs a file:line you opened; UNKNOWN instead of guessing; no questions.
