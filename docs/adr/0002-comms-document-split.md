# ADR 0002: Extract widget comm state into its own document (CommsDoc)

**Status:** Accepted (2026-06-02; implemented 2026-06-15). Partially supersedes `docs/adr/document-split.md`. Relates to [ADR 0001](0001-notebook-seeding-invariant.md), editor write-surface hardening, and the runtime-availability capability.

## Context

Desktop and cloud notebook hosts are converging on one document model and one authorization story. Editor write-surface hardening caught a P1 bug where the editor gate left root scalars writable, establishing a clear rule: **authorization boundaries must match document boundaries, not field subtrees.** Field-level carve-outs hide bugs.

The full all-or-nothing per-principal endpoint requires five documents. Shipping that in one program concentrates risk on an irreversible `cells`/`metadata` data-move out of the frozen-genesis `NotebookDoc`. Instead, we decoupled the work: ship additive, low-risk splits independently, and gate the structural `NotebookDoc` split separately.

The original split (`docs/adr/document-split.md`) separated notebook content, runtime state, and daemon pool state. Before this ADR, the notebook-room set still carried a field-level carve-out inside `RuntimeStateDoc`:

| Doc | Writers (before CommsDoc) | Rule |
|---|---|---|
| `NotebookDoc` | editors+owners (`cells`), owner (identity/metadata) | structural authoring |
| `RuntimeStateDoc` | daemon/runtime path only **except widget comm state** | runtime authority |
| `PoolDoc` | daemon only | daemon-scoped pool template, fanned out to room peers |

That carve-out created three problems:

1. **Partial ownership of `RuntimeStateDoc`.** Previously, editors could write only the `comms/*/state/*` subtree inside `RuntimeStateDoc`. Two enforcement sites — the cloud host's `receive_runtime_state_sync` path and the daemon peer-sync path (`crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs`) — compared before/after `runtime_state_policy_snapshot(&state_doc)` against `runtime_state_policy_snapshot(&preview)`. That gate blocked editor comm creation and deletion, froze topology and metadata, and rejected writes outside `comms/*/state`, repeating the brittle field-subtree pattern.
2. **Blocked read-only `RuntimeStateDoc` for regular clients.** Both hosts carried a `RuntimeStateWriteScope::Editor` comm-state exception. Divergence recovery could not treat any regular-client write to `RuntimeStateDoc` as categorically unauthorized.
3. **Coupled topology and mutable state in one object.** Previously, `comms/{comm_id}` stored both runtime-authored topology (`target_name`, `model_module`, `model_name`, `outputs`, `seq`, and the Output-widget routing field `capture_msg_id`) and the bidirectional `state` map. Co-location provided three guarantees that the split had to preserve or replace:
   - **Guard A (orphan-state no-op):** Previously, `set_comm_state_property` and `merge_comm_state_delta` returned `Ok` when the comm entry was absent (`doc.rs:2502-2515`, `:2533-2536`), silently dropping orphan state at write time.
   - **Three-layer kernel-echo filter:** Frontend comm changes forward to the kernel, while kernel-authored echoes must not feed back. Three layers prevented loops: (a) per-field LWW-authorship in `receive_sync_and_foreign_comms` (`doc.rs:3200-3205`; `doc.rs:3169-3175` explains why naive `fork + apply foreign-only` is unsafe when frontend writes land causally after kernel writes during a slider drag), (b) content-hash `EchoSuppressor` with a 30s TTL (`crates/runtimed/src/runtime_agent/echo_suppression.rs`, consulted at `runtime_agent.rs:407,440-443`), and (c) a no-op scalar skip in `merge_comm_state_delta` (`doc.rs:2545-2559`). Layer (a) requires a native per-key Automerge map.
   - **GC authority and atomicity:** Previously, `remove_comm` (on `comm_close`, `jupyter_kernel.rs:2236`) and `clear_comms` (on relaunch, `launch_kernel.rs:92`) deleted `comms/{comm_id}` in one Automerge transaction. Independent sync heads across two documents make cross-doc deletion non-atomic.

## Decision

Extract mutable widget comm **state** into a fourth sync document, **`CommsDoc`**, while comm **topology** remains in `RuntimeStateDoc`. This split ships independently of any `NotebookDoc` structural change.

