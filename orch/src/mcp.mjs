// `orch mcp` - a stdio MCP server in front of the orch CLI (slice 3, deliverable 4).
//
// NO SECOND IMPLEMENTATION. Every tool call is turned into the argv the matching CLI
// command takes, parsed by the CLI's own `parseArgs`, and run by the CLI's own
// `runCommand` (src/cli.mjs) with `--json`. The tool result carries exactly what the CLI
// would have printed, plus the CLI's exit code.
//
// PROMPT RETURNS. Every tool is job-id based and bounded: `run` returns at admission (the
// keeper/monitor are detached, as for the CLI), `review` is always `--no-wait` (finish it
// later with `review_finish`), `wait_lane` has a short default and a hard cap, and every
// call has an outer bound after which it answers `undetermined` instead of hanging.
//
// PROTOCOL. Hand-rolled newline-delimited JSON-RPC 2.0 over stdio (no runtime dependency).
// Dual-era per the MCP versioning page: legacy clients use the `initialize` handshake
// (2024-11-05 .. 2025-11-25); modern clients (2026-07-28) put the protocol version in
// `params._meta` on every request and may call `server/discover`. stdout carries protocol
// messages only; everything else goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs, runCommand } from './cli.mjs';
import { OrchError } from './errors.mjs';

const PKG = path.resolve(fileURLToPath(new URL('../package.json', import.meta.url)));
const SERVER_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(PKG, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO = { name: 'orch', version: SERVER_VERSION };
/**
 * Caching hints. In the 2026-07-28 revision `server/discover` and `tools/list` results MUST carry `ttlMs`
 * (integer >= 0, milliseconds) and `cacheScope`. The tool list is identical for every caller and fixed for the
 * life of the process, so it is `public`. Legacy (initialize-based) results never carry these fields.
 */
const DISCOVER_CACHE = { ttlMs: 3600000, cacheScope: 'public' };
const LIST_CACHE = { ttlMs: 300000, cacheScope: 'public' };

/** wait_lane: default and hard cap, in seconds. */
export const WAIT_LANE_DEFAULT_S = 20;
export const WAIT_LANE_MAX_S = 55;
/** The outer bound on any tool call, unless the tool sets its own. */
export const DEFAULT_BOUND_MS = 120000;

const INSTRUCTIONS =
  'orch launches and supervises worker CLI runs (opencode, vibe, codex, agy, copilot, muse, aider, claude) and records the ' +
  'work-package workflow. Never start a worker CLI directly: use `run`. Every tool returns promptly; a run is ' +
  'watched with `status` / `log_tail`, never by waiting. A stall is advisory; cancel only with a stated reason. ' +
  'Protocol: ORCHESTRATOR.md in the cli-agentic-coordinator repository.';

/* ------------------------------------------------------------ tool table -- */

const S = (description) => ({ type: 'string', description });
const B = (description) => ({ type: 'boolean', description });
const N = (description) => ({ type: ['integer', 'string'], description });
const A = (description) => ({ type: 'array', items: { type: 'string' }, description });

const LAUNCH_OPTS = {
  'routing-policy': S('--routing-policy <private task-fit policy>'),
  task: S('--task <typed task JSON file>'),
  profile: S('--profile <selected exact execution profile>'),
  'routing-mode': S('--routing-mode qualified|qualification'),
  size: S('--size XS|S|M (quota forecast size)'),
  'quota-policy': S('--quota-policy <private subscription policy>'),
  capability: S('--capability <explicit equivalence group>'),
  'quota-purpose': S('--quota-purpose normal|retry (forecast reserve class)'),
  agent: S('--agent <name> (opencode/vibe agent)'),
  flag: A('--flag <x>, repeatable: extra adapter flags'),
  'max-turns': N('--max-turns N'),
  'max-price': S('--max-price X (vibe)'),
  effort: S('--effort <e>'),
  'print-timeout': S('--print-timeout <t> (agy)'),
  'allow-non-ascii': B('--allow-non-ascii'),
  'no-window': B('--no-window: do not open the visible viewer window'),
  'owner-approved-model': B('--owner-approved-model: required for models the roster marks requires_permission'),
};

/**
 * name -> { cmd, sub?: fixed leading positionals, pos?: [{key, desc, required}], opts, required?,
 *           force?: args forced after parsing, boundMs?, description }
 * Option keys are the CLI flag names, so the schema reads like the CLI usage.
 */
export const TOOLS = {
  setup_repository_close:{cmd:'setup',sub:['repository-close'],description:'Explicitly close one failed or abandoned repository trial after terminal process/run checks. Retains source, records blocked outcomes and uses existing cleanup; never kills or relaunches.',opts:{session:S('Private completed setup session'),request:S('offerHash/approve:true JSON')},required:['session','request']},
  setup_repository_smoke:{cmd:'setup',sub:['repository-smoke'],description:'Offer one disposable adopted-repository controller coding/review case. No model call or owner activation.',opts:{session:S('Private completed setup session'),config:S('Private runtime config'),request:S('worker/reviewer/maxAgeSeconds JSON')},required:['session','config','request']},
  setup_repository_start:{cmd:'setup',sub:['repository-start'],description:'Prepare an exact-approved repository fixture with owner-preserving adoption and an ordinary-tool scope guard; no model launch.',opts:{session:S('Private completed setup session'),request:S('offerHash/approve:true JSON')},required:['session','request']},
  setup_repository_run:{cmd:'setup',sub:['repository-run'],description:'Reserve and launch one exact-approved native repository controller. Unknown launch outcomes are never retried automatically.',opts:{session:S('Private completed setup session'),request:S('offerHash/approve:true JSON')},required:['session','request']},
  setup_repository_qualify:{cmd:'setup',sub:['repository-qualify'],description:'Verify actual native repository tools/models, independent code/review checks and complete cleanup before capturing a scoped receipt.',opts:{session:S('Private completed setup session'),request:S('offerHash JSON')},required:['session','request']},
  setup_repository_qualification:{cmd:'setup',sub:['repository-qualification'],description:'Validate fresh repository-controller receipts. No model calls, policy changes or launch permission.',opts:{session:S('Private completed setup session'),config:S('Private runtime config')},required:['session','config']},
  setup_controller_smoke:{cmd:'setup',sub:['controller-smoke'],description:'Offer a scoped native controller lifecycle using owned child routes; no model calls or launch authority.',opts:{session:S('--session <completed private session>'),config:S('--config <private runtime config>'),request:S('--request <worker/reviewer/maxAgeSeconds JSON>')},required:['session','config','request']},
  setup_controller_start:{cmd:'setup',sub:['controller-start'],description:'Prepare an exact approved controller offer and its fixed native lifecycle instructions; no model launch.',opts:{session:S('--session <private session>'),request:S('--request <offerHash/approve:true JSON>')},required:['session','request']},
  setup_controller_run:{cmd:'setup',sub:['controller-run'],description:'Start one exact-approved native subscription controller with durable launch/process/log evidence. Never repeats an uncertain spawn.',opts:{session:S('--session <private session>'),request:S('--request <offerHash/approve:true JSON>')},required:['session','request']},
  setup_controller_step:{cmd:'setup',sub:['controller-step'],description:'Perform one fixed approved controller lifecycle step. Mutating uncertainty is retained without automatic retries; monitor steps may poll.',opts:{session:S('--session <private session>'),request:S('--request <offerHash/approve:true/step JSON>')},required:['session','request']},
  setup_controller_qualify:{cmd:'setup',sub:['controller-qualify'],description:'Capture complete native controller tool/model, claim, child, review and closure proof. Missing or changed evidence cannot qualify.',opts:{session:S('--session <private session>'),request:S('--request <offerHash JSON>')},required:['session','request']},
  setup_controller_qualification:{cmd:'setup',sub:['controller-qualification'],description:'Validate and reuse fresh scoped controller lifecycle receipts, without model calls or owner policy changes.',opts:{session:S('--session <private session>'),config:S('--config <private runtime config>')},required:['session','config']},
  setup_smoke:{cmd:'setup',sub:['smoke'],description:'Offer a private read-only worker/reviewer access smoke for selected subscription routes. Explicit indexes/freshness request; no model calls or owner repository changes.',opts:{session:S('--session <completed private session>'),config:S('--config <private runtime config>'),request:S('--request <worker/reviewer indexes and maxAgeSeconds JSON>')},required:['session','config','request']},
  setup_task_smoke:{cmd:'setup',sub:['task-smoke'],description:'Offer a representative coding/review capability case; no model calls or policy activation.',opts:{session:S('--session <completed private session>'),config:S('--config <private runtime config>'),request:S('--request <worker/reviewer/caseId/maxAgeSeconds JSON>')},required:['session','config','request']},
  setup_task_start:{cmd:'setup',sub:['task-start'],description:'Prepare one exact-approved owned capability fixture; no model launch.',opts:{session:S('--session <private session>'),request:S('--request <offerHash/approve:true JSON>')},required:['session','request']},
  setup_task_step:{cmd:'setup',sub:['task-step'],description:'Execute one fixed approved capability lifecycle step, without retries of uncertain mutations.',opts:{session:S('--session <private session>'),request:S('--request <offerHash/approve:true/step JSON>')},required:['session','request']},
  setup_task_qualify:{cmd:'setup',sub:['task-qualify'],description:'Capture exact-model task, independent verifier/review, cleanup and claim proof; no general capability or launch permission.',opts:{session:S('--session <private session>'),request:S('--request <offerHash JSON>')},required:['session','request']},
  setup_task_qualification:{cmd:'setup',sub:['task-qualification'],description:'Reuse fresh measured task-case evidence and disabled routing proposals without model calls or policy changes.',opts:{session:S('--session <private session>'),config:S('--config <private runtime config>')},required:['session','config']},
  setup_task_close:{cmd:'setup',sub:['task-close'],description:'Explicitly close a failed or abandoned owned trial, retain source evidence and release its claim after terminal jobs and cleanup; never kills or relaunches agents.',opts:{session:S('--session <private session>'),request:S('--request <offerHash/approve:true JSON>')},required:['session','request']},
  setup_probe:{cmd:'setup',sub:['probe'],description:'Launch one explicitly approved worker or reviewer access probe through existing orch machinery, with API overrides removed. Exclusive attempts; uncertain attempts are never relaunched automatically.',opts:{session:S('--session <private session>'),request:S('--request <offerHash/approve:true/role JSON>')},required:['session','request']},
  setup_qualify:{cmd:'setup',sub:['qualify'],description:'Capture exact-model access proof only after terminal run evidence and clean independent review/removal. No model calls, policy enablement or task-quality qualification.',opts:{session:S('--session <private session>'),request:S('--request <offerHash JSON>')},required:['session','request']},
  setup_qualification:{cmd:'setup',sub:['qualification'],description:'Read and reuse unexpired qualification receipts after validating executable/config/source bindings. Missing or changed evidence remains unqualified; no model calls.',opts:{session:S('--session <private session>'),config:S('--config <private runtime config>')},required:['session','config']},
  setup_health:{cmd:'setup',sub:['health'],description:'Read current setup configuration, executable discovery, policy completeness and cached subscription freshness by role. No harness calls, credential reads, collector refresh, qualification or configuration changes.',opts:{session:S('--session <completed private session>'),config:S('--config <private runtime config outside target repo>')},required:['session','config']},
  setup_preview:{cmd:'setup',sub:['preview'],description:'Preview additive private configuration and optional controller adoption. Existing conflicting settings block writes. No provider, credential, global registration or cleanup actions.',opts:{session:S('--session <completed private session>'),config:S('--config <private runtime config outside target repo>'),adopt:B('--adopt: preview controller instruction adoption'),update:B('--update: refresh unchanged owned adoption payloads')},required:['session','config']},
  setup_apply:{cmd:'setup',sub:['apply'],description:'Apply explicitly approved previewHash/approve:true from a private JSON file. Rechecks config and adoption inputs, preserves owner instructions, records partial writes; no launches or qualification.',opts:{session:S('--session <completed private session>'),approval:S('--approval <private exact preview approval JSON>')},required:['session','approval']},
  setup_receipt:{cmd:'setup',sub:['receipt'],description:'Read setup apply outcome and completed writes. Interrupted attempts require a fresh approved preview; no automatic rollback.',opts:{session:S('--session <private session>'),preview:S('--preview <exact previewHash>')},required:['session','preview']},
  setup_start:{cmd:'setup',sub:['start'],description:'Start or resume a private onboarding question session for any supported controlling harness. Checks installed executables without login or inference. No configuration/adoption/policy activation.',opts:{repo:S('--repo <existing Git root>'),harness:S('--harness claude|codex|opencode|vibe|copilot|muse'),session:S('--session <private directory outside target repo>'),catalog:S('--catalog <optional generic metadata>'),roster:S('--roster <optional explicit owner choices>')},required:['repo','harness','session']},
  setup_status:{cmd:'setup',sub:['status'],description:'Read the next unanswered setup question and accepted choices without writing, prompting on stdin or contacting providers.',opts:{session:S('--session <private directory>')},required:['session']},
  setup_answer:{cmd:'setup',sub:['answer'],description:'Record one explicit revision-bound structured answer from a private JSON file. Never overwrites an answer, activates settings or reads credentials.',opts:{session:S('--session <private directory>'),answers:S('--answers <expectedRevision/questionId/answer JSON>')},required:['session','answers']},
  setup_proposal:{cmd:'setup',sub:['proposal'],description:'Read completed onboarding intent and honest installed/unqualified readiness. No apply/activation, installations, auth, model calls, purge or scheduler.',opts:{session:S('--session <private directory>')},required:['session']},
  modelrouter_catalog: {
    cmd: 'modelrouter', sub: ['catalog'],
    description: 'Read source-backed generic model metadata. No network, model calls, owner roster changes or launch authority.',
    opts: {catalog: S('--catalog <versioned catalogue JSON>')},
  },
  modelrouter_update: {
    cmd: 'modelrouter', sub: ['update'],
    description: 'Preview a source-backed catalogue proposal. Explicit apply requires a private catalogue and exact preview approval; saves snapshots. Generic metadata never enables models or changes access, permissions or qualification.',
    opts: {catalog: S('--catalog <base JSON>'),proposal: S('--proposal <structured update JSON>'),'dry-run': B('--dry-run (preview only)'),apply:B('--apply (requires explicit private catalogue and approval)'),approval:S('--approval <preview approvalHash>'),roster: S('--roster <optional owner links JSON>'),'routing-policy': S('--routing-policy <optional owner profile links JSON>')},
    required: ['proposal'],
  },
  modelrouter_history:{cmd:'modelrouter',sub:['history'],description:'Read bounded private catalogue snapshots and interrupted publication outcomes without creating files or changing settings.',opts:{catalog:S('--catalog <private JSON>')},required:['catalog']},
  modelrouter_rollback:{cmd:'modelrouter',sub:['rollback'],description:'Preview restoring exact previous catalogue bytes. Explicit apply and preview approval are required; unrelated current revisions are preserved.',opts:{catalog:S('--catalog <private JSON>'),snapshot:S('--snapshot <transaction ID>'),'dry-run':B('--dry-run'),apply:B('--apply'),approval:S('--approval <preview approvalHash>')},required:['catalog','snapshot']},
  modelrouter_recover:{cmd:'modelrouter',sub:['recover'],description:'Preview resolving an interrupted catalogue journal from verified before/after bytes. Explicit apply and approval record its outcome; never replace catalogue bytes or take over stale locks.',opts:{catalog:S('--catalog <private JSON>'),snapshot:S('--snapshot <transaction ID>'),'dry-run':B('--dry-run'),apply:B('--apply'),approval:S('--approval <preview approvalHash>')},required:['catalog','snapshot']},
  quota: {
    cmd: 'quota',
    description: 'Shared subscription quota headroom, controller warnings and estimated launch holds. Cached reads do not mutate. Explicit refresh runs bounded telemetry helpers and reconciles proven finished holds. Never changes inference billing, running jobs or controller claims.',
    opts: {'quota-policy': S('--quota-policy <private policy>'), refresh: B('--refresh')},
    boundMs: 90000,
  },
  usage: {
    cmd: 'usage',
    description: 'Shared subscription usage for configured controller, worker and reviewer billing pools. Cached status launches and writes nothing. Explicit refresh runs bounded telemetry helpers, respects per-pool cooldown and retains stale evidence and isolated errors; it never changes inference billing or admission.',
    opts: { config: S('--config <private usage configuration>'), refresh: B('--refresh: collect subscribed pool observations'), pool: S('--pool <configured pool alias>'), role: S('--role controller|worker|reviewer') },
    boundMs: 90000,
  },
  maintain: {
    cmd: 'maintain',
    description: 'orch maintain: read-only retention preview, opt-in exact transcript collection, explicit legacy enrollment and investigation pins. Preserves compact results and process/model evidence.',
    opts: { kind: S('--kind transcripts|metadata|all (default transcripts)'), 'dry-run': B('--dry-run'), apply: B('--apply'), run: S('--run <id> (scoped collection)'), review: S('--review <id> (metadata only)'), after: S('--after <id> (resume bounded inventory)'), enroll: S('--enroll <id>'), pin: S('--pin <id>'), unpin: S('--unpin <id>'), by: S('--by <operator>'), reason: S('--reason <text>') },
    required: [],
  },
  run: {
    cmd: 'run',
    description:
      'orch run: launch ONE worker run (the only allowed way to start a worker CLI). Returns at admission with the job id ' +
      '(lane-busy = exit 3, nothing started). Then monitor with status / log_tail.',
    opts: {
      cli: S('--cli <opencode|vibe|codex|agy|copilot|muse|aider|claude>'),
      model: S('--model <id>'),
      dir: S('--dir <worktree> (absolute path)'),
      handoff: S('--handoff <file> (the prompt file)'),
      lane: S('--lane local|cloud'),
      wp: S('--wp <WP> (requires the claim)'),
      slice: S('--slice <id>'),
      by: S('--by <claude-code|codex|opencode|vibe|owner>'),
      allow: A('--allow <path>, repeatable: the allowlist (the handoff ALLOW: block is read too)'),
      size: S('--size XS|S|M'),
      ...LAUNCH_OPTS,
    },
    required: ['cli', 'dir', 'handoff'],
    boundMs: 120000,
  },
  status: {
    cmd: 'status',
    description: 'orch status <id> | --all: read-only live status of a run (process identity, activity, lane). Writes nothing.',
    pos: [{ key: 'id', desc: 'run id (omit with all=true)' }],
    opts: { all: B('--all: every run') },
  },
  result: {
    cmd: 'result',
    description: 'orch result <id>: the final message, status, exit code and model actually used. Read-only.',
    pos: [{ key: 'id', desc: 'run id', required: true }],
    opts: {},
  },
  log_tail: {
    cmd: 'log',
    description: 'orch log <id> --tail N: the last N lines of one of the run logs (default 200 lines of stderr). Read-only.',
    pos: [{ key: 'id', desc: 'run id', required: true }],
    opts: { tail: N('--tail N (default 200)'), stream: S('--stream stderr|stdout|keeper|events (default stderr)') },
    defaults: { tail: '200' },
    text: true,
  },
  cancel: {
    cmd: 'cancel',
    description:
      'orch cancel <id>: tree-kill the recorded MAIN worker of a run, identity-checked; reports cancelled only when it is ' +
      'verified gone (exit 3 = unconfirmed). State the reason to the owner before cancelling. (cancel --keeper stays CLI-only.)',
    pos: [{ key: 'id', desc: 'run id', required: true }],
    opts: {},
  },
  wait_lane: {
    cmd: 'wait-lane',
    description: `orch wait-lane: wait (bounded) for a lane to be free; never binds it. Default ${WAIT_LANE_DEFAULT_S} s, capped at ${WAIT_LANE_MAX_S} s; exit 3 = still held.`,
    opts: { lane: S('--lane local|cloud (default local)'), timeout: N(`--timeout <s> (default ${WAIT_LANE_DEFAULT_S}, max ${WAIT_LANE_MAX_S})`) },
  },
  claim: {
    cmd: 'claim',
    description: 'orch claim <WP>: take the exclusive work-package lock before any worktree or run (exit 3 = held by another).',
    pos: [{ key: 'wp', desc: 'work package id', required: true }],
    opts: { by: S('--by <claude-code|codex|opencode|vibe|owner>'), session: S('--session <s>'), note: S('--note <t>') },
    required: ['by'],
  },
  release: {
    cmd: 'release',
    description: 'orch release <WP>: release a claim (holder only; force needs a reason and is recorded).',
    pos: [{ key: 'wp', desc: 'work package id', required: true }],
    opts: { by: S('--by <x>'), force: B('--force'), reason: S('--reason <t> (required with force)') },
    required: ['by'],
  },
  claims: {
    cmd: 'claims',
    description: 'orch claims: every claim with its age; never reclaimed automatically. Read-only.',
    opts: {},
  },
  cleanup: {
    cmd: 'cleanup',
    description: 'Preview owned WP resources with dry-run, or explicitly apply safe cleanup. Active/uncertain dependencies and valuable content are retained; failed removals can be retried.',
    opts: { wp: S('--wp <WP>'), 'dry-run': B('--dry-run: read-only inventory'), apply: B('--apply: recheck and remove eligible owned resources'), by: S('--by <claim holder or recorded closing identity>'), retain: S('--retain <JSON decision file: id, reason, revisit>') },
    required: ['wp'],
    boundMs: 120000,
  },
  finish: {
    cmd: 'finish',
    description: 'Finalize a WP after all runs have dispositions and reviews/gates are finalized. Records cleanup decisions before releasing its claim; retries pending cleanup without rewriting review findings.',
    pos: [{ key: 'wp', desc: 'work package id', required: true }],
    opts: { by: S('--by <holder>'), retain: S('--retain <JSON decision file: id, reason, revisit>') },
    required: ['by'],
    boundMs: 120000,
  },
  worktree_create: {
    cmd: 'worktree',
    sub: ['create'],
    description: 'orch worktree create: branch orch/<wp>/<slice> in <repo>/.worktrees/<wp>-<slice>, baseline recorded. Needs the claim.',
    opts: { repo: S('--repo <path>'), wp: S('--wp <WP>'), slice: S('--slice <id>'), by: S('--by <x>'), base: S('--base <ref>') },
    required: ['repo', 'wp', 'slice', 'by'],
  },
  worktree_list: {
    cmd: 'worktree',
    sub: ['list'],
    description: 'orch worktree list: the orch-recorded worktrees. Read-only.',
    opts: {},
  },
  scope: {
    cmd: 'scope',
    description: 'orch scope <run>: changed + untracked paths vs the allowlist (pass 0 / fail 3 / unknown 4). Needs a finished run.',
    pos: [{ key: 'run_id', desc: 'implementer run id', required: true }],
    opts: {},
  },
  review: {
    cmd: 'review',
    description:
      'orch review --no-wait: launch a read-only reviewer (never the implementer\'s canonical model) in a detached throwaway ' +
      'worktree. Returns at launch; call review_finish once the reviewer run has ended.',
    opts: {
      run: S('--run <implementer run id>'),
      ref: S('--ref <commit>'),
      reviewer: S('--reviewer <cli>'),
      model: S('--model <id>'),
      prompt: S('--prompt <file> ({{WORKTREE}} is filled in)'),
      by: S('--by <x>'),
      blind: A('--blind <glob>, repeatable'),
      'review-root': S('--review-root <dir>'),
      ...LAUNCH_OPTS,
    },
    required: ['run', 'ref', 'reviewer', 'model', 'prompt', 'by'],
    force: { 'no-wait': true },
    boundMs: 120000,
  },
  review_finish: {
    cmd: 'review',
    description: 'orch review --finish <review-id> --by <x>: containment check and worktree removal after the reviewer ended (refused while it runs).',
    pos: [{ key: 'review_id', desc: 'review id (rv-...)', required: true, flag: 'finish' }],
    opts: { by: S('--by <x> (required when the review belongs to a work package)') },
  },
  gate_record: {
    cmd: 'gate',
    sub: ['record'],
    description: 'orch gate record: record one review round (graded findings, own verification, scope) and get the decision.',
    opts: {
      wp: S('--wp <WP>'),
      slice: S('--slice <id>'),
      round: N('--round <n>'),
      findings: S('--findings <json|file>'),
      verification: S('--verification pass|fail'),
      scope: S('--scope pass|fail (or use scope-run)'),
      'scope-run': S('--scope-run <run-id>'),
      'override-reason': S('--override-reason <t>'),
      by: S('--by <x>'),
    },
    required: ['wp', 'slice', 'round', 'findings', 'verification'],
  },
  gate_status: {
    cmd: 'gate',
    sub: ['status'],
    description: 'orch gate status: the recorded rounds and the current decision. Read-only.',
    opts: { wp: S('--wp <WP>'), slice: S('--slice <id>') },
    required: ['wp', 'slice'],
  },
  record: {
    cmd: 'record',
    description: 'orch record <run>: append the ledger row for a finished run (once per run).',
    pos: [{ key: 'run_id', desc: 'run id', required: true }],
    opts: {
      disposition: S('--disposition accepted|accepted-with-fixes|rejected|blocked|inconclusive-timeout|failed-launch'),
      notes: S('--notes <t>'),
      attempt: N('--attempt N'),
      turns: N('--turns N'),
      checks: S('--checks <json>'),
      ledger: S('--ledger <file>'),
      project: S('--project <name>'),
      quirks: S('--quirks <t>'),
      'handoff-version': S('--handoff-version <v>'),
      'cold-or-warm': S('--cold-or-warm cold|warm'),
      'credits-or-cost': S('--credits-or-cost <x>'),
      'controller-intervened': B('--controller-intervened'),
      size: S('--size XS|S|M'),
    },
    required: ['disposition'],
  },
  pick: {
    cmd: 'pick',
    description: 'orch pick: propose an eligible model from the ledger; reviewer differs from implementer. An enabled quota policy allocates equal-capability useful work across subscription reset cycles. Cached reads are read-only; explicit refresh collects usage and reconciles confirmed holds. Explicit advice can contact Jev and write bounded private accounting only with an enabled adviser policy and key; no launch authority. Admission rechecks and reserves at launch.',
    opts: { workload: S('--workload implement|review'), size: S('--size XS|S|M'), 'for-run': S('--for-run <id> (review picks)'), ledger: S('--ledger <file>'), roster: S('--roster <file>'), 'quota-policy': S('--quota-policy <file>'), capability: S('--capability <equivalence group>'), 'quota-purpose': S('--quota-purpose normal|retry'), refresh: B('--refresh'), 'routing-policy': S('--routing-policy <private task-fit policy>'), task: S('--task <typed task JSON>'), 'routing-mode': S('--routing-mode qualified|qualification'), advice: B('--advice: request explicitly enabled Jev advice'), 'advice-policy': S('--advice-policy <private adviser policy>') },
    required: ['workload', 'size'],
  },
};

export function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => {
    const properties = {};
    const required = [];
    for (const p of t.pos || []) {
      properties[p.key] = S(p.desc);
      if (p.required) required.push(p.key);
    }
    Object.assign(properties, t.opts);
    for (const r of t.required || []) required.push(r);
    return {
      name,
      description: t.description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
    };
  });
}

