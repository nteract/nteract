# Deep Dive: Notebook Host Convergence (five-document split + divergence recovery)

**Date:** 2026-06-01
**Inputs:** `docs/handoffs/2026-06-01-notebook-host-convergence.md` (the two design threads), the merged work in #3316/#3317, and a 50-agent investigation + premortem (raw result archived at the task output for run `wf_6ab5a807-669`).
**Status:** design-first. Nothing here has touched code. This supersedes the "brainstorm thread 1, then thread 2" framing of the handoff with a single coupled analysis and a sequenced recommendation.

## TL;DR

The forced derivation is **confirmed**: to make every CRDT document all-or-nothing per principal, `NotebookDoc` must split into an owner-only `MetadataDoc` and an editor+owner `CellsDoc`, and `RuntimeStateDoc`'s editor comm-state carve-out forces a `CommsDoc`. That is five documents. The logic holds.

But "confirmed as the logical endpoint" is not "ship it as one program." The recommendation is a **modified, decoupled split**: take the two independently-justified low-risk wins now (CommsDoc, and additive owner-only identity pointers), close the recovery loop using a frame that **already exists on the wire**, and treat the irreversible cells/metadata data-move as a separate, telemetry-gated, reversible-until-proven decision that does not begin until recovery and the export/identity/fleet-floor guards are live.

The single highest-leverage finding: **the recovery wire is half-built and inert.** The cloud room already emits `cloud_frame_rejected` (`apps/notebook-cloud/.../notebook-room.ts:553`), the client already receives it (`live-sync.ts:311`), and `presence.ts:48` silently drops it because it only handles `cloud_room_ready`. The re-offer-forever stall that Thread 2 exists to solve is, today, one missing frame handler.

## Ground-truth corrections to the handoff

The investigation read the actual code and corrected two premises the handoff (and I) carried in:

1. **Outputs do not live in NotebookDoc.** They moved to `RuntimeStateDoc` at `executions/{execution_id}/outputs/{output_id}` in schema v3 and became addressable in v4 (`crates/runtime-doc/src/doc.rs:21-29`, history at `crates/notebook-doc/src/lib.rs:65-67`). `CellSnapshot` has no `outputs` field. `clear_outputs` only nulls `execution_id`/`execution_count` (`lib.rs:1921-1935`); `set_cell_outputs_hidden` only writes a metadata flag (`lib.rs:2099-2109`). The CLAUDE.md invariant "RuntimeStateDoc is the durable output record" already holds at the doc-model layer. **There is no outputs-in-NotebookDoc collision to design around.**

2. **The real editor-writable wart under `cells` is a pointer, not output bytes.** Editors can write `execution_id`/`execution_count` under `cells`. They cannot mint output bytes (zero RuntimeStateDoc write access), but they *can* repoint a cell's `execution_id`. That is a read-authority question (see failure mode "execution_id repointing"), not a forgery question.

3. **The forced derivation is real.** Metadata is owner-mutable post-genesis (`set_metadata_value` `lib.rs:571`, `set_metadata_snapshot` `lib.rs:655`, `set_metadata` `lib.rs:2269`), and the frozen seed only creates empty `cells`+`metadata` maps (`lib.rs:1030-1032`). So you cannot freeze identity at genesis to reach all-or-nothing. The root must split.

## The five-document model (confirmed forced)

| Doc | Writers | Contents | All-or-nothing |
|---|---|---|---|
| **MetadataDoc** (new, from NotebookDoc root) | owner only | `notebook_id`, `schema_version`, the doc-id pointers, full `metadata` map (kernelspec, trust, deps, path) | yes |
| **CellsDoc** (new, from NotebookDoc cells) | editors + owners | cells map, source, `execution_count`, cell metadata, `resolved_assets`, attachments, `execution_id` pointer (no outputs) | yes |
| **RuntimeStateDoc** | daemon only | executions, outputs, env, trust, display index, comm **topology** | yes (once comm-state leaves) |
| **CommsDoc** (new, from RuntimeStateDoc carve-out) | anyone + runtime | comm **state** (trait values only), keyed by comm_id | yes |
| **PoolDoc** | daemon only | pool state | unchanged |

