# Web Sync Engine Architecture Plan

## Context

The desktop app currently bundles the web frontend and `runtimed-wasm` from the
same tree, while the daemon speaks a v4 notebook wire protocol over a socket.
That co-location hid a compatibility assumption: the frontend's Automerge
runtime and document bootstrap logic have to match the daemon closely enough to
merge notebook, runtime-state, and pool-state sync frames.

Recent changes reduced the sharpest failure mode by loading frozen Automerge
genesis documents for:

- `NotebookDoc` schema v4: `crates/notebook-doc/assets/notebook_genesis_v4.am`
- `RuntimeStateDoc` schema v1: `crates/runtime-doc/assets/runtime_state_genesis_v1.am`

That makes the shared root scaffolds byte-stable across Rust and WASM, but it
does not by itself solve remote web clients. A CDN-served web shell can still
lag the local daemon, and the current handshake advertises only protocol and
daemon versions. It does not advertise document schema versions, genesis hashes,
or the exact sync-engine ABI needed to interpret daemon frames.

## Goals

- Let a web frontend connect to a daemon even when the web shell and daemon were
  built at different times.
- Preserve instant editing in fresh notebooks: the frontend must still be able
  to create a local `NotebookDoc` with the correct root scaffold before the
  daemon's first sync frame arrives.
- Fail typed and early when a client cannot safely sync.
- Keep the UI shell deployable through normal web/CDN flows.
- Avoid executing daemon-provided JavaScript in the main app origin.
- Reuse the transport-agnostic `runtimed` package and the existing
  `NotebookTransport`/`SyncEngine` split instead of replacing the sync stack.

## Non-Goals

- Do not turn the browser frontend into an arbitrary plugin runtime for daemon
  code.
- Do not require lockstep deployment of the entire web app for additive
  runtime-state fields.
- Do not make document schema changes implicit. Root scaffold changes and
  incompatible runtime-state changes need explicit version bumps.
- Do not depend on SharedArrayBuffer or threaded WASM for the first version.

## Current Architecture Findings

- Protocol constants live in `crates/notebook-protocol/src/connection/handshake.rs`
  and `crates/notebook-wire/src/lib.rs`. `PROTOCOL_VERSION` is 4 and
  `MIN_PROTOCOL_VERSION` is also 4 today, so the preamble check accepts v4 only.
  Any wider window has to be reintroduced when we want to broaden the gate.
- `ProtocolCapabilities`
  (`crates/notebook-protocol/src/connection/handshake.rs:106-154`) carries
  `protocol`, `protocol_version`, `daemon_version`, and the current
  `put_blob` capability. `NotebookConnectionInfo` flattens that same capability
  object into open/create responses. They do not yet carry document
  compatibility data or sync-engine package metadata.
- `SessionControlMessage::SyncStatus`
  (`crates/notebook-wire/src/lib.rs:159-169`) wraps `SessionSyncStatusWire` with
  three phases:
  - `NotebookDocPhaseWire`: `Pending`, `Syncing`, `Interactive`
  - `RuntimeStatePhaseWire`: `Pending`, `Syncing`, `Ready`
  - `InitialLoadPhaseWire`: `NotNeeded`, `Streaming`, `Ready`, `Failed { reason }`
  `InitialLoadPhase::Failed` already exists for the initial-load bytes path. It
  is not the right channel for a coarse compatibility-gate failure that has to
  surface before any phase runs.
- The browser dev host (`packages/notebook-host/src/browser/index.ts`) is a
  small TS relay layer over WebSocket. It owns the daemon Unix-socket
  connection and forwards typed daemon frames unchanged. Request/response frames
  use the existing `FRAME_TYPE_REQUEST` / `FRAME_TYPE_RESPONSE` envelopes;
  non-response frames are delivered to subscribers as raw typed frames.
- `SessionControlMessage` decoding currently happens inside
  `crates/runtimed-wasm/src/lib.rs:1787-1801` after `SyncEngine` passes frames
  through `handle.receive_frame(...)`. That is fine for status updates after the
  engine is loaded, but it is too late for compatibility failures that decide
  whether an engine can be loaded at all.
