TASK: {{one sentence}}
WORK PACKAGE / SLICE: {{WP-NN / slice id}}    SIZE: {{XS|S|M}}
ATTEMPT: {{1|2|3}} of 3    (attempt >1: WHAT CHANGED SINCE LAST ATTEMPT: {{...}})
FILES YOU MAY EDIT: {{exact paths}}
FILES YOU MAY READ: {{exact paths}}
MIRROR THIS FILE: {{one existing file that does something similar}}
DO NOT: explore other files; add dependencies; run git write commands, installs, database or deploy commands; delete or move anything you did not create
CONTEXT: {{signatures, types, contracts, exact names/strings that are fixed — pasted inline. Not the solution.}}
ACCEPTANCE CRITERIA:
  - {{concrete example or boundary case, checkable}}
  - `{{check command}}` passes   (or: "you cannot run this; fix statically, the orchestrator verifies")
COMMANDS YOU MAY RUN: {{exact list}}. These may exit non-zero without being an error: {{e.g. grep with no match}}
MAX DIFF: {{≈20 | ≈100 | ≈300}} changed lines
IF BLOCKED OR A DECISION IS NEEDED: stop and output a block starting with NEEDS-DECISION:
REPORT: files changed; raw command output; what you did not verify; follow-ups noticed (do not do them)
