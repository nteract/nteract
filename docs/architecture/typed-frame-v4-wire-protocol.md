# Typed-frame v4 wire protocol

**Status:** Draft, 2026-05-22.

## Context

Every peer in the nteract desktop world speaks the same byte protocol over a Unix socket: the Tauri relay inside the desktop app, the daemon (`runtimed`), the runtime-agent subprocess, the `runt-mcp` proxy, the Python bindings, and (per `docs/architecture/identity-and-trust.md`) future hosted-room WebSocket bridges. The protocol is `notebook-wire` v4 typed frames on top of a 5-byte preamble.

The wire crate (`crates/notebook-wire/src/lib.rs`) is intentionally tiny: magic bytes, protocol-version constant, the `NotebookFrameType` enum, per-type size limits, and the `SessionControlMessage` shapes. Framing itself lives one crate up (`crates/notebook-protocol/src/connection/framing.rs`). Everything heavier (Automerge sync, JSON request/response, CBOR presence, blob uploads) is layered on top.

This ADR pins down what every peer must agree on so the format does not silently drift between Rust, the `packages/runtimed` TypeScript surface, the Python client, and any future browser transport. The semantic neighbors:

- `docs/architecture/identity-and-trust.md` — who is allowed to send which frame.
- `docs/architecture/three-document-split.md` — what `AutomergeSync` / `RuntimeStateSync` / `PoolStateSync` actually carry.
- `docs/architecture/execution-pipeline.md` — how `Request` / `Response` / `SessionControl` thread through cell execution.
- `docs/architecture/blob-storage-and-content-addressing.md` — what `PUT_BLOB` is moving and where it lands.
- `docs/architecture/cleanup-punchlist.md` — open gaps surfaced while writing this.

This document is the framing layer underneath all of them.

## Decision 1: Preamble is 5 bytes, magic plus version byte

Every connection opens with exactly 5 bytes before any frame:

```
0xC0 0xDE 0x01 0xAC   <protocol_version_byte>
```

- `MAGIC` is constant. A peer that does not lead with these four bytes is dropped at the daemon's 10-second handshake timeout.
- `PROTOCOL_VERSION` is currently `4`. It is a `u32` constant in source but is serialized as one byte; a `const _: () = assert!(PROTOCOL_VERSION <= u8::MAX as u32)` enforces this at compile time. We get 252 future versions of one-byte preamble before we have to widen the field. That is a deliberate design constraint, not a bug.
- `MIN_PROTOCOL_VERSION` is also `4`. Protocol v4 removed the legacy environment-sync request/response variants and is not wire-compatible with v3 clients. There is no v3 fallback path.

### Version negotiation has two tiers

Preamble-version policy is set after the handshake JSON is parsed, by handshake channel:

| Channel | Accepted preamble versions |
|---------|----------------------------|
| `Pool` | Any version with valid magic |
| `SettingsSync` | `1..=PROTOCOL_VERSION` |
| Everything else (`NotebookSync`, `OpenNotebook`, `CreateNotebook`, `RuntimeAgent`) | `MIN_PROTOCOL_VERSION..=PROTOCOL_VERSION` |

`Pool` stays version-tolerant because older stable apps ping the daemon during upgrade to detect mismatch and trigger `upgrade_daemon_via_sidecar`. Rejecting them would break the self-upgrade flow. `SettingsSync` is tolerant because it is a raw Automerge document sync that survives schema changes; keeping older app windows from spinning during a daemon upgrade is the point.

### Sender-side version reporting

The directional-hint error strings ("Please update the CLI", "Please update the daemon") live in `crates/notebook-protocol/src/connection/framing.rs:58-71`. They are emitted by **client-side** `recv_preamble` when the client reads the daemon's preamble back and finds a mismatch.

The daemon does its own preamble read (`crates/runtimed/src/daemon.rs:2424-2443`). The daemon's preamble check validates **only the magic bytes**; it does not gate on protocol version at all. Version policy is applied after the handshake JSON is parsed and the channel is known (`daemon.rs:2456-2481`). This is what lets `Pool` accept any version: the daemon never rejects on the version byte at the preamble layer.