class ToolInputError extends Error {}

/**
 * Tool arguments -> the CLI argv of the same command. Positional values may not look like
 * flags (they would be parsed as one).
 * @returns {string[]}
 */
export function toArgv(name, input) {
  const t = TOOLS[name];
  const argv = [...(t.sub || [])];
  const given = { ...(t.defaults || {}), ...(input || {}) };
  const known = new Set([...(t.pos || []).map((p) => p.key), ...Object.keys(t.opts)]);
  for (const k of Object.keys(given)) {
    if (!known.has(k)) throw new ToolInputError(`unknown argument "${k}" for ${name}`);
  }
  for (const r of [...(t.pos || []).filter((p) => p.required).map((p) => p.key), ...(t.required || [])]) {
    if (given[r] == null || given[r] === '') throw new ToolInputError(`missing required argument "${r}" for ${name}`);
  }
  for (const p of t.pos || []) {
    const v = given[p.key];
    if (v == null) continue;
    const s = String(v);
    if (s.startsWith('-')) throw new ToolInputError(`${p.key} may not start with "-": ${s}`);
    if (p.flag) argv.push(`--${p.flag}`, s);
    else argv.push(s);
  }
  for (const [k, spec] of Object.entries(t.opts)) {
    const v = given[k];
    if (v == null) continue;
    if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') throw new ToolInputError(`${k} must be a boolean`);
      if (v) argv.push(`--${k}`);
    } else if (spec.type === 'array') {
      if (!Array.isArray(v)) throw new ToolInputError(`${k} must be an array of strings`);
      for (const x of v) argv.push(`--${k}`, String(x));
    } else {
      if (typeof v === 'object') throw new ToolInputError(`${k} must be a string`);
      argv.push(`--${k}`, String(v));
    }
  }
  return argv;
}

