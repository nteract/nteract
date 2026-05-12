# PutBlob sequencing plan

**Goal:** Land one socket-native blob-write primitive (`0x08 PutBlob`) that serves widgets, markdown attachments, `dx.attach`, and eventually SSH remote runtimes. Keep it simple, performant, maintainable.

**Related:**
- #1814 — Add PutBlob frame (this is the implementation)
- #1334 — SSH remote runtimes (consumer, not a dep)
- `.context/2026-04-30-putblob-frame-design.md` (the design spec, kept out-of-tree per repo convention)
- `.context/comm-buffer-paths-blob-upload-plan.md` (widget-side consumer; this plan replaces its "transport lanes" section)

---

## Current state (verified against `main`)

- Frame byte space: `0x00..=0x07` are taken. `0x07` is `SessionControl`. PutBlob = `0x08`. (`crates/notebook-wire/src/lib.rs:9-35`)
- Frame pump already has per-type caps, size-limit warnings, and a cancel-safe `FramedReader`. (`crates/notebook-wire/src/lib.rs:56-95`, `crates/runtimed/src/runtime_agent.rs:87`)
- Existing blob write paths:
  - **Local runtime-agent:** shares the blob-store filesystem with the daemon; uses `Arc<BlobStore>` directly (`crates/runtimed/src/runtime_agent.rs:104`, `crates/runtimed/src/output_prep.rs:208`). No wire traffic. This works for in-process + same-host agents; it does not work for SSH.
  - **Out-of-process `Handshake::Blob` channel:** second socket connection accepting `BlobRequest::Store { media_type }` + raw binary frame (`crates/runtimed/src/daemon.rs:3098-3148`). No current in-tree caller; kept for back-compat. This is the thing PutBlob deprecates.
  - **Frontend:** no blob write path at all today. Drag/drop, widget binary state, and `dx.attach` can't upload bytes over the wire.
- Tauri relay allow-list at `crates/notebook/src/lib.rs:2778` explicitly rejects any outbound frame type outside `{AUTOMERGE_SYNC, REQUEST, PRESENCE, RUNTIME_STATE_SYNC, POOL_STATE_SYNC}` — PutBlob is blocked at the host-transport boundary until that allow-list includes it.

## Design anchor

Use the `.context/2026-04-30-putblob-frame-design.md` spec verbatim:

- Frame `0x08`, body = `u32 header_len | JSON header | bytes`.
- Responses ride `0x02 Response` via new `NotebookResponse` variants, correlated by `id`.
- Multipart create/complete/abort ride normal `0x01 Request` JSON — no new response path on `0x08`.
- Capability: `put_blob { version, single_frame_max, default_part_size, multipart }` advertised in existing handshake capability shapes.
- Unix-socket / named-pipe owner auth remains the security boundary. HTTP blob server stays GET-only.
- Blob bytes never enter Automerge.

Two small corrections to lock in from the dive:

1. The draft says "Add a Rust client helper that uploads bytes." That helper already has a near-sibling inside `runtimed-client`; pick one place and don't fork it. Recommendation: put the client inside the notebook-sync connection (so it shares framing/backpressure) and expose a thin `put_blob(bytes, media_type) -> ContentRef` wrapper from `runtimed-client`.
2. The draft says "Keep `Handshake::Blob` channel intact." Fine for Phase 1, but mark `BlobRequest::Store` as deprecated in doc-comments in the same PR so no new callers appear. `GetPort` has no replacement yet and must stay.

## Why this replaces the widget plan's "transport lanes" idea

`.context/comm-buffer-paths-blob-upload-plan.md` Section "Transport Lanes" proposes a main lane / bulk lane split with a separate Unix socket. That's more machinery than needed:

- The existing notebook socket already has per-type frame caps and fair frame reading; widget selection buffers (~KB) are tiny compared to the 32 MiB single-frame cap the spec proposes.
- A second socket doubles auth surface, connection lifecycle, reconnection semantics, and handshake-capability plumbing for what is structurally the same concern the frame pump already solves with caps.
- Multipart (Phase 3 in the spec) is the right answer for "don't block sync behind one huge upload." Per-peer one-active-part + bounded worker (spec §"Flow control and fairness") give the same fairness guarantee with one transport.

**Recommendation:** drop the bulk-lane section from the widget plan. Widget buffers ship on the single shared notebook socket.

## Sequencing

### Phase 0 — land the spec and the frame bytes (day-scale, no behavior)

- [ ] Add `PUT_BLOB = 0x08` constants + `NotebookFrameType::PutBlob` variant + `frame_size_limits` entry (start: cap 32 MiB, warn 8 MiB) in `crates/notebook-wire/src/lib.rs`.
- [ ] Add TS constant mirror in `crates/notebook-protocol/src/typescript.rs` generated output.
- [ ] Add blob-upload response variants to `NotebookResponse` (no handler yet).
- [ ] Add `put_blob` to the capability shapes in `ProtocolCapabilities` + `NotebookConnectionInfo`, default `None`.
- [ ] Add `0x08` to the Tauri relay allow-list at `crates/notebook/src/lib.rs:2778` so the frontend can send it once callers exist.
- [ ] Protocol contract tests: constant presence Rust + TS, frame-cap rejection round-trip.
- [ ] **No production caller in this phase.**

Exit criteria: `cargo xtask lint --fix` clean, `cargo test -p notebook-wire -p notebook-protocol` green, no runtime behavior change.

### Phase 1 — one-shot upload, server side

- [ ] Implement `op: "put"` handling on the notebook-sync connection: read header, validate `size` == body length, verify `sha256`, call `BlobStore::put`, reply with `BlobStored` response.
- [ ] Advertise `put_blob` capability from the daemon handshake.
- [ ] Structured errors: `BlobUploadError { id, reason }` with distinct reasons (`size_mismatch`, `hash_mismatch`, `over_cap`, `io`).
- [ ] Tests: success, size mismatch, hash mismatch, oversize frame, unknown media type passes through, cap enforcement.
- [ ] Decision-lock on spec open question 1: one-shot takes the direct `BlobStore::put` fast path. Multipart reuses that plus a staging dir; do not collapse them.

Exit criteria: daemon advertises capability, accepts one-shot uploads from a test client, existing `Handshake::Blob::Store` still works.

### Phase 2 — one-shot client (shared)

- [ ] Rust client: `put_blob_one_shot(conn, bytes, media_type) -> Result<BlobStored>` on the notebook-sync connection object. Single source of truth.
- [ ] Frontend client: `putBlob(bytes, mediaType)` in the existing notebook-socket wrapper. Reuse the typed-frame send path. Gate on capability.
- [ ] Fallback behavior when capability absent: clear error, no silent drop. Callers pick what to do (widget path: degrade to a no-op warning + log; attachment path: disable drop zone).

Exit criteria: both clients upload to the real daemon. Capability gating verified with a server that omits the capability.

### Phase 3 — widget binary state (first real consumer)

This is the `.context/comm-buffer-paths-blob-upload-plan.md` work, now scoped down:

- [ ] Keep the widget plan's Phase 1 (reproduction test) and Phase 2 (`comm-buffer-extraction.ts`).
- [ ] Replace its Phase 3 with: call the Phase 2 frontend `putBlob` client. No new transport machinery.
- [ ] Keep its Phase 4 (RuntimeStateDoc write path) and Phase 5 (runtime-agent rehydration).
- [ ] Delete its Phase 6 (bulk lane). If it turns out one selection buffer is big enough to matter, revisit *after* Phase 5 of this plan.

Ordering invariant to add to the widget plan: frontend MUST await `putBlob` before writing the ContentRef into RuntimeStateDoc. Otherwise the runtime-agent diff path may resolve a ContentRef whose bytes are not yet durable. (Daemon-local agents see the blob the moment `put` returns because they share the filesystem; this invariant keeps the protocol honest for remote agents too.)

