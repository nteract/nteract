# Comm Buffer Paths And Blob Upload Lanes Plan

> **For agentic workers:** This is an evaluation plan, not an execution script. If accepted, turn each phase into small commits and use the repo-local `testing` and `pr-reviewer` workflows before marking a PR ready.

**Goal:** Make browser/frontend-originated widget state updates support Jupyter comm `buffer_paths` without putting binary bytes into Automerge or blocking latency-sensitive notebook traffic.

**Architecture:** Blob upload rides the shared notebook-sync socket as a typed `PutBlob` frame (`0x08`); see `.context/putblob-sequencing-plan.md` and `.context/2026-04-30-putblob-frame-design.md` for the transport. RuntimeStateDoc remains JSON/CRDT state with ContentRefs at binary leaves, and the runtime agent reconstructs Jupyter `comm_msg(update)` buffers before forwarding to the kernel. No separate bulk lane.

**Tech Stack:** TypeScript widget bridge, WASM RuntimeStateDoc bindings, Rust typed notebook frames, daemon/runtime-agent blob store, Jupyter comm protocol.

---

## Current Behavior

Inbound kernel-to-frontend binary widget state already works:

1. Kernel sends `comm_open` / `comm_msg` with `data.state`, `data.buffer_paths`, and binary `buffers`.
2. `crates/runtimed/src/output_prep.rs::store_widget_buffers` stores buffers in the blob store.
3. RuntimeStateDoc stores ContentRefs in `comms[comm_id].state`.
4. WASM `resolve_comm_state` projects ContentRefs to blob URLs plus `bufferPaths`.
5. `src/isolated-renderer/widget-bridge-client.ts` fetches those URLs and installs `DataView`s before widget code reads state.

Frontend-to-kernel binary widget state does not work yet:

1. anywidget/jscatter calls `model.set("selection", { view: DataView, dtype, shape })`.
2. The iframe bridge sends the patch to the parent.
3. `WidgetUpdateManager` eventually calls `handle.set_comm_state_batch(commId, JSON.stringify(patch))`.
4. `DataView` cannot survive JSON serialization, so `view` becomes `{}`.
5. The runtime agent diffs RuntimeStateDoc and sends a `comm_msg(update)` with `buffer_paths: []`.
6. jscatter's Python deserializer expects `value["view"]` to be a real buffer and fails or resets the visible selection.

## Design Principles

- Keep the HTTP blob server read-only.
- Keep Automerge/RuntimeStateDoc JSON-only: metadata and ContentRefs, not raw bytes.
- Preserve Jupyter comm semantics: `buffer_paths` belongs to `comm_msg.data` and indexes into `buffers`.
- Do not route ordinary widget state updates through direct `SendComm` as a workaround; that bypasses the durable CRDT state path and weakens multi-peer behavior.
- Avoid head-of-line blocking: large `PutBlob` work must be capped and handled with the flow-control rules in `.context/putblob-sequencing-plan.md` so it does not delay interrupts, runtime logs, widget updates, or sync replies.

## Proposed Logical Flow

Frontend-originated binary widget update:

1. Widget code produces a state patch with binary leaves, for example:
   ```ts
   {
     selection: {
       view: DataView,
       dtype: "uint32",
       shape: [123],
     },
   }
   ```
2. Frontend extracts binary leaves into:
   ```ts
   {
     jsonPatch: {
       selection: {
         view: { blob: "...", size: 492, media_type: "application/octet-stream" },
         dtype: "uint32",
         shape: [123],
       },
     },
     bufferPaths: [["selection", "view"]],
   }
   ```
3. Each extracted buffer is uploaded through `putBlob(bytes, mediaType, purpose)`.
4. Frontend writes `jsonPatch` into RuntimeStateDoc and triggers runtime-state sync.
5. Runtime agent diffs comm state, walks changed values, resolves ContentRefs back into bytes, and sends:
   ```json
   {
     "method": "update",
     "state": {
       "selection": {
         "view": null,
         "dtype": "uint32",
         "shape": [123]
       }
     },
     "buffer_paths": [["selection", "view"]]
   }
   ```
   with `buffers[0]` set to the uploaded bytes.

