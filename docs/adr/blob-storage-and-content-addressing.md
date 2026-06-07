# Blob Storage and Content Addressing in the Local Daemon

**Status:** Draft, 2026-05-22.

## Context

The desktop daemon emits rich notebook outputs (images, HTML, Arrow tables,
anywidget bundles, markdown image attachments) and per-widget comm buffers that
can range from tens of bytes to tens of megabytes. Inlining all of that into
`NotebookDoc` or `RuntimeStateDoc` would push every per-frame Automerge sync
against the wire frame caps, force the CRDT to merge binary opaque blobs as
text, and make notebook persistence O(every byte ever displayed). The other
direction, treating outputs as out-of-band per-room files keyed by room id,
loses dedup across notebooks and forces a separate "which blobs does this
notebook own" bookkeeping path.

The daemon takes a third route. Output payloads above an inline threshold and
all binary MIME data live in a content-addressed blob store under
`~/.cache/runt[-nightly]/blobs/`. Documents only carry `ContentRef`s
(`{ "inline": "..." }` or `{ "blob": "<sha256>", "size": N }`). A localhost
HTTP server serves the bytes to the renderer; a typed-frame protocol
(`PUT_BLOB`, `frame_types::0x08`) lets remote peers upload bytes to the
daemon-owned store. Snapshot publish artifacts pair `NotebookDoc` and
`RuntimeStateDoc` saves with the blobs those refs point at
(`hosted-notebook-artifacts.md` covers the cloud side).

This ADR captures the desktop-side decisions: hash algorithm, encoding, the
disk layout, the inline threshold, the durability tag, retention, and the
upload protocol.

Neighbors:

- `docs/adr/typed-frame-v4-wire-protocol.md` — the `PUT_BLOB` frame
  shape and the per-type cap.
- `docs/adr/document-split.md` — which document each blob ref
  comes from (`RuntimeStateDoc` executions / comms, `NotebookDoc` assets /
  attachments).
- `docs/adr/execution-pipeline.md` — when the daemon decides to
  blob an output vs. inline it.
- `docs/adr/hosted-notebook-artifacts.md` — how snapshot bundles and
  R2 blob storage reuse the same hash addressing.
- `docs/adr/identity-and-trust.md` — the room-level auth gate that
  blob HTTP currently leans on; how a connected peer earns the right to
  upload at all.
- `docs/adr/cleanup-punchlist.md` — open gaps in blob handling.

## Decision 1: SHA-256 hex, content-addressed, two-level shard

Blobs are addressed by the lowercase hex SHA-256 of their raw bytes. The
addressing scheme has three properties baked in:

- **Hash function: SHA-256.** Wider than blake3 deployment in the Rust crate
  ecosystem, identical to what `.ipynb` ref-mime entries already write, and
  matches the hash the hosted publish layer uses (R2 dedupes on the same key
  shape, see `hosted-notebook-artifacts.md` Decision 2). The 256-bit width is
  collision-safe for the foreseeable future and not guessable by an attacker
  scanning the localhost blob origin (see Decision 4).
- **Hex, not base64.** 64-character hex composes into filesystem paths
  without case-folding worries on macOS HFS+/APFS, makes hashes greppable in
  logs, and avoids URL-escaping concerns at the HTTP layer.
- **Two-level shard.** A blob with hash `a1b2c3...` lives at
  `<root>/a1/b2c3...` with a sibling `<root>/a1/b2c3....meta`. A flat layout
  hits ENOSPC-style directory entry limits on ext4 once a workspace builds up
  tens of thousands of cached outputs; two hex characters give 256 shards,
  which is enough headroom for a desktop workspace.

`MAX_BLOB_SIZE` is 100 MiB at the store API (`blob_store.rs:33`). The wire
layer caps a single `PUT_BLOB` frame at 32 MiB (`notebook-wire/src/lib.rs`
`frame_size_limits`) and routes anything larger through multipart upload
(Decision 5).

Validation: `BlobStore::validate_hash` rejects anything that is not exactly
64 ASCII-hex characters. Path-traversal attempts via `/blob/../secret` hit the
validator and 404 (`blob_server.rs::test_blob_path_traversal_rejected`).

