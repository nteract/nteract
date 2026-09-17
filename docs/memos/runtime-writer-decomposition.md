# Runtime writer decomposition

**Status:** Proposal, 2026-09-17. Refactor internal write entry points while
preserving the existing documents, authorization policy, and process layout.

## Current implementation

A notebook room syncs `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, and
`CommentsDoc`. `PoolDoc` is daemon-scoped. The
[document split ADR](../adr/document-split.md) describes their ownership.

The daemon coordinates room lifecycle, recovery, file saves, environment
selection, and execution intent. Each kernel already has a separate
`runtimed runtime-agent` process. The agent discovers accepted executions through
RuntimeStateDoc sync and writes execution progress, outputs, and widget topology.
See `crates/runtimed/src/runtime_agent_handle.rs` and
`crates/runtimed/src/runtime_agent.rs`.

Local and hosted runtime ingress already share the Rust policy in
`crates/runtime-doc/src/policy.rs`. The daemon calls
`validate_runtime_state_sync_scope` from
`crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs`. The TypeScript
host calls `RoomHost.receive_peer_frame` through
`apps/notebook-cloud/src/room-materializer.ts`; the Rust WASM implementation in
`crates/runtimed-wasm/src/lib.rs` calls the same validator. A separate TypeScript
policy implementation is unnecessary.

Shared validation does not make every ingress behavior identical. For example,
the daemon strips RuntimeStateDoc changes from ordinary clients, while the
hosted receive path returns an error. Both prevent those changes from being
applied. Tests should distinguish that authorization outcome from the transport
response.

## Proposed change

Review the internal coordinator and runtime-agent write paths, then introduce
separate entry points where that makes ownership easier to enforce. Incoming
peer validation already distinguishes their rights; internal room-host writes
can call document methods directly. The useful question is whether a narrower
internal API would prevent mistakes in those trusted write paths.

| Responsibility | Current owner | Document or storage |
| --- | --- | --- |
| Notebook content | Authorized clients, subject to ingress checks | `NotebookDoc` |
| Execution intent, path/save, trust, environment, schema and root fields | Local coordinator or hosted room host | `RuntimeStateDoc` |
| Execution progress, outputs, and widget topology | Runtime peer within the shared write policy; room host also handles lifecycle recovery | `RuntimeStateDoc` |
| Mutable widget values | Runtime agent and authorized clients | `CommsDoc` |
| Comments | Authorized editors and owners; attribution uses admitted change actors | `CommentsDoc` |
| Environment pool counters | Daemon | `PoolDoc` |
| Notebook recovery and file checkpoints | Room source lifecycle | Recovery journal and `.ipynb` checkpoint |

The first change should be small enough to demonstrate a specific improvement:
identify an internal write path with unclear ownership, route it through a
scoped API, and test the allowed and rejected mutations. Keep the existing
shared ingress validator.

## Scope

This proposal does not require a document migration, another process, or changes
to MCP's session model. Execution continues to reference synced `cell_id` values.
Recovery remains governed by
[room source lifecycle and file recovery](../adr/room-source-lifecycle-and-file-recovery.md).

[ADR 0002](../adr/0002-comms-document-split.md) separated the CommsDoc work from a
possible NotebookDoc cells/metadata split. It did not prohibit future document
splits. Any such change needs its own compatibility and migration design.

The hosting proposals for [celld](celld-hosted-room-substrate.md) and
[AWS](aws-rust-room-host.md), the
[execution-engine proposal](execution-engines-and-marimo.md), and existing UI
and release work retain their own scope. This memo does not establish a new
prerequisite for them.

## Questions to resolve

1. Which internal write paths would benefit from separate coordinator and
   runtime-progress APIs? Identify concrete call sites before choosing a module
   or crate boundary.
2. Which host-owned recovery operations legitimately update runtime progress,
   and how should the API represent them?
3. Which differences between local and hosted ingress are intentional? Compare
   authorization, actor checks, and document state after rejection, as well as
   error handling and reconnect behavior.

The [implementation plan](../plans/runtime-writer-decomposition.md) starts with
that audit. Record an ADR once the proposed API and its tradeoffs are reviewed.
[Runtime principal promotion](../adr/runtime-principal-promotion.md) remains a
separate draft about hosted identity and authority.