The placeholder at `state.selection.view` should follow Jupyter widget expectations. Existing Python `ipywidgets` removes buffers by replacing leaves with `null`/placeholder JSON and pairing them with `buffer_paths`. Confirm the exact placeholder shape against a real ipywidgets frontend before implementation.

## Transport

Widget buffers ride the shared notebook-sync socket as one-shot `PutBlob` (`0x08`) frames. See `.context/putblob-sequencing-plan.md` for sequencing across all PutBlob consumers (widgets, attachments, `dx.attach`, SSH remote runtimes) and `.context/2026-04-30-putblob-frame-design.md` for wire shape and flow control.

Frontend API exposed by this plan is just the caller-side wrapper:

```ts
putBlob(bytes: ArrayBuffer, mediaType: string): Promise<{ blob: string; size: number; media_type: string }>
```

Widget selection buffers (jscatter-style, KB–MB) fit inside the one-shot frame cap; no bulk lane is introduced by this plan. Multipart is deferred to the sequencing plan's Phase 5 and is only reached when `dx.attach` or remote-peer replication needs it.

**Ordering invariant:** the frontend MUST await `putBlob` before writing the ContentRef into RuntimeStateDoc. The local runtime-agent shares the blob-store filesystem and sees bytes immediately on return, but the invariant must hold for future remote agents.

## Phase 1: Contract And Test Reproduction

**Files to inspect or modify:**

- `src/components/widgets/anywidget-view.tsx`
- `src/isolated-renderer/widget-bridge-client.ts`
- `src/components/isolated/comm-bridge-manager.ts`
- `src/components/widgets/widget-update-manager.ts`
- `apps/notebook/src/App.tsx`
- `crates/runtimed-wasm/src/lib.rs`
- `crates/runtimed/src/runtime_agent.rs`
- `crates/runtimed/src/output_prep.rs`
- `crates/notebook-protocol/src/protocol.rs`
- `crates/notebook-wire/src/lib.rs` (frame-type constants live here; there is no `frame_types.rs`)

Tasks:

- [ ] Add a focused unit test proving a frontend patch containing `DataView` currently loses the buffer when passed through the RuntimeStateDoc write path.
- [ ] Add a fixture for a jscatter-style patch: `{ selection: { view: DataView, dtype: "uint32", shape: [3] } }`.
- [ ] Confirm the Jupyter placeholder shape for state leaves listed in `buffer_paths`.
- [ ] Decide whether `bufferPaths` should be explicit from the widget bridge or inferred by scanning `DataView` leaves.

## Phase 2: Frontend Buffer Extraction

Add a frontend helper with one responsibility: convert a widget state patch into JSON plus binary uploads.

Candidate file:

- Create `src/components/widgets/comm-buffer-extraction.ts`
- Test `src/components/widgets/__tests__/comm-buffer-extraction.test.ts`

Behavior:

- Walk plain objects and arrays.
- Detect `DataView`, `ArrayBuffer`, and typed arrays.
- Extract bytes as exact byte ranges, respecting `byteOffset` and `byteLength`.
- Replace the binary leaf with the chosen Jupyter placeholder.
- Return `bufferPaths` in the same order as extracted `buffers`.
- Reject unsupported cyclic/non-cloneable values with a clear error.

## Phase 3: Blob Upload Client

Use the one-shot frontend blob upload API from `.context/putblob-sequencing-plan.md` Phase 2.

Candidate files:

- Create `src/lib/blob-upload-client.ts`
- Modify the notebook socket/WebSocket transport layer that currently sends typed frames.
- Add Rust frame support if `PutBlob` frame is not implemented yet.

Behavior:

