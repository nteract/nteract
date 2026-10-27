# Bokeh Session Documents

**Status:** In progress (2026-10-19): implemented for local-daemon rooms and covered by Playwright on Panel 1.9.4 and 1.10.0rc1; cloud rooms and the follow-ups below remain open.

## Context

A Panel or Bokeh output in nteract is a live Bokeh `Document` owned by the kernel. The launcher renders the Panel object into a caller-owned document (`viewable.get_root(doc=doc, comm=None)`), so no PyViz comm manager is involved; `docs/memos/panel-runtime-state.md` describes that producer seam, the initial MIME contract and the resource manifest.

The first implementation synchronized the document with a kernel-assigned revision counter, a blob-backed checkpoint plus a patch tail of up to 32 revisions in `RuntimeStateDoc`, a dedicated patch broadcast, and a browser controller that serialized one patch request at a time. Most of its code was hand-written sync: gap detection, tail catch-up versus checkpoint reconcile, rebasing stale patches, re-applying unsent edits and a divergence flag. Every revision rewrote the session record (3.7 KB of `RuntimeStateDoc` change per revision, 1.9 MB after 10 minutes of a 20 Hz callback), and every 32 revisions cost a kernel checkpoint round trip.

This ADR replaces that protocol with the pattern ipywidgets use through `CommsDoc`: shared state in an Automerge document, large values in the blob store, one-off messages on a separate channel.

## Decision

### One Automerge document per session

Each Bokeh session has its own `BokehSessionDoc` (`crates/runtime-doc/src/bokeh_session_doc.rs`), so it can be replaced on its own:

```text
schema_version
epoch                      incremented on each replacement
meta/                      session_id, producer_name, producer_version, bokeh_version,
                           root_ids, title, doc_extras (DocJson defs/config)
models/{id}/
  type                     Bokeh model name
  ref_props                properties that can hold model references (Python `has_ref`)
  props/{name}             Bokeh-encoded JSON value; references stored as {"id": ...}
columns/{source_id}/{col}  {blob, size, version} for ColumnDataSource data
```

- Values are Bokeh's own serialized encoding stored as JSON strings, one key per property, so Bokeh validates on both ends and each write is one op carrying its actor. Lists such as `children` are single values. JSON strings measured 63% of the size of native Automerge maps and about half the materialize time.
- Property values over 1 KiB, or over 256 B for arrays and Bokeh `ndarray`/`typed_array`/`bytes` encodings, are stored in the blob store (`application/vnd.nteract.bokeh-prop.v1+json`) and referenced as `{blob, size, media_type}`.
- `ColumnDataSource.data` is never a property; it lives under `columns/`. Column blobs (`application/vnd.nteract.bokeh-column.v1+json`) hold one Bokeh-encoded column with buffers inlined as base64. For Bokeh 3.8 and later the inlined bytes are gzipped first, because BokehJS and Python both gunzip every base64 buffer from 3.8 on (`ingest.rs::BytesEncoding`).
- Structure is kernel-only. A Bokeh model graph cannot be turned back into the Panel objects that produced it, so browsers and agents never create or remove models or write reference-valued properties.

`RuntimeStateDoc.bokeh_sessions/{id}` keeps topology and lifecycle only: `output_id`, `cell_id`, `execution_id`, `kernel_id`, `status` (`connected | disconnected | closed | error`), producer, `bokeh_version`, `root_ids`, `epoch`, `doc_heads` (hex heads of the freshly built epoch document, which identify it) and `previous_heads`. Policy requires non-empty `doc_heads`, `previous_heads` empty exactly at epoch 0, no epoch rewind, and identity changes only with the epoch.

The runtime agent owns the authoritative replica (`crates/runtimed/src/bokeh_session/store.rs`, written only under the kernel actor). The room keeps a hub replica per session that never writes; it syncs with the runtime agent and with each notebook peer.

Session documents are the `bokeh_session` kind of the generic keyed document sync (`crates/runtimed/src/keyed_doc/`). Bokeh plugs into generic seams and generic code names no Bokeh types:

