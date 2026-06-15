# Handoff: Notebook Host Convergence + Document-Model Hardening

**Date:** 2026-06-01
**Why this exists:** the work was done in a Codex worktree (`~/.codex/worktrees/a2f3/desktop`). Resume here on `~/projects/nteract` (`main`), which already has the merged code below. Pick up the two design threads in the second half of this doc - they are not yet started.
**Current status, 2026-06-15:** this handoff is historical. CommsDoc and the
regular-client-read-only RuntimeStateDoc boundary have since shipped; use
`docs/adr/0002-comms-document-split.md`, `docs/adr/document-split.md`, and
source policy checks for current writer authority. The old shorthand below
should not be read as live authorization guidance.

## Where we landed (shipped, in `main`)

Two stacked PRs, both merged:

- **#3316** `feat(notebook-cloud): grant editors full cell editing in hosted rooms` - hosted-room editors can now add/delete/reorder/edit cells of any type. Server-enforced.
- **#3317** `feat(notebook): gate run controls on a host-neutral runtime-availability capability` - `executionAvailable` capability; `canExecute = executionAvailable && writeAuthority`.

Don't re-derive these - read the PR bodies and the diffs. Key entry points if you need them:

- `crates/runtimed-wasm/src/lib.rs` → `validate_editor_notebook_changes` (the editor write gate) and `receive_notebook_sync` (preview → validate → accept/reject).
- `apps/notebook-cloud/src/room-materializer.ts` → `canWriteAllNotebookChanges` (owner-only flag that selects the validator).
- `apps/notebook-cloud/viewer/shell-capabilities.ts` and `apps/notebook/src/lib/desktop-shell-capabilities.ts` → the two host capability factories.
- `src/components/notebook/capabilities.ts` → `NotebookShellRuntimeCapabilities.executionAvailable`.

### The principle that emerged (this is the thesis for what's next)

Authorization boundaries should line up with **document boundaries**, not field subtrees. Field-level carve-outs are where the bugs hide: the #3316 review caught a real P1 where the editor gate checked only the `metadata` flag and left root scalars (`schema_version`, `notebook_id`, `runtime_state_doc_id`) writable. The fix replaced a metadata-denylist with a `cells`-subtree allowlist. That worked, but it's still a subtree gate inside one document. The next two threads generalize the lesson.

## Background ADRs (read before designing - do not duplicate them)