The asymmetry is load-bearing. The client gets a friendly error string because it can render one; the daemon defers version rejection so it can produce a JSON-shaped error on the right channel.

The daemon's bundled-sidecar story (commit-hash equality between app and daemon) lives in `crates/notebook-wire/AGENTS.md`; for the wire protocol the only fact that matters is that there is no in-band downgrade. The connection fails closed.

## Decision 2: Two framing surfaces share the preamble

Same preamble, two framings live on top, selected by handshake channel:

1. **Untyped length-prefixed JSON** (`Pool`, `SettingsSync`). 4-byte big-endian `u32` length, then payload. `Pool` carries `Request`/`Response` JSON; `SettingsSync` carries raw Automerge sync bytes with no leading type byte.
2. **Typed length-prefixed frames** (`NotebookSync`, `OpenNotebook`, `CreateNotebook`, `RuntimeAgent`). 4-byte big-endian `u32` length, then 1-byte type discriminator, then payload.

Both surfaces share the same 100 MiB outer ceiling (`MAX_FRAME_SIZE`) and the same 64 KiB control ceiling (`MAX_CONTROL_FRAME_SIZE`). The handshake JSON itself is read via `recv_control_frame`, which enforces the 64 KiB cap. This is what protects the handshake from a 100 MiB allocation attack before the daemon knows which channel it is on; without `recv_control_frame` on that boundary, an attacker who got past the preamble could force a 100 MiB allocation on the handshake read.

The fact that the same protocol-version preamble gates two different framing rules is intentional: pool/settings predate the typed-frame layer and were not worth migrating. New channels should adopt typed framing.

## Decision 3: Nine frame types, fixed numbering

`NotebookFrameType` is a `#[repr(u8)]` enum. Adding a new type requires a new byte, a new variant, and a CI-enforced contract test (`cargo test -p notebook-protocol`). The current set:

| Byte | Variant | Payload encoding | Direction |
|------|---------|------------------|-----------|
| `0x00` | `AutomergeSync` | Binary, raw `automerge::sync::Message` bytes | bidirectional |
| `0x01` | `Request` | JSON, `NotebookRequestEnvelope` or `RuntimeAgentRequestEnvelope` | client → daemon |
| `0x02` | `Response` | JSON, `NotebookResponseEnvelope` or `RuntimeAgentResponseEnvelope` | daemon → client |
| `0x03` | `Broadcast` | JSON, `NotebookBroadcast` | daemon → client |
| `0x04` | `Presence` | CBOR, `PresenceMessage` | bidirectional |
| `0x05` | `RuntimeStateSync` | Binary, raw `automerge::sync::Message` bytes (`RuntimeStateDoc`) | bidirectional |
| `0x06` | `PoolStateSync` | Binary, raw `automerge::sync::Message` bytes (`PoolDoc`) | bidirectional |
| `0x07` | `SessionControl` | JSON, `SessionControlMessage` | daemon → client |
| `0x08` | `PutBlob` | Framed binary (see Decision 6) | client → daemon |

### Direction is policy, not encoding

Direction is enforced by the room peer loop and by the relay, not by anything intrinsic to the type byte:

- The daemon's notebook peer loop (`crates/runtimed/src/notebook_sync_server/peer_loop.rs:358-362`) rejects `Response`, `Broadcast`, and `SessionControl` from clients with a `warn!`.
- The Tauri relay (`crates/notebook-sync/src/relay_task.rs::pipe_frame`, `:321,336`) forwards `Response` outbound to the frontend, even though `crates/runtimed/tests/integration.rs:3156,3183` (`test_pipe_mode_only_pipes_allowed_frame_types`) excludes `RESPONSE` from its allowed-set. These are different paths (relay-mode vs pipe-mode CLI), but the naming overlap is misleading. The relay's behavior is the operative one: the frontend depends on receiving `Response` frames over the relay.
- The runtime-agent peer reuses `Request`/`Response` (`0x01`/`0x02`) but the payloads are `RuntimeAgentRequestEnvelope`/`RuntimeAgentResponseEnvelope`, not `NotebookRequestEnvelope`. The type byte is identical; the JSON discriminant inside differs. That is a load-bearing implicit contract.