- Room: `BokehRoomKind` (`bokeh_session/hub.rs`) implements `KeyedDocKind` (record lookup, write permission, content filter, blob roots, data tail, agent-loss freeze, closed-session removal), registered in `extensions.rs`.
- Runtime agent: `BokehAgentExtension` (`bokeh_session/agent.rs`) owns the store, registers it with `AgentDocs` as a keyed document, claims the Bokeh runtime-agent requests and freezes sessions on kernel loss through `RuntimeAgentExtension`.
- Kernel: `bokeh_session/kernel.rs` is a `KernelExtension` that routes `nteract_bokeh_delta` from IOPub to ingest and sends patch, fold and close requests through the kernel's `KernelShellRequester`.
- Outputs: `bokeh_session/output_hook.rs` is the MIME's `OutputHook` (strips `session_doc` before storage, writes the record in the output's transaction, hands the epoch-0 document to the store after commit, writes `snapshot` at save, declares `snapshot` as mutable replay state, retires closed sessions).
- Clients: `BokehDocHandleExt` in `notebook-sync`, a `BokehSessionDocHandle` over the WASM keyed replica, the output-session plugin in `src/components/isolated/bokeh-session-plugin.ts`, and the launcher's handlers registered through `NteractKernel.register_shell_handler` with deltas sent through `IOPubPublisher`.

### Transport: keyed document sync

Session documents sync over typed frame `0x0b KeyedDocSync` with header `{kind: "bokeh_session", id: <session_id>, epoch}` (`docs/adr/typed-frame-v4-wire-protocol.md`). The daemon lists `bokeh_session` in `ProtocolCapabilities::keyed_doc_kinds` for local rooms; hosted rooms list nothing. Clients open session documents only when the kind is negotiated, and otherwise render Bokeh outputs statically from the payload. The coordinator tells the runtime agent which kinds it routes (`runtime_agent_capabilities`); without `bokeh_session` the agent creates no session documents, writes no record and sends no `0x0b`, so the output stays static and the kernel keeps running. A cloud coordinator advertises none.

- A peer subscribes by sending any frame for a session, normally the first sync message of an empty replica for the epoch in `RuntimeStateDoc`. The daemon replies and then pushes later changes. Old and Python clients that never send `0x0b` never receive it.
- The hub keeps one `sync::State` per (connection, session) and resets it when the epoch moves. When the hub moves to a new epoch it pushes a fresh sync with the new epoch in the header; peers start a new replica for any newer frame epoch and drop older frames.
- Any refusal resets that peer's sync state and sends session control `{"type": "doc_resync", "kind": "bokeh_session", "id", "epoch", "reason"}`. The peer drops its replica, syncs a new one for `epoch`, and rewrites only values the user changed that were never accepted.

A separate document per session is what makes replacement possible: a subtree of `CommsDoc` or `RuntimeStateDoc` would keep every tick forever, because those documents are never pruned. It also keeps authorization aligned with document boundaries ([ADR 0002](0002-comms-document-split.md)): `RuntimeStateDoc` is read-only to clients, and `CommsDoc` is all-or-nothing for editors, while Bokeh needs content rules that are cheap to check against one small document (7 to 21 KB measured).

### Kernel to document

The kernel hop stays on Jupyter messages. The launcher (`python/nteract-kernel-launcher/nteract_kernel_launcher/_bokeh_session.py`) turns Bokeh document events into a normalized delta and publishes it on IOPub from the calling thread:

```text
nteract_bokeh_delta
  schema_version, session_id, transaction_id
  models_added:   {id: {type, ref_props, props: {name: json}}}
  props_changed:  {id: {name: json}}       current Python values, never event.new
  models_removed: [id]                     by diffing document models before and after
  data_events:    [...]                    see Column data
  messages:       [{msg_type, msg_data}]   Python-originated MessageSent events
  meta?:          {root_ids, title}        partial; merged into the stored meta
  buffers:        [{id, hash, size, buffer_index}] plus ZMQ buffers
```

- One delta per loop iteration while the loop is free. When the loop is blocked by a running cell, an event that arrives after the scheduled flush has waited at least 50 ms flushes inline, so a running cell streams intermediate values.
- Nothing flushes before the session's display message has been sent (`_SessionAnnouncer` in `_panel.py`), and flushes wait while Bokeh holds document events, so a model is never published before the reference to it.
- The display payload carries `session_doc` (meta, models and a `ColumnsFolded` per source at version 0) and `session_doc_buffers`. The output committer builds the epoch-0 document from it in the same transaction that writes the output and the `RuntimeStateDoc` record, then strips `session_doc` from the stored payload.
- The runtime agent coalesces deltas per session over 16 ms, moves large values and column data to the blob store, and applies one Automerge change per flush under the kernel actor (`bokeh_session/ingest.rs`, `store.rs::run_ingest`). Props for models the document lacks are dropped.

### Peers to kernel