- The app imports `runtimed-wasm` directly from
  `apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js` in nine places, not
  just `useAutomergeNotebook`. Other importers include `frame-pipeline.ts`,
  `materialize-cells.ts`, `useCrdtBridge.tsx`, `usePresence.ts`,
  `project-runtime-stores.ts`, `crdt-editor-bridge.ts`, and
  `notebook-metadata.ts`. Phase 2's host abstraction has to span this surface,
  not just the `NotebookHandle` constructor in
  `apps/notebook/src/hooks/useAutomergeNotebook.ts:100`.
- `PoolDoc` is different from notebook/runtime-state today: the daemon
  scaffolds it with actor `runtimed:pool` in
  `crates/notebook-doc/src/pool_state.rs:84-93`, while clients call
  `PoolDoc::new_empty()` and only receive daemon-authored sync. It still needs
  schema compatibility metadata, but it does not currently need a shared
  frozen genesis artifact.
- `packages/runtimed/src/handle.ts:86-172` defines `SyncableHandle` with about
  fourteen methods, covering per-stream `flush_*` / `cancel_last_*_flush` /
  `generate_*_sync_reply` for notebook, runtime-state, and pool-state, plus
  `receive_frame`, `reset_sync_state`, `cell_count`, `get_heads_hex`,
  `get_dependency_fingerprint`, and an optional `resolve_comm_state`. The
  interface is the right seam for a hosted or dynamically loaded sync engine,
  but the ABI it implies is wide. Treat ABI version bumps as expected when any
  of these signatures shift.
- Renderer plugins already prove the repo has build machinery for producing
  prebuilt JS assets, but those plugins run inside isolated renderer frames.
  The sync engine is more privileged because it owns document mutations and
  runtime-state interpretation.
- The daemon already has the asset-serving discipline Phase 4 needs.
  `crates/runtimed/src/blob_server.rs` serves `/blob/{hash}` content-addressed
  blobs as `public, max-age=31536000, immutable` (line 178), dev filesystem
  plugin files as `no-store` (line 261), and embedded plugin assets with a
  bounded cache (`public, max-age=86400`, line 309). New sync-engine routes
  should live alongside these and mirror the per-route cache policy.
- Blob writes are now socket-authenticated typed frames, not a separate Blob
  handshake. `PUT_BLOB` is frame `0x08`, accepts
  `u32 header_len | JSON header | raw bytes`, replies on the existing response
  frame, and is advertised through `ProtocolCapabilities.put_blob`. Remote web
  upload support should keep using this capability-gated transport path rather
  than adding write authority to the HTTP blob server.
- There are no manifest endpoints, compatibility-check handlers, or
  sync-engine asset routes in the daemon today. The blob server currently
  exposes only `/blob/{hash}`, `/plugins/{name}`, and `/health`. Phase 4 is
  greenfield.
- `cargo xtask wasm runtimed` exists in `crates/xtask/src/main.rs` and emits
  wasm-pack JS bindings into `apps/notebook/src/wasm/runtimed-wasm/`. It does
  not currently emit a manifest. Adding manifest emission is a Phase 4 task,
  not a discovery.

## Iframe and Asset Constraints

The current isolated-output stack is useful prior art, but it should not become
the sync-engine model.

- Output iframes are deliberately permissive execution sandboxes. The frame CSP
  allows inline/eval/blob/localhost/CDN renderer code because it is constrained
  by the iframe sandbox without `allow-same-origin`.
- The Tauri iframe shell is served with `no-store, no-cache, must-revalidate`.
  That is correct for mutable bootstrap HTML and should remain separate from
  durable asset caching.
- Renderer plugins are loaded by MIME type through Vite virtual modules, cached
  in app memory, and injected into each iframe with `frame.installRenderer(...)`.
  This is the right shape for output renderers, not for the privileged sync
  engine.
- Daemon-hosted plugin assets already use different cache policies by mutability:
  dev filesystem plugin files are `no-store`, embedded plugin assets get a
  bounded cache lifetime, and content-addressed blobs get
  `public, max-age=31536000, immutable`.

