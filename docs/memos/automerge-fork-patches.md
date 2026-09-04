# Automerge Fork Patches

**Status:** Memo / active register, 2026-05-21; dependency and validator status checked 2026-09-04.

## Current dependency baseline (2026-09-04)

Production Rust and `runtimed-wasm` use crates.io Automerge exactly `0.11.0`
(`Cargo.toml:57`, `Cargo.lock:627`), adopted by `ae6aef0f` on 2026-08-26.
The frontend does not depend on the JS `@automerge/automerge` package. There is
no workspace Automerge patch override.

`automerge-store` retains `nteract/automerge` revision
`3fb6af5cc3af23b79f27cebfa339c8c98987e7b7` (Rust `0.10.0`) only as the
`automerge-legacy` dev-dependency (`crates/automerge-store/Cargo.toml:17`).
No branch is selected by that dependency. Its tests cover bidirectional
snapshot loading and encoded sync with representative legacy data
(`crates/automerge-store/tests/version_compat.rs:282–352`), not every deployed
document or every historical patch.

## Historical fork baseline (2026-07-13)

The July record described `nteract/automerge:main` as a tested mirror of
upstream commit `3fb6af5cc3af23b79f27cebfa339c8c98987e7b7`, with the previous
main preserved at `archive/main-pre-upstream-sync-20260713`. These are
historical branch observations, not current remote-ref checks.

The stale-orphan sync correction and its
`queued_orphan_need_does_not_block_unrelated_sync_response` regression are
present in the locally cached crates.io `0.11.0` source (`src/sync.rs:170–182`,
`tests/test.rs:3689`). The July record says the downstream stale-orphan PR was
closed as superseded. This supports no remaining downstream patch for that
behavior; it does not establish that all 21 patches recorded in the earlier
`b3502d42` rebase were merged upstream.

This memo tracks possible Automerge fork patches. It is not an accepted nteract
architecture decision until a patch becomes part of the workspace contract.

## Context

We retain `nteract/automerge` as a compatibility reference and possible home
for narrowly scoped future patches, not as a production requirement.

Actor-label validation is implemented with clone-preview: apply a non-empty
frame to a cloned document and peer state, validate the newly applied changes,
then mutate the real document only after admission succeeds. See
`crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs:58–95` and
`crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs:95`.
The deferred work in the identity-and-trust ADR is
reducing clone and duplicate-apply cost, not introducing validation.

`sync_message_new_changes` remains a proposed API. It is absent from the
checked crates.io `0.11.0` source and is not called by production code. Before
implementing a new patch, recheck upstream APIs and the historical research
below; switching production back to a fork is a separate dependency decision.

## Patches we want

### 1. Public receiver-context parser for sync messages

Why: the room-host's pre-apply validator needs the actor IDs of new changes in an inbound sync message before merging. Today `sync::Message.changes` is `ChunkList(Vec<Vec<u8>>)` of raw chunk bytes, V1 = one `Change` per chunk, V2 = potentially a whole-doc save. The V1/V2 distinction, text encoding, and bookkeeping for filtering already-known hashes are internal.

A `sync::Message` alone is not enough context for the robust API. V2 whole-doc chunks are reconstructed through the receiver's text encoding, and filtering duplicates is cheapest against the receiver's existing change graph. The public method should therefore live on `Automerge` and take the decoded sync message as input.

Proposed API:

```rust
impl Automerge {
    /// Parse the change chunks in `message` without applying them.
    ///
    /// Handles V1 change chunks, bundles, compressed changes, and V2
    /// whole-document chunks using this document's text encoding.
    /// Returns only changes whose hashes are not already present in
    /// this document.
    pub fn sync_message_new_changes(
        &self,
        message: &sync::Message,
    ) -> Result<Vec<Change>, ReadSyncMessageChangesError>;
}
```

Historical implementation sketch; internal signatures have not been reverified
against `0.11.0`:

```rust
impl Automerge {
    pub fn sync_message_new_changes(
        &self,
        message: &sync::Message,
    ) -> Result<Vec<Change>, ReadSyncMessageChangesError> {
        let bytes = message.changes.join();
        let loaded = load::load_changes(
            storage::parse::Input::new(&bytes),
            self.text_encoding(),
            &self.change_graph,
        );
        let changes = match loaded {
            load::LoadedChanges::Complete(changes) => changes,
            load::LoadedChanges::Partial { error, .. } => {
                return Err(ReadSyncMessageChangesError::from(error));
            }
        };
        Ok(changes
            .into_iter()
            .filter(|change| !self.has_change(&change.hash()))
            .collect())
    }
}
```