/** wait_lane's effective --timeout: the default when absent, capped; null when invalid. */
export function waitLaneSeconds(v) {
  const req = v != null ? Number(v) : WAIT_LANE_DEFAULT_S;
  if (!Number.isFinite(req) || req < 0) return null;
  return Math.min(req, WAIT_LANE_MAX_S);
}

/**
 * Run one tool call through the CLI path. Never throws.
 * @param {string} name
 * @param {any} input
 * @param {{stateRoot?:string|null}} [opts]
 */
export async function callTool(name, input, { stateRoot } = {}) {
  if (!Object.hasOwn(TOOLS, name)) return toolError(`unknown tool: ${name}`, 2, 'unknown-tool');
  const t = TOOLS[name];
  let args;
  try {
    const argv = toArgv(name, input);
    args = parseArgs(argv);
  } catch (e) {
    return toolError(`invalid arguments: ${e.message}`, 2, 'invalid-arguments');
  }
  if (!t.text) args.json = true;
  Object.assign(args, t.force || {});
  // Health is explicitly bound to its completed setup session, not server state.
  if (stateRoot && !args['state-root'] && !name.startsWith('setup_controller_') && !name.startsWith('setup_task_') && !name.startsWith('setup_repository_') && !['setup_health','setup_smoke','setup_probe','setup_qualify','setup_qualification'].includes(name)) args['state-root'] = stateRoot;
  let boundMs = t.boundMs || DEFAULT_BOUND_MS;
  if (name === 'wait_lane') {
    const s = waitLaneSeconds(args.timeout);
    if (s == null) return toolError('invalid arguments: timeout must be a number of seconds >= 0', 2, 'invalid-arguments');
    args.timeout = String(s);
    boundMs = (s + 10) * 1000;
  }

  // Operator/test knob: a lower outer bound for every call.
  const envBound = Number(process.env.ORCH_MCP_BOUND_MS);
  if (Number.isFinite(envBound) && envBound > 0) boundMs = Math.min(boundMs, envBound);

  const lines = [];
  const io = { log: (s) => lines.push(String(s)) };
  let timer = null;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), boundMs);
  });
  // FIX a1: the work promise NEVER rejects - its failure is a value. If the bound wins the
  // race, a later failure of the abandoned work is logged, not an unhandled rejection that
  // would take the whole server down.
  let settled = false;
  const work = Promise.resolve()
    .then(() => runCommand(t.cmd, args, io))
    .then(
      (v) => ({ value: v }),
      (e) => {
        if (settled) process.stderr.write(`orch mcp: ${name} failed after its bound: ${(e && e.message) || e}\n`);
        return { error: e };
      },
    );
  let r;
  try {
    r = await Promise.race([work, bound]);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
  if (r.error) {
    const e = r.error;
    if (e instanceof OrchError) return toolError(`orch: ${e.message}`, 2, e.code || 'orch-error', lines);
    return toolError(`orch: unexpected error: ${(e && e.message) || e}`, 1, 'unexpected', lines);
  }
  if (r.timedOut) {
    return toolError(
      `undetermined: ${name} exceeded ${boundMs} ms. The operation may still complete in the server; check with status / claims before retrying.`,
      4,
      'bound-exceeded',
      lines,
    );
  }
  const value = r.value;
  const exitCode = value && typeof value.exitCode === 'number' ? value.exitCode : 0;
  const text = lines.join('\n');
  let output = null;
  if (!t.text) {
    try {
      output = JSON.parse(text);
    } catch {
      output = null;
    }
  }
  const content = [{ type: 'text', text }];
  if (exitCode !== 0) content.push({ type: 'text', text: `orch exit code: ${exitCode}` });
  return { content, structuredContent: { exit_code: exitCode, output }, isError: false };
}

