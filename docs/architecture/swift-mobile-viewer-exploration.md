# Swift Mobile Viewer Exploration

## Status

Exploratory. This document is research thinking, not an implementation plan. It
maps what a SwiftUI iOS notebook viewer would need from our daemon, identifies
where our wire protocol diverges from upstream `automerge-repo`, and proposes
where convergence is worth the cost.

Sibling reading: PR #2657 (`docs/architecture/web-sync-engine-architecture.md`
on branch `quod/web-sync-engine-architecture`), which lays the manifest and
compatibility gate this client would consume. That PR is itself exploratory
and not yet merged, so the file may not exist on the branch you check out
this doc from. References below assume the manifest shape PR #2657 proposes.

## Context

The current nteract desktop frontend connects to `runtimed` over a Unix socket
using a v4 typed-frame wire protocol. The daemon manages two Automerge documents
per notebook room (`NotebookDoc`, `RuntimeStateDoc`) plus a global `PoolDoc`,
and carries a much richer message set than `automerge-repo`: kernel control,
output blobs, environment progress, presence, session-control phases, and a
PUT_BLOB upload path.

Mobile is a forcing function. A SwiftUI iOS app cannot use the Unix socket,
cannot rely on OS-level same-UID trust, and cannot afford a wire protocol that
only one ecosystem (our desktop + browser relay) speaks. If we want a Swift
viewer to exist without becoming a dialect-only client, we need an answer to
three questions:

1. What sync surface does Swift consume?
2. How close should that surface be to `automerge-repo`'s?
3. How does authn/authz work when the OS socket trust boundary disappears?

This document answers (1) and (2) and frames (3) for follow-up.

## Reference Surface

### automerge-swift

The local clone at `~/code/src/github.com/automerge/automerge-swift` is a thin
UniFFI wrapper around Rust Automerge 0.7.2. It exposes:

- `Document` (final class, `@unchecked Sendable`, conforms to `ObservableObject`
  with `objectDidChange` and `objectWillChange` Combine publishers).
- Map/list/text/scalar CRUD via `put`, `get`, `putObject`, `insert`, `splice`,
  `mark`.
- `AutomergeEncoder` / `AutomergeDecoder` with `SchemaStrategy.createWhenNeeded`
  and `.readOnly`.
- Raw sync primitives `generateSyncMessage(state:)` and `receiveSyncMessage(state:message:)`
  plus a `WithPatches` variant.
- `AutomergeText` for collaborative text.
- No `Repo`, no network adapters, no storage adapters, no WebSocket layer. The
  README points at `automerge-repo-swift` for that.

The canonical SwiftUI sample is `automerge/meetingnotes`. It exercises
`automerge-swift` + `automerge-repo-swift` end to end and is the closest thing
to a production-shaped reference app.

### automerge-repo wire protocol

Read from the local clone at `~/code/src/github.com/automerge/automerge-repo`.

Transport: WebSocket with `binaryType = "arraybuffer"`. Each WebSocket binary
frame carries exactly one CBOR-encoded message. No length prefix inside the
frame.

Message types (discriminated union on `type`):

| Type | Origin | Payload |
|------|--------|---------|
| `join` | WebSocket adapter | `senderId`, `peerMetadata`, `supportedProtocolVersions` |
| `peer` | WebSocket adapter | `senderId`, `targetId`, `peerMetadata`, `selectedProtocolVersion` |
| `error` | WebSocket adapter | `senderId`, `targetId`, `message` |
| `sync` | Core repo | `senderId`, `targetId`, `documentId`, `data: Uint8Array` |
| `request` | Core repo | `senderId`, `targetId`, `documentId`, `data: Uint8Array` |
| `doc-unavailable` | Core repo | `senderId`, `targetId`, `documentId` |
| `ephemeral` | Core repo | `senderId`, `targetId`, `documentId`, `sessionId`, `count`, `data: Uint8Array` |
| `remote-subscription-change` | Core repo | `senderId`, `targetId`, optional `add: StorageId[]`, optional `remove: StorageId[]` |
| `remote-heads-changed` | Core repo | `senderId`, `targetId`, `documentId`, `newHeads: { [storageId]: { heads, timestamp } }` |

There is no `leave` message; lifecycle is `join` → `peer` (or `error`) →
disconnect. `peerMetadata` carries `{ storageId?, isEphemeral? }` and is fully
embedder-controlled; nothing in the protocol carries auth.

ID encodings:

