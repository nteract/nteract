# ADR 0002: Extract widget comm state into its own document (CommsDoc)

- Status: Proposed
- Date: 2026-06-02
- Deciders: nteract maintainers
- Relates to: #3316 (editor write surface), #3317 (runtime-availability capability), ADR 0001 (causal seeding invariant)
- Partially supersedes: `docs/adr/three-document-split.md`

## Context

We are converging the desktop and cloud notebook hosts on one document model and one authorization story. The principle that emerged from the #3316 review (caught a real P1 where the editor gate left root scalars writable) is: **authorization boundaries should line up with document boundaries, not field subtrees.** Field-level carve-outs are where the bugs hide.

A deep investigation of where that principle leads is recorded in `docs/handoffs/2026-06-01-host-convergence-deep-dive.md`. Its conclusion: the logical endpoint is **every CRDT document is all-or-nothing per principal** (a principal can write the whole document or none of it), which would require five documents. That endpoint is logically forced, but the investigation's premortem found that shipping it as one program concentrates the dangerous failures on an irreversible `cells`/`metadata` data-move out of a frozen-genesis document. So the recommendation is to **decouple**: take the independently-justified, low-risk pieces now, and gate the structural data-move behind separate guarantees.

This ADR is the first decoupled piece. It is also the original "thread 1" of the host-convergence handoff.

Today there are three documents (`three-document-split.md`):

| Doc | Writers | Rule |
|---|---|---|
| NotebookDoc | editors+owners (cells), owner (identity/metadata) | structural authoring |
| RuntimeStateDoc | daemon/runtime only **except widget comm state** | runtime authority |
| PoolDoc | daemon only | pool template |

RuntimeStateDoc is not cleanly read-only to clients for exactly one reason: **widget comm state is bidirectional.** Editors must be able to write `comms/{comm_id}/state/{key}` so a slider or a text box pushes its value back to the kernel. That is the lone carve-out in the hosted-room authorization model (Decision 7), and it is enforced not by a document boundary but by a field-subtree policy diff.

## Problem

The comm-state carve-out is exactly the kind of partial-document ownership the convergence principle exists to retire.

1. **RuntimeStateDoc is partially owned.** An editor may write it, but only the `comms/*/state/*` subtree. Enforcement is a before/after policy snapshot: `receive_runtime_state_sync` previews the change on a clone, then compares `runtime_state_policy_snapshot(&self.state_doc)` against `runtime_state_policy_snapshot(&preview)` and rejects anything outside the permitted comm-state delta (`crates/runtimed-wasm/src/lib.rs:663-697`, scopes at `:844-849`). This is a field-subtree gate inside one document, with the same shape as the NotebookDoc editor gate that #3316 had to harden.