### Forward-compatibility behavior

Unknown frame types are logged and skipped by `recv_typed_frame`. The loop continues. This makes the format additively forward-compatible at the receive path: a v5 daemon can send a v4-unknown frame type and a v4 client will skip it. The opposite direction (v4 daemon receiving v5 frame from a newer client) is closed off by the handshake preamble check, which fails before any frame is sent. The forward-compat path is therefore daemon-to-client only.

## Decision 4: Per-type size limits trade safety for headroom

Every frame type has a hard cap (reject) and a soft warn threshold (log, continue). They are not bumper guesses; each one names what the channel legitimately needs:

| Type | Cap | Warn | Why |
|------|-----|------|-----|
| `AutomergeSync` | 64 MiB | 16 MiB | Initial doc sync for a notebook with thousands of cells |
| `Request` | 16 MiB | 256 KiB | `SendComm` envelope: widget buffers JSON-expand from binary ~4x |
| `Response` | 64 MiB | 16 MiB | `DocBytes`, `HistoryResult`, completions, env-sync replies |
| `Broadcast` | 16 MiB | 4 MiB | `Comm` custom widget broadcasts with inline buffers |
| `Presence` | 4 KiB | 1 KiB | Cursor/selection/focus updates (typically <100 bytes CBOR); matches semantic cap in `notebook-doc::presence` |
| `RuntimeStateSync` | 64 MiB | 16 MiB | Snapshots of `RuntimeStateDoc` with output manifests |
| `PoolStateSync` | 1 MiB | 256 KiB | Daemon pool state is small (counts, errors, env paths) |
| `SessionControl` | 1 MiB | 256 KiB | Tiny readiness JSON |
| `PutBlob` | 32 MiB | 8 MiB | Single-frame blob upload ceiling |

The caps and warns are duplicated across crates: `notebook_wire::frame_size_limits` (Rust), `packages/runtimed/src/transport.ts::frameSizeLimits` (TS). Two contract tests cover the Rust side:

- `crates/notebook-protocol/src/protocol.rs::typescript_protocol_contract_matches_rust_wire_discriminants` (`:1512`) compares **discriminant bytes** against a generated TS contract artifact.
- `crates/notebook-protocol/src/connection.rs::frame_size_limits_cover_every_known_frame_type` (`:530`) asserts every known type has a tighter cap than the 100 MiB outer ceiling and that warn is strictly less than cap.

Neither test compares the per-type Rust caps to the TS `frameSizeLimits` values. The two tables can drift silently. The cleanup punchlist tracks this as WP-3.

### Why the cap-first protocol matters

`recv_typed_frame` reads the 4-byte length prefix, then the 1-byte type byte, then looks up the per-type cap and applies it **before allocating the body buffer** (`crates/notebook-protocol/src/connection/framing.rs:144-178`). A garbage length prefix aimed at the `Presence` channel (which legitimately carries ~100 bytes) is rejected after 5 bytes of header read, before the body allocation. Without per-type caps, a 1.8 GB length on a narrow channel would still allocate up to the 100 MiB outer ceiling before failing. The cap structure is an allocator safety boundary, not just a sanity check.

There is one cost to forward-compat: for **unknown** frame types the per-type lookup falls back to the 100 MiB outer ceiling (`crates/notebook-wire/src/lib.rs:97-101`). The body is allocated and read into memory *before* `try_from` rejects the unknown discriminant and the frame is skipped (`framing.rs:204-222`). So a v4 daemon receiving forward-compat unknown bytes from a v5 peer can allocate up to 100 MiB per frame before skipping. Future-proof is not free.

### Outbound caps mirror inbound