- `PeerId`: opaque string, branded type. Ephemeral per process.
- `DocumentId`: base58check-encoded UUID.
- `StorageId`: opaque string, persistent across processes that share storage.
- `SessionId`: random string per peer startup.

Protocol version: currently `"1"`. Negotiated in the handshake. Keepalive on
the server side is a 5-second ping/pong.

### nteract notebook wire protocol

Two transports today, with different framing because each has a different
message-boundary model. A Swift client targeting WebSocket implements the
WebSocket form; it does not need the Unix-socket form.

**Unix socket** (`crates/notebook-protocol/src/connection/framing.rs`).
Preamble: 5 bytes (`0xC0DE01AC` magic + 1 protocol version byte). After the
preamble, each frame is:

```
┌──────────────────┬────────────────┬─────────────────────┐
│ u32 big-endian   │ u8 type byte   │ payload             │
│ length (incl.    │                │ (length - 1 bytes)  │
│  type byte)      │                │                     │
└──────────────────┴────────────────┴─────────────────────┘
```

The length includes the type byte, so the body is `length - 1` bytes. Receivers
read length first, then type, then apply a per-type cap before allocating the
body (`recv_typed_frame`). This means a corrupted length on a narrow channel
(e.g. a 1.8 GB length aimed at the Request channel) is rejected before the
allocator honors it.

**WebSocket relay** (`apps/notebook/vite-plugin-browser-relay.ts` server side,
`packages/notebook-host/src/browser/index.ts` client side). Each WebSocket
binary message is one frame, shape:

```
┌────────────────┬─────────────────────┐
│ u8 type byte   │ payload             │
└────────────────┴─────────────────────┘
```

No length prefix. The WebSocket frame boundary is the length. The relay
unwraps daemon length-prefixed frames before forwarding to the browser, and
re-wraps inbound WebSocket messages with a length prefix before writing to
the Unix socket. There is no preamble in the WebSocket transport; the relay
performs the handshake on behalf of the client over the socket.

A Swift client connecting to a future `/automerge-repo/v1`-style WebSocket
endpoint would follow the WebSocket form, not the Unix-socket form.

Per-type body caps (`crates/notebook-wire/src/lib.rs` `frame_size_limits`):

| Type | Cap |
|------|-----|
| `0x00 AutomergeSync` | 64 MiB |
| `0x05 RuntimeStateSync` | 64 MiB |
| `0x02 Response` | 64 MiB |
| `0x08 PutBlob` | 32 MiB |
| `0x01 Request` | 16 MiB |
| `0x03 Broadcast` | 16 MiB |
| `0x04 Presence` | 1 MiB |
| `0x06 PoolStateSync` | 1 MiB |
| `0x07 SessionControl` | 1 MiB |

The outer ceiling for any frame is 100 MiB (`MAX_FRAME_SIZE`), applied before
the type byte is even read.

Frame types (`crates/notebook-wire/src/lib.rs`):

| Type | Direction | Payload |
|------|-----------|---------|
| `0x00 NotebookDoc sync` | Bidirectional | Raw Automerge sync bytes for `NotebookDoc` |
| `0x01 Request` | Client → Daemon | JSON-RPC `NotebookRequest` with correlation ID |
| `0x02 Response` | Daemon → Client | JSON-RPC `NotebookResponse` |
| `0x03 Broadcast` | Daemon → Client | JSON `NotebookBroadcast` (comm events, env progress) |
| `0x04 Presence` | Bidirectional | CBOR `notebook_doc::presence` (cursors, selections) |
| `0x05 RuntimeStateDoc sync` | Bidirectional | Raw Automerge sync bytes for `RuntimeStateDoc` |
| `0x06 PoolDoc sync` | Bidirectional | Raw Automerge sync bytes for `PoolDoc` |
| `0x07 SessionControl` | Daemon → Client | JSON session sync phases |
| `0x08 PutBlob` | Client → Daemon | `u32 header_len | JSON header | bytes` |

Connection model: one connection = one notebook room. The `NotebookDoc` and
`RuntimeStateDoc` for that notebook share the connection by frame type, not by
document ID. There is no per-frame document identifier inside the sync frames.

Document discovery: `runt ps` lists open notebooks via
`Request::ListRooms` / `Response::RoomsList`
(`crates/runtimed-client/src/protocol.rs`). This is a separate Pool IPC
channel, not the websocket relay or the per-notebook socket connection.
`RoomInfo` carries `notebook_id`, `active_peers`, `had_peers`, `has_kernel`,
`kernel_type`, `env_source`, `kernel_status`, `ephemeral`, `notebook_path`,
and `state`. The shape is one-shot RPC, not a subscription.

