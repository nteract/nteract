# ADR Implementation Divergence Audit

**Status:** Audit, 2026-06-07.

This audit compares the current `docs/adr/*.md` register against the
implementation on `main` after the Notebook Comments ADR merged. It was produced
from five parallel read-only subsystem passes plus a local integration pass. The
goal is not to fix every stale document in one patch; it is to make divergence
visible enough that follow-up ADR cleanup can be prioritized.

## Summary

No P0/P1 implementation divergence was found. The largest risk is routing: the
ADR register and the older Three-Document Split still lead readers toward
outdated document-boundary and RuntimeStateDoc authority rules.

| Severity | Count | Meaning in this audit |
| --- | ---: | --- |
| P1 | 1 | Canonical routing/doc-boundary drift likely to mislead new work. |
| P2 | 9 | Implementation and ADR differ in a way that can change architecture, product, or review decisions. |
| P3 | 12 | Stale examples, status drift, or implemented follow-up not reflected in docs. |

## P1 Findings

### P1: The canonical document-boundary story is no longer canonical

**ADR claim:** The README still routes readers to the Three-Document Split as the
document-boundary source of truth ([README.md](README.md:53)). That ADR says the
runtime has three separate documents ([three-document-split.md](three-document-split.md:7))
and still describes widget comm state as an exception inside `RuntimeStateDoc`
([three-document-split.md](three-document-split.md:79)).

**Implementation and newer ADR evidence:** ADR 0002 is accepted
([0002-comms-document-split.md](0002-comms-document-split.md:3)), explicitly
partially supersedes the Three-Document Split
([0002-comms-document-split.md](0002-comms-document-split.md:7)), and introduces
`CommsDoc` as the fourth sync document
([0002-comms-document-split.md](0002-comms-document-split.md:105)). The comments
ADR adds another optional per-notebook document and already says the split ADR
needs amendment or cross-linking
([notebook-comments-document.md](notebook-comments-document.md:709)).

**Disposition:** Create a canonical multi-document split ADR or add a clear
supersession banner to `three-document-split.md`. Update the README so ADR 0002
and the comments ADR are visible modifiers of the older split.

## P2 Findings

### P2: CommsDoc is missing the accepted notebook-level identity pointer

**ADR claim:** ADR 0002 requires a durable `comms_doc_id` on `NotebookDoc`
alongside `runtime_state_doc_id` ([0002-comms-document-split.md](0002-comms-document-split.md:132)).
The implementation plan calls for accessors, deterministic derivation,
constructor stamping, migration, and pristine allowlist changes
([commsdoc-split-implementation-plan.md](commsdoc-split-implementation-plan.md:32)).

**Implementation evidence:** `NotebookDoc` only models
`runtime_state_doc_id` today ([crates/notebook-doc/src/lib.rs](../../crates/notebook-doc/src/lib.rs:111),
[crates/notebook-doc/src/lib.rs](../../crates/notebook-doc/src/lib.rs:1008),
[crates/notebook-doc/src/lib.rs](../../crates/notebook-doc/src/lib.rs:1414)).
The pristine identity allowlist includes only `notebook_id` and
`runtime_state_doc_id` ([crates/notebook-doc/src/lib.rs](../../crates/notebook-doc/src/lib.rs:2417)).
The room creates `CommsDoc` as room state without a `NotebookDoc` pointer
([room.rs](../../crates/runtimed/src/notebook_sync_server/room.rs:916)).

**Disposition:** Either implement `default_comms_doc_id` plus
accessor/ensure/stamp/migration/pristine support, or revise ADR 0002 and the
plan to state that durable notebook-level CommsDoc identity was deferred or
replaced by room/checkpoint attachment.

### P2: RuntimeStateDoc widget-state authority moved to CommsDoc

**ADR claim:** The identity ADR still says editors may write narrow widget comm
state in `RuntimeStateDoc` ([identity-and-trust.md](identity-and-trust.md:145),
[identity-and-trust.md](identity-and-trust.md:373)). The runtime-peer/blob audit
also says editor/owner writes remain limited to existing widget comm state
([runtime-peer-and-blob-authority-audit.md](runtime-peer-and-blob-authority-audit.md:159)).