For the sync engine, copy the content-addressed asset discipline, not the iframe
plugin discipline. The engine package should have its own manifest and package
cache keyed by ABI, package ID, and byte digests. It should not be installed into
output iframes, should not use the MIME-type plugin cache, and should not require
the isolated-frame CSP.

## Recommended Shape

Use a stable TypeScript bootstrap shell plus a versioned sync-engine package.
The bootstrap shell owns connection, capability validation, typed failures, and
UI integration. The sync engine owns Automerge document state and frame
interpretation.

```text
Web app shell
  |
  | fetch /runtimed/capabilities.json
  v
Bootstrap compatibility gate
  |
  | choose bundled/cached/daemon-served engine by abi + hashes
  v
Sync engine host
  |
  | stable message API
  v
Worker + runtimed-wasm package
  |
  | NotebookTransport frames
  v
Daemon notebook socket / web relay
```

The daemon should expose a manifest, not ask the app to guess.

```json
{
  "protocol": {
    "wire": 4,
    "min_client_wire": 4
  },
  "daemon": {
    "version": "2.4.6+abc123"
  },
  "documents": {
    "notebook": {
      "schema": 4,
      "genesis_sha256": "..."
    },
    "runtime_state": {
      "schema": 1,
      "genesis_sha256": "..."
    },
    "pool_state": {
      "schema": 1
    }
  },
  "transport": {
    "put_blob": {
      "version": 1,
      "single_frame_max": 33554432,
      "multipart": true,
      "ephemeral_supported": true
    }
  },
  "sync_engine": {
    "abi": "nteract-sync-engine-v1",
    "package_id": "runtimed-wasm-2.4.6-abc123",
    "js": {
      "url": "/assets/sync-engine/runtimed_wasm.js",
      "sha384": "..."
    },
    "wasm": {
      "url": "/assets/sync-engine/runtimed_wasm_bg.wasm",
      "sha256": "...",
      "content_type": "application/wasm"
    }
  },
  "features": {
    "runtime_state_additive_fields": ["project_context", "approved_conda_channels"]
  }
}
```

## Engine Loading Policy

Use this order:

1. Prefer the app-bundled engine when its manifest matches the daemon's ABI,
   document schema versions, and genesis hashes.
2. Reuse an IndexedDB/browser-cache engine when the ABI, package ID, and hashes
   match. This must be a sync-engine package cache, not the renderer plugin
   cache or isolated-renderer bundle cache.
3. Fetch the daemon-served engine only when the bundled/cached engine cannot
   satisfy the manifest.
4. Refuse to connect with a typed compatibility error if no acceptable engine
   can be loaded.

Treat the manifest as mutable metadata and engine assets as immutable only when
their URLs are content-addressed or otherwise package-ID scoped. A stale manifest
must never pin a client to an old engine after the daemon changes its compatibility
requirements.

The manifest should be authenticated by same-origin transport or by a trusted
daemon endpoint token. Asset bytes must be hash-checked before use even when
same-origin. Browser Subresource Integrity applies naturally to `<script>` and
`<link>` resources, but dynamic WASM fetches should still perform an explicit
digest check with `crypto.subtle.digest`.

## Worker Boundary

The safest deployable boundary is a dedicated worker with a stable outer API.
The main UI should not import daemon-served JS directly into the app realm.

Compatibility-gate errors must be decodable by the stable TypeScript shell
before any `runtimed-wasm` worker is selected. `SessionControlMessage` can carry
the daemon-authored error shape, but the bootstrap layer should parse that JSON
from the `SESSION_CONTROL` frame or manifest response directly. Do not rely on
`NotebookHandle.receive_frame(...)` for the first compatibility failure; an
engine that cannot be loaded cannot decode its own rejection.

The worker API should be deliberately small:

