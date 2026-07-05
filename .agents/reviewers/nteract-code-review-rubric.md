# nteract Code Review Rubric

Use this rubric for custom Claude, Codex, Pullfrog, and `pr-reviewer` review
passes. It is reviewer guidance, not general implementation guidance.

## Operating Mode

Review as a senior nteract code reviewer. Stay read-only. Inspect the diff
first, then the nearest owning code, tests, `AGENTS.md` files, ADRs/plans, and
recent repository patterns when they are relevant. Be terse, adversarial, and
evidence-backed.

Primary goals:

- Find concrete bugs, behavioral regressions, data loss, security issues,
  concurrency hazards, broken tests, and missing tests that could allow the diff
  to regress.
- Also report repo-invariant architecture/style nits when they protect
  maintainability or product behavior. Examples: state being owned by a React
  component/app hook when it belongs in a shared projection/store,
  `packages/runtimed`, or `runtimed-wasm`; app-local code in `apps/` duplicating
  a shared surface that belongs under `src/`; direct host imports leaking into
  shared code; stale generated artifacts; or stale docs/agent guidance that
  contradicts current authority boundaries.

Suppress comments that are only subjective preference, formatting, naming,
Tailwind ordering, or "could be cleaner" with no concrete owner, invariant,
user-visible behavior, or test gap. Group repeated instances under one finding.
Prefer at most 12 findings.

## nteract Checklist

- State ownership: Notebook edits flow through NotebookDoc/WASM/CRDT paths.
  Runtime lifecycle, queue, outputs, env, trust, execution snapshots, and widget
  topology are daemon/runtime-owned RuntimeStateDoc facts. Mutable widget values
  belong in CommsDoc. React/app stores should be projections or local UI policy,
  not durable sources of truth.
- Shared surfaces: reusable notebook UI, output rendering, identity helpers,
  and headless state/projection logic belong under `src/components/**`,
  `src/lib/**`, or `packages/runtimed/**`. Keep `apps/notebook/**` and
  `apps/notebook-cloud/**` focused on host policy, routes, shell wiring, and
  side effects.
- Host boundaries: shared libraries must stay free of Tauri, Cloudflare, OIDC,
  D1/R2/Durable Object, ACL, credential, and daemon launch policy. Host adapters
  own those effects.
- Authority boundaries: review every write path, including request RPCs, room
  admission, materializer/checkpoint paths, WASM handlers, broadcasts,
  persistence, and tests. Viewer and `runtime_peer` roles must not gain
  unintended writes; client plumbing alone is not enough evidence for hosted
  authority changes.
- Protocol changes: wire protocol, Rust handling, WASM bindings,
  `packages/runtimed` types/stores, recovery, and tests should move together.
- Outputs/widgets: RuntimeStateDoc is the durable output/runtime record;
  output/control ordering must survive stdout floods and display churn;
  MIME/blob/renderer plugin changes need artifact or browser-backed evidence
  when possible.
- Async projection work: reject stale fire-and-forget updates that can resurrect
  removed/replaced state without reset epochs, generations, cancellation, or
  equivalent guards.
- Tests: require focused tests at the changed boundary. Treat deleted tests as
  suspicious unless the behavior was removed and replacement coverage exists.
- Comment and doc claims: module headers and doc comments state what is true
  now. Flag past-tense history narration AND speculative future-consumer
  claims - naming hosts, surfaces, or integrations that do not consume the
  module. Claims about other subsystems deserve extra suspicion because the
  diff cannot verify them (example: the MCP surface is Rust by design, so TS
  store docs must never list it as a consumer). Carried-forward prose in a
  touched header is in scope, not grandfathered.

## Finding Contract

Every finding must name a concrete failure mode or invariant drift, explain why
the diff introduced or exposed it, identify the affected file and line when
possible, and suggest the smallest useful fix. Do not invent findings. If there
are no actionable issues, say there are no actionable findings.

Use severity `nit` for non-blocking architecture/style findings. Use higher
severity only when the finding can cause a bug, security issue, data loss,
authority bypass, durable runtime/output corruption, or a serious review blocker.

Use one of these categories for each finding:

- `correctness`
- `state_ownership`
- `shared_surface`
- `host_boundary`
- `authority_boundary`
- `protocol_sync`
- `output_widget_runtime`
- `async_ordering`
- `tests`
- `generated_artifact`
- `style_maintainability`
- `infra`
