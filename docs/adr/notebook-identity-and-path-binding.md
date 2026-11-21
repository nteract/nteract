# Notebook Identity and Path Binding

**Status:** In progress, 2026-06-24. Persistent path-to-id registry and untitled
recovery landed; existing-room reconciliation remains open.

**Neighbors:**
- `docs/adr/mcp-session-lifecycle.md`: Decision 8 keys file-backed rejoin on the path; this ADR explains why and where that key comes from.
- `docs/adr/local-first-notebook-state.md`: persistence and reconnect direction for local handles; this registry provides the durable store.
- `docs/adr/identity-and-trust.md`: principal/operator *actor* identity (who connects), separate from *document* identity (which notebook). They do not share an id space.
- `docs/adr/runtime-state-document-identity.md`: `RuntimeStateDoc` id ownership by `NotebookDoc`; the same stable-id separation applies to file paths.
- `docs/prd/notebook-identity-environment-surfaces.md` and `docs/audits/notebook-identity-environment-surface-audit.md`: product surfaces and audit motivating end-to-end notebook identity.

## Done / Next

**Done:**
- Daemon-local persistent `path <-> id` SQLite registry (`crates/runtimed/src/notebook_registry.rs`), wired into both open-by-path sites in `daemon.rs` and save/save-as in `save_notebook.rs`.
- Untitled (non-ephemeral) notebook recovery across daemon restarts, backed by daemon-authoritative, attach-only `NotebookSync` rejoin.
- Session path backfill and proxy rejoin-target propagation for file-backed notebooks (`crates/runt-mcp/src/tools/session.rs`, `crates/runt-mcp-proxy/src/session.rs`).
- Cross-channel file claim leases at `~/.cache/runt-shared/file-claims/` (`runt_workspace::file_claims`).

**Next:**
- Reconciliation design for a file that already has an in-memory room under a fresh UUID when the registry is introduced.

## Context

A notebook's identity must survive daemon restarts. Originally, it did not.

When a room opened, the daemon minted a fresh UUID (`crates/runtimed/src/notebook_sync_server/room.rs`, `Uuid::parse_str(notebook_id).unwrap_or_else(Uuid::new_v4)`). It persisted the document under `docs_dir/<derived-from-notebook_id>`, with different roles by kind (`room.rs:859`):

- **Untitled notebooks:** the id-keyed doc is the sole content record and reloads on restart.
- **File-backed notebooks:** the `.ipynb` file is authoritative, so the daemon deletes the stale id-keyed doc on load and re-imports from disk.

Content survived restarts only if clients resolved back to the same id (untitled) or file (file-backed). Because the path-to-room binding lived only in memory (`RoomRegistry`, `set_bound_path`, `bind_existing`, `promote_after_save`), a new daemon minted a new UUID for the same `.ipynb`.

Nightly auto-updates exposed this gap whenever the daemon restarted under a live client. Reproduced live on `2.6.0-nightly` (`8f2c9c4`) with `fasty.ipynb`:

1. An MCP client joined a file-backed room by `notebook_id` (UUID).
2. The daemon restarted on upgrade, and the MCP child reconnected.
3. Rejoin sent the old UUID, which was scoped to the dead daemon. The new daemon had no matching room or opened an empty one.
4. Desktop tracked the file path, reopened `fasty.ipynb`, and reloaded its cells. Desktop showed the notebook; the agent saw `cells: []`.

The peer holding a path recovered; the peer holding a UUID did not. The UUID was a daemon-local handle masquerading as a durable identity.

## Decision 1: Identity is opaque and stable; the path is a mutable attribute

A notebook's id is an opaque, stable token assigned once: at creation for untitled notebooks, at first open for files. The file path is an attribute of that id, not part of it.

Never encode the path into the id or derive the id from the path. Path-derived ids change on every move or rename, forcing an `old_id -> new_id` remap table just to undo that coupling. Keeping them separate eliminates the remap table: a move updates the path attribute, leaves the id intact, and triggers the existing file watcher.