`send_typed_frame` enforces the same per-type cap as `recv_typed_frame`. An outbound oversize fails locally with `"outbound frame too large"` instead of producing a frame the peer will reject and a generic connection-drop error. The test that exercises this (`typed_frame_send_rejects_outbound_oversize`) also asserts that no bytes are written when the frame is over cap, so a partial write cannot desync the stream.

## Decision 5: Cancel-safe receive via dedicated reader actor

`recv_typed_frame` is built on `tokio::io::AsyncReadExt::read_exact`, which is **not cancel-safe**. Dropping the future mid-read silently consumes bytes; the next call reads a length prefix from the middle of the previous payload and the stream is desynced.

Direct use in a `tokio::select!` arm is therefore forbidden. The peer loops obey this by handing the read half to `FramedReader::spawn`, a dedicated tokio task that owns the read half exclusively and publishes frames through a bounded mpsc channel (capacity 16 in the daemon peer loop). `FramedReader::recv()` is just `mpsc::Receiver::recv()`, which is cancel-safe.

This is the only correct way to put `recv_typed_frame` inside a busy `select!`. The convention is enforced by reading: any direct `recv_typed_frame(...)` call inside a `select!` arm is a bug. The bounded mpsc capacity is also where back-pressure lives: a slow consumer applies pressure to the source.

## Decision 6: PUT_BLOB is a frame within a frame

`PutBlob` (0x08) is the only frame type whose payload is not a single self-describing encoding. It is a length-prefixed JSON header followed by raw blob bytes:

```
┌──────────────┬────────────────┬─────────────────┐
│ u32 header_  │ JSON header    │ raw blob bytes  │
│ len (BE)     │ (PutBlobHeader)│                 │
└──────────────┴────────────────┴─────────────────┘
```

The outer frame still has the standard `length | type_byte (0x08) | payload` shape. The inner 4-byte length is only the header's length, not the whole payload. `PutBlobHeader::try_parse` peels it back off and returns the parsed header plus a `&[u8]` slice pointing at the body inside the original buffer (no copy).

Two header variants:

- `Put { id, media_type, size, sha256, durability?, purpose? }` for one-shot uploads.
- `Part { id, upload_id, part_number, size, sha256 }` for multipart uploads.

The `id` correlates with the matching `Response` frame; multipart uploads carry an additional `upload_id` that ties parts together across frames.

### Why a sub-framing layer

Three reasons:

1. Blob bytes are raw and arbitrary. Embedding them in JSON would force base64 (4/3 expansion plus parser overhead) on every upload.
2. The header needs to be JSON because it carries semantic metadata (`media_type`, `sha256`, `durability`, `purpose`) that we want schema-versioned without a new wire type.
3. The 32 MiB cap on `PutBlob` is deliberately lower than the 64 MiB cap on `AutomergeSync`. Output blobs above 32 MiB go through the multipart path; one-shot uploads stay bounded.

The capability handshake (`ProtocolCapabilities::put_blob`) advertises `single_frame_max` so the client knows the daemon's current cap without recompiling.

### Capability advertisement

After the handshake, the daemon sends a `ProtocolCapabilities` (for `NotebookSync`) or `NotebookConnectionInfo` (for `OpenNotebook` / `CreateNotebook`) struct. Both flatten `ProtocolCapabilities`. The fields that matter for the wire layer:

- `protocol: "v4"` — string for backward-compatible string matching.
- `protocol_version: 4` — numeric for explicit comparison.
- `daemon_version` — e.g. `"2.0.0+abc123"`, useful for crash reports.
- `put_blob.single_frame_max` — defaults to `frame_size_limits(PUT_BLOB).cap`. A future daemon could narrow this without breaking older clients.
- `put_blob.multipart` — whether `Part` headers are supported. Always `true` today.
- `put_blob.ephemeral_supported` — whether `durability = "ephemeral"` is honored. Always `true` today.
- `actor_label` / `connection_scope` — populated from the identity layer (see Decision 3 of the identity ADR).

## Decision 7: Handshake variants pick the channel, not the framing