**Implementation evidence:** RuntimeStateDoc sync strips or rejects non-runtime
peer changes ([peer_runtime_sync.rs](../../crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs:83),
[peer_runtime_sync.rs](../../crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs:215)).
The shared policy says `RuntimeStateDoc` is runtime-peer only
([policy.rs](../../crates/runtime-doc/src/policy.rs:115)) and explicitly notes
comm state moved to `CommsDoc` ([policy.rs](../../crates/runtime-doc/src/policy.rs:391)).
`CommsDoc` accepts editor/owner/runtime-peer writes
([peer_comms_sync.rs](../../crates/runtimed/src/notebook_sync_server/peer_comms_sync.rs:49),
[peer_comms_sync.rs](../../crates/runtimed/src/notebook_sync_server/peer_comms_sync.rs:169)).

**Disposition:** Update the identity and runtime-peer docs to state that
peer-synced `RuntimeStateDoc` is runtime-peer only, while editor/owner widget
state now flows through `CommsDoc`.

### P2: Hosted run controls are editor-or-owner, not owner-only

**ADR claim:** Hosted browser run controls require a live `runtime_peer` and
browser scope `owner` ([hosted-room-authorization.md](hosted-room-authorization.md:137)).

**Implementation evidence:** Cloud capabilities allow execution for owner or
editor ([shell-capabilities.ts](../../apps/notebook-cloud/viewer/shell-capabilities.ts:64)).
Room request frames allow any non-viewer
([notebook-room.ts](../../apps/notebook-cloud/src/notebook-room.ts:466)). Tests
assert editor execution
([viewer-shell-capabilities.test.ts](../../apps/notebook-cloud/test/viewer-shell-capabilities.test.ts:136)).

**Disposition:** Choose the intended product policy. Either update the ADR to
editor-or-owner execution, or tighten UI/room/WASM gating back to owner-only.

### P2: Live hosted room durability is DO storage, not R2/D1 revision checkpoints

**ADR claim:** The hosted-room authorization ADR says the Durable Object persists
`NotebookDoc` and `RuntimeStateDoc` snapshots back to R2 and records a D1
revision/checkpoint row ([hosted-room-authorization.md](hosted-room-authorization.md:258)).
The deployment topology assigns document snapshots to R2, not DO storage
([deployment-topology.md](deployment-topology.md:300)).

**Implementation evidence:** Live-room checkpoints write notebook/runtime/comms
bytes to Durable Object storage
([room-materializer.ts](../../apps/notebook-cloud/src/room-materializer.ts:121)),
and load prefers that DO checkpoint
([room-materializer.ts](../../apps/notebook-cloud/src/room-materializer.ts:166)).

**Disposition:** Document DO storage as the current interim live-room durability
layer, or add R2/D1 checkpoint persistence before relying on live-room state as
the durable hosted record.

### P2: Cloud still full-rematerializes notebook cell changes

**ADR claim:** Live hosts should use full materialization only for initial render,
pinned snapshot render, structural changes, missing changesets, or unresolved
projection fallback. Runtime/output/source-only updates should project narrowly
([live-notebook-projection-policy.md](live-notebook-projection-policy.md:26),
[live-notebook-projection-policy.md](live-notebook-projection-policy.md:52)).

**Implementation evidence:** Cloud subscribes to `cellChanges$`, ignores the
changeset payload, rematerializes through `get_cells_json()`, and replaces the
full cell store ([cloud-viewer-session.ts](../../apps/notebook-cloud/viewer/cloud-viewer-session.ts:506),
[cloud-view-model.ts](../../apps/notebook-cloud/viewer/cloud-view-model.ts:29),
[notebook-view-store-bridge.ts](../../apps/notebook-cloud/viewer/notebook-view-store-bridge.ts:31)).