Auth: none at the connection level today. Trust is OS-level same-UID socket
file permissions (`0600` socket, `0700` directory). The
`needs_trust_approval`/`ApproveTrust` flow is a kernel-dependency policy, not
connection auth.

## Where We Diverge from automerge-repo, and Why

### Sync payload bytes

We are already aligned. The bytes inside `0x00 NotebookDoc sync`,
`0x05 RuntimeStateDoc sync`, and `0x06 PoolDoc sync` are exactly what
`Automerge::generateSyncMessage` produces in Rust, and exactly what an
`automerge-repo` `sync` message would carry in its `data` field. A
`automerge-swift` consumer can feed those bytes to `receiveSyncMessage`
without further unwrapping. This is the most important convergence and we get
it for free.

### Frame envelope

We diverge. automerge-repo packs each message into one CBOR object per
WebSocket binary frame and tags the message kind with a string `type`. We use
a length-prefixed binary stream with a single-byte `frame_type` discriminator,
because we run over Unix socket as well as WebSocket and we want the same
codec on both.

The cost of staying diverged: a Swift client cannot reuse off-the-shelf
`automerge-repo-swift` `WebSocketClientAdapter`. It has to implement our
framing. The implementation is small (the spec is one page) but it is one
more thing.

The cost of converging: we would have to teach the Unix socket transport to
carry CBOR messages instead of length-prefixed typed frames, or we would have
to maintain two codecs. The Unix socket is also our hot path; switching it for
the sake of remote clients is not obviously worth it.

The middle path is the most interesting (see "Recommendation" below).

### Document multiplexing

We diverge. automerge-repo carries N documents per connection, addressed by
`documentId` in each sync message. We carry exactly two (notebook + runtime
state) plus an optional pool sync, addressed by frame type. Connection lifecycle
is bound to a single notebook room.

This is load-bearing. The notebook and its runtime state are a unit: opening
one without the other has no meaningful semantics in our domain, and the
daemon's room registry is keyed by notebook UUID. Forcing automerge-repo-style
N-doc multiplexing on one connection would not produce a useful client.

### Document discovery

We have it, just on a different surface. `runt ps` → `Request::ListRooms` is
the equivalent of automerge-repo's "tell me what documents exist," except it
runs on the Pool IPC channel (`crates/runtimed-client/src/client.rs`) and is
not exposed through the WebSocket relay. A Swift client cannot call it today.

Closing this gap is a small, additive change: expose `ListRooms` (or a
sanitized subset) over the relay. It does not require a protocol version bump
if we put it behind a `ProtocolCapabilities` flag.

### Non-document messages

automerge-repo has `ephemeral` for transient gossip and that is the full set.
We have `Request` / `Response` / `Broadcast` / `SessionControl` / `PutBlob` /
`Presence`. These are mostly kernel-control concerns that automerge-repo has
no notion of, and we should not pretend they fit into `ephemeral`.

Our `Presence` frame is the closest match to `ephemeral`, but it does not map
1:1. The daemon decodes the CBOR in `peer_presence::handle_presence_frame`
(`crates/runtimed/src/notebook_sync_server/peer_presence.rs`), maintains a
shared `PresenceState`, rejects client-published `KernelState` channel
updates, synthesizes initial snapshots for new peers, emits `Left` events on
disconnect, and prunes stale peers by TTL. `automerge-repo`'s `ephemeral` is
pure peer-to-peer relay with no server interpretation, and the daemon would
have to keep doing the validation and state synthesis even if the wire shape
were borrowed.

In practice that means presence on the read-only `automerge-repo` endpoint
either: (a) ships without the snapshot/left/prune semantics and Swift clients
get a degraded view, or (b) keeps a daemon adapter that reads/validates
inbound `ephemeral` payloads as if they were `Presence` frames. Option (b) is
the right answer once we want write-side presence; option (a) is fine for a
read-only viewer that only needs to see other peers' cursors.

### Auth

Both protocols punt. automerge-repo's `peerMetadata` is embedder-controlled
and carries no token. Our wire is "trust the socket." Mobile breaks both.

This is the divergence we have to design through, not around (see "Auth" below).

### Schema and versioning