The first frame after the preamble is a JSON `Handshake`, length-prefixed but **without** the type byte (it predates typed framing). The daemon dispatches on the `channel` field:

| Variant | Channel | Frame layer afterwards |
|---------|---------|------------------------|
| `Pool` | Pool IPC | Untyped JSON request/response |
| `SettingsSync` | Global settings doc | Untyped binary Automerge sync |
| `NotebookSync` | Per-notebook room | Typed frames (0x00 through 0x08) |
| `OpenNotebook` | Per-notebook room from file path | Typed frames |
| `CreateNotebook` | New untitled room | Typed frames |
| `RuntimeAgent` | Kernel sidecar attached to a room | Typed frames, different request/response payloads |

For typed-frame channels, after the handshake the daemon writes a `ProtocolCapabilities` JSON frame (or `NotebookConnectionInfo` for `OpenNotebook`/`CreateNotebook`) **using the untyped framing** — this is still pre-typed-frame setup. Once that response is read, both sides switch to typed framing for the rest of the connection's life.

This split (typed framing only kicks in after capability negotiation) is the reason the handshake JSON itself does not carry a type byte. Conventionally, a client waits for the capability response before sending typed frames, but the server does not enforce this: the post-handshake frame loop starts immediately after `ProtocolCapabilities` is written (`crates/runtimed/src/notebook_sync_server/peer_connection.rs:241`, `peer_loop.rs:161`), so a client that sends typed frames early will have them processed without rejection. The capability response is informational, not gating.

## Decision 8: Session control is daemon-originated readiness, not a request channel

`SessionControl` (0x07) carries `SessionControlMessage::SyncStatus`, a snapshot of three connection-bootstrap phases:

```
{
  "type": "sync_status",
  "notebook_doc": "pending" | "syncing" | "interactive",
  "runtime_state": "pending" | "syncing" | "ready",
  "initial_load": { "phase": "not_needed" | "streaming" | "ready" | { "phase": "failed", "reason": "..." } }
}
```

The daemon emits one of these whenever a phase advances, gated on `client_protocol_version >= 3` (`crates/runtimed/src/notebook_sync_server/peer_loop.rs:66, :79, :101`). The frontend reads them to know when the doc is interactive, when runtime state is ready, and when (for file-backed notebooks) the initial load streamed into the room has finished.

The `>= 3` gate is intentional: clients that pre-date v4 still get the readiness signal because v3 added it. v4 did not change the schema. v4 raised `MIN_PROTOCOL_VERSION` to 4 for everything except `Pool` and `SettingsSync`, so in practice only those two channels see v3 clients today, and neither advances `SessionControl`. But the conditional is still in the code, and a future relaxation of `MIN_PROTOCOL_VERSION` would re-expose it.

`SessionControl` is intentionally **not** a request/response channel:

- The client never originates a `SessionControl` frame. The peer loop drops one with a warning.
- It is not used for revocation today. The identity ADR (`docs/architecture/identity-and-trust.md` open question 4) explicitly flags `SESSION_CONTROL` as the future delivery channel for server-initiated connection close.

Reserving the type byte for daemon-originated state means the channel can grow new server-pushed signals (e.g., revocation, plan downgrade, room eviction) without inventing another frame type or repurposing broadcasts.

## Decision 9: Request/response correlate by id, not by frame order

Both `Request` (0x01) and `Response` (0x02) carry a JSON envelope with a correlation id:

```jsonc
// NotebookRequestEnvelope, flattened:
{ "id": "req-7", "action": "execute_cell", "cell_id": "abc" }

// NotebookResponseEnvelope, flattened:
{ "id": "req-7", "result": "cell_queued" }
```

The client tracks pending requests by id and routes incoming `Response` frames by id, because `AutomergeSync`, `RuntimeStateSync`, `Broadcast`, `Presence`, and `SessionControl` frames all interleave freely between request send and response receipt. Frame order across types is **not** an invariant the client can rely on.