**Disposition:** Route cloud `cellChanges$` through the existing cell changeset
projection path and keep full materialization only for classified fallback cases.

### P2: Public ACL migration infers public access from prior published revisions

**ADR claim:** Public access is not inferred from render cache or snapshot
existence ([hosted-room-authorization.md](hosted-room-authorization.md:96),
[hosted-room-authorization.md](hosted-room-authorization.md:205)). The sharing
PRD says public viewing is an explicit ACL toggle
([hosted-sharing-invites.md](hosted-sharing-invites.md:210)).

**Implementation evidence:** Migration `0003` backfills public anonymous viewer
ACL rows for every notebook with `latest_revision_id IS NOT NULL`
([0003_notebook_acl.sql](../../apps/notebook-cloud/migrations/0003_notebook_acl.sql:35)).

**Disposition:** Document this as a one-time prototype compatibility migration,
or guard/remove it if private published revisions can exist.

### P2: Captured-environment launch retry is decided but not implemented

**ADR claim:** Captured env launch failures with retryable infrastructure hints
should repair and retry once internally
([captured-environment-lifecycle.md](captured-environment-lifecycle.md:97)).
Runtime-agent responses should carry structured launch failure hints instead of
requiring string parsing
([captured-environment-lifecycle.md](captured-environment-lifecycle.md:116)).

**Implementation evidence:** `RuntimeAgentResponse::Error` carries only
`error: String` ([protocol.rs](../../crates/notebook-protocol/src/protocol.rs:881)).
Runtime agent wraps launch failure as a string
([runtime_agent.rs](../../crates/runtimed/src/runtime_agent.rs:1462)).
Launch handling publishes/returns final errors rather than repairing and retrying
internally ([launch_kernel.rs](../../crates/runtimed/src/requests/launch_kernel.rs:1396),
[launch_kernel.rs](../../crates/runtimed/src/requests/launch_kernel.rs:1596)).
Typed captured disk-state and partial repair do exist
([metadata.rs](../../crates/runtimed/src/notebook_sync_server/metadata.rs:1650),
[metadata.rs](../../crates/runtimed/src/notebook_sync_server/metadata.rs:1950)).

**Disposition:** Implement the protocol-internal hint plus one-shot retry, or
mark Decisions 5 and 6 as target/future while documenting current partial repair.

### P2: Register status and membership are stale

**ADR claim:** The README is the durable register and says new entries should
start with status lines ([README.md](README.md:1), [README.md](README.md:122)).

**Evidence:** README lists ADR 0001 and ADR 0002 as Proposed even though both
files are Accepted ([README.md](README.md:54), [README.md](README.md:56),
[0001-notebook-seeding-invariant.md](0001-notebook-seeding-invariant.md:3),
[0002-comms-document-split.md](0002-comms-document-split.md:3)). The comments,
peer-egress, and remote-workstation docs exist but are not registered
([notebook-comments-document.md](notebook-comments-document.md:3),
[peer-egress-lanes.md](peer-egress-lanes.md:3),
[remote-workstation-doc-agents.md](remote-workstation-doc-agents.md:3)).
Two README design-memo entries lack in-file status lines
([arrow-manifest-durable-storage-design.md](arrow-manifest-durable-storage-design.md:1),
[runtime-redaction-refresh-design.md](runtime-redaction-refresh-design.md:1)).

**Disposition:** Update the README statuses and rows, and add missing status
headers to the two design memos.

### P2: Blob hash syntax remains inconsistent across docs

**ADR claim:** Blob Storage decides lowercase bare SHA-256 hex and validates
exactly 64 ASCII hex chars
([blob-storage-and-content-addressing.md](blob-storage-and-content-addressing.md:49),
[blob-storage-and-content-addressing.md](blob-storage-and-content-addressing.md:72)).

