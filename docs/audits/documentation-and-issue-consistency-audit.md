# Documentation and Issue Consistency Audit

Status: Audit
Date: 2026-07-02

Source-backed sweep of the full documentation surface — 36 ADRs, 13 memos,
plans, PRDs, prior audits, measurements, runbooks, the docs front door,
12 nested `AGENTS.md` files, `CLAUDE.md` + 10 `.claude/rules`, 9 repo skills,
24 Elements docs, top-level repo docs, `apps/notebook-cloud/README.md`,
`.context/plans`, and all 22 open GitHub issues — cross-referenced against the
code and git history. 153 artifacts were classified; 101 findings survived
independent adversarial verification (13 high, 56 medium, 32 low). Findings
whose evidence did not reproduce were dropped.

**Resolution status:** execution batches 1-5 below (protocol truth, agent
guidance, status hygiene, hosted refresh, release/ops truth) were applied in
the PR that introduced this audit, so the per-file findings they cover are
fixed as of that PR and kept here as evidence. Still live: the two Decisions
Needed below, batch 6 (issue gardening on the tracker), and any follow-ups
recorded in the owning docs.

Headline: the architecture docs are structurally healthy (64 artifacts fully
current), but a June burst of landed work — CommentsDoc sync, daemon-mediated
hosted rooms (#3884), the hosted artifact/dashboard wave, release signing —
outran the documentation layer. Most fixes are mechanical doc updates; two
findings need a real decision because an Accepted/spec'd behavior and the
shipped code disagree.

## Decisions Needed (code vs. accepted docs)

### 1. Publish does not re-author into the destination identity space

`docs/adr/identity-and-trust.md` Decision 6 (Accepted) says a publish produces
a **fresh** Automerge document in the destination identity space with source
actor history stripped, and the threat table marks import-time cross-IdP
forgery "closed" on that basis. The shipped path contradicts it:
`crates/runt-publish/src/lib.rs` saves and uploads the source document bytes
directly (`save_snapshot_pair` → upload of
`source_snapshot.snapshot.notebook_bytes`), and the Worker stores the uploaded
body as-is before recording the revision (`apps/notebook-cloud/src/index.ts`,
snapshot PUT path). Either implement publish-time re-authoring, or amend
Decision 6 and the threat table to state that publish currently preserves
source actor history. Until then an Accepted security invariant is
aspirational, not descriptive.

### 2. Invite flow never issues immediate ACL grants

`docs/prd/hosted-sharing-invites.md` specifies that inviting an existing
verified profile grants ACL access immediately (PRD steps around lines
140–157). The shipped route always creates or returns a `pending` invite row.
Decide whether immediate grants are still a product requirement; implement
profile lookup + ACL insert in `POST /invites` if yes, or update the PRD if no.

Also in this category, smaller: the typed-frame v4 ADR claims its frame-size
contract test covers every known Rust frame type; that claim is now
overstated and either the test or the claim should be extended.

## Systemic Thread A: CommentsDocSync (0x0a) never propagated to protocol docs

The `CommentsDocSync` typed frame landed in
`crates/notebook-wire/src` (frame type `0x0a`), with daemon and cloud sync
plumbing, but every protocol description still stops at `0x09`:

- `crates/notebook-wire/AGENTS.md` — typed-frame table, traffic classes,
  sender/receiver validity.
- `crates/notebook-sync/AGENTS.md` — frame-boundary summary.
- `.claude/rules/protocol.md` — auto-loaded wire protocol table.
- `docs/adr/typed-frame-v4-wire-protocol.md` — "ten frame types" claim, frame
  table, caps, examples. Same ADR also still describes post-handshake
  capabilities as untyped-only despite typed `SessionControl` bootstrap.
- `docs/adr/document-split.md` — still labels CommentsDoc "proposed"; also has
  an incorrect PoolDoc fan-out worked example.
- `apps/notebook-cloud/AGENTS.md` — CommentsDoc listed as proposed though room
  CommentsDoc sync is implemented.
- `crates/runtimed/AGENTS.md` — scope omits daemon-side CommentsDoc
  persistence/sync.
- `.agents/skills/automerge-sync/SKILL.md` — stream table documents CommentsDoc
  as not implemented.
- `apps/notebook-cloud/README.md` — checkpoint recovery section omits
  CommentsDoc although the code checkpoints it.

These files auto-load into agent sessions, so the drift actively misleads
future work. One batched PR should fix all nine surfaces together.

## Systemic Thread B: implemented Drafts should graduate

Per `docs/adr/README.md`, `Accepted` marks decisions ready to guide review.
These are implemented and load-bearing but still say Draft/Proposed:

- `docs/adr/execution-pipeline.md` → Accepted (refresh stale line refs).
- `docs/adr/tokio-mutex-discipline.md` → Accepted (CI-enforced today).
- `docs/adr/runtime-state-document-identity.md` → Accepted; keep open
  questions as follow-ups.
- `docs/adr/schema-evolution-and-genesis.md` → Accepted; frozen-genesis and
  max-reader rules are enforced in code.
- `docs/adr/notebook-identity-and-path-binding.md` → In progress: NIP-1
  and NIP-2 landed (e.g. untitled recovery, #3818); NIP-3 remains design.
- `docs/adr/README.md` itself: three ADRs use compound statuses
  ("Accepted / implementation in progress") outside the defined vocabulary —
  either extend the vocabulary or normalize the status lines.

Memos describing landed work should convert to implementation records or
graduate:

- `docs/memos/desktop-cloud-daemon-bridge.md` — V1 landed in #3884; graduate
  the decided architecture toward an ADR, keep remaining #3861 slices explicit.
- `docs/memos/arrow-manifest-durable-storage-design.md` — save/load and
  active-room GC landed; only the closed-room asset-index gap is still open.
- `docs/memos/markdown-node-identity-reconciler.md` — engine + tests landed
  (#3862); also predates island/inline-JSX identity fields (#3878).
- `docs/memos/compute-session-index.md` — OwnerComputeIndex shipped with a
  narrower shape than the memo sketches.
- `docs/memos/panel-runtime-state.md` — stale as a plan: #3750 was fixed by
  renderer/output-lane work (`5171ccb1`), not this architecture; typed Panel
  channel work exists only on feature branches. Archive or reframe as a
  follow-up proposal.

## Systemic Thread C: hosted/cloud docs lag the June burst

- `apps/notebook-cloud/README.md` (913 lines) — live-room auth still describes
  short-lived sync tickets instead of app-session cookies; snapshot curl
  examples omit the required runtime-state doc id header; storage section
  predates list-scale presence R2/D1 usage (#3890); ACL section misses the
  sharing/invite/access-request layer; "prototype" framing is now too broad.
- `docs/adr/hosted-notebook-artifacts.md` — missing comments snapshots, cover
  metadata, cell composition/language (#3886), pinned OG-image behavior
  (#3888/#3889).
- `docs/adr/cloud-connected-local-mcp.md` — does not reconcile the
  daemon-mediated hosted room bridge (#3884).
- `docs/adr/deployment-topology.md` — browser credential path still says OIDC
  bearer tokens over WebSocket subprotocols; first-party sessions use cookies.
- `docs/adr/hosted-room-authorization.md` — prototype-era framing; the Durable
  Object room host is materialized.
- `apps/elements/content/docs/cloud-dashboard.mdx` — still documents the
  pre-redesign search-first dashboard; the shipped `/n` model (#3883, #3885,
  #3892), covers/OG images, presence/identity contract, and loading resilience
  are absent.

## Systemic Thread D: release and operational docs are wrong in load-bearing ways

- `RELEASING.md` — says Windows builds are not code signed; the workflow now
  has Windows signing tooling and Azure credentials. Artifact table omits
  macOS x64 DMG, updater bundles/signatures, Linux-only standalone
  daemon/MCP binaries, and `latest.json`. Unpublished-crate list incomplete.
- `.agents/skills/releasing/SKILL.md` — bump procedure omits the canonical
  `cargo xtask bump` flow, under-lists versioned files, and its stable tag
  example conflicts with `RELEASING.md`.
- `docs/runbooks/remote-workstation.md` — wakeup channel documented as SSE
  with `Last-Event-ID`; the implementation is a hibernatable WebSocket event
  socket plus polling fallback.
- `docs/runbooks/macos-setup.md` — claims `cargo xtask dev` builds Python
  bindings via `maturin develop`; bindings are no longer in the default path.
- `docs/runbooks/hosted-direct-oidc-demo-runbook.md` — expected `/api/health`
  JSON includes fields the worker intentionally does not expose.

## Agent-guidance corrections (auto-loaded surfaces)

- `CLAUDE.md` — nteract-dev summary says "up/down… plus 26 proxied notebook
  tools" unconditionally; attach mode hides the lifecycle verbs and the
  advertised proxied list is 19 tools.
- `.claude/rules/mcp-servers.md` — same attach-mode caveat missing.
- `.claude/rules/logging.md` — says dev uses `attachConsole`; code uses
  `attachLogger` (attachConsole removed to avoid feedback loops).
- `AGENTS.md` (root) — intro says two root invariants; four are listed.
- `crates/kernel-env/AGENTS.md` — Deno bootstrap source stale.
- `src/components/isolated/AGENTS.md` — omits Bokeh/Panel renderer plugins,
  points at an old MIME map.
- `src/components/ui/AGENTS.md` — shadcn primitive inventory stale.
- `.agents/skills/daemon-dev/SKILL.md` — wrong crates in the single Rust
  compilation step; calls hidden read tools "advertised".
- `.agents/skills/mcp-session-lifecycle/SKILL.md` — rejoin guidance still
  pre-checks `list_rooms`; current rejoin relies on daemon-authoritative
  refusal.

## Measurement docs

- `docs/measurements/output-widget-replay-measurements.md` — describes the
  pre-optimization full-list replay path as current; production uses a
  per-comm replay cache. Reframe as baseline evidence.
- `docs/measurements/output-commit-measurements.md` — intro predates
  `output_committer` queueing for ordinary rich outputs.
- `docs/measurements/runtime-output-optimization.md` — several plan items
  written as future work have landed.

## Issue triage (22 open)

Close:

- #3750 (Panel components not displayed) — fixed by Panel renderer + comm
  bridge (`5171ccb1` and follow-ups); verify once, then close.
- #3015 (Ventura crash, 2.5.1) — no repro/logs after maintainer request;
  unactionable on current builds.
- #1391 (generic Julia/R kernels) — fold into #3608, which carries the
  actionable kernelspec/JupyterHub work.

Update/re-scope (architecture moved underneath):

- #3861, #3600, #3599 — refresh for the landed daemon-mediated bridge (#3884);
  the signal source for link health is now `HostedBridgeHandle`, not
  cloud runtime_agent only.
- #3598 — #3595 chunked store dependency landed; pending-edit marker still open.
- #2285 — silent-overwrite claims superseded by the staleness guard + atomic
  write path (#3544); the remaining gap is cross-daemon owner lock/heartbeat.
- #1969 — `.captured-ok` acceptance criteria superseded by the
  captured-environment lifecycle ADR; launch-handshake retry remains.
- #1968 — implementation sketch must move to daemon-owned lifecycle APIs, not
  frontend cache deletion / `env_id` rewrites.
- #1307 — split Python env-build sandboxing (landing) from runtime process
  isolation (open); stale path reference in body.
- #3381 — pairing credentials and Rust workstation service mode landed;
  refresh checklist.
- #681 — frontmatter syntax detection landed; UI/metadata sync remain.
- #662 — proposed `nteract://` deep-link scheme now collides with the MCP
  resource URI namespace; needs a different scheme.

Still valid as written: #3887, #3665, #3608, #3601, #3593, #3538, #1334, #777.

## Taxonomy moves

- Delete (landed work retained in git history): `.context/plans/001…003` and
  the `.context/plans/README.md` index; `.context/codex-reusable-odometer-pr.md`
  (single-use PR handoff).
- `DESIGN.md` — durable design-system spec at repo root; consider moving under
  `docs/` or the Elements catalog (low priority).
- Memo graduations per Thread B.
- Gap for a future pass: define when a partially-landed memo graduates to an
  ADR vs. updates in place; four memos hit this ambiguity.

## Top-level docs

- `README.md` / `CONTRIBUTING.md` — project-structure blocks omit current
  top-level surfaces (`packages/`, current `python/` inventory);
  `plugins/nteract` is an agent plugin distribution, not renderer plugins;
  manual maturin command points at the wrong directory.
- `python/README.md` — `python/nteract` is now a thin launcher for the Rust
  MCP server, not a composition of runtimed primitives.
- `DESIGN.md` — token inventory stale relative to shared semantic tokens
  (`d30f7ce3` unified engine tokens).

## Suggested execution batches

1. **Protocol truth** (Thread A): one PR, nine files, CommentsDocSync + typed
   bootstrap corrections.
2. **Agent guidance**: CLAUDE.md, `.claude/rules`, nested AGENTS.md, skills
   corrections listed above.
3. **Status hygiene** (Thread B): ADR status graduations + ADR README
   vocabulary + memo reframings. Mostly status-line and framing edits.
4. **Hosted docs refresh** (Thread C): cloud README, hosted ADRs,
   cloud-dashboard.mdx.
5. **Release/ops truth** (Thread D): RELEASING.md, releasing skill, three
   runbooks, top-level docs.
6. **Issue gardening**: closes/updates per the triage list.
7. **Decisions**: publish re-authoring (Decision 6) and invite immediate
   grants — need an owner, not just a doc edit.

## Appendix: non-current artifact verdicts

Verdicts: `needs-update` (specific fixes identified), `in-flight` (accurate,
work ongoing), `stale` (superseded/contradicted), `misfiled` (wrong home or
status). Artifacts judged fully current (64) are omitted.

- `docs/adr/document-split.md` — **needs-update**: Update current-room document count for landed CommentsDoc and fix the PoolDoc worked example.
- `docs/adr/0001-notebook-seeding-invariant.md` — **needs-update**: Update the exact pristine predicate to include the daemon ephemeral room flag scaffold exception.
- `docs/adr/runtime-state-document-identity.md` — **needs-update**: Change status from Draft to Accepted/implemented and keep open questions as follow-ups.
- `docs/adr/schema-evolution-and-genesis.md` — **needs-update**: Change status from Draft to Accepted; the frozen-genesis and schema-version max-reader rules are implemented.
- `docs/adr/notebook-identity-and-path-binding.md` — **needs-update**: Change status from Proposed to In progress; NIP-1 and NIP-2 have landed while NIP-3 remains design.
- `docs/adr/notebook-comments-document.md` — **in-flight**: Keep as in-flight; core CommentsDoc and hosted/local sync landed, while MCP tools, polish, and publish policy remain tracked in the rollout plan.
- `docs/adr/execution-pipeline.md` — **misfiled**: Accurate and load-bearing; graduate Draft to Accepted after refreshing a few stale line references.
- `docs/adr/typed-frame-v4-wire-protocol.md` — **needs-update**: Core framing story is right, but the frame table/bootstrap/forward-compat details lag current v4 code.
- `docs/adr/blob-storage-and-content-addressing.md` — **needs-update**: Mostly current, but renderer-plugin serving paths are stale.
- `docs/adr/output-rendering-segmentation.md` — **needs-update**: Decision is implemented, but code has split chart lanes beyond the four-lane text in the ADR.
- `docs/adr/peer-egress-lanes.md` — **in-flight**: Accurately records the landed reliable/ephemeral split and remaining work.
- `docs/adr/generated-runtime-artifacts.md` — **needs-update**: Artifact ownership model is right, but the volatile renderer bundle list omits panel.js.
- `docs/adr/tokio-mutex-discipline.md` — **misfiled**: Accurate and CI-backed; graduate Draft to Accepted.
- `docs/adr/identity-and-trust.md` — **needs-update**: Accepted trust model mostly matches, but Decision 6 publish-as-fresh is contradicted by the current snapshot publish path.
- `docs/adr/hosted-room-authorization.md` — **needs-update**: Core authorization model matches, but prototype-only/status text should be updated for the materialized Durable Object room host.
- `docs/adr/hosted-notebook-artifacts.md` — **needs-update**: Artifact model is mostly right but missing comments snapshots, cover metadata, cell composition, language, and pinned-OG behavior.
- `docs/adr/deployment-topology.md` — **needs-update**: Topology is broadly useful, but browser credential transport is stale relative to app-session cookie auth.
- `docs/adr/cloud-connected-local-mcp.md` — **needs-update**: Direct hosted MCP remains implemented, but the ADR needs to reconcile daemon-mediated hosted rooms from #3884.
- `docs/adr/frontend-sync-bridge.md` — **needs-update**: Behavior is current and load-bearing, but several hard-coded line references are stale.
- `docs/adr/remote-workstation-doc-agents.md` — **in-flight**: Accurately describes the partially landed workstation doc-agent architecture and remaining rollout surface.
- `docs/adr/runtime-principal-promotion.md` — **in-flight**: Hosted promotion and authority split are current, but local runtime principal naming remains target architecture.
- `docs/adr/captured-environment-lifecycle.md` — **needs-update**: Architecture is still right, but implementation notes should reflect that typed disk state and partial routing have landed.
- `docs/memos/arrow-manifest-durable-storage-design.md` — **needs-update**: Save/load and active-room GC have landed; mark implemented sections as superseded/decided and keep only the closed-room output asset-index gap open.
- `docs/memos/compute-session-index.md` — **needs-update**: Core OwnerComputeIndex slice landed with a narrower summary shape; update status, shipped contract, and remaining questions.
- `docs/memos/desktop-cloud-daemon-bridge.md` — **in-flight**: V1 daemon-mediated hosted bridge landed in PR #3884; mark decided portions and leave remaining #3861 slices explicit.
- `docs/memos/env-sandbox-policy-design.md` — **needs-update**: Still useful exploration, but it should clarify current sandbox enforcement gaps and link the runtime-agent work in issue #1307.
- `docs/memos/execution-liveness.md` — **needs-update**: Design remains open, but exact code line references have drifted.
- `docs/memos/markdown-node-identity-reconciler.md` — **needs-update**: Mark the memo as landed/implementation record and update it for island/inline-JSX identity fields added after the original design.
- `docs/memos/markdown-plan-documents.md` — **needs-update**: Keep as the Markdown document surface RFC, but refresh OC-2/suggested spikes for the landed island projection work.
- `docs/memos/panel-runtime-state.md` — **stale**: Archive or rewrite as a follow-up only if native typed Panel runtime state is still desired; the display issue was fixed through renderer/output-lane work instead.
- `docs/memos/projection-source-rendered-correspondence.md` — **needs-update**: Keep the memo, but refresh the open questions/status for multiple-per-run highlights now that the deferred part landed.
- `docs/memos/runtime-redaction-refresh-design.md` — **in-flight**: Keep as the active design for runtime-created redaction candidate refresh; launch-time matcher optimization and Python caching landed, daemon-local refresh has not.
- `docs/plans/comments-rollout.md` — **needs-update**: Remove hosted room ingress from remaining work; keep MCP tools/resources, desktop polish, and publish policy as open.
- `docs/prd/hosted-sharing-invites.md` — **needs-update**: Update to reflect the shipped pending-invite-only POST behavior, added unique indexes, and non-draft implementation state.
- `docs/prd/notebook-identity-environment-surfaces.md` — **needs-update**: Update status from draft/prototype to implemented product contract with follow-ups delegated to the audit/ADR trail.
- `docs/audits/runtime-peer-and-blob-authority-audit.md` — **needs-update**: Refresh blob metadata finding for hosted first-writer-wins and link the remaining Content-Type issue.
- `docs/measurements/output-commit-measurements.md` — **needs-update**: Rewrite the intro as historical baseline/model evidence now that production uses the output committer.
- `docs/measurements/output-widget-replay-measurements.md` — **stale**: Rewrite as pre-optimization baseline evidence; production now uses cached replay resolution.
- `docs/measurements/runtime-output-optimization.md` — **needs-update**: Mark landed flat-path optimizations and leave only remaining work as active.
- `docs/adr/README.md` — **needs-update**: The status vocabulary is clear, but the ADR register contains non-conforming status lines.
- `docs/runbooks/macos-setup.md` — **needs-update**: Mostly current, but the first-build description still claims default dev builds Python bindings with maturin.
- `docs/runbooks/remote-workstation.md` — **needs-update**: Commands and paths mostly match; workstation wakeup transport text is stale.
- `docs/runbooks/hosted-direct-oidc-demo-runbook.md` — **needs-update**: Deployment variables match, but the expected health response shape is stale.
- `.context/plans/README.md` — **misfiled**: All listed plans are DONE and should be archived/deleted or promoted out of .context.
- `.context/plans/001-cap-snapshot-blob-ref-validation.md` — **misfiled**: Landed plan remains as an executor checklist in .context.
- `.context/plans/002-preserve-actor-across-loads-and-rebuilds.md` — **misfiled**: Landed plan remains as an executor checklist in .context.
- `.context/plans/003-share-outline-interaction-wiring.md` — **misfiled**: Landed plan remains as an executor checklist in .context.
- `AGENTS.md` — **needs-update**: mostly accurate, but the load-bearing invariants intro says two invariants while four are listed
- `apps/notebook-cloud/AGENTS.md` — **needs-update**: mostly accurate on cloud authority and worker/viewer split, but CommentsDoc is now implemented rather than proposed
- `crates/kernel-env/AGENTS.md` — **needs-update**: mostly accurate, but Deno bootstrap provenance is stale
- `crates/notebook-sync/AGENTS.md` — **needs-update**: mostly accurate, but omits CommentsDocSync handling added to the frame boundary
- `crates/notebook-wire/AGENTS.md` — **needs-update**: core protocol model is right, but frame tables and lifecycle text omit CommentsDocSync and OpenHostedNotebook
- `crates/runtimed/AGENTS.md` — **needs-update**: runtime guidance is broadly accurate but omits daemon-side CommentsDoc persistence/sync responsibilities
- `src/components/isolated/AGENTS.md` — **needs-update**: security guidance is current, but renderer plugin inventory and plugin mapping instructions are stale
- `src/components/ui/AGENTS.md` — **needs-update**: shared UI guidance is broadly useful but hard-coded structure/counts are stale
- `CLAUDE.md` — **needs-update**: Update nteract-dev tool availability/count guidance for attach mode and current proxied tool surface.
- `.claude/rules/logging.md` — **needs-update**: Replace stale attachConsole dev-mirror wording with attachLogger/original-console behavior.
- `.claude/rules/mcp-servers.md` — **needs-update**: Clarify owner/isolated versus Codex attach-mode tool availability.
- `.claude/rules/protocol.md` — **needs-update**: Update included wire-protocol table for CommentsDocSync frame 0x0a and valid senders.
- `#3861` — **in-flight**: Update status for #3884: daemon-mediated hosted rooms and the bridge memo landed, with persistence/CommsDoc/local runtime/status still remaining.
- `#3750` — **stale**: Close as fixed by Panel renderer and Panel widget comm bridge commits.
- `#3600` — **needs-update**: Update for #3884: desktop-hosted room lifecycle is now mapped, but local-first persistence is still not wired.
- `#3599` — **needs-update**: Update the implementation source from runtime-agent-only to the new HostedBridgeHandle/hosted bridge path for desktop-hosted rooms.
- `#3598` — **needs-update**: Update dependency wording: #3595 chunked store/meta has landed; durable pending-local-edit marker remains open.
- `#3381` — **in-flight**: hosted workstation registration, pairing, attach jobs, current-python runtime peer, and dispatch have landed; catalog projection, provider smokes, kernelspec/cwd selection, and final ticket hardening remain
- `#3015` — **stale**: one-line Ventura crash report for 2.5.1 is no longer actionable without logs or a repro on current 2.6.2 builds
- `#2285` — **needs-update**: silent overwrite and in-place write details were mitigated by #3544, but the owner lock/heartbeat cross-daemon coordination gap remains
- `#1969` — **needs-update**: typed captured-env disk state and partial repair routing landed, and the ADR rejects .captured-ok for the first pass; launch-handshake retry still remains
- `#1968` — **needs-update**: manual rebuild/refresh controls are still absent, but the implementation sketch must use daemon-owned lifecycle APIs rather than frontend cache deletion and env_id rewriting
- `#1391` — **misfiled**: generic Julia/R kernels remain unsupported, but the actionable kernelspec/JupyterHub work is now captured in #3608
- `#1307` — **needs-update**: runtime-agent spawning remains unsandboxed, but recent sandbox work is scoped to Python env builds and should be separated from runtime process isolation
- `#681` — **needs-update**: raw-cell YAML/frontmatter detection exists; native Document Settings UI and metadata sync remain open
- `#662` — **needs-update**: the content-fetch/deep-link idea remains plausible, but nteract:// is now the MCP resource namespace and is explicitly not a connect target
- `apps/elements/content/docs/index.mdx` — **needs-update**: Catalog links resolve and recent dashboard/comment/output surfaces are represented, but the routing page does not surface the shipped shared-primitives/Sift native-look decision from #3872.
- `apps/elements/content/docs/editor-surfaces.mdx` — **needs-update**: Mostly accurate, but one phrase implies a package boundary that does not exist.
- `apps/elements/content/docs/compute-placement.mdx` — **in-flight**: Accurately describes the partially landed compute placement model: local desktop, cloud workstations, SSH/direct candidates, selected room target, and environment/runtime separation.
- `apps/elements/content/docs/cloud-dashboard.mdx` — **needs-update**: The broad app-level dashboard intent is still right, but the artifact missed the shipped redesigned /n model, presence and identity contract, loading resilience, and cover/OG-image behavior.
- `apps/elements/content/docs/cloud-notebook-shell.mdx` — **in-flight**: Accurately documents the shared cloud shell and still-provisional workstation/provider slots as an active convergence surface.
- `.agents/skills/automerge-sync/SKILL.md` — **needs-update**: Mostly current, but CommentsDoc stream guidance is stale.
- `.agents/skills/daemon-dev/SKILL.md` — **needs-update**: Core guidance is useful, but build phase and MCP tool-surface claims lag current xtask/runt-mcp code.
- `.agents/skills/mcp-session-lifecycle/SKILL.md` — **needs-update**: Session model is mostly current, but ephemeral rejoin eviction checking changed.
- `.agents/skills/releasing/SKILL.md` — **stale**: Release bump and tagging instructions conflict with RELEASING.md and xtask bump source.
- `README.md` — **needs-update**: Mostly current positioning and xtask workflow, but the project structure block omits current top-level surfaces and Python packages.
- `CONTRIBUTING.md` — **needs-update**: Build commands match the xtask surface, but project-structure and Python-binding manual instructions have drifted.
- `DESIGN.md` — **needs-update**: Design intent remains useful, but the token spec is behind the unified semantic token implementation and the doc belongs under the durable docs/Elements taxonomy.
- `RELEASING.md` — **needs-update**: Release streams are broadly right, but Windows signing, artifact inventory, and unpublished crate inventory are stale or incomplete.
- `python/README.md` — **needs-update**: Workspace/package inventory is current, but the python/nteract package description no longer matches its launcher-only implementation.
- `apps/notebook-cloud/README.md` — **needs-update**: Mostly load-bearing, but several sections lag shipped cloud auth, room-summary presence, sharing APIs, CommentsDoc handling, and snapshot command requirements; 'prototype' should be scoped to preview/dev-token deployment rather than the whole system.
