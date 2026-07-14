# Automerge Fork Patches

**Status:** Memo / active register, 2026-05-21; fork baseline updated 2026-07-13.

## Fork baseline update (2026-07-13)

`nteract/automerge:main` is a tested mirror of upstream Automerge commit
`3fb6af5cc3af23b79f27cebfa339c8c98987e7b7`. The previous fork main is
preserved at `archive/main-pre-upstream-sync-20260713`.

Upstream already includes the stale-orphan sync correction and its
`queued_orphan_need_does_not_block_unrelated_sync_response` regression test.
The downstream stale-orphan PR was therefore closed as superseded rather than
rebased: the minimal nteract-only patch set for that behavior is empty. The
nteract workspace pins the tested mirror commit exactly and can drop the fork
URL once the corresponding upstream release is available.

This memo tracks possible Automerge fork patches. It is not an accepted nteract
architecture decision until a patch becomes part of the workspace contract.

## Context

We already maintain a fork of Automerge at `nteract/automerge`, pinned in this workspace's `Cargo.toml`. The identity-and-trust ADR (`docs/adr/identity-and-trust.md`) defers per-frame actor-label validation because doing it cleanly requires either an upstream Automerge contribution, a fork patch, or a throwaway-peer hack per frame. The first two are real options; the third is not. This ADR proposes the patches we want on our fork and how they relate to upstream.

Sister concern: before adding new patches we want to pull the latest upstream into our fork. Rebasing on current upstream is its own little exercise (the `filters` branch and other in-flight work shift the surface around), but it's cheap and one-time. Tracked as a sibling task, not a patch.

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

Internal implementation shape:

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

`ReadSyncMessageChangesError` is a public error type in `automerge::sync`. It can be constructed from the crate-private load errors internally, but it must not expose crate-private types in its public variants.

Cost on the hot path: parse twice (once here, once in `receive_sync_message`). The doubled work is bounded by message size and acceptable for our scale. The method must be read-only: it cannot advance sync state, mutate the document, or accept partially parsed data. The room-host validator should fail closed if this parser errors.

Required fork tests:

- Empty `Message.changes` returns an empty vector.
- V1 sync message with new changes returns those `Change`s and exposes their `actor_id()`.
- A message containing changes already present in the receiver returns an empty vector.
- V2 whole-document sync message returns only changes missing from the receiver.
- Malformed or partially loadable change bytes return `ReadSyncMessageChangesError` without returning the successfully parsed prefix.

Upstream story: this is an additive public method with no behavior change to existing callers. Reasonable PR to submit upstream after we've got it working on our fork. If accepted, we drop our patch later.

### 2. (Tentative) Pull the `filters` branch in

Upstream `origin/filters` is post-peer-review but not yet in `main`. It introduces `Filter { default, authors, actors }` with rules `Allow / AllowUpTo { heads } / Deny`. Subduction semantics: rejected changes still ingest and sync, just stop rendering. That's the right primitive for runtime revocation and post-hoc audit hiding (see the identity ADR's revocation follow-up).

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

## Implementation order

1. Pull latest upstream into our fork. Keep that as a fork-only maintenance PR unless the workspace pin changes.
2. Implement patch 1 on a `nteract/automerge` branch with the tests above. Submit it upstream once the fork patch passes locally.
3. Update this workspace's `Cargo.toml` and `Cargo.lock` to the fork commit. Verify at least `cargo test -p automerge-recovery`, `cargo test -p notebook-doc`, `cargo test -p runtime-doc`, and `cargo test -p notebook-sync`.
4. Wire the pre-apply actor-label validator in the room-host extraction using `Automerge::sync_message_new_changes(&message)` before `receive_sync_message_recovering`. Identity ADR's deferred limitation closes only after this step lands.
5. Watch the upstream filters PR. Revisit cherry-picking when revocation work begins.

## Out of scope here

- The room-host crate extraction itself (separate ADR).
- Pre-existing fork patches (whatever's on `nteract/automerge` today vs upstream `main`). The history is in the fork; this ADR is about what we want to add.
- Whether we should switch to `automerge-repo` for any part of the sync transport (separate question, separate ADR if it ever becomes one).

## Acceptance Criteria

Draft. Becomes accepted when patch 1 lands on the fork.