**Evidence:** Hosted artifacts examples use both `sha256-...` and `sha256:...`
forms ([hosted-notebook-artifacts.md](hosted-notebook-artifacts.md:133),
[hosted-notebook-artifacts.md](hosted-notebook-artifacts.md:152)). Blob Ref
still leaves hash syntax open
([blob-ref-and-chunk-manifest-protocol.md](blob-ref-and-chunk-manifest-protocol.md:216)).
The punchlist explicitly names the inconsistency
([cleanup-punchlist.md](cleanup-punchlist.md:79)).

**Disposition:** Choose one syntax and update examples, validators, and HCA-5 in
one patch.

## P3 Findings

| Finding | Evidence | Disposition |
| --- | --- | --- |
| Typed-frame ADR predates `COMMS_DOC_SYNC` and generated TS constants. | ADR lists frames through `PutBlob` ([typed-frame-v4-wire-protocol.md](typed-frame-v4-wire-protocol.md:66)); implementation includes `COMMS_DOC_SYNC` and generated TS constants ([crates/notebook-wire/src/lib.rs](../../crates/notebook-wire/src/lib.rs:9), [wire-constants.ts](../../packages/runtimed/src/wire-constants.ts:1)). | Update frame tables and generated-binding notes. |
| Three-Document Split still has a stale schema v4 context line. | Mentions v4 near top ([three-document-split.md](three-document-split.md:9)); same doc and schema ADR use v5 ([three-document-split.md](three-document-split.md:63), [schema-evolution-and-genesis.md](schema-evolution-and-genesis.md:12)). | Fix while adding supersession banner. |
| CommsDoc implementation plan is now partly historical. | Plan says no production reads/writes yet ([commsdoc-split-implementation-plan.md](commsdoc-split-implementation-plan.md:9)); production writes and sync exist ([jupyter_kernel.rs](../../crates/runtimed/src/jupyter_kernel.rs:2156), [sync-engine.ts](../../packages/runtimed/src/sync-engine.ts:728)). | Mark completed portions and preserve remaining `comms_doc_id` gap. |
| MCP output resources are specified but absent. | ADR specifies output resources ([mcp-resource-addressing.md](mcp-resource-addressing.md:64)); parser/resources lack output variants and tests reject output URIs ([resources.rs](../../crates/runt-mcp/src/resources.rs:107), [resources.rs](../../crates/runt-mcp/src/resources.rs:783)). | Implement output resources or mark Decision 3 as future. |
| Hosted artifacts ADR still says notebook/runtime snapshot pair. | ADR uses pair language ([hosted-notebook-artifacts.md](hosted-notebook-artifacts.md:36)); implementation revisions include comms snapshot fields ([storage.ts](../../apps/notebook-cloud/src/storage.ts:97), [index.ts](../../apps/notebook-cloud/src/index.ts:887)). | Update terminology to document set/triple. |
| Cloud live transport is ack-only, not the generic request/response contract. | Shared browser transport waits for `RESPONSE` by request id ([packages/notebook-host/src/browser/index.ts](../../packages/notebook-host/src/browser/index.ts:226)); cloud matches `cloud_frame_accepted` FIFO ([live-sync.ts](../../apps/notebook-cloud/viewer/live-sync.ts:213)). | Document as hosted ack-only transport or propagate response ids. |
| Peer egress lane ADR describes the old single queue. | ADR describes shared `PeerWriter` queue ([peer-egress-lanes.md](peer-egress-lanes.md:11)); implementation already has reliable/ephemeral queues and tests ([peer_writer.rs](../../crates/runtimed/src/notebook_sync_server/peer_writer.rs:26), [peer_writer.rs](../../crates/runtimed/src/notebook_sync_server/peer_writer.rs:723)). | Mark two-lane scheduler implemented. |
| Output rendering segmentation omits standalone Vega/Plotly lanes. | ADR lanes put charts/maps in interactive lane ([output-rendering-segmentation.md](output-rendering-segmentation.md:42)); implementation has `vega-frame` and `plotly-frame` ([output-lane-policy.ts](../../src/components/isolated/output-lane-policy.ts:12)). | Update lane taxonomy. |
| Blob storage worked example says anywidget Arrow comm buffer is ephemeral. | Example says `Ephemeral` ([blob-storage-and-content-addressing.md](blob-storage-and-content-addressing.md:425)); kernel-side `BlobStore::put` uses durable storage ([output_prep.rs](../../crates/runtimed/src/output_prep.rs:61), [blob_store.rs](../../crates/runtimed/src/blob_store.rs:288)). | Fix example; reserve ephemeral for frontend widget uploads. |
| Output widget replay measurement labels historical uncached path as current. | Measurement says current replay is triangular ([output-widget-replay-measurements.md](output-widget-replay-measurements.md:12)); production has replay cache ([jupyter_kernel.rs](../../crates/runtimed/src/jupyter_kernel.rs:224), [jupyter_kernel.rs](../../crates/runtimed/src/jupyter_kernel.rs:1388)). | Mark as historical baseline and document cache. |
| Runtime redaction refresh design has proposal/implementation ambiguity. | Design proposes mutable redaction candidate events ([runtime-redaction-refresh-design.md](runtime-redaction-refresh-design.md:36)); implementation redactor remains launch-time snapshot ([output_redaction.rs](../../crates/runtimed/src/output_redaction.rs:20)). | Add status or current-state note. |
| Runtime principal / attachment-ticket docs need routing cleanup. | Deployment topology leaves runtime principal shape open ([deployment-topology.md](deployment-topology.md:342)); runtime principal promotion resolves part of it ([runtime-principal-promotion.md](runtime-principal-promotion.md:44)); remote workstation says ticket details should move to hosted credential transport ([remote-workstation-doc-agents.md](remote-workstation-doc-agents.md:191)). | Mark principal question resolved and move/defer ticket contract. |