The same envelope shape covers the runtime-agent subprotocol (`RuntimeAgentRequestEnvelope` / `RuntimeAgentResponseEnvelope`); the difference is purely in the inner JSON action/result discriminant. The type bytes are identical.

`PutBlob` (0x08) also correlates with `Response` frames using the same id mechanism, even though `PutBlob` is a different type byte. The relay's `sendTypedRequest(frameType, payload, id, timeoutMs)` is the generic path; `sendRequest` is the JSON-request wrapper, and the blob-upload code uses `sendTypedRequest` directly.

## Decision 10: Back-pressure is bounded by the reader actor, not the wire

There is no flow-control field on the wire. No window, no credits, no rate limit. Back-pressure is structural:

1. The receiving side reads through `FramedReader`, a bounded mpsc channel (capacity 16 in the daemon peer loop). When the consumer falls behind, the reader task blocks on `tx.send()` and stops reading from the socket. TCP/Unix-socket flow control then propagates to the sender, which blocks on its own `write_all`.
2. The peer writer (`peer_writer.rs`) is a single ordered actor task that owns the write half. Other room tasks queue frames through a bounded mpsc (`PEER_OUTBOUND_QUEUE_CAPACITY = 1024`, `crates/runtimed/src/notebook_sync_server/peer_writer.rs:14`); if the writer falls behind, the queue fills and producers block on `tx.send()`. The peer-loop rule "register waiters/pending requests instead of blocking inside command paths" exists because a blocking `recv()` inside a command handler would back up the writer's queue and deadlock the room.
3. The 100 MiB outer ceiling on a single frame bounds the worst-case allocation; per-type caps bound it per channel.

The frame-level cap-and-warn pattern is the closest the protocol gets to flow control, and it is a hard reject, not a rate limit. A misbehaving peer that floods small frames will fill the bounded mpsc, then the OS socket buffer, then block. The only escape valve is the idle-peer timeout in the daemon's peer loop, which disconnects peers that stop sending inbound frames for a configured interval (the daemon's `idle_peer_timeout`).

## Decision 11: One bag of bytes, three+ language ports

Wire compatibility is enforced by:

- `crates/notebook-wire/src/lib.rs` for Rust frame constants and limits.
- `packages/runtimed/src/transport.ts` for TypeScript constants and limits (hand-mirrored, no codegen).
- `packages/runtimed/src/protocol-contract.ts` for TS discriminant lists, checked against the Rust source of truth.
- `crates/notebook-protocol/src/protocol.rs::typescript_protocol_contract_matches_rust_wire_discriminants` (`:1512`) compares the TS discriminant lists against the Rust enums.
- `crates/notebook-protocol/src/connection.rs::frame_size_limits_cover_every_known_frame_type` (`:530`) asserts every Rust per-type cap is tighter than the 100 MiB outer ceiling and that warn < cap.

The contract tests compare enum variant lists and frame-type byte values, not the full per-type size table. Per-type caps and warns are copied by hand into `frameSizeLimits` and are not asserted against the Rust table by CI.

The Python client (`crates/runtimed-py`) uses the Rust framing directly through `crates/notebook-sync` and `crates/notebook-protocol`, so it inherits any Rust-side change automatically. The bare WebSocket transport that hosted rooms will eventually ship is not implemented yet; when it lands it has to choose between calling the same Rust framing through WASM or reimplementing the byte layout in TS.

## Worked examples

### Frontend → daemon: execute a cell

1. Frontend calls `host.transport.sendRequest({ type: "execute_cell", cell_id: "abc" })`.
2. `TauriTransport` encodes a `NotebookRequestEnvelope` with id `"req-7"`, JSON-serializes it, prefixes type byte `0x01`, length-prefixes the whole thing.
3. Tauri pipes the bytes to the daemon socket.
4. Daemon peer loop reads the frame, sees `NotebookFrameType::Request`, hands the payload to the request worker.
5. Request worker enqueues a `CellQueued` response with id `"req-7"`.
6. Peer writer serializes the response envelope, prefixes type byte `0x02`, length-prefixes, writes.
7. Relay pipes the frame outbound to the frontend; the frame bus dispatches by type; the transport response tap resolves the pending promise.

