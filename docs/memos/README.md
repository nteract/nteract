# Memos

Memos are shared thinking space for product, design, engineering, research, and
AI collaborators.

They are source-grounded but not decision-authoritative. A memo may contain
context, user problems, design principles, technical constraints, options, open
comments, sketches, and proposed next steps.

Durable technical decisions graduate into ADRs. Durable product requirements
graduate into PRDs. Scoped execution work may graduate into implementation
plans. Time-bound transfer notes belong in `docs/handoffs/`.

## Status Values

- **Exploration**: context gathering, source references, options, and open
  comments.
- **RFC**: concrete proposal ready for cross-functional review, not yet
  accepted.
- **Superseded**: replaced by an ADR, PRD, implementation plan, or newer memo.

## Current Memos

| Memo | Status | Notes |
|------|--------|-------|
| [Arrow Manifest Durable Storage](arrow-manifest-durable-storage-design.md) | Exploration | Durable storage design framing for Arrow manifest outputs. |
| [Execution Liveness](execution-liveness.md) | Exploration | Divergence-detection framing; not a recovery decision yet. |
| [Markdown Plan Documents](markdown-plan-documents.md) | Exploration | First pass on a first-class Markdown/MDX document surface, comments, presence, outputs, and hosted publishing. |
| [Runtime Redaction Refresh](runtime-redaction-refresh-design.md) | Exploration | Output redaction refresh design referenced by the traceback protocol. |
| [Environment Sandbox Policy Design](env-sandbox-policy-design.md) | Exploration | nono integration for env build sandboxing: pack namespace, machine policy, notebook hints, denial flow, MCP context. |