## Decision 2: Atomic write, idempotent put, sidecar metadata

Each blob has two on-disk files in its shard directory:

```
<root>/a1/b2c3d4...        # raw bytes
<root>/a1/b2c3d4....meta   # JSON: { media_type, size, created_at, durability }
```

Writes are tmp-file + `rename` on the same filesystem. A `*.lock` file in the
shard directory serializes concurrent writers per hash with a 10s timeout and a
60s stale-lock window. Re-puts of identical content are no-ops on the bytes
file and may rewrite the sidecar to update `media_type` (a blob first stored
as `application/json` and later rewritten as `text/javascript` for an
anywidget `_esm` payload reads the latest media type, see
`test_same_bytes_different_media_type`).

The sidecar is a separate file rather than xattrs because xattrs are not
portable, and not embedded in the blob bytes because that would defeat
content addressing (the hash is over the raw payload, not the wrapped form).

`BlobMeta::created_at` is the daemon's `Utc::now()` at first write. It is
used by the GC sweep (Decision 6) to apply a grace period; nothing else
depends on it.

## Decision 3: Inline below 1 KiB, blob above; binary always blobbed

`DEFAULT_INLINE_THRESHOLD = 1024` (`output_store.rs:96`). Text-MIME outputs
(`text/*`, `application/json`, `image/svg+xml`, `+json` / `+xml` suffixes)
smaller than 1 KiB are written inline as `{ "inline": "..." }` directly in the
output manifest stored in `RuntimeStateDoc`. Text content equal to or larger
than the threshold is written to the blob store, and the manifest carries
`{ "blob": "<sha256>", "size": N }`. Binary MIMEs (`image/png`, `audio/*`,
`video/*`, most `application/*`) skip the threshold entirely and always go to
the blob store. Jupyter sends binary as base64 on the wire; the daemon
**decodes before storing** so the blob is the real image bytes, not the base64
form. Re-serialization back to `.ipynb` re-encodes via
`ContentRef::resolve_binary_as_base64`.

Why this split:

1. **CRDT merge cost.** Below ~1 KiB, inline text strings merge cheaply and
   the round trip cost of an HTTP fetch dwarfs the payload. Above 1 KiB,
   inlining bloats the doc and forces every joiner to download the bytes as
   part of the sync stream.
2. **Binary as bytes, not base64.** Storing PNGs as base64 inside Automerge
   text fields would 1.33x the size, defeat OS-level filesystem caching, and
   misclassify the data for HTTP serving.
3. **One classification source for output manifests.** MIME classification
   lives in `notebook_doc::mime` (`is_binary_mime`, `mime_kind`). Rust output
   paths and WASM output resolution use that source to resolve `ContentRef`s
   into one of `Inline | Url | Blob` via
   `notebook-doc::mime::ResolvedContentRef`. The hosted widget-comm bridge
   currently mirrors the same binary/text split in TypeScript when projecting
   `RuntimeStateDoc.comms`; that is a host adapter for read-only widget state,
   not a second durable output-manifest policy.

The threshold is a constant rather than a runtime-configurable knob today.
Anything load-bearing on its value (test fixtures, the comm-state externalizer
in `output_prep.rs`) reaches for `DEFAULT_INLINE_THRESHOLD` so a future tune
flips one site.

There is a **separate, parallel** threshold for comm-state externalization:
`COMM_STATE_BLOB_THRESHOLD = 1024` (`crates/runtimed/src/output_prep.rs:138-218`).
Comm-state top-level values blob when their byte size exceeds 1024. The two
thresholds happen to share the same numeric value but are independent
constants; they could diverge.

Save to `.ipynb` does not re-externalize every blob ref back to bytes. Only
Arrow IPC and Parquet blobs are written into the save output array as
`BLOB_REF_MIME` references (`output_store.rs:62-89, :1252-1282`); other
binary MIMEs are base64-inlined into the nbformat output payload. A user
opening the saved `.ipynb` outside nteract therefore gets self-contained
binary outputs for everything except Arrow / Parquet, which require a tool
that understands `BLOB_REF_MIME` and the colocated blob store.

