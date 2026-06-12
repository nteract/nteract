# Architecture Decision Register

This directory is the durable architecture register for nteract notebook rooms,
runtime state, output transport, hosted sharing, and related daemon invariants.
Most entries are still draft because this register is actively being extracted
from shipped code, in-flight hosted work, and follow-up audits.

## Document Types and Statuses

- **Accepted**: load-bearing decision that current and future work should treat
  as the architectural source of truth.
- **Draft**: proposed or recently extracted decision that should be reviewed
  before being used as a hard dependency.
- **PRD draft**: product requirements and user-facing behavior that need
  product/design validation before architecture or implementation depends on
  them. PRDs can cite ADRs, but they should not silently make low-level
  transport, storage, or security decisions.
- **Design memo**: analysis that frames a decision but intentionally stops short
  of recording one.
- **Runbook**: operational instructions tied to a design; not itself an ADR.
- **Measurement**: benchmark evidence or performance model; not itself an ADR.
- **Audit**: evidence and follow-up list for a boundary or subsystem.
- **Living**: maintained tracking document whose contents are expected to change.

## Read First

These entries define the center of gravity for the system:

| Area | Entry | Status |
|------|-------|--------|
| Identity, actors, scopes | [Identity and Trust](identity-and-trust.md) | Accepted |
| Wire format | [Typed-frame v4 wire protocol](typed-frame-v4-wire-protocol.md) | Draft |
| Document boundaries | [The Document Split](document-split.md) | Draft |
| Schema evolution | [Notebook Schema Evolution and the Frozen Genesis](schema-evolution-and-genesis.md) | Draft |
| Runtime-state identity | [Runtime State Document Identity](runtime-state-document-identity.md) | Draft |
| Environment lifecycle | [Captured Environment Lifecycle](captured-environment-lifecycle.md) | Draft |
| Notebook host shell | [Notebook Host Shell Convergence](notebook-host-shell-convergence.md) | Draft |
| Notebook identity and environment surfaces | [Notebook Identity and Environment Surfaces](notebook-identity-environment-surfaces.md) | PRD draft |
| Notebook identity and environment audit | [Notebook Identity and Environment Surface Audit](notebook-identity-environment-surface-audit.md) | Audit |
| Runtime principal promotion | [Runtime Principal Promotion](runtime-principal-promotion.md) | Draft |
| Execution ordering | [Cell Execution Pipeline and Control-Plane Separation](execution-pipeline.md) | Draft |
| Blob storage | [Blob Storage and Content Addressing](blob-storage-and-content-addressing.md) | Draft |
| Sharing product requirements | [Hosted Notebook Sharing and Invites](hosted-sharing-invites.md) | PRD draft |

## Register

### Core Local Runtime

| Entry | Status | Notes |
|-------|--------|-------|
| [Typed-frame v4 wire protocol](typed-frame-v4-wire-protocol.md) | Draft | Frame bytes, channels, caps, and compatibility. |
| [The Document Split](document-split.md) | Draft | Count-neutral document-boundary baseline for notebook-room docs and daemon-scoped PoolDoc; extended by CommsDoc and CommentsDoc follow-ons. |
| [Peer Egress Lane Split Investigation](peer-egress-lanes.md) | Draft | Reliable/ephemeral peer-writer lane split investigation; implementation has partially landed. |
| [ADR 0001: Notebook seeding invariant](0001-notebook-seeding-invariant.md) | Accepted | Causal `is_pristine` seeding gate replacing the cell-count/metadata proxy. |
| [Notebook Pristine-Seeding Implementation Plan](notebook-pristine-seeding-implementation-plan.md) | Implementation plan | Task breakdown for ADR 0001; shipped in #3342. |
| [ADR 0002: CommsDoc split](0002-comms-document-split.md) | Accepted | Extract widget comm state into a fourth document so RuntimeStateDoc becomes cleanly daemon-only. |
| [CommsDoc Split Implementation Plan](commsdoc-split-implementation-plan.md) | Implementation plan | Phase-1 (foundation) TDD task breakdown for ADR 0002. |
| [Notebook Comments Document](notebook-comments-document.md) | Draft | Separate per-notebook CommentsDoc for human and agent comments across local and hosted rooms. |
| [Runtime State Document Identity](runtime-state-document-identity.md) | Draft | NotebookDoc-owned pointer to the RuntimeStateDoc identity and checkpoint-head split. |
| [Notebook Schema Evolution and the Frozen Genesis](schema-evolution-and-genesis.md) | Draft | Frozen genesis seed, freeze-and-layer evolution, forward-tolerant reader, and cross-version sync hazards. |
| [Notebook Host Shell Convergence](notebook-host-shell-convergence.md) | Draft | Shared notebook shell, capability vocabulary, and host adapter boundary across desktop, cloud, and elements. |
| [Cell Execution Pipeline and Control-Plane Separation](execution-pipeline.md) | Draft | Execution state, output ordering, and lifecycle priority. |
| [Execution Liveness](execution-liveness.md) | Design memo | Divergence-detection framing; not a recovery decision yet. |
| [Tokio Mutex Discipline](tokio-mutex-discipline.md) | Draft | Async lock and cancel-safety invariants. |
| [Generated Runtime Artifacts](generated-runtime-artifacts.md) | Draft | Gitignored WASM/renderer outputs, LFS bundles, and `xtask artifacts` ownership. |
| [Frontend Sync Bridge and Stable DOM Order](frontend-sync-bridge.md) | Draft | React/store projection and iframe-preserving cell order. |
| [Live Notebook Projection Policy](live-notebook-projection-policy.md) | Draft | Full materialization fallback boundaries and narrow live store projections. |
| [MCP Session Lifecycle and Daemon Supervision](mcp-session-lifecycle.md) | Draft | MCP proxy, daemon, and session lifetime boundaries. |
| [MCP Resource Addressing](mcp-resource-addressing.md) | Draft | Local `nteract://` MCP resource namespace. |
| [Cloud-Connected Local MCP Clients](cloud-connected-local-mcp.md) | Draft | Local MCP target resolution for hosted notebook URLs and machine-local cloud remote config. |

