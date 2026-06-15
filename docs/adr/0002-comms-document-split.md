# ADR 0002: Extract widget comm state into its own document (CommsDoc)

- Status: Accepted
- Date: 2026-06-02
- Deciders: nteract maintainers
- Relates to: #3316 (editor write surface), #3317 (runtime-availability capability), ADR 0001 (causal seeding invariant)
- Partially supersedes: `docs/adr/document-split.md`

## Context

We are converging the desktop and cloud notebook hosts on one document model and one authorization story. The principle that emerged from the #3316 review (caught a real P1 where the editor gate left root scalars writable) is: **authorization boundaries should line up with document boundaries, not field subtrees.** Field-level carve-outs are where the bugs hide.

A deep investigation of where that principle leads is recorded in `docs/handoffs/2026-06-01-host-convergence-deep-dive.md`. Its conclusion: the logical endpoint is **every CRDT document is all-or-nothing per principal** (a principal can write the whole document or none of it), which would require five documents. That endpoint is logically forced, but the investigation's premortem found that shipping it as one program concentrates the dangerous failures on an irreversible `cells`/`metadata` data-move out of a frozen-genesis document. So the recommendation is to **decouple**: take the independently-justified, low-risk pieces now, and gate the structural data-move behind separate guarantees.

This ADR is the first decoupled piece. It is also the original "thread 1" of the host-convergence handoff.

The historical document split (`document-split.md`) separated notebook content,
runtime state, and daemon pool state. At the time this ADR was written, the
notebook-room set had grown beyond that original count but still carried a
RuntimeStateDoc field-level carve-out:

| Doc | Writers | Rule |
|---|---|---|
| NotebookDoc | editors+owners (cells), owner (identity/metadata) | structural authoring |
| RuntimeStateDoc | daemon/runtime path only **except widget comm state** | runtime authority |
| PoolDoc | daemon only | daemon-scoped pool template, fanned out to room peers |

The current implementation has shipped the CommsDoc split. RuntimeStateDoc sync
is read-only for ordinary viewer/editor/owner clients; runtime peers can write
only policy-allowed runtime progress, lifecycle, outputs, and topology for
accepted work, and coordinator/room-host paths own execution intent and room
facts. Bidirectional widget values live in CommsDoc.

## Problem

The comm-state carve-out was exactly the kind of partial-document ownership the convergence principle exists to retire.

1. **RuntimeStateDoc was partially owned.** Before CommsDoc, an editor could write it, but only the `comms/*/state/*` subtree. Enforcement was a before/after policy snapshot run at **two sites**: the cloud host's `receive_runtime_state_sync` path and the daemon peer-sync path in `crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs`, both comparing `runtime_state_policy_snapshot(&state_doc)` against `runtime_state_policy_snapshot(&preview)` and rejecting anything outside the permitted comm-state delta. The carve-out did more than drop orphan state: it rejected editor comm creation/deletion, froze all topology/metadata, and rejected any write outside `comms/*/state`. This was a field-subtree gate inside one document, with the same shape as the NotebookDoc editor gate that #3316 had to harden.

