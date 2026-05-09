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

- The daemon accepts notebook connections whose preamble version is in
  `MIN_PROTOCOL_VERSION..=PROTOCOL_VERSION`, and v4 is current.
- `ProtocolCapabilities` and `NotebookConnectionInfo` carry `protocol`,
  `protocol_version`, and `daemon_version`, but no document compatibility data.
- `SessionControlMessage::SyncStatus` has phases for notebook doc, runtime
  state, and initial load, but no terminal compatibility error.
- The browser dev host already uses a small TS relay layer over WebSocket and
  forwards typed daemon frames unchanged.
- The app imports `runtimed-wasm` directly from
  `apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js`, and
  `useAutomergeNotebook` creates `NotebookHandle` directly.
- `PoolDoc` is different from notebook/runtime-state today: the daemon
  scaffolds it with actor `runtimed:pool`, while clients start empty and only
  receive daemon-authored sync. It still needs schema compatibility metadata,
  but it does not currently need a shared frozen genesis artifact.
- `packages/runtimed` already defines a narrow `SyncableHandle` interface used
  by `SyncEngine`; that is the right seam for a hosted or dynamically loaded
  sync engine.
- Renderer plugins already prove the repo has build machinery for producing
  prebuilt JS assets, but those plugins run inside isolated renderer frames.
  The sync engine is more privileged because it owns document mutations and
  runtime-state interpretation.

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
2. Reuse an IndexedDB/browser-cache engine when the package ID and hashes match.
3. Fetch the daemon-served engine only when the bundled/cached engine cannot
   satisfy the manifest.
4. Refuse to connect with a typed compatibility error if no acceptable engine
   can be loaded.

The manifest should be authenticated by same-origin transport or by a trusted
daemon endpoint token. Asset bytes must be hash-checked before use even when
same-origin. Browser Subresource Integrity applies naturally to `<script>` and
`<link>` resources, but dynamic WASM fetches should still perform an explicit
digest check with `crypto.subtle.digest`.

## Worker Boundary

The safest deployable boundary is a dedicated worker with a stable outer API.
The main UI should not import daemon-served JS directly into the app realm.

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

## Implementation Plan

### Phase 0: Document and Enforce Manifests

- Add compile-time constants for document schema versions and genesis hashes in
  `notebook-doc` and `runtime-doc`; add an explicit pool-state schema version
  without implying a frozen pool genesis artifact.
- Extend `ProtocolCapabilities` and `NotebookConnectionInfo` with optional
  `document_compatibility` and `sync_engine` fields.
- Keep fields optional initially so current clients remain source-compatible.
- Add tests that assert manifest hashes match the checked-in `.am` artifacts.

### Phase 1: Typed Compatibility Failures

- Add `SessionControlMessage::CompatibilityError`.
- Add a frontend/store path that displays compatibility errors before
  `Initializing`.
- Teach browser relay and Tauri host to pass the new session-control frame
  unchanged.
- Add tests for schema/hash mismatch producing typed failure instead of
  runtime-state pending forever.

### Phase 2: Engine Host Abstraction

- Extract direct `NotebookHandle` creation from `useAutomergeNotebook` behind a
  `NotebookEngineHost` interface.
- Keep the existing in-bundle WASM as the default implementation.
- Preserve `SyncableHandle` as the core runtime package seam.
- Add an integration test that runs `SyncEngine` against the host abstraction,
  not the concrete wasm-bindgen class.

### Phase 3: Worker Engine

- Build a same-bundle worker that wraps the current `runtimed-wasm` glue.
- Move frame receive, flush, runtime-state projection, and mutations into the
  worker API.
- Keep materialization outputs compatible with the current stores.
- Verify that startup, cell typing, runtime-state sync, comm projection, and
  output updates match the direct-WASM path.

### Phase 4: Daemon-Served Engine Package

- Extend `cargo xtask wasm runtimed` to emit an engine manifest containing JS
  and WASM hashes.
- Add daemon HTTP routes for:
  - `/sync-engine/manifest.json`
  - `/sync-engine/runtimed_wasm.js`
  - `/sync-engine/runtimed_wasm_bg.wasm`
- Serve `.wasm` with `application/wasm` and long cache headers keyed by content
  hash.
- Add explicit digest verification before instantiating downloaded assets.

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
- Bundled engine ABI mismatch, daemon engine available: daemon engine loads in
  worker and syncs.
- Daemon engine hash mismatch: asset rejected with `engine_integrity_failed`.
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
- Automerge sync concepts:
  <https://automerge.org/docs/reference/concepts/>
- Automerge Rust sync API:
  <https://automerge.org/automerge/automerge/sync/index.html>