- `docs/adr/notebook-host-shell-convergence.md` - shared shell + capability vocabulary across desktop/cloud/elements.
- `docs/adr/hosted-room-authorization.md` - ACL model, scopes, **Decision 7** (editor write surface; the part this work most directly touches).
- `docs/adr/document-split.md` - NotebookDoc / RuntimeStateDoc / PoolDoc boundaries. **Thread 1 proposes superseding this.**
- `docs/adr/frontend-sync-bridge.md` - per-document RxJS streams, stable DOM order, local-first writes.
- `docs/adr/schema-evolution-and-genesis.md` - frozen genesis, cross-version sync hazards (relevant to both threads' migration story).
- `docs/adr/runtime-state-document-identity.md` - the `runtime_state_doc_id` pointer model (the thing #3316 hardened).

## Active design thread 1: four-document split (CommsDoc)

Proposed by the user as the document-level generalization of the #3316 lesson. Today RuntimeStateDoc is not cleanly read-only to clients only because **widget comm state is bidirectional** - editors must write `comms/*/state/*` (the one carve-out in Decision 7). Pull that into its own document and the boundaries get coarse and auditable:

| Doc | Writers | Rule |
|---|---|---|
| NotebookDoc | editors+owners (cells), owner (identity/metadata) | structural authoring |
| **CommsDoc (new)** | editor/owner/runtime peer | mutable widget state, topology-gated |
| RuntimeStateDoc | local daemon / room host / runtime peer, policy-scoped | read-only to regular clients |
| PoolDoc | daemon only | unchanged |

The subtlety that keeps it clean: split comm **topology** (which comms exist,
target, owning cell - stays runtime-owned in RuntimeStateDoc) from comm
**state** (the mutable model values - CommsDoc, keyed by comm_id). Then
multi-principal CommsDoc writes are safe at the kernel-forward boundary: editor
or owner state written for a comm_id with no topology is orphaned and ignored by
the runtime. The daemon and room host both drop the `comms/*/state/*` exception,
and Decision 7's "editor RuntimeStateDoc enforcement" collapses to "editors
can't write that doc, period."

**Honest cost** (name it before committing): a fourth CRDT doc threads through a frozen genesis seed, a new transport frame type, daemon+wasm writer paths, the room host's snapshot logic (NotebookDoc+RuntimeStateDoc *pair* becomes a triple), a `comms_doc_id` identity pointer (NotebookDoc-owned, same shape as `runtime_state_doc_id`), and a new sync-bridge stream. Easier at the authorization layer, more plumbing at the document-management layer. Plus a migration story (RuntimeStateDoc genesis is frozen).

**Open questions to resolve in the brainstorm:** topology/state boundary exactly; is Automerge even the right substrate for live comm state vs a presence-style ephemeral-but-persisted channel; closed-comm GC authority; cross-version sync during migration.

Status: **superseded.** The CommsDoc split is now covered by
`docs/adr/0002-comms-document-split.md`; do not treat this section as open
backlog without checking that ADR and source first.

## Active design thread 2: sync-divergence recovery (user's priority)

The concern the user most wants designed. When a peer makes a write the room **rejects** (the validator returns `Err`, room never applies it), the peer has **already applied it locally** (local-first). The peer's heads now diverge from the room's. The change lives in the peer's Automerge history; the room won't accept it; the peer keeps re-offering it. Convergence can stall. We need a designed path, not just "rejected."

The fork the user named:
- **Malicious** - deliberate forbidden writes → sever the connection (there is a `SESSION_CONTROL` close frame, referenced in `hosted-room-authorization.md` for ACL revocation/eviction).
- **Accidental / behind / buggy** - a stale peer rejoins, an old client version writes a key it shouldn't, or histories diverged. These peers are not hostile; they need to be **helped back up to speed**, not severed.

The hard part: **you usually can't tell which from the frame bytes alone** - the same rejected change could be malice or a stale client. So the design probably can't be "detect intent"; it's more likely "treat every rejection as recoverable first, escalate to sever on repetition/abuse."

Genuinely hard sub-problems to work through:
1. **Per-message vs per-change validation.** Today a sync message bundling many changes is rejected wholesale if *any* change is invalid - so one bad change blocks a batch of otherwise-valid edits. Should validation become per-change (accept the valid, reject the invalid)? That's a meaningful model change.
2. **Preserving legitimate concurrent edits.** Automerge can't surgically remove one change from a peer's history. The blunt recovery (peer discards local doc, re-bootstraps from the room snapshot) loses any *good* unsynced local edits. Is there a rebase-the-good-drop-the-bad path, or do we accept the blunt reset and design the UX around it?
3. **The "wiped out a key they shouldn't have" / stale-peer case.** CRDT merge causality: a delete/overwrite from a stale peer can win or lose depending on history. Tie into `schema-evolution-and-genesis.md` cross-version hazards.
4. **Recovery protocol.** Likely a control frame that tells the peer "your last change was rejected; here are the authoritative heads; reset/re-sync to them" - distinct from the terminal sever frame.

Existing surfaces to build on (don't start from scratch):
- `receive_sync_message_recovering` in `crates/runtimed-wasm/src/lib.rs` (already used by `receive_notebook_sync` with the `"cloud-room-doc-receive-sync"` tag) and the `crates/automerge-recovery` crate - the recovery machinery for malformed/divergent sync may already give you primitives.
- The preview-then-validate-then-reject structure in `receive_notebook_sync` - the rejection point is where the recovery decision would hook in.
- `SESSION_CONTROL` framing for the sever path.

Status: **not started, design-first.** This is squarely an automerge-sync convergence/reconnection problem.

## Relevant subsystem skills (invoke as relevant)

- `automerge-sync` - thread 2 (divergence/recovery, reconnection, peer state) is exactly this skill's domain; also relevant to thread 1's new sync stream.
- `mcp-session-lifecycle` - rejoin/reconnect/eviction races; the "stale peer rejoined" scenario.
- `daemon-dev` and `frontend-dev` - implementation across the daemon, wasm bindings, and the React sync bridge.
- `testing` - both threads need room-host/sync test coverage (see `apps/notebook-cloud/test/room-materializer.test.ts` and `crates/runtimed-wasm` unit tests for the existing patterns).
- Both threads are design-first: settle the decision in a `docs/adr/` entry, then write an implementation plan alongside it before cutting code.

## Notes

- Both threads are design-first. Do **not** start cutting code on a four-document refactor or a recovery protocol off this doc - brainstorm and write the ADR first.
- Verification patterns used in the shipped work: `cargo test -p runtimed-wasm`, `pnpm -C apps/notebook-cloud test` (rebuilds wasm via `cargo xtask wasm runtimed`), `cargo xtask lint --fix` before commit. Repo squash-merges; commit/PR titles are Conventional Commits.
</content>