Between steps 3 and 6, the daemon may interleave `AutomergeSync` frames (for cells modified during execution), `RuntimeStateSync` frames (kernel busy → outputs → kernel idle), `Broadcast` frames (custom comm messages), and `SessionControl` frames (if a phase advances). The frontend routes them by type byte and correlates the `Response` by id.

### Daemon → frontend: kernel emits stdout

1. Kernel produces stdout via Jupyter IOPub.
2. Daemon writes a stream-output manifest into `RuntimeStateDoc`.
3. Daemon generates an Automerge sync message for `RuntimeStateDoc`, prefixes type byte `0x05`, length-prefixes, writes.
4. Relay pipes the frame outbound to the frontend.
5. Frontend WASM receives the bytes, demuxes the type byte, calls `handle.receive_frame(0x05, ...)`.
6. WASM applies the sync to its local `RuntimeStateDoc` replica.
7. `useRuntimeState()` re-renders the output cell.

The output stream is on `0x05`, not `0x03`. State-carrying broadcasts (`CommSync`, kernel state, output, env sync) were deliberately removed in favor of CRDT sync because broadcasts suffered from silent drops, no initial state for late joiners, and ordering races. `Broadcast` (0x03) is now reserved for ephemeral non-state events (`Comm` custom messages, `EnvProgress` snapshots).

### Frontend → daemon: upload a 5 MiB widget asset

1. Frontend calls `transport.sendTypedRequest(FrameType.PUT_BLOB, framePayload, "blob-3", 30000)`.
2. `framePayload` is built by `PutBlobHeader::Put { id: "blob-3", media_type, size, sha256 }`.encode_frame(body), which produces `u32 header_len | JSON header | 5 MiB bytes`.
3. Frame goes out as `length | 0x08 | <payload>`. Length is `1 + 4 + header_json.len() + 5*1024*1024`. The 32 MiB `PutBlob` cap easily accommodates it.
4. Daemon peer loop sees `NotebookFrameType::PutBlob`, hands the payload to the put-blob worker.
5. Worker calls `PutBlobHeader::try_parse(&payload)`, gets back `(Header::Put { ... }, &body_slice)`, hashes the body, verifies the SHA-256 matches the header, writes to the blob store.
6. Worker queues a `Response` frame with id `"blob-3"` carrying `PutBlobResult { blob, size, media_type }`.

If the same upload were 40 MiB, step 3 would fail outbound with `"outbound frame too large"` at the client because 40 MiB exceeds the 32 MiB cap. The client falls back to multipart (`PutBlobHeader::Part { upload_id, part_number, ... }` per chunk).

### Daemon → frontend: connection bootstrap readiness

1. Handshake completes; daemon sends `NotebookConnectionInfo` JSON frame (untyped, this is still pre-typed-frame setup).
2. Daemon enters `run_sync_loop_v2`. If `client_protocol_version >= 3`, it queues an initial `SessionControl::SyncStatus { pending, pending, ... }`.
3. As the daemon sends the initial `NotebookDoc` sync (frame `0x00`), it advances the `notebook_doc` phase to `syncing` and queues another `SessionControl` (`0x07`).
4. As the daemon sends the initial `RuntimeStateDoc` sync (frame `0x05`), it advances `runtime_state` to `syncing` and queues another `SessionControl`.
5. If the notebook needs a file load, the daemon streams the load and sets `initial_load` to `streaming` then `ready` (or `failed`); each transition queues another `SessionControl`.
6. Frontend reads each `SessionControl` and updates `useRuntimeState()` so the UI can stop showing a loading spinner.

The phase fields are deliberately ordered so a later snapshot never represents less progress than an earlier one (modulo the `failed` terminal). Clients can treat them as monotonic per-connection.

## Open questions