- Browsers and agents write `models/{id}/props/{name}` directly in their replica. The runtime agent diffs changes whose winning actor is not the kernel actor (`receive_sync_and_foreign_props`), and sends the kernel `nteract_bokeh_patch_request {patch: {events: [ModelChanged ...]}}` with a fresh `transaction_id` on a dedicated serial shell connection (120 s timeout). The launcher derives the Bokeh setter from the transaction, so accepted values are not echoed.
- Correction rule: after applying a foreign patch, the launcher compares the current Python value of every touched `(model, attr)` with the requested value and publishes each one that differs, even when Bokeh saw no change. On an apply error, or a handler failure before applying, it publishes the current value of every touched key. Without this, a value a callback rejects would stay wrong in the document.
- Callback stdout, stderr and errors from the patch reply are appended to the session's owning execution.
- One-off events (`MessageSent` such as button clicks and Panel custom messages, and browser data edits) go through `NotebookRequest::ApplyBokehSessionPatch {session_id, transaction_id, patch, buffers?, buffer_refs?}`, which accepts only `MessageSent`, `ColumnsStreamed` and `ColumnsPatched`. The reply is `accepted | error` after the callback ran. The frame flushes pending property writes before sending a one-off event. `document_ready` is filtered in the browser.
- Python-originated messages and data events reach peers as `NotebookBroadcast::BokehSessionEvents {session_id, epoch, transaction_id, data_events?, messages?, buffers?}`, where `buffers` maps Bokeh buffer ids to blob refs.

### Authority

The hub applies these checks to every peer frame, in order (`keyed_doc/hub.rs` with `BokehRoomKind` callbacks):

1. Epoch: the frame's epoch must match the current one (the larger of the hub's and the `RuntimeStateDoc` record's). The runtime agent connection may run one epoch ahead because it builds N+1 first.
2. Write permission: viewers never write; editors and owners write only while the session is `connected`; the runtime peer may write structure. A failed check strips the changes and keeps syncing read-only.
3. Content and actors (`receive_peer_sync_message_checked`): the message is applied to a clone and every op of every new change is decoded. Only string puts on the `props` map of a model that existed before the message, to a name not in `ref_props`, with a value that parses as JSON, are allowed, and every change actor must belong to the connection's principal. Anything else rejects the whole message and leaves the document and sync state unchanged.

The filter validates decoded ops rather than the visible diff, because a losing concurrent op that a diff would not show can resurface after a later delete.

### Column data

- Data events are one-off and versioned per source: `ColumnsStreamed {source_id, base_version, new_version, data, rollover}` and `ColumnsPatched {..., patches}` are applied by each side with Bokeh's own stream and patch, including rollover. `ColumnDataChanged {..., columns, columns_removed}` replaces whole columns and bumps the version. `ColumnsFolded {source_id, version, columns}` carries every column at the current version.
- The launcher folds when the stream and patch bytes since the last fold reach twice the last fold's size, after 2 s without events, or on request (`nteract_bokeh_fold_request`). A fixed event count could not fit both small and large tables (at 100k rows, folding every 600 events cost 6.1x the old patch size); the byte ratio keeps the kernel hop at about 1.5x and a connected peer at 1.04 to 1.06x of the old patch at both sizes.
- The runtime agent stores streams and patches as ephemeral buffer blobs, broadcasts them, and retains them per source since the last fold. A fold stores durable column blobs, moves the `columns/` refs and clears the tail; it is not broadcast, because connected peers already applied the events. A full replacement stores ephemeral column blobs, moves the refs, clears the tail and is broadcast with blob refs instead of payloads.
- Late joiners use `NotebookRequest::GetBokehSessionData {session_id, source_ids?}`, answered from the runtime agent with the tail (allowed for viewers, and without a kernel). A source whose tail exceeds its fold size is listed in `fold_requested` without its events, and the agent asks the kernel to fold.
- Under backpressure a pending full replacement replaces the source's pending events when it covers every column they touch, so intermediate image frames never reach the blob store. Superseded column blobs and cleared-tail buffers are deleted after a 60 s grace, so peers that just received a ref can still fetch it. At deletion the runtime agent's store skips any hash still referenced by one of its sessions (column refs, offloaded property values, retained tails); it does not see other runtime agents' sessions or its own frozen sessions still held by the hub, and a hash that becomes current again leaves the retirement list.
- Browser data edits (Tabulator) go to the kernel as one-off events. The launcher re-emits each one with versions under the request's `transaction_id` and `echo_of` set to its index in the request patch; events derived from Python callbacks carry no `echo_of`. The originating frame adopts the version of the marked echo without applying it again and applies every other event, including callback-derived events in its own transaction. A frame that sees a `base_version` gap reloads the source from its blobs plus the tail.

