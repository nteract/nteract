# Automerge Fork Patches

**Status:** Draft, 2026-05-21.

## Context

We already maintain a fork of Automerge at `nteract/automerge`, pinned in this workspace's `Cargo.toml`. The identity-and-trust ADR (`docs/architecture/identity-and-trust.md`) defers per-frame actor-label validation because doing it cleanly requires either an upstream Automerge contribution, a fork patch, or a throwaway-peer hack per frame. The first two are real options; the third is not. This ADR proposes the patches we want on our fork and how they relate to upstream.

Sister concern: before adding new patches we want to pull the latest upstream into our fork. Rebasing on current upstream is its own little exercise (the `filters` branch and other in-flight work shift the surface around), but it's cheap and one-time. Tracked as a sibling task, not a patch.

## Patches we want

### 1. Public change-chunk parser on `sync::Message`

Why: the room-host's pre-apply validator needs the actor IDs of new changes in an inbound sync message before merging. Today `sync::Message.changes` is `ChunkList(Vec<Vec<u8>>)` of raw chunk bytes, V1 = one `Change` per chunk, V2 = potentially a whole-doc save. The V1/V2 distinction and the bookkeeping for filtering already-known hashes are internal.

Proposed API:

```rust
impl sync::Message {
    /// Parse change chunks in this message into Change objects without
    /// applying them to a document. Handles V1 and V2 chunk shapes.
    /// Returns only changes whose hash is not already in `have_hashes`,
    /// so the caller sees just the new ones.
    pub fn parse_new_changes(
        &self,
        have_hashes: &HashSet<ChangeHash>,
    ) -> Result<Vec<Change>, ReadChangeError>;
}
```

Cost on the hot path: parse twice (once here, once in `receive_sync_message`). The doubled work is bounded by message size and acceptable for our scale.

Upstream story: this is an additive public method with no behavior change to existing callers. Reasonable PR to submit upstream after we've got it working on our fork. If accepted, we drop our patch later.

### 2. (Tentative) Pull the `filters` branch in

Upstream `origin/filters` is post-peer-review but not yet in `main`. It introduces `Filter { default, authors, actors }` with rules `Allow / AllowUpTo { heads } / Deny`. Subduction semantics: rejected changes still ingest and sync, just stop rendering. That's the right primitive for runtime revocation and post-hoc audit hiding (see the identity ADR's revocation follow-up).

Two paths:

- Wait for filters to merge upstream and rebase our fork on it.
- Cherry-pick the filters work onto our fork now.

Cherry-picking buys subduction support sooner, costs us maintenance until upstream merges. The trigger to act is when revocation becomes a near-term need on the hosted product. Until then, watch the upstream PR.

### 3. (Tentative) Path-aware filter hook on `receive_sync_message`

For server-side enforcement of the `doc.comms/*/state/*` subtree as the only `RuntimeStateDoc` region the editor scope may write. Today this is enforced client-side via the approved comm writer. Server-side enforcement requires inspecting change ops to see what paths they touch. The shape of this is fuzzier than patch 1; we may decide it's not worth the complexity and stay with client-side discipline.

Decision deferred until we benchmark v1 in production. No code yet.

### 4. (Speculative) Hooks for signed-change verification

When keyhive's surface stabilizes, signed changes would let us verify cross-space authorship at publish import (lifting the "publish is a fresh document" restriction in the identity ADR). The shape of this depends entirely on what keyhive lands. Tracked as future-compat, not on the current fork roadmap.

## Coordination with upstream

- Submit patch 1 as an upstream PR once we have a working implementation on our fork.
- Track the `filters` branch; comment on the upstream PR if helpful; revisit cherry-picking when revocation becomes a near-term need.
- Submit patches 3 and 4 only if and when they become real.

Maintaining a long-lived fork is a known cost; the patches are deliberately small and additive to keep rebases boring.

## Implementation order

1. Pull latest upstream into our fork. Update `Cargo.toml` pin. Verify the workspace still builds and tests pass.
2. Implement patch 1 on the fork. Land it behind the room-host crate extraction PR (the natural calling site).
3. Wire the validator in `nteract-room-host` against the new helper. Identity ADR's deferred limitation closes.
4. Watch the upstream filters PR. Revisit cherry-picking when revocation work begins.

## Out of scope here

- The room-host crate extraction itself (separate ADR).
- Pre-existing fork patches (whatever's on `nteract/automerge` today vs upstream `main`). The history is in the fork; this ADR is about what we want to add.
- Whether we should switch to `automerge-repo` for any part of the sync transport (separate question, separate ADR if it ever becomes one).

## Status

Draft. Becomes accepted when patch 1 lands on the fork.
