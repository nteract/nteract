# Documentation

This directory separates thinking, decisions, product requirements, execution
plans, evidence, and operations so product, design, engineering, research, and
AI collaborators can use the same vocabulary.

## Start Here

Use these entry points when you need the current durable framing for a subsystem.
They are not a complete inventory; they route to the docs most likely to anchor
new product, engineering, or agent work.

| Topic | Start with |
|-------|------------|
| Local-first notebook state | [`adr/local-first-notebook-state.md`](adr/local-first-notebook-state.md), [`adr/document-split.md`](adr/document-split.md), [`adr/runtime-state-document-identity.md`](adr/runtime-state-document-identity.md) |
| Execution and output transport | [`adr/execution-pipeline.md`](adr/execution-pipeline.md), [`adr/typed-frame-v4-wire-protocol.md`](adr/typed-frame-v4-wire-protocol.md), [`adr/blob-ref-and-chunk-manifest-protocol.md`](adr/blob-ref-and-chunk-manifest-protocol.md) |
| MCP notebook connections | [`adr/mcp-session-lifecycle.md`](adr/mcp-session-lifecycle.md), [`adr/notebook-identity-and-path-binding.md`](adr/notebook-identity-and-path-binding.md), [`memos/mcp-connect-initial-projection.md`](memos/mcp-connect-initial-projection.md) |
| Notebook shell, frontend convergence, and RxJS stores | [`adr/notebook-host-shell-convergence.md`](adr/notebook-host-shell-convergence.md), [`adr/frontend-sync-bridge.md`](adr/frontend-sync-bridge.md), [`memos/shared-store-projection-convergence.md`](memos/shared-store-projection-convergence.md), [`adr/output-rendering-segmentation.md`](adr/output-rendering-segmentation.md) |
| Hosted accounts, Notebook Home, and compute federation | [`adr/cloud-connected-local-mcp.md`](adr/cloud-connected-local-mcp.md), [`memos/hosted-notebook-federation.md`](memos/hosted-notebook-federation.md), [`memos/desktop-cloud-daemon-bridge.md`](memos/desktop-cloud-daemon-bridge.md), [`adr/remote-workstation-doc-agents.md`](adr/remote-workstation-doc-agents.md) |
| Identity, trust, and hosted rooms | [`adr/identity-and-trust.md`](adr/identity-and-trust.md), [`adr/hosted-room-authorization.md`](adr/hosted-room-authorization.md), [`adr/deployment-topology.md`](adr/deployment-topology.md) |
| Remote compute and workstations | [`adr/remote-workstation-doc-agents.md`](adr/remote-workstation-doc-agents.md), [`adr/runtime-principal-promotion.md`](adr/runtime-principal-promotion.md), [`runbooks/remote-workstation.md`](runbooks/remote-workstation.md) |
| Product requirements | [`prd/notebook-identity-environment-surfaces.md`](prd/notebook-identity-environment-surfaces.md), [`prd/hosted-sharing-invites.md`](prd/hosted-sharing-invites.md) |
| Evidence and measurements | [`audits/`](audits/), [`measurements/`](measurements/) |
| Operational setup | [`runbooks/macos-setup.md`](runbooks/macos-setup.md), [`runbooks/hosted-direct-oidc-demo-runbook.md`](runbooks/hosted-direct-oidc-demo-runbook.md) |

For the architecture decision register's status vocabulary and maintenance
rules, start with [`adr/README.md`](adr/README.md).

## Taxonomy

| Home | Purpose |
|------|---------|
| [`adr/`](adr/) | Durable technical decisions, proposed decisions, rejected alternatives, invariants, and compatibility boundaries. |
| [`memos/`](memos/) | Shared thinking, research, options, sketches, open comments, and RFCs before they become decisions. |
| [`prd/`](prd/) | Product requirements, workflows, roles, launch criteria, and user-facing behavior. |
| [`plans/`](plans/) | Scoped implementation plans for already-framed work. |
| [`audits/`](audits/) | Source-backed evidence and follow-up lists for a boundary, subsystem, or product surface. |
| [`measurements/`](measurements/) | Benchmark evidence, performance models, and optimization plans. |
| [`runbooks/`](runbooks/) | Operational procedures. |

When in doubt, start with a memo. Durable technical decisions can graduate into
ADRs, durable product commitments can graduate into PRDs, and scoped execution
can graduate into plans.