- `putBlob` computes SHA-256 before upload.
- Send widget buffers as one-shot `PutBlob` frames.
- Reject or defer values larger than the advertised one-shot cap; widget state does not introduce a separate bulk lane.
- Return the existing ContentRef shape: `{ blob, size, media_type }`.
- Expose capability information so callers know whether binary widget updates are supported.

## Phase 4: RuntimeStateDoc Write Path

Modify the frontend widget update path:

- `WidgetBridgeClient.sendUpdate` should preserve local optimistic `DataView` state for the iframe.
- `CommBridgeManager.handleWidgetCommMsg` should pass binary-aware state to the parent update path.
- `WidgetUpdateManager.updateAndPersist` should accept either plain JSON patches or pre-extracted `{ jsonPatch, bufferPaths }`.
- `apps/notebook/src/App.tsx` should upload buffers before calling `set_comm_state_batch`.

Important boundary:

- RuntimeStateDoc stores ContentRefs only.
- The frontend WidgetStore can keep `DataView`s for local responsiveness.
- Echo suppression must compare the user-visible value, not the ContentRef object.

## Phase 5: Runtime Agent Rehydration

Modify the runtime-agent comm diff path:

- `diff_comm_state` currently returns `(comm_id, serde_json::Value)` only.
- Add a helper that walks each delta, finds ContentRefs at binary leaves, loads bytes from `ctx.blob_store`, replaces those leaves with the Jupyter placeholder, and returns `(state, buffer_paths, buffers)`.
- Extend `KernelConnection::send_comm_update` to accept buffer paths and buffers.
- Update `JupyterKernel::send_comm_update` to send real Jupyter comm buffers instead of always emitting `buffer_paths: []`.

This keeps kernel delivery compatible with traitlets serializers such as jscatter's `binary_to_array`.

## Phase 6: (removed)

The original "bulk lane" phase is deleted. If widget buffers ever exceed the one-shot cap, reach for multipart (`.context/putblob-sequencing-plan.md` Phase 5), not a second socket.

## Phase 7: Verification

Targeted tests:

- Frontend extraction tests for `DataView`, typed arrays, nested paths, and arrays.
- Widget bridge tests proving iframe-originated binary state reaches the parent update manager with paths preserved.
- WASM/RuntimeStateDoc tests proving ContentRefs at comm state leaves project back to `bufferPaths`.
- Rust runtime-agent tests proving ContentRefs in a frontend-originated comm delta become Jupyter `buffer_paths + buffers`.
- Browser E2E with jscatter:
  1. render scatter,
  2. lasso points,
  3. execute `jpl.selection`,
  4. assert selected indices remain non-empty and the visual selection does not disappear.

Manual checks:

- Lasso selection in nteract.
- Filter selection in nteract.
- Existing ipywidgets sliders/buttons still update.
- Output widgets still render nested plotly/vega/sift outputs.
- Large stdout/log output remains responsive while a blob upload is active.

Required before commit:

```bash
cargo xtask lint --fix
```

## Open Questions

- What exact placeholder should state use at paths listed in `buffer_paths` when forwarding to the kernel?
- Should frontend extraction infer buffer paths from binary leaves, or should the AFM model proxy track keys that serializers produced?
- Should `PutBlob` return only `{hash, size, media_type}` or the full ContentRef object?
- Should widget updates fail hard or degrade to a logged no-op when the connection lacks `put_blob` capability?
- Do we need multipart now, or is one-shot sufficient until notebook attachments/dx attach land?

## Recommended First PR

After `.context/putblob-sequencing-plan.md` Phase 2 exists, keep the first widget implementation narrow:

1. Add buffer extraction helper and tests.
2. Add runtime-agent rehydration tests around a synthetic comm delta.
3. Wire extracted buffers through the one-shot `putBlob` frontend client.
4. Prove jscatter selection round-trips in a browser E2E.

Defer multipart until one-shot widget buffers are correct.