1. ~~**TS-Rust size-limit drift.**~~ **Resolved** by punchlist WP-3. New Rust contract test `frame_size_limits_match_typescript` parses the TS table and compares cap+warn per type against `notebook_wire::frame_size_limits`. Any Rust cap change that forgets the TS side now fails CI. The deeper fix is WP-12: expose the table through `runtimed-wasm` (or ts-rs codegen) so the mirror — and the contract test — disappear entirely.

2. **AGENTS.md drift on `Handshake::Blob`.** `crates/notebook-wire/AGENTS.md` lists a `Blob` handshake variant for "Store blobs and query the localhost blob HTTP port." No such variant exists in `crates/notebook-protocol/src/connection/handshake.rs`. Blob uploads ride the `NotebookSync` channel as `0x08` frames; blob downloads go over the daemon's HTTP server (`GET /blob/{hash}`). The AGENTS.md row is stale.

3. ~~**Presence size cap is duplicated.**~~ **Resolved** by punchlist WP-2: the wire-layer cap was reduced from 1 MiB to 4 KiB to match `notebook-doc::presence::MAX_PRESENCE_FRAME_SIZE`. Two layers still hold the constant but the values agree, and the WP-3 contract test (next stack PR) prevents drift.

4. **`Request` cap of 16 MiB feels high.** It exists because `SendComm` envelopes carry widget buffers that JSON-expand ~4x from binary. A 4 MiB widget buffer becomes ~16 MiB on the wire. Moving widget buffers off the `Request` channel and onto `PutBlob` (with comm IDs that reference the resulting blob hash) would let `Request` drop to ~1 MiB. Tracked as a follow-up.

5. **`Response` cap of 64 MiB is the largest single allocation in the protocol.** `DocBytes`, `HistoryResult`, and large completion replies live here. If a runaway response triggers the cap, the connection drops and the room re-syncs from scratch. There is no streaming path for large responses today; everything is one frame. A future improvement would be a streaming response framing (multiple `Response` frames with the same id, terminated by an end marker).

6. **Forward-compat is daemon-to-client only.** A v5 daemon can send a v4 client an unknown frame type and the v4 client will skip it. The opposite direction is closed by the preamble check. If we ever want client-side frame extensions (e.g., a future browser client that emits a new frame type the daemon doesn't recognize), we need a separate capability-negotiation step or a relaxed preamble policy. Not v4.

7. **Untyped framing for handshake and capability response is load-bearing legacy.** Pool, SettingsSync, the handshake JSON, and the post-handshake capability JSON all use the untyped framing. Migrating them to typed frames would require a v5 protocol bump. Worth doing as part of a future hosted-room WebSocket transport, where the URL path can carry the channel and the framing can be consistent.

8. **Idle-peer timeout is the only liveness check.** There is no application-layer heartbeat on typed-frame connections. Presence has heartbeats (`PresenceMessage::Heartbeat`) but those are room-level, not connection-level. A peer that stops sending Presence but keeps sending Automerge sync will not be detected as orphaned. Worth considering an explicit `SessionControl::Ping` for v5.

9. **No wire-level signature or MAC.** The identity ADR mandates server-side per-frame actor validation against `AuthenticatedConnection.principal`, but the bytes themselves carry no cryptographic binding. A trusted intermediary (Tauri relay) could rewrite an outbound frame's payload before forwarding. v1 inherits the same-UID trust model from the Unix socket; hosted rooms will inherit the TLS trust model from the WebSocket. Change-level signed authorship (Keyhive direction) is the eventual fix.

10. **Runtime-agent reuses Request/Response type bytes.** `0x01`/`0x02` carry either `NotebookRequestEnvelope`/`NotebookResponseEnvelope` or `RuntimeAgentRequestEnvelope`/`RuntimeAgentResponseEnvelope` depending on which connection it is. There is no way to tell them apart from the type byte alone; the handshake variant determines the payload shape. A misrouted frame (e.g., a buggy proxy that crosses the streams) would deserialize incorrectly. Worth either a distinct type-byte block for runtime-agent traffic or an explicit `kind` field in the envelope.