The id is the primary key; the path is a mutable column.

## Decision 2: Local notebooks resolve through a daemon-local persistent registry

A daemon-local SQLite `path <-> id` registry (`crates/runtimed/src/notebook_registry.rs`, same pattern as `trusted-packages.sqlite`) persists identity across restarts and closes the gap left by in-memory `RoomRegistry`:

- **Open by path:** both open-by-path sites in `daemon.rs` look up `path -> id` and reuse the existing id and persisted doc instead of minting a fresh UUID.
- **Open by id:** look up `id -> path` and reload the file when no in-memory room exists.
- **Move/rename:** update the path for that id without changing the id.
- **Untitled to save:** `save_notebook.rs` records `path -> id` on the existing id; the notebook keeps its id and becomes file-backed.
- **Save-as:** `save_notebook.rs` forgets the old path and records the new one.

A file now resolves to the same id across daemon restarts whether opened directly, saved from untitled, or saved-as.

Untitled (non-ephemeral) notebooks also recover across restarts. Their docs persist by id in `docs_dir`, and the daemon reloads them on connect-by-id. `NotebookSync` is daemon-authoritative and attach-only: it attaches to a resident or recoverable room and refuses a gone one without creating a phantom. MCP rejoin therefore drops its `list_rooms` pre-check heuristic (which could not tell `Evicted` rooms from dormant recoverable ones) and trusts the daemon. Truly ephemeral notebooks (no persisted doc) still disappear on restart by design. See `docs/adr/mcp-session-lifecycle.md` Decision 8.

## Decision 3: The cloud id is the only globally meaningful identity, and the only one that may be embedded

Local ids are machine-scoped and must never be written into `.ipynb` metadata. Committing a local id would cause every collaborator's daemon to churn diffs on open or collide across divergent `docs_dir` state. Committed notebook files must stay machine-agnostic.

Only the **cloud/hosted id** is globally meaningful, because the hosting layer owns and shares it by construction. It is the sole notebook identity permitted in embedded or cross-user references. The codebase already splits these paths (`is_hosted()`, `NotebookSession::hosted`, `cloud::hosted_notebook_url` vs. `Local`).

Cell ids in nbformat remain safe to commit; they identify content, not the notebook.

## Decision 4: A freed path gets a new id where we can tell; identity otherwise binds to the path

Explicit path transitions keep identities distinct:

- **Untitled notebooks** have no path, so each new untitled notebook gets a fresh id.
- **Save-as** moves a room from its old path to a new one (`save_notebook.rs`: `release_path` plus `registry.forget`/`record`). The vacated path is free, and a future file there gets a fresh id.

