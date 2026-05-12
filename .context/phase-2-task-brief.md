# Phase 2 task brief — PutBlob one-shot clients

**Target branch:** fresh `feat/putblob-phase-2` off `main` when implementation
starts. This brief may be committed separately on a docs/planning branch.
**Scope:** one PR.
**Depends on:** Phase 0+1 (merged via #2739).
**Blocks:** Phase 3 (widgets), Phase 4 (attachments).

---

## Goal

Ship the caller-side `putBlob` helper in both Rust and TypeScript so a notebook peer can upload bytes to the daemon's content-addressed `BlobStore` and receive a `{ blob, size, media_type }` handle back. No user-visible behavior; this is the API surface every downstream consumer depends on.

## Out of scope

- Anything multipart (`op: "part"`, create/complete/abort). That's Phase 5.
- Widget buffer extraction, attachment ingestion. Phase 3/4.
- Runtime-agent remote upload. Phase 6.
- Deleting `Handshake::Blob::Store`. Orthogonal cleanup.
- Capability fallback behavior. Deployment assumption (app+daemon ship together) says we don't write that code.

## Ground facts (re-verified on `main`)

- Rust client handle: `RelayHandle` at `crates/notebook-sync/src/relay.rs:86-`. Public surface today: `send_request`, `send_request_with_broadcast`, `forward_frame`, `notebook_id`, `set_notebook_id`. Correlation id + pending-map live in `relay_task.rs`; `handle_send_request` at `relay_task.rs:196-235` is the only path that inserts a correlation entry.
- `RelayCommand` enum at `relay.rs:30-62` is the command surface the relay task accepts. PutBlob needs a new variant; the id should originate in `RelayHandle::put_blob_one_shot` before sending the command, matching `send_request_inner`, so a timeout can evict the pending entry cleanly.
- Relay pending map routes responses by `id` regardless of the outbound frame type. `route_incoming_frame` at `relay_task.rs:245-288` does not care whether the request that populated the id was `0x01 Request` or `0x08 PutBlob`. No refactor needed there.
- TS transport interface: `packages/runtimed/src/transport.ts` exports `FrameType` (0x00–0x08) and `NotebookTransport` (`sendFrame`, `onFrame`, `sendRequest`).
- Tauri transport: `packages/notebook-host/src/tauri/transport.ts:117-156` — `sendRequest` hardcodes `FRAME_TYPE_REQUEST = 0x01` at `:149`. Pending map + 0x02 response tap at `:53`, `:181-`. Correlation is generic; it's the outbound side that's hardcoded.
- Direct transport (test double): `packages/runtimed/src/direct-transport.ts:96-191`. It does **not** mirror Tauri's pending-map correlation today; `sendRequest` simply delegates to `requestHandler`. Phase 2 should add the minimal typed-request hook needed by `putBlob` tests without turning DirectTransport into a full Tauri response tap.

  **Interface decision:** `sendTypedRequest` is a **required** method on `NotebookTransport` — same status as `sendRequest`. DirectTransport's implementation should be the minimum viable shape: route `sendTypedRequest(FrameType.REQUEST, ...)` through the existing `requestHandler` path (so `sendRequest` keeps working), and for any other `frameType` delegate to a caller-supplied `typedRequestHandler?` that tests can stub. Do **not** add a real pending map to DirectTransport — correlation testing happens against the Tauri transport or a dedicated test double. No third option: don't make the method optional via default implementation.
- Typed header already shared on the Rust side: `PutBlobHeader::Put { id, media_type, size, sha256, purpose }` in `crates/notebook-protocol/src/protocol.rs` plus `try_parse` helper. Rust clients should use the same serde serialization. TypeScript must mirror the JSON shape explicitly and lock it with byte-level tests.

## Deliverables

### 1. Shared frame builder in `notebook-protocol`

Add a small helper next to `PutBlobHeader` so Rust callers build the wire bytes
through the inverse of the daemon parser:

```rust
// in crates/notebook-protocol/src/protocol.rs (or a new put_blob.rs module)
impl PutBlobHeader {
    pub fn encode_frame(&self, body: &[u8]) -> Vec<u8>;
}
```

Writes `u32 header_len_be | serde_json(header) | body`. Round-trips through `PutBlobHeader::try_parse`. One unit test asserting the shape.

Rationale: the daemon already uses `try_parse`. Adding `encode_frame` as its
inverse means Rust clients never assemble the envelope by hand, and serde
changes stay centralized for Rust. The TS helper still assembles bytes directly,
but its tests should parse the emitted header and compare it to the Rust wire
shape (`op`, `id`, `media_type`, `size`, `sha256`, optional `purpose`).

### 2. New `RelayCommand::SendPutBlob` + `handle_send_put_blob`

In `crates/notebook-sync/src/relay.rs`:

```rust
pub enum RelayCommand {
    // ... existing variants ...
    SendPutBlob {
        id: String,
        frame: Vec<u8>,                         // already-assembled u32|header|body
        reply: oneshot::Sender<Result<NotebookResponse, SyncError>>,
    },
}
```

In `crates/notebook-sync/src/relay_task.rs`, parallel to `handle_send_request`:

```rust
async fn handle_send_put_blob<W: AsyncWrite + Unpin>(
    writer: &mut W,
    pending: &mut HashMap<String, PendingEntry>,
    id: String,
    frame: Vec<u8>,
    reply: oneshot::Sender<Result<NotebookResponse, SyncError>>,
) { ... }
```

Must:
- Register pending entry BEFORE sending the frame (mirror the comment at `relay_task.rs:219-227`).
- Call `connection::send_typed_frame(writer, NotebookFrameType::PutBlob, &frame)`.
- On write failure, evict the pending entry and deliver `SyncError::Io(e)`.
- No `broadcast_tx`. PutBlob does not produce progress broadcasts.

Wire it into the command loop in `relay_task.rs:128-` next to the existing `SendRequest` arm.

### 3. `RelayHandle::put_blob_one_shot`

In `crates/notebook-sync/src/relay.rs`:

```rust
pub async fn put_blob_one_shot(
    &self,
    bytes: &[u8],
    media_type: &str,
) -> Result<PutBlobResult, SyncError>;
```

Where `PutBlobResult` is a dedicated struct. Prefer `{ blob, size, media_type }`
to match frontend `ContentRef` naming, while mapping from daemon
`NotebookResponse::BlobStored { hash, ... }`. Do not return a raw
`NotebookResponse`.

Implementation steps:
1. Compute SHA-256 of `bytes` via `sha2::Sha256`; hex-encode.
2. `id = Uuid::new_v4().to_string()`.
3. Build `PutBlobHeader::Put { id: id.clone(), media_type: media_type.into(), size: bytes.len() as u64, sha256, purpose: None }`. (`purpose` is reserved for Phase 4/5.)
4. `let frame = header.encode_frame(bytes);`
5. Send `RelayCommand::SendPutBlob { id: id.clone(), frame, reply }`.
6. `tokio::time::timeout(Duration::from_secs(30), recv(reply))` — use a PutBlob-specific timeout; do NOT reuse `request_timeout(&NotebookRequest)` because PutBlob doesn't have a `NotebookRequest` variant. 30s is a reasonable initial value; revisit once real uploads happen.
7. On timeout, fire-and-forget `CancelRequest { id }` same as `send_request_inner` (`relay.rs:179-183`). Evicts the pending entry.
8. Match response:
   - `NotebookResponse::BlobStored { hash, size, media_type }` → `Ok(PutBlobResult { blob: hash, size, media_type })`.
   - `NotebookResponse::BlobUploadError { reason }` → `Err(SyncError::BlobUpload(reason))`.
   - Any other response variant → `Err(SyncError::Protocol("unexpected response for PutBlob"))`. Daemon misbehavior.

Add `SyncError::BlobUpload(BlobUploadErrorKind)` to `crates/notebook-sync/src/error.rs`. Callers distinguish `too_many_in_flight` (retryable) from the others (terminal) by pattern-matching the inner kind.

### 4. Expose from `runtimed-client`

`notebook-sync` re-exports `RelayHandle` from its crate root, but
`runtimed-client` does not currently re-export `RelayHandle` directly. Verify
which downstream Rust callers actually need the upload helper. If they receive
a `RelayHandle` already, no `runtimed-client` wrapper is needed. If a
`runtimed-client` surface is the intended API, add a thin wrapper module such
as `crates/runtimed-client/src/blob_upload.rs` and re-export the result/error
types there.

### 5. TS transport refactor — split correlation from outbound

`packages/notebook-host/src/tauri/transport.ts`:

Add a public method and extract the correlation machinery. Sketch:

```ts
async sendTypedRequest(
  frameType: FrameTypeValue,
  payload: Uint8Array,
  id: string,
  timeoutMs: number,
): Promise<NotebookResponse> {
  const promise = this.awaitResponse(id, timeoutMs);
  this.sendFrame(frameType, payload).catch((err) => this.failPending(id, err));
  return promise;
}

private awaitResponse(id: string, timeoutMs: number): Promise<NotebookResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
  });
}

private failPending(id: string, err: unknown): void {
  const entry = this.pending.get(id);
  if (entry) {
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
```

Refactor `sendRequest` to:
1. Generate `id`.
2. Build the `NotebookRequest` envelope (the existing `action`/`type` translation at `:126-132` stays — don't touch the serde rename question here, that's a separate concern).
3. Delegate to `sendTypedRequest(FrameType.REQUEST, payload, id, requestTimeoutMs(req))`.

Mirror the interface change in `packages/runtimed/src/transport.ts` (add
`sendTypedRequest` to `NotebookTransport`) and in
`packages/runtimed/src/direct-transport.ts`. For `DirectTransport`, do not try
to emulate Tauri's event-tap pending map unless a test needs it. Add a
`typedRequestHandler(frameType, payload, id, timeoutMs)` hook that records the
outbound typed frame and returns a mocked response; `putBlob` unit tests can
assert the bytes through `sentFrames` and return a response through that hook.

Do NOT:
- Delete the `FRAME_TYPE_REQUEST = 0x01` local constant in the Tauri file. It's used at the one remaining call site. Cleanup is a separate PR.
- Touch the `action`/`type` serde comment. Separate PR.

### 6. TS `putBlob` helper

New file `packages/runtimed/src/blob-upload.ts`:

```ts
export interface PutBlobResult {
  blob: string;
  size: number;
  media_type: string;
}

export async function putBlob(
  transport: NotebookTransport,
  bytes: Uint8Array,
  mediaType: string,
): Promise<PutBlobResult>;
```

Steps:
1. `const sha256 = await hexHash(bytes)` — `crypto.subtle.digest("SHA-256", bytes)` + `Uint8Array` → hex.
2. `const id = crypto.randomUUID()`.
3. Build header object `{ op: "put", id, media_type: mediaType, size: bytes.byteLength, sha256 }`. Omit `purpose` for now; add it when a concrete caller owns the policy.
4. Encode header to `Uint8Array` via `TextEncoder`.
5. Assemble frame: `[u32 BE header_len, header_bytes, body_bytes]`.
6. `const response = await transport.sendTypedRequest(FrameType.PUT_BLOB, frame, id, PUT_BLOB_TIMEOUT_MS)`.
7. Match response by `result` discriminant:
   - `blob_stored` → return `{ blob: hash, size, media_type }`.
   - `blob_upload_error` → throw a typed `BlobUploadError` class whose `reason` is the `BlobUploadErrorKind`. Export this class so widget/attachment callers can distinguish `too_many_in_flight` from terminal errors.
   - Anything else → throw `Error("unexpected response for PutBlob")`.

Re-export `putBlob`, `BlobUploadError`, and the relevant result/error types
from `packages/runtimed/src/index.ts`. `BlobUploadErrorKind` already exists in
`request-types.ts`; include it in the public type exports if it is not already
exported.

### 7. Tests

Rust:
- `crates/notebook-protocol` — `put_blob_header_encode_frame_roundtrips_via_try_parse`.
- `crates/notebook-sync/src/tests.rs` or a relay-focused integration test —
  `relay_handle_put_blob_one_shot_routes_response_by_id` using the existing
  in-process socket/relay test pattern. Assert response routing by id. Same-peer
  starvation is already primarily a daemon peer-loop property covered in Phase
  1; Phase 2 should only add a relay-level concurrency test if the new
  `SendPutBlob` arm could block `SendRequest`.
- `crates/runtimed-client/tests/blob_upload.rs` (only if a `runtimed-client` wrapper is added per §4) — end-to-end against a spawned daemon, verifying the blob is retrievable via the existing read path.

TypeScript:
- `packages/runtimed/tests/blob-upload.test.ts`:
  - Frame layout: send a known body + media_type, intercept the outbound `sendFrame` call, assert byte-level shape (u32 header length, parseable JSON, body bytes match).
  - Response correlation: mock transport that resolves a stashed response with a matching `id`; assert `putBlob` returns the expected `PutBlobResult`.
  - Error propagation: mock transport resolves `blob_upload_error { reason: too_many_in_flight }`; assert `BlobUploadError` is thrown with the correct kind.
  - Hash correctness: upload a known byte sequence, assert the header carries the expected SHA-256 hex.
- `packages/runtimed/tests/transport.test.ts` — extend the existing snapshot
  test if needed and exercise `sendTypedRequest` routing with a non-`0x01`
  frame type. `PUT_BLOB` is already in the FrameType snapshot from Phase 0/1;
  this phase should guard the new typed-request behavior.

No daemon-integration TS test needed in this phase; the widget E2E in Phase 3 will cover it.

## Open decisions (ask before coding)

1. **`RelayHandle::put_blob_one_shot` vs. a new `BlobUploadHandle`.** The existing relay handle is clone-friendly and already has a pending map. Adding one more method there is fine. Flag if you think a dedicated handle is better — I don't, but worth being explicit.
2. **PutBlob timeout.** 30s initial. Could be smaller (widgets upload KB) or parameterized. Phase 3 may want to pass a per-call override; ship with a const for now and expose an override only if Phase 3 asks.
3. **`PutBlobResult` naming on the Rust side.** Prefer a fresh struct in
   `notebook-sync` or `notebook-protocol` named `PutBlobResult { blob, size,
   media_type }`. Avoid a struct named `BlobStored`; that collides conceptually
   with the daemon response variant and keeps the less useful `hash` field name
   at the caller boundary.
4. **Should `putBlob` compute SHA-256 on a worker thread?** Web Crypto is off-main-thread already. Skip this worry.

## Review checklist

When the PR lands, I will look at:

- [ ] `PutBlobHeader::encode_frame` is the only Rust place the u32|JSON|body
      layout is written. TS has one explicit builder in `blob-upload.ts`, with
      byte-level tests covering shape and hash.
- [ ] `RelayCommand::SendPutBlob` mirrors `SendRequest`'s "register pending before sending the frame" discipline. No race where a fast daemon response arrives before the pending entry lands.
- [ ] Timeout path evicts the pending entry (CancelRequest) so the map does not grow unboundedly on a slow daemon.
- [ ] `SyncError::BlobUpload(kind)` distinguishes the retryable `TooManyInFlight` from terminal errors. Callers can implement retry at the layer that owns retry policy (Phase 3 widget consumer will add that).
- [ ] `sendTypedRequest` lives in `NotebookTransport` and is implemented on both transports. `sendRequest` goes through it. No duplicated pending-map logic.
- [ ] TS `BlobUploadError` class exports the `BlobUploadErrorKind` discriminant so the TS pattern match is type-safe.
- [ ] No new unknown frame type handling anywhere. Phase 0 already covered `0x08` in every allow-list.
- [ ] Tests cover: frame shape, response correlation, `too_many_in_flight` propagation, hash correctness, and cross-request fairness on `RelayHandle`.
- [ ] `cargo xtask lint --fix` + `pnpm typecheck` + `pnpm test:run packages/runtimed` all green.

## Risks

1. **Pending-map race on fast daemons.** Mitigation: register before send. Existing pattern; copy-paste faithfully.
2. **Duplicate correlation machinery.** Mitigation: `sendTypedRequest` extraction. Avoid giving `putBlob` its own pending map.
3. **Silent schema drift between Rust and TS.** Mitigation: the `transport.test.ts` snapshot already covers `FrameType`; extend it to include the new method's behavior. Rust `encode_frame`/`try_parse` round-trip test covers the header.
4. **`too_many_in_flight` surfacing as a generic error.** Mitigation: typed error class (TS) and dedicated `SyncError` variant (Rust). Widget consumer will thank you.

## Suggested PR title

`feat(protocol): add PutBlob one-shot clients`

## Followup PRs (not this one)

- Delete duplicated `FRAME_TYPE_REQUEST`/`FRAME_TYPE_RESPONSE` constants in `tauri/transport.ts` (one-liner once `sendTypedRequest` is in).
- Resolve or delete the `action`/`type` serde rename comment in `tauri/transport.ts:122-131`.
- `Handshake::Blob::Store` deletion. Still dead code.
