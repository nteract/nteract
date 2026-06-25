# Notebook Identity and Path Binding

**Status:** Proposed, 2026-06-24.

**Neighbors:**
- `docs/adr/mcp-session-lifecycle.md` - Decision 8 keys file-backed rejoin on the path; this ADR is the why behind that key and where it must come from.
- `docs/adr/local-first-notebook-state.md` - persistence and reconnect direction for local handles; the registry proposed here is the durable side of that.
- `docs/adr/identity-and-trust.md` - principal/operator identity. That is *actor* identity (who is connecting); this ADR is *document* identity (which notebook). They do not share an id space.
- `docs/adr/runtime-state-document-identity.md` - how the RuntimeStateDoc id is owned by the NotebookDoc; the same "stable id, separate concern" instinct applies here for the file path.
- `docs/prd/notebook-identity-environment-surfaces.md` and `docs/audits/notebook-identity-environment-surface-audit.md` - the product surfaces and the audit that motivated looking at identity end to end.

## Context

A notebook needs an identity that survives the daemon process. Today it does not.

When a room is created, the daemon mints a `notebook_id` as a fresh UUID (`crates/runtimed/src/notebook_sync_server/room.rs`, `Uuid::parse_str(notebook_id).unwrap_or_else(Uuid::new_v4)`). The notebook *document* is persisted by that id to `docs_dir/<derived-from-notebook_id>`. The roles differ by kind (`room.rs:859`): for an **untitled** notebook the id-keyed doc is the only content record, loaded on restart so content survives. For a **file-backed** notebook the `.ipynb` is the source of truth, so the daemon deletes the stale id-keyed doc on load and re-imports from disk. Either way, content is recoverable across a restart - *if* the same notebook can be resolved to the same id (untitled) or the same file (file-backed).

What does **not** survive is the binding from a file path to that id. The path-to-room binding lives only in memory (`RoomRegistry`, `set_bound_path`, `bind_existing`, `promote_after_save`). On a fresh daemon, opening the same `.ipynb` mints a **new** UUID and a new persisted doc. The same file therefore has different ids in different daemon lifetimes.

That gap is invisible until the daemon is replaced under a live client, which on the nightly channel happens routinely (auto-update). The failure mode, reproduced live against `2.6.0-nightly` (`8f2c9c4`) with `fasty.ipynb`:

1. An MCP client joins a file-backed room **by `notebook_id`** (UUID).
2. The daemon is upgraded/replaced. The MCP child reconnects to the new daemon.
3. The rejoin uses the only handle it kept - the UUID - but that UUID is scoped to the dead daemon's room space. The new daemon either has no such room or an empty one.
4. The desktop, which tracks the **path**, reopens `fasty.ipynb` and reloads its cells. Desktop shows the notebook; the agent sees `cells: []`.

The asymmetry is the tell: the peer that kept a path recovered, the peer that kept a UUID did not. The UUID is a daemon-local handle wearing the costume of a durable identity.

## Decision 1: Identity is opaque and stable; the path is a mutable attribute

A notebook's id is an opaque, stable token assigned once - at creation for an untitled notebook, at first open for a file. The file path is **an attribute of that id**, not a component of it.

Do not encode the path into the id, and do not derive the id from the path. A path-derived id changes on every move or rename, which forces a compensating `old_id -> new_id` remap table to preserve continuity - machinery that exists only to undo the coupling you introduced by deriving the id from the path in the first place. Keep them separate and the remap table never needs to exist: a move updates the path attribute, the id is unchanged; the file watcher already fires on the rename.

This is the ordinary database split between a primary key and a mutable column. The id is the key. The path is a column.

## Decision 2: Local notebooks resolve through a daemon-local persistent registry

The missing piece is a persistent **path <-> id registry**, daemon-local, surviving restarts. It is the same shape as `trusted-packages.sqlite` (a daemon-local sqlite store), and it closes the loop the in-memory `RoomRegistry` leaves open:

- **Open by path:** look up `path -> id`; reuse the existing id and its already-persisted doc instead of minting a fresh UUID.
- **Open by id:** look up `id -> path`; reload the file when the in-memory room is gone.
- **Move/rename:** update the path for that id. Id unchanged.
- **Untitled to save:** assign a path to the existing id. Same id, now file-backed.

With the registry, daemon churn stops being a data-loss event for file-backed notebooks, and untitled notebooks recover too (their doc is already persisted by id; the registry keeps the id stable so the doc can be found again).

## Decision 3: The cloud id is the only globally meaningful identity, and the only one that may be embedded

Local ids are per machine and must never enter a committed file. If a local daemon id were written into `.ipynb` metadata and committed, every collaborator's daemon would either churn the field on each open (noisy diffs, merge conflicts on a meaningless token) or collide on it (two machines claiming the same id over divergent `docs_dir` state). Committed file content has to stay machine-agnostic.

The only identity that is globally meaningful is the **cloud/hosted id**, because the hosting layer owns it and it is shared by construction. That is the one - and the only one - that may be embedded or shared across users. The codebase already separates these paths (`is_hosted()`, `NotebookSession::hosted`, `cloud::hosted_notebook_url` vs `Local`); this ADR pins the rule: local document identity never leaves the machine, cross-user continuity comes from the cloud id when a notebook is hosted.

Cell ids already in nbformat are fine to commit; they are content, not notebook identity.