### Environment and Trust

| Entry | Status | Notes |
|-------|--------|-------|
| [Identity and Trust](identity-and-trust.md) | Accepted | Principal/operator labels, room ACLs, scopes, and publish semantics. |
| [Kernel Environment Trust Model](kernel-env-trust.md) | Draft | Dependency approval and trust-state propagation. |
| [Captured Environment Lifecycle](captured-environment-lifecycle.md) | Draft | Captured environment identity, repair, retry, and manual reset shape. |
| [Automerge Fork Patches](automerge-fork-patches.md) | Draft | Fork/upstream patches needed for lower-cost validation. |

### Blob and Output Protocols

| Entry | Status | Notes |
|-------|--------|-------|
| [Blob Storage and Content Addressing](blob-storage-and-content-addressing.md) | Draft | Local CAS, HTTP serving, durability, and GC. |
| [Blob Ref and Chunk Manifest Output Protocol](blob-ref-and-chunk-manifest-protocol.md) | Draft | Host-neutral blob refs and logical chunk manifests. |
| [Arrow Manifest Durable Storage](arrow-manifest-durable-storage-design.md) | Design memo | Durable storage design for Arrow manifest outputs. |
| [Arrow C Stream Output Protocol](arrow-c-stream-output-protocol.md) | Draft | Table producer contract and Arrow IPC transport. |
| [Structured Kernel Traceback Output Protocol](traceback-output-protocol.md) | Draft | Structured traceback MIME payload and fallback behavior. |
| [Runtime Redaction Refresh](runtime-redaction-refresh-design.md) | Design memo | Output redaction refresh design referenced by the traceback protocol. |
| [Output Rendering Segmentation](output-rendering-segmentation.md) | Draft | Rendering-lane segmentation invariants. |
| [Runtime Output Optimization Plan](runtime-output-optimization.md) | Measurement / plan | Performance plan; not an ADR. |
| [Non-Stream Output Commit Measurements](output-commit-measurements.md) | Measurement | Benchmark evidence for ordinary output commits. |
| [Output Widget Replay Measurements](output-widget-replay-measurements.md) | Measurement | Benchmark evidence for widget replay costs. |

### Hosted Rooms

| Entry | Status | Notes |
|-------|--------|-------|
| [Deployment Topology](deployment-topology.md) | Draft | Hosted room topology, compute attachment, and durable state split. |
| [AWS Rust Room Host](aws-rust-room-host.md) | Draft | Proposed native Rust room host on AWS with Postgres/RDS and S3. |
| [Hosted Room Authorization and Cloud Room Host](hosted-room-authorization.md) | Draft | D1 ACLs, scope derivation, and DO room host. |
| [Runtime Principal Promotion](runtime-principal-promotion.md) | Draft | Local runtime principals, hosted promotion, and execution authority split. |
| [Remote Workstation Doc Agents](remote-workstation-doc-agents.md) | Draft | Provider-neutral workstation/doc-agent registration and runtime-peer attachment model. |
| [Hosted Credential Transport and OIDC Binding](hosted-credential-transport.md) | Draft | Browser, native, agent, and runtime credential transport. |
| [Hosted Notebook Artifacts](hosted-notebook-artifacts.md) | Draft | Published snapshots, R2 layout, and cloud viewer materialization. |
| [Hosted Output Origin Isolation](hosted-output-origin-isolation.md) | Draft | App, output, and renderer origin separation. |
| [Hosted Direct OIDC Anaconda Demo Runbook](hosted-direct-oidc-demo-runbook.md) | Runbook | `preview.runt.run` route takeover, direct OIDC deployment, and smoke-test instructions. |
| [Runtime Peer Contract and Blob Authority Audit](runtime-peer-and-blob-authority-audit.md) | Audit | Current runtime-peer and blob-authority evidence plus follow-ups. |

### Product Requirements

| Entry | Status | Notes |
|-------|--------|-------|
| [Hosted Notebook Sharing and Invites](hosted-sharing-invites.md) | PRD draft | User-facing sharing, invite, first-login, public-viewer, and revocation requirements. |
| [Notebook Identity and Environment Surfaces](notebook-identity-environment-surfaces.md) | PRD draft | Shared product language and UI contract for actors, agents, access, runtime, packages, and trust across desktop, cloud, and Elements. |

### Cross-Cutting Audits

| Entry | Status | Notes |
|-------|--------|-------|
| [Notebook Identity and Environment Surface Audit](notebook-identity-environment-surface-audit.md) | Audit | Current shared shell, Elements, desktop, and cloud gaps against the identity/environment PRD. |

## Maintenance Rules

1. New ADRs, PRDs, runbooks, audits, and measurements should start with
   `# Title` and `**Status:** ...` in the first few lines.
2. Use `Accepted` only when the decision is ready to guide future code review.
3. Use PRDs for user-facing requirements, workflows, roles, launch criteria,
   and product constraints. Use ADRs for durable technical decisions, rejected
   alternatives, invariants, and compatibility boundaries.
4. Keep runbooks, measurements, and audits in this directory only when they
   directly support ADR or PRD decisions, and mark their status accordingly.
5. Record architectural smells in the owning ADR's "Tracked follow-ups" section
   instead of hiding them in prose-only open questions.
6. When a tracked follow-up lands, remove its bullet from the ADR's
   "Tracked follow-ups" section in the same patch, recording the evidence in
   the relevant decision text if it changed one.