**The topology/state boundary that keeps CommsDoc safe.** Comm *topology* (which comms exist, target, model module/name, owning cell) stays runtime-owned in RuntimeStateDoc. Comm *state* (mutable trait values) moves to CommsDoc. The field split already exists and is enforced by `validate_comm_metadata_unchanged` (`policy.rs:497-502`). The load-bearing subtlety: today orphan-comm state writes silently no-op because `set_comm_state_property` bails `Ok` when the comm entry is absent (`doc.rs:2502-2512`) - call it **Guard A**. Guard A only works because topology and state are co-located. A flat anyone-writes CommsDoc destroys Guard A, so safety rests entirely on the runtime before-snapshot membership gate `diff_comm_state` (`runtime_agent.rs:1500-1521`), which CommsDoc **must** preserve, plus an explicit runtime-side drop of orphan state.

**Identity pointers** (all owner-only, in MetadataDoc): `cells_doc_id` (new), `comms_doc_id` (new), `runtime_state_doc_id` (moves from NotebookDoc root, already `ensure_`-based at `room.rs:835/960`), plus `notebook_id`/`schema_version`. **Make every new pointer deterministically derivable** (`cells:{notebook_id}`, `comms:{notebook_id}`), mirroring `default_runtime_state_doc_id` (`lib.rs:118-120`). A random, non-derivable id whose `put` fails to reach disk gets re-minted divergently on next load - a silent fork (see failure mode). Each multi-principal doc (CellsDoc, CommsDoc) needs its own `is_canonical_*_seed_change` hash-pin mirroring NotebookDoc (`lib.rs:2400-2429`); daemon-only docs need none.

## Recovery: the residual after all-or-nothing

The north star delivers exactly what was claimed: once no document is partially owned, **authorization-field rejection disappears entirely.** A single sync message can no longer mix an editor cell-edit with an owner root-edit, because each message targets exactly one doc with exactly one required scope. `validate_editor_notebook_changes` (the only diff-based per-path validator) is **deleted**. The per-change-vs-per-message question is mooted: stay per-message (the recovery-primitives ground truth confirms no selective-apply primitive exists in this Automerge stack, `automerge-recovery/src/lib.rs:159-161`; the planned `sync_message_new_changes` is read-only).

What remains are the problems that were never about *who-owns-which-field*. They are about **version** and **time**:

1. **Schema/version divergence.** A mixed-version peer writing the legacy NotebookDoc root during migration is rejected by the new policy, but both peers believe they own the doc. The all-or-nothing argument does not apply. A true-old client that blunt-resets here resets into **silent data invisibility** (empty notebook), not a crash. This rejection class must be gated behind Phase-0 forward-tolerant-reader propagation; until then the daemon must *translate* old-root writes into CellsDoc, not reject them.
2. **Divergent-genesis (#3086).** Build-coupled, not state-coupled. Reset re-bootstraps from the snapshot, but if the client *build* embeds the wrong seed, the next write re-diverges. Reset cannot fix a bad build; only a reload can. The seed-hash mismatch is available at the rejection site (`lib.rs:879`) but never read into the recovery decision.
3. **Scope revocation mid-session.** Scope is frozen at connect (`notebook-room.ts:85,199`, survives hibernation), the ACL is read once at connect, and there is no eviction path. A downgraded editor keeps writing legally until it chooses to disconnect. A doc boundary cannot police this; it needs a server-pushed terminal sever.

**The recovery frame.** Carry it on the existing `SESSION_CONTROL` frame type (`notebook-wire/src/lib.rs` byte 0x07), already daemon-outbound-only and already reserved by the ADRs for server-pushed signals. Add two variants to `SessionControlMessage`:
- `ResyncRequired { doc_id, authoritative_heads, rejected_reason }` - **non-terminal**. "Your last write to this doc was rejected; discard your local replica of `doc_id` and re-bootstrap to these heads." This is the missing corrective signal that closes the re-offer-forever stall.
- `Sever { reason, retryable }` - **terminal**. Revocation, eviction, or repeated non-convergence.

Both are additive under `#[serde(tag="type")]`; old clients ignore unknown variants by the same mechanism that lets `SyncStatus` reach v3 clients.

**Sever vs help: you cannot tell them apart from the bytes.** A viewer writing CellsDoc, an old client writing a legacy root key, and an attacker probing owner-only fields all surface identically. So the policy is behavioral, not intent-detecting: **treat every rejection as recoverable-first** (send `ResyncRequired`), and **escalate to `Sever` only on repetition past a small threshold** - the signature of malice (or a bad build) is non-convergence after a clean snapshot, not the content of any single frame. Bias toward help: a false sever disconnects an honest stale client (recoverable by reconnect); a false help re-syncs an attacker who just gets rejected again, costing only bandwidth.

## Why not one program: the hidden assumption

Every dangerous failure shares one assumption: that a property proven at the **document layer** (authorization is all-or-nothing; a rejected write means no good edits to preserve; topology and state can live in separate docs) holds at the **layers that touch the document** - sync, persistence, lifecycle, recovery, runtime echo-suppression, identity-pointer durability, and scope-currency.

It does not. Co-location in one document was silently providing invariants the split removes:
- the comm orphan-state Guard A (`doc.rs:2502-2515`),
- the kernel-echo authorship filter's substrate (one doc, distinguishable actor prefixes, `runtime_agent.rs:351`),
- closed-comm GC authority (`remove_comm` deletes topology+state in one op),
- atomic `cells`+`metadata` reads for `.ipynb` export (`persist.rs:91-102`),
- identity-pointer durability via deterministic re-derivation.

And the scope governing each new boundary is itself a connect-time-frozen snapshot, not a live fact. "Rejected == no good edits" is true only *after* data lives in the right per-principal doc *and* the writing principal's authority is still current.

### Premortem headlines

- **Most likely failure:** the recovery loop never gets closed because "blunt reset already exists" was conflated with "recovery is solved." The reset *action* exists; the reset *trigger* does not. The split relocates and multiplies the rejection surface while leaving the stall untouched, and daemon-local per-field actor filtering (`runtime_agent.rs:348-352`) means single-user and desktop testing never reproduce it.
- **Most dangerous failure:** silent half-notebook / data invisibility from the cells/metadata move, in three converging forms that all fail without a crash, an above-info log, or a `.corrupt` rename: in-place reshape LWW-merging the frozen root into garbage; a v5 client rendering an empty notebook over real CellsDoc content (the #3086 autosave-zeroing class); and the `.ipynb` emitter reading two subtrees off one handle and writing a half-notebook to disk *and* the publish artifact. The most-dangerous failure costs users their work, irreversibly, on the population least likely to file a precise bug.

19 of 20 generated failure modes survived adversarial verification against the real code. The full set is in the premortem report (`docs/handoffs/2026-06-01-host-convergence-premortem.html`).

## Revised plan

Each item maps to a specific surfaced failure.

1. **Ship CommsDoc decoupled** from the NotebookDoc owner/cells split, as its own decision. It collapses the RuntimeStateDoc carve-out on its own merits and is the cheap additive new-doc playbook. Do not hold the cheap win hostage to the expensive structural copy.
2. **Land the recovery wire FIRST**, before any post-split rejection class can fire, using the frame that already exists. Add a `presence.ts`/`live-sync.ts` handler for `cloud_frame_rejected` (today dropped at `presence.ts:48`) that triggers `reset_sync_state` + re-bootstrap; carry authoritative heads + doc_id; add a per-peer consecutive-rejection counter on the room host.
3. **Classify rejections by KIND at the rejection site** and branch recovery on it. Propagate a typed reason (can_write gate vs principal-forgery at `lib.rs:864` vs version-skew vs editor-path) instead of generic `Err(JsError)`. Version-skew MUST NOT blunt-reset or increment the sever counter; principal-forgery escalates on a far shorter counter.
4. **Make rejection cheap before making it punitive.** Add an O(1) pre-check (can_write scalar + raw-actor-label principal binding) that short-circuits before the full doc+peer-state clone at `lib.rs:605-606`; land the `sync_message_new_changes` parser as a launch blocker for CommsDoc specifically (its write frequency is per-widget-tick).
5. **Make all new doc-id pointers derivable, never random** (`cells:{notebook_id}`, `comms:{notebook_id}`). If a random id is ever required it must be minted into the frozen genesis seed and `ensure_` must fail-closed on absent-for-existing, never mint a second.
6. **Anchor the kernel-forward membership gate to RuntimeStateDoc topology, never to CommsDoc keys.** Forward state only for comm_ids present in *both* docs; re-create Guard A as an explicit runtime-side drop of orphan CommsDoc state; give the daemon CommsDoc write authority so `remove_comm`/`clear_comms` wipe both docs atomically.
7. **Make the kernel-echo filter a structural property of the CommsDoc receive path**, not a re-homed closure. Decide and document where the kernel writes echoes after the split; ensure the `rt:kernel:` actor-prefix discrimination lives on that doc's receive path; add a CI guard asserting a kernel-authored CommsDoc change is NOT forwarded to the kernel.
8. **Type-split the export signature so it cannot compile against one doc.** `build_v4_notebook`/`save_notebook_to_disk` take cells from a CellsDoc handle and metadata from a MetadataDoc handle as distinct typed params; harden the zeroing guard (`persist.rs:304`) to treat "one subtree empty while the other is populated" as data-loss; gate `runt-publish` on assembling from both snapshots.
9. **Forbid in-place reshape mechanically.** The data-move copies read-only from the legacy root into new sidecar docs; the migration holds no write handle to legacy cells/metadata. Add a CI lint (tokio_mutex_lint pattern) that fails on `put_object`/`delete` against ROOT cells|metadata in the load/migration path, plus a shape-asserting `verify-genesis` sibling.
10. **Gate the irreversible data-move on a MEASURED per-room fleet floor**, not a calendar soak. The room host sees each peer's `schema_version` per connection - refuse the move into any room that has seen a sub-v6 connection within the snapshot-retention window. Ship a v5.x point build whose tolerate branch **refuses to render** (hard "please update") when a `cells_doc_id`/`comms_doc_id` pointer is present, rather than rendering empty. Dual-write the legacy root through a deprecation window; promote the forward-tolerant-load info log (`lib.rs:1227`) to a monitored per-topology metric.
11. **Build the ACL-revocation eviction path as a HARD dependency** of deleting `validate_editor_notebook_changes`, not future work. On ACL revoke (`index.ts:967`) call a new room DO `notifyAclChanged(principal)` that re-derives scope and pushes a terminal `SESSION_CONTROL` Sever; re-validate every peer's scope against the ACL on hibernation-restore (`notebook-room.ts:173`).
12. **Enforce the execution_id cell-binding.** Drop outputs at resolution when `execution.cell_id != cell_id` (the field exists at `doc.rs:201` but is unread at `notebook-outputs.ts:288` and `materialize-cells.ts:28`; first plumb `cell_id` into the frontend `ExecutionSnapshot`); tighten the cells allowlist so editors may only NULL `execution_id`; add the repoint-foreign-execution regression test.
13. **Unify the daemon (`identity.rs:83`) and WASM (`lib.rs:917`) validators into one shared crate before the split.** If that consolidation is too costly, treat it as direct evidence the five-doc parity burden is worse and revisit go/no-go. Add a cross-environment conformance test: identical forbidden write through cloud host AND local daemon must reach the same terminal state.
14. **Make per-document reset primitives a prerequisite for arming any recovery frame.** Split `reset_sync_state` (`lib.rs:2447`) into per-doc methods; dispatch `ResyncRequired`/`cloud_frame_rejected` on `doc_id` with no whole-notebook fallback; decouple reset from the shared 20ms flush (`sync-engine.ts:786`) or flush per-doc; route post-bootstrap materialization through `replaceNotebookCells` diffing (`notebook-cells.ts:253`), never `resetNotebookCells` empty-then-refill (it defeats the stable-DOM-order iframe protection - white-flashes every cell).

## Sequencing

**Phase A (ships first, no data move, each independently valuable):**
1. CommsDoc with its three load-bearing invariants built IN, not after - topology-anchored membership gate, explicit Guard-A orphan drop, daemon CommsDoc write authority for atomic remove/clear, kernel-echo filter wired structurally onto CommsDoc's receive path with a CI guard.
2. Close the recovery loop using the existing `cloud_frame_rejected` frame: client handler, heads+doc_id+typed reason, per-peer rejection counter.
3. O(1) pre-check + `sync_message_new_changes` parser so clone-before-validate cannot OOM the single-threaded DO.
4. ACL-revocation eviction/Sever path.
5. execution_id cell-binding guard.
6. Unify the dual validators into one shared crate + cross-environment conformance test.

None of A touches the frozen NotebookDoc root or moves populated data. A is low-risk and reversible.

**GATE 1 (all green before any NotebookDoc structural work):** export round-trips new pointers and assembles a valid `.ipynb` from split docs; new doc-id pointers are deterministic; the v5.x tolerate branch refuses-to-render (not empty) on a present structural-move pointer and has propagated; recovery classifies version-skew distinctly and does NOT reset/sever it; per-document reset primitives exist.

**Phase B (only after Gate 1):** additive owner-only pointers (`cells_doc_id` deterministic), forward-tolerant v6 reader, register seeds in `GENESIS_SEEDS_IN_WASM` + shape-asserting verify-genesis sibling + migration-path reshape lint. Pointer-first, no data move.

**GATE 2 (green before the irreversible data-move):** measured per-room fleet floor refusing the move into any room that saw a sub-v6 connection in the retention window; dual-write the legacy root; forward-tolerant-load metric reading near-zero on cloud; daemon translates legacy-root writes into CellsDoc rather than rejecting them during the window.

**Phase C (last, reversible-until-proven):** the cells/metadata copy into sidecar docs, copy-only/read-only on the legacy root, dual-read in export and resolution, legacy root cleared ONLY after fleet-floor telemetry confirms zero sub-v6 writers. The data-move gates the deletion of `validate_editor_notebook_changes`; that deletion does not land until Phase C completes and the eviction path from A.4 is live.

## Open questions to resolve before implementation

- **Pointer authority:** can a malicious editor repoint a cell `execution_id` at another principal's execution to surface foreign outputs? (Validate against a daemon-bound execution; do not move the pointer to RuntimeStateDoc since editors must also clear it.)
- **`.ipynb` round-trip:** can the v5/v6 reader assemble a valid `.ipynb` from split docs? Gates Phase C.
- **Seed hash-pinning:** is the runtime-state genesis seed hash-pinned for cross-peer auth, or does it rely on scope gating? Determines whether multi-principal CommsDoc/CellsDoc each need a new `is_canonical_*_seed_change` helper.
- **Counter keying:** can one principal hold multiple concurrent connections with different scopes (editor + runtime_peer)? Determines whether the rejection/sever counter keys on connection or principal. Gates arming sever.
- **CommsDoc substrate:** `doc.rs:68` records state as JSON-encoded `Str` vs a native per-trait map. Confirm CommsDoc preserves per-key merge, and whether Automerge beats a presence-style ephemeral channel for live comm state.
- **Reader fan-out:** verify no reader of `state.comms` (daemon.rs, output_widget_replay/commit_measure) breaks if state moves out of RuntimeStateDoc while topology stays.

## Next step

Decouple this into tracked work along Phase A / Gate 1 / Phase B / Gate 2 / Phase C, then turn each phase into its own ADR + plan. Candidate ADRs: `four-document-split` (CommsDoc, superseding `three-document-split.md` partially), `notebook-doc-structural-split` (MetadataDoc/CellsDoc, the gated data-move), and `sync-divergence-recovery` (the ResyncRequired/Sever frame). Phase A's recovery-wire fix and CommsDoc are the two things worth starting on.