```ts
type SyncWorkerCommand =
  | { type: "init"; actorLabel: string; blobPort: number | null; engineManifest: SyncEngineManifest }
  | { type: "receive_frame"; frame: Uint8Array }
  | { type: "flush" }
  | { type: "mutate"; op: NotebookMutation }
  | { type: "set_blob_port"; port: number | null }
  | { type: "free" };

type SyncWorkerEvent =
  | { type: "ready"; capabilities: EngineCapabilities }
  | { type: "frame_reply"; frameType: number; payload: Uint8Array }
  | { type: "cell_changes"; changeset: CellChangeset | null }
  | { type: "runtime_state"; state: RuntimeState }
  | { type: "pool_state"; state: PoolState }
  | { type: "session_status"; status: SessionStatus }
  | { type: "compatibility_error"; error: CompatibilityError }
  | { type: "panic"; message: string };
```

For phase one, the worker can wrap the existing wasm-bindgen JS glue plus
`NotebookHandle`. Longer term, we can make the worker the only consumer of
`runtimed-wasm` and remove direct app imports of
`apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js`.

## Compatibility Rules

### Wire Protocol

The wire protocol version remains the coarse connection gate. Breaking changes
to frame format, request envelope shape, or required frame ordering still bump
`PROTOCOL_VERSION`.

### NotebookDoc

`NotebookDoc` root scaffold changes require:

- New schema version.
- New frozen genesis artifact.
- New genesis hash in the manifest.
- A compatible engine that can create a fresh doc with that scaffold before
  accepting user edits.

Additive cell or metadata fields that do not alter the root scaffold can stay
within schema v4 if older clients preserve unknown fields and do not need to
author them.

### RuntimeStateDoc

Runtime-state v1 genesis must remain immutable. Additive fields should be
daemon-authored after genesis and projected through `read_state()` with defaults
for missing fields. This lets:

- Old client + new daemon: old client ignores unknown CRDT paths.
- New client + old daemon: new client defaults missing paths.

Runtime-state schema v2 is needed only when changing root structure, removing
or retyping existing fields, or requiring a field for basic sync/readiness.

### Sync Engine ABI

The sync engine ABI should change when the main app/worker message contract
changes, not when the internal Rust schema changes. A daemon can serve a newer
engine package with the same ABI if the outer worker messages remain stable.

### PoolDoc

Pool state is daemon-authoritative and global. Because browser clients currently
start from an empty `PoolDoc`, additive daemon-authored fields can follow the
runtime-state defaulting model. If clients ever need to pre-scaffold pool state,
then pool state should get the same frozen genesis treatment as
`RuntimeStateDoc`.

## Security Model

- Daemon-served `.wasm` may be loaded after hash verification; it is still
  native-quality logic with access to imported JS functions, so imports must be
  minimal and deterministic.
- Daemon-served JS glue should run only inside a dedicated worker, not the main
  app window.
- The worker should not receive DOM handles, React state setters, auth tokens
  unrelated to the daemon, or arbitrary network helpers.
- Do not reuse the isolated-output iframe CSP for the sync engine. Output frames
  need permissive renderer execution; the sync worker should get the narrowest
  `worker-src`, `script-src`, and WASM permissions that the selected loading mode
  needs.
- CSP needs explicit `worker-src` and `script-src 'wasm-unsafe-eval'` planning.
  Avoid general `unsafe-eval` for the main app.
- If the worker is built from a blob URL, CSP must allow `worker-src blob:`.
  If it is served as a URL, prefer an allowlisted same-origin daemon asset path.
- Do not require cross-origin isolation in phase one. If we later use
  SharedArrayBuffer/threaded WASM, COOP/COEP becomes a product-level hosting
  requirement.

## Product Behavior

Compatibility failures should surface before the notebook enters the normal
initializing state. Suggested user-facing buckets:

- `daemon_too_old`: update/restart daemon.
- `client_too_old`: refresh/update web shell.
- `engine_unavailable`: daemon-compatible sync engine could not be fetched.
- `engine_integrity_failed`: fetched engine hash did not match manifest.
- `schema_unsupported`: no available engine can handle daemon document schema.

The UI should keep these distinct from kernel launch, trust approval, and
initial notebook load failures.

Fresh-notebook editing is allowed only after the bootstrap selects a compatible
engine. In the happy path this is still instant because the bundled engine can
create the frozen-genesis `NotebookDoc` before daemon sync frames arrive. If no
compatible engine is available, do not accept local edits into a document that
cannot safely sync or execute; show the typed compatibility error with the
right action (`Refresh`, `Restart daemon`, `Update desktop`, or `Open
diagnostics`).