## Decision 4: A freed path gets a new id where we can tell; identity otherwise binds to the path

The clean cases hold:

- **Untitled** notebooks have no path, so they cannot collide with a reused path - a new untitled notebook is always a new id.
- **Save-as** explicitly moves a room from one path to another. The registry forgets the old path and binds the new one (`save_notebook.rs`: `release_path` + `registry.forget`/`record`), so the vacated path is free and a future file there gets a fresh id.

The case we cannot cleanly detect: a file is replaced **out of band** at the same path with no save event the daemon observes - `rm x.ipynb && cp other.ipynb x.ipynb`, a `git checkout`, an editor's atomic write. There the registry still maps that path to the old id, so reopening resolves to the prior id. We accept this, because:

1. The blast radius is small. File-backed rooms reload content from the `.ipynb` and delete the id-keyed Automerge doc on open (`room.rs:859`), and trust is keyed on package content, not id. The replacement gets the old id but its own (correct) content; there is no stale-content leak.
2. There is no reliable signal to do better. Inode, mtime, birth time, and content hash all change on ordinary edits and atomic saves, so keying on any of them would churn a notebook's id on every save - breaking the whole point of a stable id to "fix" a contrived edge.

So for file-backed notebooks, identity binds to the canonical path over time (`fs::canonicalize`, so symlinks are resolved and trailing slashes normalized). "Claim a fresh id for the file now at this path" is a candidate explicit action if we ever need it (NIP-3), never the default.

## Decision 5: Carry the path on the session and the rejoin target now (landed stopgap)

The registry is the durable fix and is not a same-release change. The release stopgap, landed with this ADR, carries the path that already exists rather than persisting a new structure:

- `connect_notebook(notebook_id=...)` resolves the room's canonical path from the daemon (`list_rooms`, authoritative) and stores it on `NotebookSession.notebook_path` instead of `None`, so `daemon_watch`'s in-child rejoin uses `connect_open(path)` and reloads (`crates/runt-mcp/src/tools/session.rs`).
- The same connect/create response surfaces `notebook_path` for file-backed rooms, and the proxy's `extract_session_id` prefers it over the UUID, so a respawn after a daemon swap seeds the **path** into the new child's rejoin target (`crates/runt-mcp-proxy/src/session.rs`). Ephemeral notebooks omit the path and still rejoin by UUID, which is correct for them.

This restores ADR `mcp-session-lifecycle.md` Decision 8's invariant for sessions established by `notebook_id`. It is forward-compatible: even after the registry lands, carrying the path on the session and the rejoin target is still correct.

## Rejected alternatives

- **Path-encoded or path-derived ids.** Couples identity to location; every move mints a new id and you are back to needing a remap table. Rejected in Decision 1.
- **Embed the local id in `.ipynb` metadata.** Breaks git collaboration: id churn or cross-machine collision. Rejected in Decision 3. Only a cloud id is embeddable.
- **`old_id -> new_id` remap table.** A symptom of path-derived ids. With a stable id and a mutable path attribute it has nothing to track. Rejected in Decision 1.
- **Treat the UUID as durable and reload by UUID across daemons.** The UUID is daemon-instance scoped; the live failure above is exactly this. Rejected in Decision 2.

## Open Follow-ups

- **NIP-1** (Landed; `crates/runtimed/src/notebook_registry.rs`): the persistent path <-> id registry (daemon-local sqlite, mirroring `trusted-packages.sqlite`) is in place. The two open-by-path sites in `daemon.rs` resolve `path -> stable id` instead of minting per run, and `save_notebook.rs` records `path -> id` on untitled->save and forgets-then-records on save-as. A file resolves to the same id across daemon restarts whether it was opened-as-file, saved from untitled, or saved-as.
- **NIP-2** (Landed): untitled (non-ephemeral) notebook recovery across a daemon restart. The doc *is* persisted by id in `docs_dir` and the daemon already reloads it on a connect-by-id — the real gap was the MCP rejoin giving up (clearing the session as `Evicted`) rather than reconnecting, because its `list_rooms` pre-check could not tell "evicted" from "dormant but recoverable". Fixed by making `NotebookSync` daemon-authoritative and attach-only: it attaches to a resident-or-recoverable room and refuses a gone one (no phantom), so the rejoin drops the heuristic and trusts the daemon. Truly ephemeral notebooks (no persisted doc) are still gone on restart by design. See `docs/adr/mcp-session-lifecycle.md` Decision 8.
- **NIP-3** (Design): migration and id reconciliation when a file already has an in-memory room under a fresh UUID at the moment the registry is introduced. Decide whether to adopt the existing room's id into the registry or rebind.

## References

- `crates/runtimed/src/notebook_sync_server/room.rs` - `load_or_create`, UUID assignment, `RoomRegistry`, path binding (`bind_existing`, `promote_after_save`, `rebind_after_save_as`).
- `crates/runt-mcp/src/tools/session.rs` - `connect_notebook`, `resolve_room_notebook_path`, session path backfill.
- `crates/runt-mcp/src/daemon_watch.rs` - `rejoin`, the path-vs-UUID fork.
- `crates/runt-mcp-proxy/src/session.rs` - `extract_session_id`, rejoin-target selection.
- `crates/runtimed/src/lib.rs` - `trusted-packages.sqlite` as the daemon-local store precedent.
- `docs/adr/mcp-session-lifecycle.md` - Decision 8, the rejoin invariant this ADR backs.