Out-of-band file replacement at the same path (`rm x.ipynb && cp other.ipynb x.ipynb`, `git checkout`, or an editor's atomic write) leaves the registry pointing at the prior id. Reopening reuses that id. We accept this tradeoff for two reasons:

1. **Small blast radius:** file-backed rooms delete the id-keyed Automerge doc on open and reload from the `.ipynb` (`room.rs:859`), and package trust keys on package content, not notebook id. No stale content leaks.
2. **No reliable signal:** inode, mtime, birth time, and content hash all change on ordinary edits and atomic saves. Keying on them would churn notebook ids on every save.

File-backed identity therefore binds to the canonical path (`fs::canonicalize`, resolving symlinks and normalizing trailing slashes). An explicit "claim a fresh id for the file at this path" action may be added later if needed, never as the default.

## Decision 5: Carry the path on the session and the rejoin target

Originally landed as a release stopgap ahead of the persistent registry, path propagation stays active and forward-compatible alongside it:

- `connect_notebook(notebook_id=...)` queries the daemon's authoritative `list_rooms` for the room's canonical path and stores it on `NotebookSession.notebook_path` instead of `None`. `daemon_watch` in-child rejoin then calls `connect_open(path)` and reloads (`crates/runt-mcp/src/tools/session.rs`).
- Connect and create responses surface `notebook_path` for file-backed rooms. The proxy's `extract_session_id` prefers it over the UUID, seeding the path into a respawned child's rejoin target after a daemon swap (`crates/runt-mcp-proxy/src/session.rs`).
- Ephemeral notebooks omit the path and still rejoin by UUID.

This preserves `docs/adr/mcp-session-lifecycle.md` Decision 8 for sessions opened by `notebook_id`.

## Decision 6: One daemon process serves a path at a time (cross-channel file claims)

Because each daemon's registry is local, a second daemon (another release channel or dev worktree) could open the same `.ipynb` and split-brain it on save. A shared lease registry at `~/.cache/runt-shared/file-claims/` (`runt_workspace::file_claims`) prevents this.

**Claim gate:**
- Every handshake attaching a peer to a path-bound room passes a single claim gate.
- The gate acquires the canonical path (recording channel, socket path, room id, and pid) or fails with a structured `file_active_elsewhere` error naming the owning channel and socket.
- The error surfaces verbatim through the handshake error field MCP clients already read.

**Activity-driven lifetime (not room residency):**
- A daemon holds a claim while the room has connected peers or unexported durable state (durable heads ahead of exported heads, i.e., a dirty journal).
- A clean idle room releases its claim after a short grace window (~1 minute, long enough to survive a window reload) while staying resident for fast rejoin.
- The daemon re-acquires the claim through the gate on peer reconnect, or through the reconciler when dirty state appears.
- If re-acquisition hits a live foreign claim, the open or reconnect fails with `file_active_elsewhere`. The daemon never overwrites a live foreign claim; a conflict while this daemon still serves the room is logged, not stolen.

**Explicit release triggers:**
- Room eviction.
- Explicit `ShutdownNotebook`, after the journal barrier, autosave shutdown, and autosave-owner-marker release so the successor daemon can save.
- Save-as (releases the old path).
- Clean daemon shutdown.

**Lease semantics:**
- Claims are leases, never locks. A dead pid or lapsed refresh window makes a claim stale, and the next writer reaps it so a crashed daemon cannot brick a path.
- The registry stores facts only; source-conflict reconciliation stays the last line of defense if a claim is wrong or a race slips through.

## Rejected alternatives

- **Path-encoded or path-derived ids.** Couples identity to location; every move mints a new id and forces a remap table. Rejected in Decision 1.
- **Embed the local id in `.ipynb` metadata.** Causes git diff churn and cross-machine collisions. Rejected in Decision 3; only cloud ids are embeddable.
- **`old_id -> new_id` remap table.** Only needed when ids derive from paths. Unnecessary with a stable id and mutable path attribute. Rejected in Decision 1.
- **Treat the UUID as durable across daemons without persistence.** Unpersisted UUIDs are daemon-instance scoped and caused the live failure above. Rejected in Decision 2.

## Open Follow-ups

- **Existing-room id reconciliation:** Decide how to reconcile a file that already has an in-memory room under a fresh UUID when the registry is introduced (adopt the existing room's id into the registry vs. rebind), and whether to expose an explicit "claim a fresh id" action for out-of-band file replacement.

## References

- `crates/runtimed/src/notebook_registry.rs`: daemon-local SQLite `path <-> id` registry.
- `crates/runtimed/src/notebook_sync_server/room.rs`: `load_or_create`, UUID assignment, `RoomRegistry`, path binding (`bind_existing`, `promote_after_save`, `rebind_after_save_as`).
- `crates/runt-mcp/src/tools/session.rs`: `connect_notebook`, `resolve_room_notebook_path`, session path backfill.
- `crates/runt-mcp/src/daemon_watch.rs`: `rejoin`, the path-vs-UUID fork.
- `crates/runt-mcp-proxy/src/session.rs`: `extract_session_id`, rejoin-target selection.
- `crates/runtimed/src/lib.rs`: `trusted-packages.sqlite` precedent for daemon-local SQLite stores.
- `docs/adr/mcp-session-lifecycle.md`: Decision 8, the rejoin invariant this ADR backs.