## Confirmed Alignment

- Schema v5, frozen genesis, forward-tolerant loading, and canonical seed hash
  checks align with the schema ADR
  ([crates/notebook-doc/src/lib.rs](../../crates/notebook-doc/src/lib.rs:74),
  [crates/notebook-doc/src/lib.rs](../../crates/notebook-doc/src/lib.rs:1218),
  [crates/notebook-doc/src/lib.rs](../../crates/notebook-doc/src/lib.rs:2401)).
- RuntimeStateDoc client policy is runtime-peer-only in code, consistent with
  the post-CommsDoc architecture even though older ADR prose lags
  ([policy.rs](../../crates/runtime-doc/src/policy.rs:115),
  [peer_runtime_sync.rs](../../crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs:215)).
- Frontend stable DOM order is implemented in `NotebookView`
  ([NotebookView.tsx](../../apps/notebook/src/components/NotebookView.tsx:539),
  [NotebookView.tsx](../../apps/notebook/src/components/NotebookView.tsx:1088)).
- Hosted auth/credential transport, output-origin isolation, and sharing invites
  are broadly aligned with their ADRs and tests
  ([identity.ts](../../apps/notebook-cloud/src/identity.ts:207),
  [output-document-worker.ts](../../apps/notebook-cloud/src/output-document-worker.ts:13),
  [sharing-storage.test.ts](../../apps/notebook-cloud/test/sharing-storage.test.ts:130)).
- Execution pipeline/liveness, traceback protocol, Arrow/blob output protocols,
  ordinary-output commit work, and Tokio mutex discipline are aligned at the
  major invariant level.
- Cloud CommentsDoc implementation is intentionally not present yet; the
  comments ADR is a pre-implementation decision.

## Recommended Follow-Up Order

1. Fix routing first: README register, Three-Document Split supersession, and
   accepted ADR 0001/0002 statuses.
2. Decide whether to implement or defer `comms_doc_id`; this is the only accepted
   ADR gap that changes durable document identity.
3. Update identity/trust docs for CommsDoc so reviewers stop expecting
   editor/owner `RuntimeStateDoc` writes.
4. Resolve hosted policy choices: editor execution, DO checkpoint durability,
   public ACL migration, and live projection materialization.
5. Batch stale P3 output/runtime docs as documentation cleanup.