## Cross-Perspective Review Requirements

### Product

- Preserve the current "open a fresh notebook and type" feel when the bundled
  engine matches the daemon manifest.
- Treat dynamic engine fetch as an implementation detail. Users should see a
  short compatibility/loading state, not a plugin-install workflow.
- Provide actionable mismatch states with daemon version, client version,
  document schema, engine source, and a copyable diagnostic payload.

### Systems Engineering

- Maintain Automerge's reliable, in-order, per-peer sync assumption. If the web
  relay buffers frames while the engine loads, the buffer must be ordered,
  bounded, and drained only after the engine is ready.
- Do not release notebook, runtime-state, or pool-state sync frames to the
  worker before the compatibility gate passes. `SESSION_CONTROL` compatibility
  frames and manifest responses are the only pre-engine protocol inputs.
- Worker replacement must preserve the user's actor label and reset only
  transport sync state. It must not fork the same actor into two live engines.

### Maintainers

- Treat the worker API and `SyncableHandle` as explicit versioned contracts.
  Adding a method, changing event shape, or changing error semantics requires an
  ABI bump, generated TS contract update, and cross-version tests.
- Keep each phase independently mergeable: manifest metadata, typed failures,
  host abstraction, worker boundary, and daemon-served package should not be one
  large migration.
- Add a schema/engine bump checklist next to the genesis assets once the first
  manifest constants land.

### User Experience

- Avoid "Initializing" for compatibility failures. That state should mean normal
  notebook startup, not "this client can never converge."
- If the client falls back from bundled to cached to daemon-served engine, expose
  only the final state unless diagnostics are open.
- Keep kernel launch and trust-approval errors visually separate from
  compatibility errors so users do not retry the wrong operation.

### Security

- The manifest must bind protocol version, document schema versions, genesis
  hashes, engine ABI, package ID, asset URLs, and asset digests in one object.
  A valid asset hash is not enough if an attacker can replay a stale manifest.
- Capability metadata such as `put_blob` should come from the same handshake or
  manifest snapshot as the sync-engine decision. Do not allow the app to combine
  a fresh engine manifest with stale transport capabilities.
- Daemon-served engine routes should be authenticated and same-origin where
  possible. If cross-origin is unavoidable, use an allowlist and credentials
  strategy; do not copy the permissive blob/plugin CORS policy by default.
- Keep blob writes on authenticated notebook transports (`PUT_BLOB` or its
  successors). The HTTP blob server remains read-only for content-addressed GETs
  and plugin/engine asset delivery.
- Serve worker scripts with their own CSP response header. Workers are not a
  reason to relax the main app CSP.
- Keep daemon-served JS out of the main realm even after digest verification.
  Hash checking proves bytes, not behavior.

## Implementation Plan

### Phase 0: Document and Enforce Manifests

- Add compile-time constants for document schema versions and genesis hashes in
  `crates/notebook-doc` and `crates/runtime-doc` next to the existing genesis
  assets. Add an explicit pool-state schema version without implying a frozen
  pool genesis artifact.
- Extend `ProtocolCapabilities` in
  `crates/notebook-protocol/src/connection/handshake.rs` with optional
  `document_compatibility` and `sync_engine` fields. `NotebookConnectionInfo`
  already flattens `ProtocolCapabilities`, so open/create responses should pick
  up the same metadata without a parallel shape.
- Keep the new fields optional so current clients remain source-compatible
  during the rollout. The wire-version gate (`PROTOCOL_VERSION = 4`,
  `MIN_PROTOCOL_VERSION = 4`) does not need to move for additive metadata.
- Add tests that assert manifest hashes match the checked-in `.am` artifacts at
  `crates/notebook-doc/assets/notebook_genesis_v4.am` and
  `crates/runtime-doc/assets/runtime_state_genesis_v1.am`.
- Add tests that `ProtocolCapabilities::v4(...)`, direct `NotebookSync`, and
  `NotebookConnectionInfo` open/create responses all expose the same
  document/sync-engine compatibility metadata alongside the existing `put_blob`
  capability.