Exit criteria: jscatter lasso round-trips in an E2E.

### Phase 4 — attachments + markdown ingestion

Picks up spec Phase 2. Consumes the same one-shot path. Independent of widgets; can interleave.

### Phase 5 — multipart

Spec Phase 3 verbatim. Required before `dx.attach(path)` can upload files larger than the single-frame cap. Required before SSH remote agents can move big outputs (parquet, images).

Explicit dependencies on prior phases:
- Peer-scoped upload registry (spec §"Upload session ownership") — keyed by the existing connection identity from handshake.
- Per-peer byte budget enforcement + expiry GC — shares the bounded-worker pattern from Phase 1.

Exit criteria: `dx.attach` of a 200 MiB parquet lands as a single content-addressed blob, aborts clean, concurrent sync traffic stays responsive.

### Phase 6 — remote peers, legacy cleanup

- [ ] SSH remote runtime-agent switches from "shared `BlobStore` filesystem" to PutBlob over the forwarded socket. This removes the "separate blob-store path / tunneled socket" clause in #1334's blob-upload section.
- [ ] Deprecate `Handshake::Blob::Store`; keep `GetPort` or migrate callers to a daemon-info capability response.

## Decisions that don't have to wait

These are independent of the phase order but belong in the plan for visibility:

- **Where the client lives:** one Rust client inside the notebook-sync connection object, re-exported through `runtimed-client`. No second helper crate.
- **One-shot implementation:** direct `BlobStore::put` fast path; multipart is its own staging path. (Resolves spec OQ 1.)
- **Purpose field:** keep in the header but don't use it for policy in v1. Log + reserve. (Resolves spec OQ 3 by deferring.)
- **Frame caps:** 32 MiB single-frame, 8 MiB default part. Revisit after the frame pump has real traffic. Named-pipe defaults are identical until measurements say otherwise. (Resolves spec OQ 2 by picking a default and moving on.)
- **Remote push vs pull:** defer. The SSH phase picks one at implementation time. (Spec OQ 4.)

## What each consumer actually needs

| Consumer | Needs | Phase |
|---|---|---|
| Widgets (jscatter-style binary state) | One-shot, small (KB-MB) | 3 |
| Markdown attachment drag/drop | One-shot, small-medium | 4 |
| `dx.attach(path)` small files | One-shot | 4 |
| `dx.attach(path)` large files | Multipart | 5 |
| Runtime-agent output bytes (local, same host) | Nothing — keeps `Arc<BlobStore>` | — |
| Runtime-agent output bytes (SSH remote) | Multipart | 6 |
| Remote-peer blob replication | Multipart + maybe lazy pull | 6 |

## Risks

1. **Echo suppression.** When the runtime agent reads back a ContentRef it originated, it must not re-emit or re-resolve it. Solve in the widget phase (phase 3 of this plan, rehydration step) by tagging resolved bytes by hash and comparing, not by ContentRef identity.
2. **Capability rollout drift.** A new daemon talking to an old frontend (and vice versa) must not hang. The spec already mandates capability gating; keep the TS contract test that asserts "client refuses to send 0x08 without capability" in Phase 0.
3. **Framed reader memory pressure.** The reader can buffer several max-size frames before the peer loop dequeues. For PutBlob, clamp queue depth or backpressure before read; spec §"Flow control" calls this out. Land as part of Phase 1 — do not defer.
4. **Control-plane starvation.** CLAUDE.md invariant: runtime control-plane signals must not share bounded output transport with floods. PutBlob must be on the runtime-sync transport reader but processed through its own bounded worker so `ExecutionDone` / `KernelIdle` don't wait behind a 32 MiB blob write. Belongs in Phase 1.

## First PR (narrow)

Phase 0 only: constants, caps, response variants, capability field, Tauri allow-list, TS contract test, docs. Zero behavior change. This is the smallest reviewable slice and unblocks every downstream phase in parallel.