| Doc | Writers | Contents |
|---|---|---|
| `RuntimeStateDoc` | local daemon, room host, or runtime peer (policy-scoped) | executions, outputs, env, trust, display index, **comm topology** (`target_name`, `model_module`, `model_name`, `outputs`, `seq`, `capture_msg_id`, owning cell) |
| `CommsDoc` | editor, owner, or runtime peer | **comm state** (mutable widget trait values), keyed by `comm_id` |

`RuntimeStateDoc` sync is read-only for ordinary viewer, editor, and owner clients. Runtime peers write only policy-allowed runtime progress, lifecycle, outputs, and topology for accepted work; coordinator and room-host paths own execution intent and room facts. The `RuntimeStateWriteScope::Editor` comm-state exception and the before/after `runtime_state_policy_snapshot` carve-out are removed at both enforcement sites (cloud host and daemon peer-sync).

### Required invariants

1. **Topology-anchored membership gate (replaces Guard A).** The runtime agent forwards comm state to the kernel only for `comm_id`s present in `RuntimeStateDoc` topology (`diff_comm_state`, `runtime_agent.rs:1495-1522`). Membership is re-derived from `RuntimeStateDoc` on every `CommsDoc` receive, never inferred from `CommsDoc`'s own keys. Orphan state is dropped at the kernel-forward boundary and reaped by a topology-absence GC pass.
   - **Security boundary:** This shifts Guard A from write-rejection to forward-suppression plus reclamation. Multi-principal writes are safe at the kernel-forward boundary, not inert to storage or rendering: a buggy or malicious `CommsDoc` writer can mint unmatched `comm_id` entries that persist durably and broadcast to peers until GC reaps them. Because `CommDocEntry` (`doc.rs:276`) has no per-comm owner and the prior carve-out already let any editor write state for any existing comm, authorization does not regress. The orphan reclamation pass is mandatory to bound accumulation.
2. **Three-layer echo suppression on `CommsDoc`.** Kernel-authored widget state lands in `CommsDoc` under runtime actor labels. All three echo-filter layers live on `CommsDoc`'s receive and forward path: per-field LWW-authorship (preserving the `doc.rs:3169-3175` causality invariant), the 30s-TTL content-hash `EchoSuppressor`, and the no-op scalar skip. CI verifies that neither a kernel-actor-authored change nor a content-hash echo within TTL reaches the kernel.
3. **Two-part GC and delete ordering.** Daemon and runtime cleanup hold `CommsDoc` write authority so `remove_comm` (`comm_close`) and `clear_comms` (relaunch) reclaim both documents, alongside the mandatory topology-absence GC pass for suppressed orphans. Deletions remove state before topology so non-atomic cross-doc sync avoids stranding present-topology/absent-state. Readers still tolerate transient split states: present-topology/absent-state is treated as not yet loaded, and absent-topology/present-state is inert under the membership gate.
4. **Multi-principal verification.** Acceptance tests cover:
   - An editor writing `CommsDoc` state for a `comm_id` absent from `RuntimeStateDoc` topology — never forwarded to the kernel, and reaped by orphan GC.
   - A kernel-authored `CommsDoc` change and a content-hash echo within TTL — both dropped from the kernel-forward path.
   - A multi-principal room (editor plus `runtime_peer`), because the echo filter is actor-prefix-based (`runtime_agent.rs:351`) and single-principal desktop runs cannot exercise cross-principal forwarding.

### Substrate and representation

`CommsDoc` is a CRDT document storing *settled* trait values (kernel-authoritative, durably cached for no-kernel renders and late joiners). Three properties justify a CRDT over an ephemeral channel:

- Continuous durability with no snapshot-timing gap or lost-state window on host hibernation.
- Free late-join convergence over the existing sync protocol.
- Lowest-cost bidirectional kernel path via the re-homed `diff_comm_state` forwarder, with no extra writeback protocol.

An optional ephemeral presence fast-lane for high-frequency in-flight updates (such as mid-drag intermediate values) that commits to the CRDT on settle is deferred. Add it only if measured churn proves costly; the CRDT remains the durability record.

**Native per-key map invariant:** Comm state is stored as a native per-key Automerge `Map`, never a `serde_json::to_string` blob. Per-field LWW-authorship depends on this invariant. The per-comm `state` map is created lazily on first `comm_open` rather than in frozen genesis. `put_comm` uses the batched automunge helper (`automunge::put_json_at_key_batched`) instead of the deprecated per-key helper, preserving object identity, and the per-property setter requires an existing `Map`.