- Add a manifest replay test: an older valid manifest with stale schema or
  package metadata must be rejected against a newer daemon capability response.

### Phase 1: Typed Compatibility Failures

- Add `SessionControlMessage::CompatibilityError` as a sibling of `SyncStatus`.
  Keep this distinct from `InitialLoadPhaseWire::Failed`: the latter is for
  failures inside the initial-load bytes phase, while compatibility errors
  must surface before any phase begins.
- Add the generated TypeScript protocol contract for `CompatibilityError` and
  route that frame/manifest response through the bootstrap shell before frames
  are released to the WASM demux.
- Add a frontend/store path that displays compatibility errors before
  `Initializing`.
- Teach the browser relay (`packages/notebook-host/src/browser/index.ts`) and
  the Tauri host to pass the new session-control frame through unchanged.
- Add a small stable TS decoder for pre-engine `SESSION_CONTROL` compatibility
  frames. WASM can keep decoding post-engine session status.
- Add tests for schema/hash mismatch producing a typed failure instead of
  runtime-state pending forever.

### Phase 2: Engine Host Abstraction

- Extract direct `NotebookHandle` creation from `useAutomergeNotebook` behind a
  `NotebookEngineHost` interface.
- Audit the nine direct importers of
  `apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js` (notebook hook,
  `frame-pipeline.ts`, `materialize-cells.ts`, `useCrdtBridge.tsx`,
  `usePresence.ts`, `project-runtime-stores.ts`, `crdt-editor-bridge.ts`,
  `notebook-metadata.ts`, plus the frame-pipeline test). Decide which routes
  through the host and which stay as direct types-only imports. Type-only
  imports do not block worker isolation; runtime calls do.
- Keep the existing in-bundle WASM as the default implementation.
- Preserve `SyncableHandle` (`packages/runtimed/src/handle.ts`) as the core
  runtime package seam. Treat its current 14-method shape as the v1 ABI; bump
  the engine ABI when any signature changes.
- Add an integration test that runs `SyncEngine` against the host abstraction,
  not the concrete wasm-bindgen class.

### Phase 3: Worker Engine

- Build a same-bundle worker that wraps the current `runtimed-wasm` glue.
- Move frame receive, flush, runtime-state projection, and mutations into the
  worker API.
- Add a bounded, ordered pre-engine frame buffer or delay daemon sync frame
  release until worker initialization finishes. Overflow should fail with
  `engine_unavailable`, not silently drop frames.
- Keep materialization outputs compatible with the current stores.
- Verify that startup, cell typing, runtime-state sync, comm projection, and
  output updates match the direct-WASM path.

### Phase 4: Daemon-Served Engine Package

- Extend `cargo xtask wasm runtimed` (in `crates/xtask/src/main.rs`) to emit an
  engine manifest containing JS and WASM hashes alongside the existing
  wasm-pack output under `apps/notebook/src/wasm/runtimed-wasm/`.
- Add daemon HTTP routes alongside the existing handlers in
  `crates/runtimed/src/blob_server.rs`:
  - `/sync-engine/manifest.json`
  - `/sync-engine/assets/{package_id}/runtimed_wasm.js`
  - `/sync-engine/assets/{package_id}/runtimed_wasm_bg.wasm`
- Serve the manifest as mutable metadata: `no-store` in dev, and either
  `no-store` or short-cache plus `ETag` in production. This matches the
  existing dev-plugin policy at `blob_server.rs:261`.
- Serve dev worktree engine assets with `no-store`, matching current dev plugin
  behavior.
- Serve release engine assets with long cache headers only when the route is
  package-ID/hash scoped, modeled on the `/blob/{hash}` policy at
  `blob_server.rs:178` (`public, max-age=31536000, immutable`). Use
  `application/wasm` for `.wasm` and keep `X-Content-Type-Options: nosniff`.
- Serve worker script responses with a narrow worker CSP. Do not depend only on
  the parent document CSP.