2. **It blocked "RuntimeStateDoc is read-only to regular clients."** As long as the carve-out existed, the daemon and the room host both carried a comm-state exception, and the divergence-recovery work (the handoff's thread 2) could not make the clean statement "a regular client rejected on RuntimeStateDoc wrote a document it may not write at all."

3. **The carve-out coupled comm topology and comm state in one object.** Before the split, `comms/{comm_id}` held both the runtime-authored topology and the bidirectional state map. "Topology" here was wider than "target, model, owning cell": it included `target_name`, `model_module`, `model_name`, `outputs`, `seq`, and `capture_msg_id` (the Output-widget routing field). The policy snapshot had to thread that needle on every write.

What makes this tractable is that co-location is currently providing a **cluster of co-location guarantees - three of them load-bearing** - and any split has to re-provide each deliberately:

- **Guard A (orphan-state no-op).** `set_comm_state_property` and `merge_comm_state_delta` bail `Ok` when the comm entry is absent (`doc.rs:2502-2515`, `:2533-2536`). Editor state for a comm that does not exist is silently dropped at write time. This works only because membership (topology) and state live in the same object. The split changes this from **write-rejection** (orphan state never enters the doc) to **forward-suppression** (orphan state lands and persists, but never reaches the kernel) - a real semantic shift, see Decision and the safety discussion in Consequences.
- **The kernel-echo filter is three layers, not one.** Frontend comm changes forward to the kernel; kernel-authored echoes must not, or widgets feed back on themselves. The mechanism is: (a) **per-field LWW-authorship** - `receive_sync_and_foreign_comms` walks each comm's state map key-by-key and retains a key only if its current LWW winner's actor is foreign (`doc.rs:3200-3205`); the doc comment at `doc.rs:3169-3175` explains why a naive `fork + apply foreign-only` is unsafe (frontend writes are causally after kernel writes during a slider drag). (b) a content-hash `EchoSuppressor` with a 30s TTL (`crates/runtimed/src/runtime_agent/echo_suppression.rs`, consulted at `runtime_agent.rs:407,440-443`). (c) a no-op scalar skip in `merge_comm_state_delta` (`doc.rs:2545-2559`). Critically, layer (a) only works if state is a native per-key map - which ties this invariant to the representation question below.
- **GC has two properties: delete authority *and* delete atomicity.** `remove_comm` (on comm_close, `jupyter_kernel.rs:2236`) and `clear_comms` (on relaunch, `launch_kernel.rs:92`) delete the whole `comms/{comm_id}` entry in one Automerge transaction. Co-location gave both "whoever deletes topology reclaims state" *and* the atomicity of doing it in one transaction. A split breaks the second: two docs have independent sync heads, so the delete cannot be atomic across them.

## Forces

- **Document-level authorization.** After the change, "who may write this document" is a single bit per principal, no subtree policy diff.
- **RuntimeStateDoc becomes truly read-only to regular clients.** The comm-state exception leaves it entirely.
- **Safety of multi-principal widget writes.** A document writable by editors,
  owners, and runtime peers is only safe if a write that does not correspond to
  real runtime topology is inert.
- **No data loss across save/load and `.ipynb` export.** Widget state must still round-trip.
- **Low blast radius.** CommsDoc is additive. RuntimeStateDoc genesis is frozen (`RUNTIME_STATE_GENESIS_V2_BYTES`, `doc.rs:338`), so this must not reshape it in place.
- **Decoupled from the frozen-NotebookDoc data-move.** This ADR must stand alone and ship before any `cells`/`metadata` structural split.

## Options

### A. Keep the carve-out, leave RuntimeStateDoc partially owned

Do nothing; keep the policy-snapshot gate.

- **Pros:** zero work; widgets keep working.
- **Cons:** keeps a field-subtree authorization boundary inside a document - the exact pattern #3316 proved dangerous. Blocks RuntimeStateDoc from being cleanly read-only and blocks the clean divergence-recovery statement. Does not address the objection.

### B. Extract comm state into a dedicated CommsDoc (recommended)

A fourth document holds comm **state** only; comm **topology** stays in RuntimeStateDoc.

| Doc | Writers | Contents |
|---|---|---|
| RuntimeStateDoc | local daemon / room host / runtime peer, policy-scoped | executions, outputs, env, trust, display index, **comm topology** (target, model, owning cell) |
| **CommsDoc** (new) | editor/owner/runtime peer | **comm state** (mutable trait values), keyed by comm_id |

The boundary is the existing topology/state field split: RuntimeStateDoc keeps
comm topology, while CommsDoc owns mutable widget values. Editors stop writing
RuntimeStateDoc entirely; the policy-snapshot carve-out and the
`RuntimeStateWriteScope::Editor` comm exception are deleted at both enforcement
sites.

CommsDoc's multi-principal write surface is safe **at the kernel-forward
boundary**, and this needs scoping honestly. State written for a comm_id with no
topology in RuntimeStateDoc is dropped by the membership gate
(`diff_comm_state`, `runtime_agent.rs:1495-1522`) and never reaches the kernel.
It is *not* inert to durable persistence or cross-client rendering: a malicious
or buggy CommsDoc writer can mint arbitrary comm-state entries that land durably
and broadcast to every peer's widget layer until a GC pass reaps them. There is
no per-comm owner concept in the code today (`CommDocEntry`, `doc.rs:276`, has
no owner field) and the previous carve-out already let any editor write state
for any comm with topology, so the split does **not** regress authorization.
What it does shift is the entire safety burden onto a gate that today governs
only kernel-forwarding, not storage or render, and it turns Guard A from
write-rejection into forward-suppression. So the orphan-reclamation path is a
**named requirement**, not a fallback (see Decision).

- **Pros:**
  - RuntimeStateDoc becomes all-or-nothing for regular clients. Runtime peers still use the validated runtime-authoring path.
  - Authorization is a document bit, not a subtree diff.
  - Additive: CommsDoc gets its own frozen genesis seed; RuntimeStateDoc genesis is untouched.
  - Unblocks the clean divergence-recovery statement for RuntimeStateDoc.
- **Cons (each maps to a load-bearing invariant that must be rebuilt, not assumed):**
  - **Guard A becomes forward-suppression.** Membership can no longer be inferred from CommsDoc's own keys (membership is exactly the untrusted thing multiple principals can write). It must be re-derived from RuntimeStateDoc topology on every CommsDoc receive. Orphan state now lands in the doc, so the runtime-side drop is a forward-suppression *plus* a reclamation pass, not a write rejection.
  - **The echo filter loses its substrate, on all three layers.** Per-field LWW-authorship, the content-hash `EchoSuppressor`, and the no-op scalar skip all assume kernel and frontend writes co-locate. After the split each must be re-homed onto CommsDoc's receive path, preserving the causality argument at `doc.rs:3169-3175`. The CI guard must assert that **both** a kernel-actor-authored change **and** a content-hash echo within TTL are never forwarded to the kernel - not just the actor case.
  - **GC splits into authority and atomicity.** The daemon (a pure reader of CommsDoc state for live-sync) must be given CommsDoc write authority so `remove_comm`/`clear_comms` reclaim both docs, *and* a topology-absence GC pass must reap orphans the gate suppresses. Because the two docs have independent sync heads, the delete is non-atomic: a peer can observe topology-gone/state-present (inert, covered by the membership gate) or state-gone/topology-present (surfaces a widget with identity but no values). Specify delete ordering or have readers treat present-topology/absent-state as "not yet loaded."
  - A fourth sync stream on the frontend bridge and a fourth document to bootstrap/reset.

### C. Do the full five-document split now (CommsDoc + MetadataDoc + CellsDoc) as one program

Ship the all-or-nothing endpoint in one go.

- **Pros:** reaches the principle's logical end; deletes `validate_editor_notebook_changes`.
- **Cons (decisive):** couples this cheap, additive, reversible change to the irreversible `cells`/`metadata` data-move out of the frozen NotebookDoc root - the source of the premortem's most-dangerous failures (in-place reshape, silent empty-notebook on a stale client, half-notebook `.ipynb` export). Rejected as one program; the structural split is its own ADR, gated separately (see `docs/handoffs/2026-06-01-host-convergence-deep-dive.md`, Gate 1 / Gate 2).

### D. Move comm state to an ephemeral presence channel instead of a CRDT document

Treat live comm state as presence-style ephemeral data broadcast through the room's single authority, snapshotted to a durable doc only at save.

- **Pros:** no fourth frozen seed, no `comms_doc_id` pointer, no `is_pristine` allowlist change - the carve-out vanishes by making state ephemeral and daemon-snapshotted, so RuntimeStateDoc stays all-or-nothing with the smallest blast radius. Matches the kernel-as-authority reality (the doc is only ever a cache of kernel-owned widget state) and sheds high-churn intermediate values for free.
- **Cons:** durability is no longer continuous - you must answer *when* to snapshot and accept a lost-state window if the room host hibernates or the DO evicts mid-interaction. Late-join is no longer free - the relay must replay a current-state snapshot on join, which the CRDT gives via the sync protocol it already has. The bidirectional kernel path costs *more* than B, not less: presence needs a new forward path plus a writeback for kernel-pushed values, where B re-homes the existing `diff_comm_state` forward.

The reframe behind D is real (if the kernel is the sole authority, a durable CRDT is over-engineering), but its peer-to-peer-convergence payoff is moot here because a room already has a single authority. What is *not* moot - continuous durability and free late-join - is exactly the requirement, so D loses the things this ADR needs and saves a superpower it does not use. D is not rejected outright: its churn-shedding is the right idea in the wrong slot, retained as a future fast-lane (see Decision).

## Decision

**Recommended: Option B (CommsDoc), shipped decoupled from any NotebookDoc structural change, with its three load-bearing invariants built in from the first commit, not deferred.**

Implementation note: this ADR is satisfied by adding CommsDoc as the fourth sync document, keeping RuntimeStateDoc as the topology/runtime document, and shipping the membership gate, echo suppression, orphan GC, save/load merge, and cloud/daemon fourth-stream acceptance tests together. It intentionally does **not** include the larger five-document split.

Concretely, CommsDoc does not land unless the same change set also:

1. **Anchors the membership gate to RuntimeStateDoc topology, and lands it atomically with the carve-out deletion.** Forward comm state to the kernel only for comm_ids present in RuntimeStateDoc topology; re-create Guard A as an explicit runtime-side drop of orphan CommsDoc state plus a reclamation pass for what persists. **This is a hard acceptance gate, not prose guidance:** deleting the carve-out before the cross-doc membership gate lands opens a real window where orphan or abusive comm state reaches the kernel or persists unfiltered. The carve-out deletion (both sites) and the membership gate ship in one change set or not at all.
2. **Re-homes all three echo-suppression layers onto CommsDoc's receive path** - per-field LWW-authorship (preserving the `doc.rs:3169-3175` causality argument), the content-hash `EchoSuppressor`, and the no-op scalar skip. The CI guard must assert that neither a kernel-actor-authored change nor a content-hash echo within TTL is forwarded to the kernel.
3. **Rebuilds both GC properties.** Give the daemon CommsDoc write authority so `remove_comm`/`clear_comms` reclaim both docs, *and* add the topology-absence GC pass for orphans the gate suppresses (the pass is required, not an "or"). Specify delete ordering (state before topology) so the non-atomic cross-doc delete never strands present-topology/absent-state.

**Acceptance tests gating the change set:**
- An editor writes CommsDoc state for a comm_id with no RuntimeStateDoc topology; assert it is (a) never forwarded to the kernel and (b) reaped by the orphan-drop pass.
- A kernel-authored CommsDoc change and a content-hash echo within TTL are both dropped from the kernel-forward path.
- A **multi-principal** integration test (editor + runtime_peer in one room), because a single-principal dev session cannot exercise the cross-principal forward path (the echo filter is actor-prefix-based, `runtime_agent.rs:351`) - the identified blind spot where partial re-homings pass desktop CI and fail only in real rooms.

**A is insufficient** - it preserves the field-subtree boundary this ADR exists to retire. **C is rejected as one program** and split out.

### Substrate: CRDT spine, presence fast-lane deferred (resolves open question 1)

CommsDoc is a CRDT document, for three reasons that survive scrutiny: durability is continuous and free (no "when do we snapshot" question, no lost-state window on host hibernation); late-join convergence is free via the existing sync protocol; and the bidirectional kernel path is the cheapest option (re-homed `diff_comm_state`, no new writeback). The substrate holds *settled* state - the current value of each trait - which is kernel-authoritative but cached durably so the no-kernel render and late joiners are correct.

Option D's presence idea is retained, but in its correct slot: an **optional ephemeral fast-lane for in-flight high-frequency updates** (mid-drag intermediate values) that commits to the CRDT on settle. It is **not** built now. It is added only if measured churn proves to hurt, and it never owns durability - the CRDT remains the record. This keeps presence's churn-shedding exactly where it helps without giving up durability or late-join where it does not.

The per-key prerequisite is **already satisfied** - comm state is a native per-key Automerge map today, which lowers implementation risk and is the reason invariant #2's per-field LWW-authorship works at all. The legacy RuntimeStateDoc write path (`put_comm` -> `automunge::put_json_at_key_batched`) creates a native map, the per-property setter requires an existing map, the kernel-forward diff is per-key, and the policy gate is per-key. No `serde_json::to_string` of comm state exists. So per-key is a **non-regression invariant** to preserve, not a representation to migrate. The per-comm `state` map is created lazily on first `comm_open`, not in frozen genesis, so the seed shape does not bind it; the write helpers and unit tests do.

Resolved implementation note: `put_comm` now uses the batched automunge helper
instead of the older deprecated per-key helper, and mutable widget values moved
to CommsDoc. Preserve that object-identity behavior if this topology helper is
rewritten again.

## Consequences

- **RuntimeStateDoc becomes read-only to regular clients.** The `RuntimeStateWriteScope::Editor` comm-state exception and the `runtime_state_policy_snapshot` before/after carve-out are removed at both enforcement sites: the cloud host and the daemon peer-sync path. Runtime peers remain the runtime-authoring scope for policy-allowed progress, lifecycle, outputs, and topology; execution intent/provenance remains coordinator/room-host owned. This is the convergence principle applied to regular client writes into the runtime document.
- **Any CommsDoc writer can now mint unbounded orphan comm_ids.** Because orphan state lands durably (forward-suppression, not write-rejection), CommsDoc needs an orphan floor / size consideration: the reclamation pass must bound how much un-topologied state can accumulate, and the doc-size budget has to account for abusive minting.
- **A new frozen CommsDoc genesis seed** is added and registered in `GENESIS_SEEDS_IN_WASM` (`crates/xtask/src/main.rs:1509`), with a shape-asserting `verify-genesis` check, or an old wasm ships the wrong seed and re-triggers the #3086 zeroing footgun. CommsDoc is multi-principal, so it needs its own `is_canonical_*_seed_change` hash-pin mirroring NotebookDoc's seed authorization.
- **A `comms_doc_id` identity pointer** is added, owner-only, alongside `runtime_state_doc_id`. **Make it deterministically derivable** (`comms:{notebook_id}`), mirroring `default_runtime_state_doc_id` (`crates/notebook-doc/src/lib.rs:118-120`); a random pointer whose `put` fails to reach disk gets re-minted divergently on reload, a silent fork.
- **Implementation update, 2026-06-15:** production CommsDoc sync, storage,
  and projection exist, and `NotebookDoc.comms_doc_id` now lands through
  `new_inner` plus the load/migration repair path. It is deterministically
  derived as `comms:{notebook_id}` and included in ADR 0001's pristine
  allowlist, so a fresh notebook that stamps the pointer still seeds exactly
  once. Hosted snapshot routes still use their existing runtime-state keyed
  CommsDoc object paths; moving those routes and catalog rows to first-class
  `comms_doc_id` keying is the remaining hosted persistence cleanup.
- **Migration is stop-writing, not reshape.** RuntimeStateDoc genesis is frozen v2, so the daemon simply stops writing `comms/*/state` there while old peers read an absent map, and the forward path reads state from CommsDoc. Verify no reader of `state.comms` breaks when state leaves RuntimeStateDoc while topology stays - the readers extend past the obvious ones: `daemon.rs:4603-4612`, `output_commit_measure.rs:287-297`, plus the daemon-local comm-keyed caches (`capture_cache`, `output_widget_replay_cache`, cleared on `remove_comm` at `jupyter_kernel.rs:2232-2233`). Confirm the policy-sense topology fields (`capture_msg_id`, `outputs`, `seq`) stay in RuntimeStateDoc, not CommsDoc.
- **A fourth frontend sync stream** is added to the bridge (`apps/notebook/src/lib/notebook-sync-store-bridge.ts`, `runtime-state.ts`), with its own bootstrap and reset path. Per-document reset matters here: resetting CommsDoc must not blow away RuntimeStateDoc or CellsDoc projections (a constraint the divergence-recovery ADR builds on).
- **`.ipynb` and save/load** must read topology from RuntimeStateDoc and state from CommsDoc and reassemble one widget-state blob. Confirm the two docs' comm_id sets are read at a consistent snapshot so widgets do not restore with identity-but-no-values or values-but-no-identity.

## Follow-up status

1. **Comm-state representation - resolved, no migration.** Comm state is already a native per-key Automerge map. RuntimeStateDoc topology creation now uses the batched automunge helper, CommsDoc stores mutable widget values, and the per-property setter requires a Map. Treat per-key state as a non-regression invariant. Substrate itself is resolved in Decision: CRDT spine, presence fast-lane deferred.
2. **Closed-comm GC: implemented with non-atomic cross-doc ordering.** Daemon/runtime cleanup has CommsDoc write authority for `comm_close`/relaunch and topology-absence pruning. Readers must still tolerate the transient split states caused by independent RuntimeStateDoc and CommsDoc heads.
3. **Echo-filter homing: implemented on the CommsDoc receive/forward path.** Kernel-authored widget state lands in CommsDoc under runtime actor labels, and the runtime forward path filters kernel-authored echoes before forwarding foreign deltas to the kernel.
4. **Consistent save snapshot: implemented, still worth watching.** Save/export reads RuntimeStateDoc topology and CommsDoc state and reassembles widget metadata; because the two docs have independent heads, future changes should preserve the current tolerance for identity-without-values and values-without-identity windows.
5. **Seed hash-pinning: implemented through the frozen CommsDoc genesis artifact.** Keep CommsDoc genesis verification alongside NotebookDoc and RuntimeStateDoc genesis verification when the schema evolves.