function toolError(message, exitCode, code, lines = []) {
  const text = [...lines, message].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text }], structuredContent: { exit_code: exitCode, error: code, output: null }, isError: true };
}

/* ------------------------------------------------------------- protocol -- */

const err = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * Handle one decoded JSON-RPC message. Returns the response object, or null for a
 * notification / a response to a request we never sent.
 * @param {any} msg
 * @param {{stateRoot:string|null, legacyVersion:string|null}} ctx
 */
export async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
    return err(msg && msg.id, -32600, 'Invalid Request');
  }
  const isRequest = typeof msg.method === 'string' && Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
  if (typeof msg.method !== 'string') return null; // a response: we send no requests
  if (!isRequest) return null; // notifications (initialized, cancelled, ...) need no answer
  const id = msg.id;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : null;
  const modernVersion = meta && typeof meta[META_VERSION] === 'string' ? meta[META_VERSION] : null;
  if (modernVersion && !MODERN_VERSIONS.includes(modernVersion)) {
    return err(id, -32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: modernVersion });
  }
  const modern = !!modernVersion;
  const complete = (result) => (modern ? { resultType: 'complete', ...result } : result);
  const capabilities = { tools: { listChanged: false } };

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const protocolVersion = asked && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0];
      ctx.legacyVersion = protocolVersion;
      return ok(id, { protocolVersion, capabilities, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'server/discover':
      return ok(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities,
        ...DISCOVER_CACHE,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok(id, complete({}));
    case 'tools/list':
      return ok(id, complete({ tools: toolList(), ...(modern ? LIST_CACHE : {}) }));
    case 'tools/call': {
      const name = params.name;
      // FIX a4: own properties only - `toString`, `constructor`, `__proto__` are not tools.
      if (typeof name !== 'string' || !Object.hasOwn(TOOLS, name)) return err(id, -32602, `Unknown tool: ${name}`);
      const args = params.arguments == null ? {} : params.arguments;
      if (typeof args !== 'object' || Array.isArray(args)) return err(id, -32602, 'arguments must be an object');
      const result = await callTool(name, args, { stateRoot: ctx.stateRoot });
      return ok(id, complete(result));
    }
    default:
      return err(id, -32601, `Method not found: ${msg.method}`);
  }
}

/**
 * Serve MCP on stdin/stdout until stdin ends. Requests are handled concurrently; each
 * answer is written as one line as soon as it is ready.
 */
export async function serveMcp({ stateRoot = null, input = process.stdin, output = process.stdout } = {}) {
  // Nothing but protocol messages may reach stdout.
  console.log = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);
  console.debug = (...a) => console.error(...a);
  const ctx = { stateRoot, legacyVersion: null };
  // FIX a2: a write to a pipe the client closed fails ASYNCHRONOUSLY (an 'error' event, e.g.
  // EPIPE); without a listener that event would crash the server.
  let outputBroken = false;
  output.on('error', (e) => {
    if (!outputBroken) process.stderr.write(`orch mcp: stdout closed (${(e && e.code) || e}); answers are dropped\n`);
    outputBroken = true;
  });
  // FIX a1 (second line of defence): nothing that escapes a handler may end the server.
  process.on('unhandledRejection', (/** @type {any} */ e) => process.stderr.write(`orch mcp: unhandled rejection (kept serving): ${(e && e.message) || e}\n`));
  process.on('uncaughtException', (e) => process.stderr.write(`orch mcp: uncaught exception (kept serving): ${(e && e.message) || e}\n`));
  const write = (obj) => {
    if (outputBroken) return;
    try {
      output.write(JSON.stringify(obj) + '\n');
    } catch {
      /* the client went away */
    }
  };
  const inflight = new Set();
  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write(err(null, -32700, 'Parse error'));
      return;
    }
    const p = (async () => {
      if (Array.isArray(msg)) {
        if (!msg.length) return write(err(null, -32600, 'Invalid Request'));
        const answers = (await Promise.all(msg.map((m) => handleMessage(m, ctx).catch((e) => err(m && m.id, -32603, String(e)))))).filter(Boolean);
        if (answers.length) write(answers);
        return;
      }
      const answer = await handleMessage(msg, ctx).catch((e) => err(msg && msg.id, -32603, `Internal error: ${(e && e.message) || e}`));
      if (answer) write(answer);
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  });
  await new Promise((resolve) => rl.once('close', resolve));
  // stdin ended: give in-flight calls a short, bounded chance to answer.
  await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 5000).unref())]);
}