- Add explicit digest verification before instantiating downloaded assets.
- Keep `/sync-engine/*` routes read-only. Do not reuse them for blob upload;
  authenticated blob writes stay on `PUT_BLOB`/multipart notebook frames.

### Phase 5: Remote Web Deployment

- Define the production web handshake:
  - Web shell connects to daemon/reverse proxy.
  - Web shell fetches compatibility manifest.
  - Bootstrap selects bundled/cached/daemon engine.
  - Worker initializes.
  - Only then are notebook sync frames released to the engine.
- Decide whether daemon asset routes are same-origin via reverse proxy or
  cross-origin with CORS. Same-origin is simpler and preferable.
- Add telemetry/logging for compatibility decisions and engine source
  (`bundled`, `cache`, `daemon`, `failed`).

## Test Matrix

- Same version shell and daemon: bundled engine used.
- New daemon with additive runtime-state field: old bundled engine connects and
  ignores unknown field.
- Old daemon missing additive runtime-state field: new bundled engine connects
  and defaults field.
- Daemon notebook genesis hash differs: connection stops with
  `schema_unsupported`.
- Daemon runtime-state genesis hash differs: connection stops before
  runtime-state sync bytes are processed.
- Pool-state schema is newer than the engine supports: pool sync is disabled or
  connection stops with a typed compatibility error, depending on whether pool
  state is required for the current UI route.
- Pre-engine sync frames arrive before worker readiness: frames are buffered in
  order within the configured limit or connection fails typed; no frames are
  dropped or reordered.
- User starts a fresh notebook with a compatible bundled engine: local editing
  becomes available before the first daemon sync frame.
- User starts a fresh notebook with no compatible engine: editing stays blocked
  and the compatibility error offers the correct action.
- Bundled engine ABI mismatch, daemon engine available: daemon engine loads in
  worker and syncs.
- Daemon engine hash mismatch: asset rejected with `engine_integrity_failed`.
- Stale but hash-valid manifest replay: manifest rejected because it does not
  match current daemon capability metadata.
- Stale transport capability replay: client must not combine fresh
  sync-engine metadata with stale `put_blob` limits or unsupported multipart
  behavior.
- Cached daemon engine package with stale package ID or digest: cache entry is
  ignored and assets are refetched or rejected with `engine_integrity_failed`.
- Mutable engine manifest is not served with immutable cache headers.
- Dev worktree engine assets are served with `no-store` so rebuilds are visible
  without clearing browser caches.
- WASM served with wrong content type: loader falls back or reports
  `engine_unavailable` with diagnostic detail.
- Worker creation blocked by CSP: typed `engine_unavailable` with CSP guidance.

## Open Questions

- Should the sync engine package include only `runtimed-wasm`, or should it also
  include the TypeScript `SyncEngine` pipeline? My recommendation is to keep
  `SyncEngine` in the stable shell initially and move only `NotebookHandle` into
  the worker. Move more only if the ABI proves too wide.
- Should the daemon ever serve JS to a CDN-hosted page directly? I would avoid
  that for the main origin. If JS glue is required, run it in a worker and
  verify its hash.
- Do we need a signed manifest for remote daemon scenarios beyond same-origin
  TLS? For local/dev daemon use, hash verification plus endpoint auth is enough.
  For multi-tenant remote runtimes, signed manifests may be warranted.
- Can we publish a small compatibility table with each web release so the shell
  knows when bundled engines cover known daemon versions? This would reduce
  daemon asset fetches and make failures easier to explain.

## Sources Consulted

- MDN WebAssembly loading guidance:
  <https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static>
- MDN CSP guidance:
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy>
- MDN `worker-src` guidance:
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src>
- MDN Worker constructor security guidance:
  <https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker>
- MDN Subresource Integrity guidance:
  <https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Subresource_Integrity>
- MDN cross-origin isolation guidance:
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy>
- MDN `Cache-Control` guidance:
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control>
- WebAssembly security model:
  <https://webassembly.org/docs/security/>
- Automerge sync concepts:
  <https://automerge.org/docs/reference/concepts/>
- Automerge Rust sync API:
  <https://automerge.org/automerge/automerge/sync/index.html>