2. **It blocks "RuntimeStateDoc is read-only to clients, period."** As long as the carve-out exists, the daemon and the room host both carry a comm-state exception, and the divergence-recovery work (the handoff's thread 2) cannot make the clean statement "a client rejected on RuntimeStateDoc wrote a document it may not write at all."

3. **The carve-out couples comm topology and comm state in one object.** `comms/{comm_id}` holds both the runtime-authored topology (target, model module/name, owning cell) and the bidirectional state map (`crates/runtime-doc/src/doc.rs:2467-2496`). The policy snapshot has to thread that needle on every write.

What makes this tractable is that co-location is currently providing three invariants *for free*, and any split has to re-provide them deliberately:

- **Guard A (orphan-state no-op).** `set_comm_state_property` and `merge_comm_state_delta` bail `Ok` when the comm entry is absent (`doc.rs:2502-2515`, `:2533-2536`). Editor state written for a comm that does not exist is silently dropped. This works only because membership (topology) and state live in the same object.
- **The kernel-echo filter.** Frontend-originated comm changes are forwarded to the kernel, but kernel-authored echoes are not (or widgets feed back on themselves). The filter is per-change actor discrimination on one document: `receive_sync_and_foreign_comms_recovering` + `diff_comm_state(&comms_before, &foreign_comms)`, skipping when all applied changes were self-kernel echoes (`crates/runtimed/src/runtime_agent.rs:336-368`).
- **GC authority.** `remove_comm` and `clear_comms` delete the whole `comms/{comm_id}` entry in one op (`doc.rs:2606-2627`). Whoever can delete topology reclaims state for free.

## Forces

- **Document-level authorization.** After the change, "who may write this document" is a single bit per principal, no subtree policy diff.
- **RuntimeStateDoc becomes truly read-only to clients.** The comm-state exception leaves it entirely.
- **Safety of "anyone writes."** A document anyone in the room may write is only safe if a write that does not correspond to real runtime topology is inert.
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
| RuntimeStateDoc | daemon/runtime only | executions, outputs, env, trust, display index, **comm topology** (target, model, owning cell) |
| **CommsDoc** (new) | anyone in the room + runtime | **comm state** (mutable trait values), keyed by comm_id |

The boundary is the existing topology/state field split (already enforced by `validate_comm_metadata_unchanged`, `crates/runtime-doc/src/policy.rs:491`). "Anyone writes CommsDoc" is genuinely safe because state written for a comm_id with no topology in RuntimeStateDoc is orphaned and ignored. Editors stop writing RuntimeStateDoc entirely; the policy-snapshot carve-out and the `RuntimeStateWriteScope::Editor` comm exception are deleted.

- **Pros:**
  - RuntimeStateDoc becomes all-or-nothing (daemon-only), read-only to clients.
  - Authorization is a document bit, not a subtree diff.
  - Additive: CommsDoc gets its own frozen genesis seed; RuntimeStateDoc genesis is untouched.
  - Unblocks the clean divergence-recovery statement for RuntimeStateDoc.
- **Cons (each maps to a load-bearing invariant that must be rebuilt, not assumed):**
  - **Guard A is gone.** Membership can no longer be inferred from CommsDoc's own keys (membership is exactly the untrusted thing anyone can write). It must be re-derived from RuntimeStateDoc topology on every CommsDoc receive, as an explicit runtime-side drop of orphan state.
  - **The echo filter loses its substrate.** It depends on kernel and frontend writes living in one document with distinguishable actor prefixes. After the split it must be re-homed structurally onto CommsDoc's receive path, with a CI guard that a kernel-authored CommsDoc change is never forwarded to the kernel.
  - **GC authority splits.** Deletion is a write; the daemon (a pure reader of CommsDoc state for live-sync) must be given CommsDoc write authority so `remove_comm`/`clear_comms` wipe both docs, or a topology-absence GC pass must reclaim orphaned state.
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

Concretely, CommsDoc does not land unless the same change set also:

1. **Anchors the membership gate to RuntimeStateDoc topology.** Forward comm state to the kernel only for comm_ids present in RuntimeStateDoc topology; re-create Guard A as an explicit runtime-side drop of orphan CommsDoc state.
2. **Re-homes the kernel-echo filter onto CommsDoc's receive path** as a structural property, with a CI guard asserting a kernel-authored CommsDoc change is never forwarded to the kernel.
3. **Gives the daemon CommsDoc write authority** so `remove_comm`/`clear_comms` reclaim topology and state atomically (or a topology-absence GC pass does).

**A is insufficient** - it preserves the field-subtree boundary this ADR exists to retire. **C is rejected as one program** and split out.

### Substrate: CRDT spine, presence fast-lane deferred (resolves open question 1)

CommsDoc is a CRDT document, for three reasons that survive scrutiny: durability is continuous and free (no "when do we snapshot" question, no lost-state window on host hibernation); late-join convergence is free via the existing sync protocol; and the bidirectional kernel path is the cheapest option (re-homed `diff_comm_state`, no new writeback). The substrate holds *settled* state - the current value of each trait - which is kernel-authoritative but cached durably so the no-kernel render and late joiners are correct.

Option D's presence idea is retained, but in its correct slot: an **optional ephemeral fast-lane for in-flight high-frequency updates** (mid-drag intermediate values) that commits to the CRDT on settle. It is **not** built now. It is added only if measured churn proves to hurt, and it never owns durability - the CRDT remains the record. This keeps presence's churn-shedding exactly where it helps without giving up durability or late-join where it does not.

The decision is gated on one representation sub-question: comm state must be a **native per-key Automerge map**, not a single JSON-blob string per comm. A blob rewrite is one fat op per keystroke and history bloats fast; a per-key map keeps churn per-trait and compacts far better. The current representation is ambiguous in the code (`doc.rs:63` describes a JSON-encoded `Str`, but the wasm setter writes per-key), so this must be nailed before the CommsDoc seed shape is frozen. If comm state cannot be made a per-key map and measured churn is high, revisit D as the primary substrate.

## Consequences

- **RuntimeStateDoc becomes daemon-only and read-only to clients.** The `RuntimeStateWriteScope::Editor` comm-state exception and the `runtime_state_policy_snapshot` before/after carve-out (`crates/runtimed-wasm/src/lib.rs:663-697`) are removed. This is the convergence principle applied to the runtime document.
- **A new frozen CommsDoc genesis seed** is added and registered in `GENESIS_SEEDS_IN_WASM` (`crates/xtask/src/main.rs:1509`), with a shape-asserting `verify-genesis` check, or an old wasm ships the wrong seed and re-triggers the #3086 zeroing footgun. CommsDoc is multi-principal, so it needs its own `is_canonical_*_seed_change` hash-pin mirroring NotebookDoc's seed authorization.
- **A `comms_doc_id` identity pointer** is added, owner-only, alongside `runtime_state_doc_id`. **Make it deterministically derivable** (`comms:{notebook_id}`), mirroring `default_runtime_state_doc_id` (`crates/notebook-doc/src/lib.rs:118-120`); a random pointer whose `put` fails to reach disk gets re-minted divergently on reload, a silent fork.
- **Dependency on ADR 0001.** `comms_doc_id` is a new ROOT scaffolding key on the notebook document. ADR 0001's `is_pristine` predicate keys on a ROOT identity-put allowlist (`notebook_id`, `runtime_state_doc_id`) and explicitly says "if document creation ever writes a new ROOT scaffolding key, add it to the identity allowlist." **`comms_doc_id` must be added to that allowlist**, or a freshly created notebook that stamps `comms_doc_id` reads as non-pristine and never gets its starter cell. This coupling is the reason this ADR cites 0001: the two predicates share the same ROOT-scaffold contract.
- **Migration is stop-writing, not reshape.** RuntimeStateDoc genesis is frozen v2, so the daemon simply stops writing `comms/*/state` there while old peers read an absent map, and the forward path reads state from CommsDoc. Verify no reader of `state.comms` (daemon, output-widget-replay, commit-measure) breaks when state leaves RuntimeStateDoc while topology stays.
- **A fourth frontend sync stream** is added to the bridge (`apps/notebook/src/lib/notebook-sync-store-bridge.ts`, `runtime-state.ts`), with its own bootstrap and reset path. Per-document reset matters here: resetting CommsDoc must not blow away RuntimeStateDoc or CellsDoc projections (a constraint the divergence-recovery ADR builds on).
- **`.ipynb` and save/load** must read topology from RuntimeStateDoc and state from CommsDoc and reassemble one widget-state blob. Confirm the two docs' comm_id sets are read at a consistent snapshot so widgets do not restore with identity-but-no-values or values-but-no-identity.

## Open questions (resolve in the implementation plan)

1. **Comm-state representation (gates the seed shape).** Resolved in Decision: CommsDoc is a CRDT spine, presence is a deferred fast-lane. The remaining sub-question is whether comm state is stored as a native per-key Automerge map or a JSON-blob string. The code is ambiguous (`doc.rs:63` describes a JSON-encoded `Str`; the wasm setter writes per-key). It must be a per-key map before the CommsDoc seed is frozen, or churn bloats history. Confirm and, if needed, migrate the representation.
2. **Closed-comm GC authority.** Daemon CommsDoc write authority versus a topology-absence GC pass: which reclaims orphaned state, and what is the authority on `comm_close`?
3. **Echo-filter homing.** Exactly which document does the kernel write widget echoes into after the split, and does `rt:kernel:` actor-prefix discrimination still hold on that document's receive path?
4. **Consistent save snapshot.** Is there a read path that snapshots RuntimeStateDoc topology and CommsDoc state at mutually consistent heads for export, given they now have independent sync heads and independent GC?
5. **Seed hash-pinning.** Does CommsDoc need a new `is_canonical_comms_seed_change` helper for multi-principal seed convergence, matching `is_canonical_schema_seed_change`? (Almost certainly yes, since anyone may write it.)