### Replacement

The runtime agent replaces a session document when the raw change bytes since the epoch exceed `max(512 KiB, 4 × the epoch document's saved size)`, at most once per 60 s (`BokehReplacementPolicy`). Measured on a 20 Hz callback this replaces about 0.7 times a minute and keeps the document under 17 KB; without replacement it grows linearly.

- Before building the new document, every foreign-won property is forwarded to the kernel under the same lock, because the new document authors everything under the kernel actor.
- `build_replacement` builds deterministically from the materialized state (same state, same heads), bumps `epoch`, and the agent writes `epoch`, `doc_heads` and `previous_heads` to `RuntimeStateDoc`.
- Peers drop the old replica and sync the new one. The browser switches without touching BokehJS when the heads it delivered to the frame equal `previous_heads`; otherwise it reconciles the new state into the mounted document in place, resetting omitted properties to their defaults.
- Writes made against an old epoch are dropped by the filter. The host rewrites pending values the new replica lacks, only while connected, never for reference properties, and only for values written in the last 10 s.

### Frozen state and persistence

Desktop persists neither `RuntimeStateDoc` nor the session documents; only outputs come back from the `.ipynb`. So the frozen state travels with the output:

- The room hub also retains the data events from the runtime agent's broadcasts per source, dropping each once its synced document shows a column version at or past it. Retained bytes per source are capped at `max(1 MiB, 4 × the source's folded column bytes)`, twice the launcher's fold trigger; on overflow the hub clears that source's tail and marks it lost up to the highest dropped version until a fold at or past it syncs. A session's hub tail is dropped once its record leaves `connected`.
- Frozen and saved states replay the retained tail over the folded columns (`materialize.rs::apply_tail`, on a blocking thread, decoding and encoding each touched column once). Typed patches cast numeric values like NumPy and fail otherwise; a version gap, missing blob, lost tail, unwritable value or unsupported event (multi-dimensional patches, unknown dtypes) fails the replay. A freeze then uses the folded state with a warning, since the stored payload is older than any fold; a save keeps the stored payload.
- On kernel death, restart or shutdown, the runtime agent removes the kernel's sessions from the store, materializes each (with its tail) into Bokeh DocJson (`materialize.rs`: roots expanded, models defined at first reference, columns and blob values inlined), writes that DocJson into the payload's `snapshot` key (`{document, buffers: []}`), leaves `document` as displayed, and marks the session `disconnected`. On runtime agent loss the daemon does the same from the hub and then re-saves the durable execution records with the frozen `snapshot`.
- Before each save, the saved payload's `snapshot` is set in memory to the hub's current state plus tail, only for sessions whose record is `connected`; frozen payloads are authoritative.
- The durable execution record keeps `document` as displayed; its `snapshot` is whatever the last re-save wrote. The Bokeh MIME declares `snapshot` as mutable replay state, so load accepts a saved output that differs from its record only in `snapshot` and adopts the saved payload; any other difference, including in `document` or `session_id`, still fails with `source_degraded`. Readers (frame, MCP summary) prefer `snapshot.document` over `document`.
- A disconnected or closed session is read-only: the hub refuses writes, the frame stops writing and shows the disconnected overlay, and a reloaded room renders the payload's `snapshot` (or `document` when there is none). Rerunning the cell creates a new session; nothing re-adopts an old document.
- Blob GC treats live session documents and retained tail buffers as roots (`keyed-docs`). A closed session's hub document and tail are removed; disconnected sessions keep their hub document for mounted pages. Hub epochs never move backwards across runtime-agent restarts, and a new agent never resumes an old session.

### Browser

- `BokehSessionDocStore` (`src/components/isolated/bokeh-session-doc-store.ts`) holds one WASM `BokehSessionDocHandle` per subscribed session, receives `bokeh_session` frames from the sync engine's keyed-document streams, handles resync and reconnect, and delivers ordered `full` and `delta` updates with decoded values to the frame bridge. Columns are delivered as versions only; the frame fetches column blobs on demand through `nteract/bokehSessionData`.
- The frame controller (`src/isolated-renderer/bokeh-session-controller.ts`) turns updates into Bokeh JSON patches applied through `deferExistingModelUpdates`, inlining new models at their first reference. A live payload with out-of-band buffers mounts from the first full update; the retained tail is replayed before views are created, because some views (Panel's Tabulator) drop data changes that arrive before they finish building.
- Local BokehJS changes to syncable, non-columnar properties of models in the session document are serialized with `Serializer({binary: false})`, batched for 50 ms and written with `nteract/bokehSetProps`. Each delta carries the winning writer of every changed property (`kernel`, `local` or `peer`): values won by the kernel or another peer are always applied, a remote value is held back while a local edit for that property is still unsent, and only values this host won are matched against its recent writes for 500 ms after the flush. The frame skips names in the document's `ref_props` rather than properties BokehJS marks `may_have_refs`, because generically typed properties such as panel-material-ui widget values carry that flag without holding references.

### Agent access

- Read: MCP output summaries (`crates/runtimed-outputs/src/bokeh_summary.rs`) describe a session from a live replica, or from the payload's `snapshot` or `document` when there is none: widgets with name, value and bounds, text, plots with glyphs and sources, data sources with columns and row counts, tables, and collapsed layouts. Password values are masked.
- Write: `set_bokeh_property(cell_id, model, property, value, output_id?, wait_ms?)` writes a property value as the MCP connection's actor. The MCP server keeps its own replica over `0x0b` (`crates/notebook-sync/src/bokeh.rs`, `BokehDocHandleExt`), exactly like a browser, so the hub applies the same authority rules and the runtime agent forwards the write to Python as foreign. The tool reports `acknowledged`, `corrected` (the kernel won the property back) and callback side effects observed within `wait_ms`. Its description says writes run Python callbacks.

### Test-only replacement policy

`NTERACT_TEST_BOKEH_REPLACEMENT=<change bytes>[,<min interval ms>]` replaces the default policy with no saved-size factor so end-to-end tests can force replacements in seconds (the Playwright suite uses `16384,3000`). It is read by the runtime agent and honored only in dev mode (`RUNTIMED_DEV=1`); otherwise it is ignored.

## Rejected Alternatives

### Revision counter, checkpoint and patch tail

The previous protocol. It made the kernel the revision authority and every browser a hand-written replication client, wrote the session record on every revision, and needed a stale-revision path because Bokeh patches can contain structural changes that cannot be merged at the envelope level. Keeping structure kernel-only and syncing property values as a CRDT removes the merge problem instead of detecting it.

### Session state inside `CommsDoc` or `RuntimeStateDoc`

Neither document is pruned, so replacement could not bound history, and all sessions would share one sync state. Editor-writable properties in `RuntimeStateDoc` would reintroduce the carve-out ADR 0002 removed.

### JSON sync bytes over `NotebookRequest`/`NotebookBroadcast`

Adds base64 overhead and has no sync state, and broadcasts are reserved for ephemeral events.

### Column data inside the document

Streaming plots would grow history with every tick. Versioned one-off events plus byte-ratio folds keep per-tick cost near the old patch size and the document small.

## Open Follow-ups

- Cloud rooms do not route `bokeh_session`: outputs from a cloud runtime agent stay static until the cloud room host implements the kind.
- The protocol has no unsubscribe. Browser hosts and MCP connections keep receiving pushes for sessions they no longer show, and the hub keeps disconnected documents for the room's lifetime.
- The runtime agent's retained data tail is in memory and bounded only by the launcher's folds (the hub's is capped); on-demand folds are triggered only by joins and are not rate limited.
- GC roots do not cover buffers referenced by a live payload's `buffers` descriptors; they rely on the GC grace period.
- An `ApplyBokehSessionPatch` reply lost to a runtime agent reconnect is not replayed; the request times out at the daemon.
- Browser- and agent-written values larger than the blob cutoff stay inline in the document.
- Ordering between a one-off event and a property change made just before it relies on the frame flushing property writes first; no document heads travel with the event.
- MCP: Python's acceptance is inferred from the absence of a correction within `wait_ms`; raw session payloads reach `structuredContent` as blob URLs, so a password in the saved document is not masked there; blob-backed values over 64 KB are shown only by size.
- Launcher: a Panel session whose mimebundle is formatted but never published stays unannounced and accumulates events; the delta built inside `apply_patch` does not wait for held events; a Panel parameter that diverges from its Bokeh model is invisible to the correction rule.
- Frame: a live payload without out-of-band buffers mounts from the payload and then reconciles, so a data change in that first reconcile can still reach a view that has not finished building; a data edit whose echo arrives after a gap reload is adopted without being reapplied.
- The content filter uses `automerge::legacy` op types, which are public but `#[doc(hidden)]`; an Automerge upgrade could change them.