## Consequences

- **Read-only `RuntimeStateDoc` for regular clients.** Removing the comm-state carve-out makes regular-client write authorization a document-level bit and unblocks clean divergence recovery on `RuntimeStateDoc`.
- **Frozen `CommsDoc` genesis and hash-pinning.** `CommsDoc` has its own frozen genesis artifact registered in `GENESIS_SEEDS_IN_WASM` (`crates/xtask/src/main.rs:1509`) with a shape-asserting `verify-genesis` check, preventing stale WASM builds from shipping mismatched seeds and zeroing documents. Because `CommsDoc` is multi-principal, it uses its own `is_canonical_*_seed_change` hash-pin mirroring `NotebookDoc`. Keep `CommsDoc` genesis verification alongside `NotebookDoc` and `RuntimeStateDoc` whenever schemas evolve.
- **Deterministic `comms_doc_id` identity pointer.** `NotebookDoc.comms_doc_id` (owner-only, alongside `runtime_state_doc_id`) is deterministically derived as `comms:{notebook_id}`, mirroring `default_runtime_state_doc_id` (`crates/notebook-doc/src/lib.rs:118-120`), so a failed persist cannot re-mint a divergent pointer on reload. It lands via `new_inner` and the load/migration repair path, and is included in ADR 0001's pristine allowlist so fresh notebooks still seed once.
- **Stop-writing migration.** `RuntimeStateDoc` genesis (`RUNTIME_STATE_GENESIS_V2_BYTES`, `doc.rs:338`) is untouched. The daemon stops writing `comms/*/state` there; old peers see an absent map while the forward path reads `CommsDoc`. Policy-sense topology fields (`capture_msg_id`, `outputs`, `seq`) remain in `RuntimeStateDoc`. Topology readers — including `daemon.rs:4603-4612`, `output_commit_measure.rs:287-297`, and daemon-local caches (`capture_cache`, `output_widget_replay_cache`, cleared on `remove_comm` at `jupyter_kernel.rs:2232-2233`) — keep reading from `RuntimeStateDoc`.
- **Fourth frontend sync stream.** The frontend bridge (`apps/notebook/src/lib/notebook-sync-store-bridge.ts`, `runtime-state.ts`) adds a fourth stream with its own bootstrap and per-document reset. Resetting `CommsDoc` does not wipe `RuntimeStateDoc` or `CellsDoc` projections.
- **Save, load, and `.ipynb` export.** Save and export read topology from `RuntimeStateDoc` and state from `CommsDoc`, reassembling one widget-state blob. Because the two documents have independent heads, save/export and readers must preserve tolerance for transient identity-without-values and values-without-identity windows.

## Rejected Alternatives

### A. Keep the carve-out inside `RuntimeStateDoc`

Leaving the policy-snapshot gate in place requires zero work, but keeps a brittle field-subtree authorization boundary inside one document, prevents `RuntimeStateDoc` from being read-only to regular clients, and blocks clean divergence recovery.

### C. Ship the full five-document split (`CommsDoc` + `MetadataDoc` + `CellsDoc`) in one program

Shipping all five documents at once would reach the full all-or-nothing endpoint and delete `validate_editor_notebook_changes`. Rejected as a single program because it couples an additive, reversible change to the irreversible `cells`/`metadata` data-move out of frozen `NotebookDoc`, concentrating risk around in-place reshapes, silent empty notebooks on stale clients, and half-notebook `.ipynb` exports. That structural split belongs in its own ADR.

### D. Move comm state to an ephemeral presence channel

Broadcasting live comm state through the room's single authority and snapshotting to a durable document on save would avoid a fourth frozen seed, `comms_doc_id`, and `is_pristine` changes while shedding high-churn values. Rejected as the primary substrate because it loses continuous durability (creating a lost-state window on host hibernation or Durable Object eviction), loses free late-join sync (requiring relay snapshot replay), and complicates the bidirectional kernel path with a new forward path plus kernel writeback. Its churn-shedding idea is kept only as a deferred fast-lane.

## Open Follow-ups

- Migrate hosted snapshot routes and catalog rows from runtime-state-keyed `CommsDoc` object paths to first-class `comms_doc_id` keying.
- Enforce an explicit orphan floor and doc-size budget in `CommsDoc` reclamation so abusive minting of unmatched `comm_id` entries cannot grow the document unboundedly.