In this proposal, `ReadSyncMessageChangesError` would be a public error type in `automerge::sync`. It could be constructed from crate-private load errors internally, but must not expose crate-private types in its public variants.

Cost on the hot path: parse twice (once here, once in `receive_sync_message`). The doubled work is bounded by message size and acceptable for our scale. The method must be read-only: it cannot advance sync state, mutate the document, or accept partially parsed data. The room-host validator should fail closed if this parser errors.

Required fork tests:

- Empty `Message.changes` returns an empty vector.
- V1 sync message with new changes returns those `Change`s and exposes their `actor_id()`.
- A message containing changes already present in the receiver returns an empty vector.
- V2 whole-document sync message returns only changes missing from the receiver.
- Malformed or partially loadable change bytes return `ReadSyncMessageChangesError` without returning the successfully parsed prefix.

Upstream story: this is an additive public method with no behavior change to existing callers. Reasonable PR to submit upstream after we've got it working on our fork. If accepted, we drop our patch later.

### 2. (Historical research, tentative) Pull the `filters` branch in

The 2026-05-21 research described upstream `origin/filters` as post-peer-review
but not yet in `main`. Its current status was not reverified in the
2026-09-04 local audit; the options below are historical, not a recommendation
to cherry-pick today. The described API was
`Filter { default, authors, actors }` with rules
`Allow / AllowUpTo { heads } / Deny`. Subduction would retain changes for
storage and sync while hiding them from rendering, a possible primitive for
runtime revocation and post-hoc audit hiding.

Two paths:

- Wait for filters to merge upstream and rebase our fork on it.
- Cherry-pick the filters work onto our fork now.

Cherry-picking buys subduction support sooner, costs us maintenance until upstream merges. The trigger to act is when revocation becomes a near-term need on the hosted product. Until then, watch the upstream PR.

### 3. (Resolved for v1) Path-aware filter hook on `receive_sync_message`

This no longer blocks v1 authorization. The current room-host path enforces
document write authority with clone-preview validation before mutating the real
room document. Editor/owner mutable widget state moved to `CommsDoc`;
`RuntimeStateDoc` remains runtime-owned and is still guarded by the shared
runtime-doc policy.

An upstream path-aware hook could still be useful as a lower-cost optimization or for richer diagnostics, but it is no longer the authorization boundary.

### 4. (Speculative) Hooks for signed-change verification

When keyhive's surface stabilizes, signed changes would let us verify cross-space authorship at publish import (the identity ADR's Decision 6 target is publish-time re-authoring; signed changes would let preserved history carry verified attribution instead). The shape of this depends entirely on what keyhive lands. Tracked as future-compat, not on the current fork roadmap.

## Coordination with upstream

- Submit patch 1 as an upstream PR once we have a working implementation on our fork.
- Track the `filters` branch; comment on the upstream PR if helpful; revisit cherry-picking when revocation becomes a near-term need.
- Submit patches 3 and 4 only if and when they become real.

Maintaining a long-lived fork is a known cost; the patches are deliberately small and additive to keep rebases boring.

## Proposed implementation order

1. Recheck upstream for a suitable parser before creating a new fork patch.
2. If still needed, prototype patch 1 with the tests above and submit it upstream.
3. Decide separately whether a temporary production fork is justified. Any dependency change must retain legacy compatibility checks and verify at least `automerge-store`, `automerge-recovery`, `notebook-doc`, `runtime-doc`, `notebook-sync`, and WASM tests.
4. Replace the implemented clone-preview validator with the parser only after verifying equivalent admission and rejection behavior. This addresses deferred performance work, not a missing v1 authorization boundary.
5. Recheck the historical filters research when revocation work becomes a requirement.

## Out of scope here

- The room-host crate extraction itself (separate ADR).
- An exhaustive disposition of historical fork patches. The current production pin is upstream; this memo does not establish that every earlier patch was merged.
- Whether we should switch to `automerge-repo` for any part of the sync transport (separate question, separate ADR if it ever becomes one).

## Acceptance Criteria

Draft. Becomes accepted when patch 1 lands on the fork.