## Decision 4: Localhost HTTP read, content-immutable cache headers

Blobs are served by an in-process Hyper HTTP server bound to
`127.0.0.1:<port>` (`blob_server.rs`). The port is chosen via
`runt_workspace::preferred_blob_port()` with a small bump range, then falls
back to OS-assigned. The server exposes:

- `GET /blob/{hash}` - raw bytes, `Content-Type` from the metadata sidecar
  (falling back to `application/octet-stream`).
- `GET /plugins/{name}` - embedded renderer plugin assets (out of scope for
  this ADR; lives on the same listener because the renderer needs both
  origins and a single port keeps the CSP simple). The renderer can be told
  to fetch these assets from a different base URL via
  `NteractEmbedHostContext.nteract.rendererAssetsBaseUrl`
  (`src/components/isolated/host-context.ts`, added in #2812). Desktop
  leaves it unset and falls back to `/plugins/{name}` on the daemon's HTTP
  origin; hosted viewers point it at a cloud-served asset prefix.
- `GET /health` - probe.

Response headers:

```
Cache-Control: public, max-age=31536000, immutable
Access-Control-Allow-Origin: *
X-Content-Type-Options: nosniff
```

`immutable` is honest here: a SHA-256 collision is the only way the bytes at a
given URL would ever change. `Access-Control-Allow-Origin: *` is acceptable
because the listener is loopback-only, the hash is 256 bits (not guessable),
and the contents are user-produced. The blob HTTP origin is **not**
authenticated; the trust model leans entirely on loopback isolation and hash
unguessability. Renderer iframes and the MCP App load blobs from this origin
without further auth.

The trade is explicit: anyone with code execution on the user's machine can
already read the blob store via the filesystem, and code running in the user's
browser cannot reach `127.0.0.1` cross-origin without a CORS-prefligh-able
header set that this server intentionally provides only to its own clients.
The room-level identity gate (`identity-and-trust.md`) lives at the sync
socket layer; once a peer is authenticated it can `GET /blob/<hash>` for any
blob in the store.

When the daemon restarts, the port may shift. The frontend resolves blob URLs
through `BlobResolver` (Decision 7) so a port change at reconnect time is a
single resolver refresh, not a per-output URL rewrite.

## Decision 5: PUT_BLOB is a binary frame; multipart is required above 32 MiB

Remote peers upload blobs via typed frame `PUT_BLOB` (`0x08`). The wire shape
is deliberately not JSON: a JSON envelope around megabytes of base64 would
double the bytes on the wire and force every peer to allocate a string buffer
the size of the blob.

```
PUT_BLOB payload = u32_be header_len | JSON header | raw blob bytes
```

The JSON header is one of two `PutBlobHeader` variants
(`crates/notebook-protocol/src/protocol.rs:313`):

- `op: "put"` - one-shot. Carries `id`, `media_type`, `size`, `sha256`,
  `durability?`, `purpose?`. Used when the caller chooses to upload in one
  frame; the daemon does not refuse one-shot uploads above a size threshold,
  it refuses one-shot uploads above the 32 MiB per-frame cap.
- `op: "part"` - multipart part. Carries `id`, `upload_id`, `part_number`,
  `size`, `sha256` of the part. Used after a `CreateBlobUpload` request opens
  an upload session.

The per-frame cap for `PUT_BLOB` is 32 MiB (`crates/notebook-wire/src/lib.rs:93-96`).
Anything that must travel in one frame is bounded by that cap; the caller
explicitly chooses one-shot vs multipart (`packages/runtimed/src/blob-upload.ts:44-60`
always builds a single frame; the Rust APIs expose `relay.rs:201-217` for
one-shot and `relay.rs:254-259` for multipart). Above the cap, multipart is
the only path:

1. **`CreateBlobUpload` request** - peer announces total size, expected final
   `sha256`, and part size (default 8 MiB, max 32 MiB). Daemon returns an
   `upload_id` and `expires_at` (1 hour TTL).
2. **`PUT_BLOB` part frames** - one per part, with per-part `sha256` checked
   on arrival. Parts stage to `<root>/uploads/<upload_id>/<part>.part`.
3. **`CompleteBlobUpload` request** - peer sends the part manifest; daemon
   re-hashes the concatenation while copying into the final shard path, fails
   loudly on `ManifestMismatch` or `FinalHashMismatch`, and only then
   publishes the final blob.
4. **`AbortBlobUpload` request** - removes the staging directory.

Safety properties baked in:

- **Per-peer staging budget.** `MAX_PEER_STAGED_BYTES = 256 MiB`. Multipart
  state is tracked per peer (`MultipartUploadState`), so one malicious peer
  cannot exhaust disk by opening many sessions.
- **One active upload per peer at a time.** `PUT_BLOB_QUEUE_CAPACITY = 1`,
  enforced via an `AtomicBool::in_flight` (`crates/runtimed/src/blob_upload.rs:181-185`).
  This gate covers **both** one-shot and multipart uploads, not multipart only.
  The peer loop is never blocked: excess uploads return `TooManyInFlight`
  immediately rather than queueing.
- **No partial publish.** The blob bytes only appear at their final path
  after the daemon verifies size and SHA-256 against the manifest. A
  hash-mismatched upload leaves the staging dir for the abort/sweep paths to
  clean up.
- **TTL sweep.** Multipart sessions older than 1 hour are reaped on the next
  Create/Complete/Abort entry into the registry; there is no periodic timer
  (`crates/runtimed/src/blob_upload.rs:469`, `:664`, `:847`). An idle daemon
  retains expired staging directories until traffic resumes. The registry's
  `Drop` impl also removes staged dirs at process shutdown.
- **Early hash validation.** `is_sha256_hex` runs against the
  `CreateBlobUpload` expected hash (`blob_upload.rs:482`), not only against
  the final `CompleteBlobUpload` hash. Malformed hashes are rejected before
  staging begins.

The peer-facing handshake advertises this surface via
`ProtocolCapabilities.put_blob` (single-frame max, multipart support, ephemeral
durability hint support), so older clients can detect what the daemon will
accept. The type lives at `crates/notebook-protocol/src/connection/handshake.rs:118-131`;
`crates/notebook-protocol/src/connection.rs:399` is the test
`protocol_capabilities_advertise_put_blob_frame_limit` that pins the wire
value.

## Decision 6: Two durability classes, mark-and-sweep with a 30-day grace

Every blob carries `BlobDurability` in its sidecar: `Durable` or `Ephemeral`.

- **`Durable`** - the default. Outputs from cell executions, markdown image
  attachments, blob refs in `NotebookDoc.cell.resolved_assets` or
  `cell.attachments`. Kept until the daemon GC decides no live or persisted
  document references them and the 30-day grace has elapsed.
- **`Ephemeral`** - opt-in from the **frontend** widget upload path. The
  kernel-side output prep path uses default `Durable` for everything it
  writes including widget comm buffers (`crates/runtimed/src/output_prep.rs:60-63,
  :209`, `crates/runtimed/src/blob_store.rs:253-255`). Frontend writes
  through `set_comm_state_batch` can request `Ephemeral` explicitly. An
  ephemeral blob is eligible for `delete_if_ephemeral` as soon as a
  superseding comm update arrives
  (`runtime_agent.rs::free_superseded_ephemeral_blobs`).

Promotion is monotone. A blob first written as ephemeral can be promoted to
durable on a later put; the reverse never happens. `merged_durability`
chooses `Durable` whenever either side asks for it. This keeps the durability
tag honest: once anyone asserts a blob is durable, no later opportunistic
ephemeral write demotes it. The sidecar rewrite on re-put covers durability
merging as well as media-type changes (`blob_store.rs:344-365`); a re-put
with a stricter durability rewrites the sidecar even when the content is
unchanged.

Sidecar back-compat: `BlobMeta.durability` has `serde(default)` to `Durable`
(`blob_store.rs:58-64`), so legacy sidecars predating the field are read as
durable. `BlobMeta.size` is stored as `u64`.

In-memory layer: `BlobStore` also holds a memory cache capped at
`EPHEMERAL_BLOB_CAP_BYTES = 64 MiB` (`crates/runtimed/src/blob_store.rs:34`).
The cache is content-addressed by the same hash and falls through to disk on
miss. Durable puts also prime the cache; ephemeral puts that exceed the cap
stay disk-only. **Eviction is insertion-order FIFO, not LRU**: `get` does not
refresh recency (`blob_store.rs:174-176`), and `evict_to_cap`
(`blob_store.rs:191-201`) pops from the front of the insertion order. A
high-traffic durable blob accessed many times still falls out first if it
was inserted earliest. The cleanup punchlist names this naming inconsistency.

Garbage collection is a daemon-level mark-and-sweep that runs every 30 minutes
(`daemon.rs::ghost_room_reaper_loop` adjacent loop, search for
`sweep_orphaned_blobs`):

1. **Mark phase.** Walk every active notebook room: `RuntimeStateDoc`
   executions and comms (outputs + comm state), `NotebookDoc` resolved assets
   and attachments. Then walk persisted `notebook_docs_dir/*.automerge` for
   closed-but-saved notebooks to protect their refs through the close/reopen
   window. Also walk the durable execution-store records **within** their
   retention window via `collect_execution_store_refs_for_gc`
   (`crates/runtimed/src/daemon.rs:3935-3939`). Arrow stream manifests get a
   second-pass walk that pulls referenced data blobs out of the manifest body
   (`daemon.rs:4227, 4531-4532`). The mark produces one combined hash set
   with no per-ref provenance; the punchlist tracks this opacity (BS-7).
2. **Skip guard.** If there are zero rooms loaded **and** no room has ever
   been loaded since daemon start, the sweep skips. That guard exists because
   "zero refs" is ambiguous in the post-restart window (we genuinely don't
   know yet) but unambiguous once any room has been loaded.
3. **Sweep phase.** For every blob on disk not in the referenced set, check
   `BlobMeta.created_at`. If the blob is older than `BLOB_GC_GRACE_SECS`
   (30 days, overrideable via `RUNTIMED_BLOB_GC_GRACE_SECS`), delete the
   bytes file and the sidecar. Clock-skew guard: a negative age never
   triggers deletion.

The 30-day grace deliberately errs on the side of disk over data loss. A user
saving an `.ipynb` that points at blob refs and not reopening it for a week
should not come back to broken outputs.

## Decision 7: Cross-document references and the BlobResolver indirection

Blob hashes live in three documents the daemon owns:

- **`RuntimeStateDoc` executions.** Each `OutputManifest` variant
  (`Stream`, `DisplayData`, `ExecuteResult`, `Error`, `UpdateDisplayData`)
  carries `ContentRef` fields for its text/data/traceback/rich slots
  (`runtimed/src/output_store.rs`).
- **`RuntimeStateDoc` comms.** `comm.state` is a JSON tree with embedded
  `{ "blob": ..., "size": ... }` refs at arbitrary depth, plus
  `comm.outputs` (same shape as execution outputs).
- **`NotebookDoc` cells.** `cell.resolved_assets` (markdown image hashes by
  alt key) and `cell.attachments` (nbformat attachments by name; each carries
  a `blob_hash`).

The two docs reference the same blob store. They never reference each other:
`NotebookDoc` does not cache execution output blob hashes, and
`RuntimeStateDoc` does not cache attachment hashes. Each doc walks its own
subtree during GC mark, and the union of marked hashes is the protected set.

The frontend never sees a daemon-local HTTP URL embedded in a doc. WASM
narrowing yields `ResolvedContentRef::Url` only when `set_blob_port(port)`
has been called and the MIME is binary; text and inline refs stay structured
and travel through `BlobResolver`. That indirection earns three things:

`BlobResolver` and `rendererAssetsBaseUrl` are deliberately **two separate
host contracts**, not one. Output blob bytes (the content of executions,
attachments, comm buffers) flow through `BlobResolver` and may eventually
ride a signed-URL or per-room origin in hosted deployments. Renderer plugin
sidecar assets (Sift's WASM binary, future renderer JS/CSS) flow through
`rendererAssetsBaseUrl` (Decision 4) and behave like static CDN assets.
Generic renderer code should only read whichever host context applies to it;
it should never reconstruct a cloud route shape from `notebookId` or any
other doc-level value. On the desktop, both default to the daemon's local
HTTP origin and the same port, but the contracts can move independently.

The resolver boundary is also an authority boundary. `BlobBackend` stores bytes;
`BlobResolver` decides how an authorized viewer obtains them. `PutBlob` and
multipart upload only transfer bytes into the backend. They do not grant read
access, mutate room state, or prove that a peer may reference the hash from a
particular document path. Hosted room hosts must authorize both the upload
surface and the later `NotebookDoc` / `RuntimeStateDoc` reference that makes the
blob reachable.

1. **Port-change tolerance.** Daemon restart with a new port is one refresh
   on the resolver, not a doc rewrite.
2. **Cloud transport reuse.** The hosted notebook path
   (`hosted-notebook-artifacts.md` Decision 4) keeps the same
   `{ "blob": "<sha>" }` shape and ships a different `BlobResolver` that
   maps to `/api/n/:id/blobs/:hash` or a future signed origin. The desktop
   resolver maps to `http://127.0.0.1:<port>/blob/<hash>`.
3. **Snapshot bundle.** `NotebookHandle.load_snapshot(notebookBytes,
   runtimeStateBytes)` materializes the notebook/runtime pair, and hosts may
   then load a saved `CommsDoc` snapshot for widget state. Outputs decode to
   `ContentRef`s; the host plugs in a `BlobResolver` against whichever origin
   owns the bytes (local daemon for a desktop viewer, cloud origin for a hosted
   viewer). The snapshot bundle plus the resolver is the durable source of
   truth. Hosts may still build derived JSON render caches at publish/request
   time, but those caches are regenerable validation artifacts, not a second
   notebook format.

The snapshot bundle invariant: a saved `RuntimeStateDoc` or `CommsDoc` is only
renderable if every `ContentRef::Blob` it carries is reachable through the
resolver. Publish flows (cloud or local export) must upload the referenced blobs
alongside the snapshot bundle, or pre-resolve them into inline form before
saving. The desktop daemon does not enforce this on save today; it is the publisher's
responsibility (covered explicitly by the R2 layout in
`hosted-notebook-artifacts.md` Decision 2).

## Worked examples

### Python kernel emits a 200 KiB PNG

1. Kernel sends an `iopub` `display_data` with `image/png` base64 in the data
   bundle.
2. `output_store::create_manifest` decodes the base64 to 200 KiB of raw PNG
   bytes, calls `BlobStore::put` with `media_type = "image/png"`. Hash is
   `sha256(png_bytes)`. Disk write lands at `<root>/<aa>/<bb...>` with the
   sidecar.
3. The output manifest stored in `RuntimeStateDoc` carries
   `{ "blob": "<hash>", "size": 200000 }` for the `image/png` slot.
4. Frontend sync picks up the doc change, WASM narrows the manifest and
   resolves the binary ref to `ResolvedContentRef::Url`
   `http://127.0.0.1:<port>/blob/<hash>`.
5. Renderer `<img>` fetches the URL. Daemon serves with `Content-Type:
   image/png`, `immutable` cache. Browser caches forever.

### Anywidget pushes a 12 MiB Arrow buffer via comm

1. Kernel calls `update_display_data` with binary buffers attached.
2. Runtime agent calls `BlobStore::put_with_durability(bytes, "application/vnd.apache.arrow.stream", Ephemeral)`.
3. Comm-state delta is rewritten with `{ "blob": "<hash>", "size": 12582912, "media_type": "..." }`
   at the buffer paths; the bytes themselves are not re-sent on subsequent
   merges of the same value.
4. Next comm update with a different buffer arrives. The previous hashes are
   handed to `free_superseded_ephemeral_blobs`, which calls
   `delete_if_ephemeral` per hash. Disk reclaims immediately.

### Cloud viewer renders a published snapshot

1. Publish (out of scope here; see `hosted-notebook-artifacts.md`) writes
   `notebookBytes`, `runtimeStateBytes`, optional `commsBytes`, and the
   referenced blobs to R2.
2. The viewer fetches the snapshot bundle, calls
   `NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes)`, and loads
   `commsBytes` when present.
3. WASM `set_blob_port` stays unset, so binary refs are not auto-resolved to
   URLs. Refs are returned as `ResolvedContentRef::Blob` and the host's
   `BlobResolver` (a cloud one in this case) is asked to produce a URL or
   fetch the bytes per ref.
4. The same WASM handle code that drives the desktop viewer renders the
   hosted notebook. No daemon involved.

### Daemon GC tick reclaims old screenshot outputs

1. User deletes a notebook from disk that used to reference a 4 MB screenshot
   blob.
2. Next 30-min GC tick: rooms scan, persisted-doc scan walks
   `notebook_docs_dir/*.automerge`. The deleted notebook is not in either
   set.
3. `sweep_orphaned_blobs` enumerates `BlobStore::list()`, skips every blob in
   the referenced set, and finds the screenshot's hash unreferenced.
4. If the blob's `created_at` is more than 30 days old, `BlobStore::delete`
   removes the bytes and sidecar. If younger, the grace keeps it for a
   future tick.

## Open Questions

These are the gaps that came out of writing the ADR. Some are tracked
elsewhere, some are surfaced here for the first time.

1. **Cross-room blob attribution.** GC walks all rooms with one referenced set
   and one disk listing. There is no per-room reference count, no "which rooms
   pointed at this hash before delete" audit log. A bug that double-counts a
   ref or misses one is silently a data-loss bug at the next sweep. Worth
   considering a debug-mode ref-source map (hash -> Vec<(room_id, ref_kind)>)
   that the sweep can dump on demand.
2. **No backend abstraction.** `BlobStore` is hard-coded to the local
   filesystem. Desktop will keep using the local filesystem store as its
   source of truth; the hosted path needs a real object-store backend (R2
   for the prototype, signed-origin or per-tenant bucket for production)
   with streaming reads and paginated listing. The right shape is a
   `BlobBackend` trait (storage concern: filesystem, R2, etc.) kept
   separate from `BlobResolver` (host/viewer concern: how a renderer
   fetches blob bytes given a hash). Conflating them would force the
   browser viewer to know about daemon filesystem assumptions or force the
   storage layer to know about HTTP routing. Punchlist BS-6.
3. **Authenticated blob HTTP.** `Access-Control-Allow-Origin: *` plus loopback
   is acceptable for the single-user desktop today. The moment the daemon
   serves more than one local OS user (multi-tenant Anaconda hosted on the
   same node, future SSH-forwarded scenarios), the unauthenticated blob HTTP
   becomes a cross-user read. The hosted side already addresses this via
   `/api/n/:id/blobs/:hash` and a signed origin; the desktop side does not.
4. **Per-blob ACL.** A room ACL today gates *connect*; once a peer is
   authenticated it can `GET` any blob in the store regardless of which room
   the blob belongs to. This is correct for single-user desktop and acceptable
   for the cloud layer because the cloud blob origin is per-notebook, but it
   means a desktop daemon serving an authenticated remote peer leaks any
   guessed hash. Hash unguessability is the only mitigation.
5. **Inline threshold tuning.** 1 KiB is one number applied uniformly. Text
   outputs cluster near the threshold often enough (long traceback strings,
   pandas reprs) that a value-aware threshold (e.g., higher for
   `text/plain` traceback, lower for `application/json`) might cut sync
   bandwidth materially. No data captured to drive that choice.
6. **Publish ref collectors must stay schema-complete.** The publish boundary
   now walks saved snapshot documents and rejects hosted revisions when
   materialized render refs are missing from the destination blob store. The
   remaining risk is schema drift: every new ref shape in `RuntimeStateDoc`
   outputs/comms, `NotebookDoc` assets/attachments, or inline manifest children
   must be added to the publisher, hosted validator, and GC inventory together.
   Desktop save still does not have a separate publish boundary; the room either
   has the blobs or it does not.
7. **MIME mutation on re-put.** A repeat put with the same bytes but a
   different `media_type` overwrites the sidecar (`put_disk` fast path).
   That is intentional for the `application/json` -> `text/javascript`
   case but means any peer with write access can rewrite the served
   `Content-Type` of an existing blob. Not exploitable on a single-user
   desktop, plausibly a vector once the protocol carries authenticated remote
   peers.
8. ~~**No `Content-Length`-bounded streaming on the read path.**~~ **Resolved**
   by punchlist BS-1. `BlobStore::open_reader` returns either an in-memory
   `Bytes` (memory-layer hit) or an open `tokio::fs::File` (disk-only).
   `GET /blob/<hash>` now wraps the disk variant in
   `StreamBody<ReaderStream<File>>`, so a 100 MiB output is streamed off
   the OS page cache instead of allocated into Rust heap per fetch.
   `Content-Length` is taken from the reader's reported size.
9. **Multipart upload TTL and sweep timing.** `MULTIPART_UPLOAD_TTL` is 1
   hour and the registry only sweeps when a new Create/Complete/Abort entry
   arrives. A daemon that goes idle with stale staging dirs on disk does
   not reclaim them until the next upload. Not a correctness bug; a "we
   never bothered cleaning up" gap. Punchlist BS-3.
10. **`MAX_BLOB_SIZE = 100 MiB` only gates `BlobStore::put()`.** The
    multipart finalize path validates against the caller's declared
    `expected_size` and the per-peer 256 MiB staging budget; it does not
    enforce a 100 MiB ceiling on the completed blob. A peer could
    multipart-upload a 200 MiB blob. Either intentional (multipart is the
    escape hatch above 100 MiB) or an undocumented bypass.
11. **Frontend blob-fetch retry policy is invisible from the daemon side.**
    `packages/runtimed/src/sync-engine.ts:107-140, :165-183` retries text
    blob fetches with `[100, 300, 1000]` ms backoff and gives up immediately
    on 4xx. The daemon does not know about this policy; a renderer that
    requests a not-yet-written blob will retry on its own cadence.

## References

- `crates/runtimed/src/blob_store.rs` - the store API, sharding, atomic
  write, in-memory FIFO cache, durability merging.
- `crates/runtimed/src/blob_server.rs` - the localhost HTTP read server.
- `crates/runtimed/src/notebook_sync_server/blob_upload.rs` - `PUT_BLOB`
  handling, multipart sessions, peer-staging budget.
- `crates/notebook-wire/src/lib.rs` - `PUT_BLOB = 0x08`, 32 MiB cap.
- `crates/notebook-protocol/src/protocol.rs` - `PutBlobHeader`,
  `BlobDurability`, `BlobUploadErrorKind`, multipart request/response shapes.
- `crates/runtimed/src/output_store.rs` - `ContentRef`,
  `DEFAULT_INLINE_THRESHOLD`, manifest creation/resolution.
- `crates/runtimed/src/daemon.rs` - GC entry point (`sweep_orphaned_blobs`,
  `collect_blob_refs_for_gc`), `BLOB_GC_GRACE_SECS`, skip-guard.
- `crates/runtimed-wasm/src/lib.rs` - `NotebookHandle::load_snapshot`,
  `resolve_content_ref`, snapshot+blob pairing.
- `packages/runtimed/src/blob-resolver.ts` - host-agnostic resolver surface
  (`BlobResolver`, `createHttpBlobResolver`, `createBlobResolver`).
- `docs/adr/hosted-notebook-artifacts.md` - cloud R2 layout, publish
  artifacts, the matching cloud resolver.
- `docs/adr/identity-and-trust.md` - room-level auth that gates the
  socket the `PUT_BLOB` frame rides on.
- `docs/adr/runtime-peer-and-blob-authority-audit.md` - hosted
  scope-gating and reference-authority audit for `PutBlob` and runtime peers.