automerge-repo has none. Documents merge or they don't. nteract has a
`PROTOCOL_VERSION`, a `SCHEMA_VERSION`, frozen genesis artifacts, and (per
PR #2657's `web-sync-engine-architecture.md`) a planned manifest with content-addressed
engine packages. This is strictly more disciplined than automerge-repo and we
should keep it. A Swift client benefits from a manifest as much as a WASM
engine does, for the same reason: it can refuse to connect when its baked-in
schema understanding cannot interpret the daemon's documents.

## Recommendation: An automerge-repo-Compatible Read-Only Sync Endpoint

Stay on the typed-frame wire for the desktop and browser relay. Add a second,
narrower endpoint that speaks automerge-repo's wire format for read-only
notebook sync.

```text
Daemon
 ├─ Unix socket / WebSocket relay   (typed-frame v4, full surface)
 │
 └─ /automerge-repo/v1 WebSocket    (automerge-repo wire, read-only)
       ↑
       Swift app, future web embeds, third-party tools
```

The automerge-repo endpoint:

- Serves one `DocumentId` per notebook (and optionally a second `DocumentId`
  per `RuntimeStateDoc`).
- Speaks `join` / `peer` / `request` / `sync` / `doc-unavailable` only.
- Refuses mutations: any inbound `sync` carrying changes from the peer is
  acknowledged but not merged into the daemon's document.
- Carries a daemon-issued bearer token in the WebSocket URL or
  `Authorization` header, validated before upgrade. Maps to a capability
  (e.g., "read NotebookDoc N").
- Exposes a manifest at `GET /automerge-repo/v1/manifest.json` mirroring the
  fields defined in PR #2657's `web-sync-engine-architecture.md`: protocol version,
  document schema versions, genesis hashes, capability summary.

Why this works:

- Stock `automerge-repo-swift` clients connect with no nteract-specific code.
- We can offer the same endpoint to a future web embed, a Python client, a
  Hugo blog plugin, anything `automerge-repo`-speaking.
- The desktop wire stays unchanged. PUT_BLOB and kernel control stay on the
  authenticated rich path.
- Auth has a clear front door: the bearer token gates the WebSocket upgrade.

Why not just adopt automerge-repo wire everywhere:

- The Unix socket transport benefits from length-prefixed framing because it
  is a byte stream, not a message stream. CBOR-per-message would need an
  inner length prefix anyway and we would have re-invented our current
  framing inside CBOR.
- The desktop frontend already has the typed-frame codec wired in nine
  places (per PR #2657's `web-sync-engine-architecture.md` Phase 2). Migrating those
  call sites is a real cost with no user-visible payoff.

## Auth

The desktop's auth model does not survive contact with mobile. A Swift app
running on a phone connecting to a daemon on a laptop (or, eventually, a
hosted runtime) needs four things our current wire does not provide:

- **Pre-upgrade authentication.** A bearer token or signed handshake that
  the daemon validates before the WebSocket upgrades. URL-based tokens are
  fine for localhost/Tailscale dev; production needs `Authorization`
  headers.
- **Capability scoping.** The Swift viewer should hold a read-only,
  notebook-scoped capability. It should not be able to launch kernels,
  approve trust, or write blobs.
- **Token rotation.** A persistent token from a paired-device flow with the
  ability to revoke from the desktop. Phones get lost.
- **Identity.** Who is this device, who is the user, what notebooks can they
  see? Today there is no answer because there is no remote case.

For exploration, treat localhost-only as Phase 0 and put the auth design on
the critical path of any phase beyond it. This is the right time to think
about it because the desktop has not yet committed to any model.

## Swift Implementation Phases

### Phase 0: Static viewer

No automerge-swift, no live sync. Daemon exposes a read-only HTTP endpoint:

- `GET /notebook/{id}/snapshot.json` → current ipynb-equivalent JSON
- Output blobs by content hash

The existing blob server (`crates/runtimed/src/blob_server.rs`) binds to
`127.0.0.1` and is documented as unauthenticated localhost HTTP. That's fine
for the iOS Simulator and a same-host dev workflow but unreachable from a
physical device. Phase 0 therefore splits in two:

- **Same-host (Simulator / dev)**: reuse the existing `/blob/{hash}` route
  directly. No new daemon surface required for blobs. Snapshot endpoint is
  the only addition.
- **Off-host (real device, blog embed, hosted runtime)**: add an
  authenticated, externally-bindable blob proxy alongside the snapshot
  endpoint. Bearer-token gated, same auth front door the `/automerge-repo/v1`
  endpoint will use. Reverse-proxy to the underlying `127.0.0.1` blob server
  rather than re-implementing storage. Keeps the existing loopback boundary
  intact for the desktop path.

Swift app renders cells from JSON. Refresh on pull. The same snapshot
endpoint can power blog embeds, link previews, anything that wants a
notebook snapshot without running a CRDT.

This unblocks UI work (cell rendering, mobile layout) before any wire
decisions are committed. The split also forces the auth question early: the
moment a physical phone enters the picture, blob URLs need a story.

### Phase 1: Live read-only via automerge-repo endpoint

Swift app uses `automerge-swift` and `automerge-repo-swift`. Points at the
new `/automerge-repo/v1` endpoint. Subscribes to the notebook's
`DocumentId`. Renders from the projected typed view (see "Typed projection"
below). No RuntimeStateDoc, no presence, no mutations.

Manifest gate runs first: if the Swift app's compiled-in schema constants
don't match the daemon, fail with a typed error before any sync frames.

### Phase 2: Runtime state and presence

Subscribe to a second `DocumentId` for `RuntimeStateDoc`. Render cell
execution status, queue position, outputs. Optionally emit presence via
`ephemeral` (our cursor CBOR fits directly into `ephemeral.data`).

Still no mutations. Auth is still read-only-capability bearer.

### Phase 3: Interactive

Cell edits, comments, eventually `ExecuteCell`. Requires upgrading from the
automerge-repo read-only endpoint to the full typed-frame protocol, because
kernel control lives there. At this point the Swift app is a full client and
needs the same wire codec as the desktop.

Phases 1 and 2 are months. Phase 3 is quarters.

## Swift Package Shape

Three SPM products, smallest first:

```text
NteractWire       // typed-frame codec, preamble, version constants,
                  // schema-version constants. Pure protocol, no Automerge.
   ↓
NteractClient     // WebSocket transport (typed-frame and automerge-repo),
                  // connection actor, NotebookDocument wrapper around
                  // automerge-swift.Document, manifest gate.
   ↓
NteractUI         // SwiftUI cell and output views. Optional, opinionated.
```

`NteractWire` should be generated from the same Rust source as the existing
`ts-rs` bindings. Schema drift between Swift and Rust then surfaces at Swift
build time, not at runtime when a manifest gate rejects the client. Options
for the generator: `typeshare` (Mozilla, multi-language), `swift-bridge`,
or a custom build script with `serde_reflection`. `typeshare` is the path
of least resistance.

## Swift Patterns That Matter

### Connection as actor

```swift
public actor NotebookConnection {
    private var task: URLSessionWebSocketTask
    private var inbound: AsyncStream<NotebookFrame>.Continuation?
    private var pendingResponses: [CorrelationId: CheckedContinuation<NotebookResponse, Error>] = [:]

    public func send(_ request: NotebookRequest) async throws -> NotebookResponse {
        try await withCheckedThrowingContinuation { cont in
            let id = newCorrelationId()
            pendingResponses[id] = cont
            Task { try await task.send(frame(request, id: id)) }
        }
    }

    public func frames() -> AsyncStream<NotebookFrame> { /* ... */ }
}
```

Frame I/O is naturally serial, so an actor is the right primitive. Don't
build a `class NotebookConnection` with a manual lock; that fights Swift 6
strict concurrency.

### Typed projection from Automerge

```swift
struct CellView: Codable, Identifiable {
    let id: String
    let cellType: CellType
    let source: AutomergeText
    let outputs: [OutputView]
}

@MainActor
final class NotebookViewModel: ObservableObject {
    @Published private(set) var cells: [CellView] = []

    private let document: Document
    private var cancellable: AnyCancellable?

    init(document: Document) {
        self.document = document
        self.cancellable = document.objectDidChange.sink { [weak self] in
            self?.refresh()
        }
        refresh()
    }

    private func refresh() {
        let decoder = AutomergeDecoder(doc: document)
        if let notebook = try? decoder.decode(NotebookView.self) {
            cells = notebook.cells
        }
    }
}
```

SwiftUI views observe the view model, not the raw `Document`. Keeps the
Automerge lock off the main thread and keeps view updates coalesced.

### AsyncSequence for inbound frames

```swift
for await frame in connection.frames() {
    switch frame {
    case .notebookSync(let bytes):
        try await document.receive(syncBytes: bytes)
    case .runtimeStateSync(let bytes):
        try await runtimeState.receive(syncBytes: bytes)
    case .response(let id, let body):
        try await connection.resolvePending(id, with: body)
    /* ... */
    }
}
```

`URLSessionWebSocketTask`'s callback API wraps cleanly into `AsyncStream`.
Pre-engine buffering (per PR #2657's `web-sync-engine-architecture.md` Phase 3) is
trivial as a bounded `AsyncStream` with overflow policy `.dropOldest` →
typed compatibility error.

### Offline cache

`Document.save() -> Data`. Persist with `SwiftData` keyed by notebook ID.
`Document(bytes: data)` reconstitutes on launch before the network is even
available. Big UX win on mobile: notebook opens instantly, sync catches up
in the background. The frozen genesis guarantees this works even for fresh
notebooks where the daemon hasn't shipped the document yet.

## Test Matrix (Sketch)

- Stock `automerge-repo-swift` client connects to `/automerge-repo/v1` and
  receives notebook sync without nteract-specific code.
- Manifest mismatch returns a typed `schema_unsupported` before any sync
  frames cross.
- Bearer token missing or invalid: WebSocket upgrade refused with `401`.
- Read-only capability holder attempts to send `sync` with changes: daemon
  acknowledges but does not merge; or daemon refuses and disconnects with a
  typed error (choose one and document it).
- Old Swift client + new daemon (additive `RuntimeStateDoc` field): Swift
  ignores unknown path, renders defaulted fields. Mirrors the same rule the
  WASM engine follows.
- New Swift client + old daemon (Swift expects newer schema): manifest gate
  fails with `daemon_too_old`.
- Offline reopen: cached document opens with last-known cells before
  WebSocket connects.
- Pre-sync buffering: frames arriving before manifest gate completes are
  buffered in order, drained when the gate passes.

## Open Questions

1. **HTTP snapshot endpoint.** Is a Phase 0 `GET /notebook/{id}/snapshot.json`
   worth shipping in the daemon independently of the Swift work? It would
   unblock blog embeds and link previews and lets us test mobile rendering
   without the sync layer.
2. **Read-only capability shape.** What does the bearer token actually
   authorize? Per-notebook read, per-user read of all notebooks they've
   opened, per-device pairing? This is the first concrete decision in the
   auth design.
3. **Schema codegen.** Worth introducing `typeshare` (or similar) now so
   that `NteractWire` is generated, or hand-write the Swift types until
   the second cross-language client appears?
4. **Pool state.** Does the Swift app care about `PoolDoc`? Mobile probably
   doesn't show kernel pools. Phase 1 should leave it out and let the
   daemon's automerge-repo endpoint not serve it.
5. **Presence on the read-only endpoint.** If we allow Swift to emit
   `ephemeral` for cursor presence but not document mutations, the
   capability check has to distinguish ephemeral from sync. Worth
   designing now or punt to Phase 2?
6. **automerge-repo-swift adoption cost.** The package is on a separate
   release cadence from `automerge-swift`. Pinning a version means
   pinning their upgrade timeline. Evaluate before committing.
7. **Manifest signing.** PR #2657's `web-sync-engine-architecture.md` flags signed
   manifests as a "maybe" for multi-tenant scenarios. Mobile to a hosted
   daemon is a multi-tenant scenario. If we want this, decide before the
   first hosted deployment.

## Sources

- `crates/notebook-wire/src/lib.rs` (frame types, preamble, size limits)
- `crates/notebook-protocol/src/connection/handshake.rs` (capabilities, handshake)
- `crates/notebook-protocol/src/protocol.rs` (request/response/broadcast)
- `crates/runtimed-client/src/client.rs` and `protocol.rs` (`ListRooms`, `RoomInfo`)
- `crates/runtimed/src/notebook_sync_server/` (room state machine)
- `crates/runtimed/src/blob_server.rs` (existing HTTP surface, cache policy)
- `packages/notebook-host/src/browser/index.ts` (WebSocket relay)
- `~/code/src/github.com/automerge/automerge-repo/packages/automerge-repo-network-websocket/src/` (websocket adapter, message envelopes)
- `~/code/src/github.com/automerge/automerge-repo/packages/automerge-repo/src/network/messages.ts` (core message types)
- `~/code/src/github.com/automerge/automerge-swift` (Swift Automerge bindings)
- `~/code/src/github.com/automerge/meetingnotes` (referenced SwiftUI example)
- `docs/architecture/web-sync-engine-architecture.md` (manifest and compatibility gate plan)
