# Bokeh Session Documents

**Status:** In progress (2026-10-19). Landed for local-daemon rooms; cloud rooms and protocol follow-ups remain open.

## Done

- Local-daemon `BokehSessionDoc` sync over typed frame `0x0b KeyedDocSync` and generic `keyed_doc` room/agent/kernel/output extensions.
- Kernel launcher delta encoding, byte-ratio column folding, serial outbox with one-off barriers, and correction rule.
- Hub authority and decoded-op content filter, epoch replacement, and freeze/save materialization into output `snapshot`.
- Browser `BokehSessionDocStore`, frame controller, viewer read-only mode, MCP output summaries, and `set_bokeh_property`.
- End-to-end Playwright coverage on Panel 1.9.4 and 1.10.0rc1.

## Next

- Route `bokeh_session` in the cloud room host so hosted Bokeh outputs stay live instead of static.
- Add session unsubscribe and cleanup for unmounted or disconnected documents.
- Close the reliability, GC, launcher, frame, and MCP gaps listed in [Open Follow-ups](#open-follow-ups).

## Context

A Panel or Bokeh output in nteract is a live Bokeh `Document` owned by the kernel. The launcher renders the Panel object into a caller-owned document (`viewable.get_root(doc=doc, comm=None)`), so no PyViz comm manager is involved. `docs/memos/panel-runtime-state.md` covers that producer seam, the initial MIME contract, and the resource manifest.

The first implementation synchronized documents using a kernel-assigned revision counter, a blob-backed checkpoint plus a 32-revision patch tail in `RuntimeStateDoc`, a dedicated patch broadcast, and a browser controller that serialized one patch request at a time. Most of that code was hand-written sync: gap detection, tail catch-up versus checkpoint reconcile, rebasing stale patches, re-applying unsent edits, and a divergence flag. Every revision rewrote the session record (3.7 KB of `RuntimeStateDoc` change per revision, reaching 1.9 MB after 10 minutes of a 20 Hz callback), and every 32 revisions cost a kernel checkpoint round trip.

This ADR replaces that protocol with the `CommsDoc` pattern used by ipywidgets: shared state in an Automerge document, large values in the blob store, and one-off messages on a separate channel.

## Decision

### One Automerge document per session

Each Bokeh session has its own `BokehSessionDoc` (`crates/runtime-doc/src/bokeh_session_doc.rs`), allowing independent replacement:

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

- **JSON-string property values.** Values use Bokeh's own serialized encoding stored as JSON strings, one key per property. Bokeh validates on both ends, each write is one op carrying its actor, and lists such as `children` stay single values. JSON strings measured 63% of the size of native Automerge maps and roughly half the materialize time.
- **Property blob offloading.** Property values over 1 KiB (or over 256 B for arrays and Bokeh `ndarray`/`typed_array`/`bytes` encodings) move to the blob store (`application/vnd.nteract.bokeh-prop.v1+json`) and store a `{blob, size, media_type}` reference.
- **Column blobs.** `ColumnDataSource.data` never lives in `props/`; it lives under `columns/`. Each column blob (`application/vnd.nteract.bokeh-column.v1+json`) holds one Bokeh-encoded column with base64-inlined buffers. For Bokeh 3.8 and later, inlined bytes are gzipped first because BokehJS and Python both gunzip every base64 buffer from 3.8 onward (`ingest.rs::BytesEncoding`).
- **Kernel-only structure.** A Bokeh model graph cannot be reconstructed back into the Panel objects that built it. Browsers and agents never create or remove models and never write reference-valued properties.

`RuntimeStateDoc.bokeh_sessions/{id}` stores topology and lifecycle only: `output_id`, `cell_id`, `execution_id`, `kernel_id`, `status` (`connected | disconnected | closed | error`), producer, `bokeh_version`, `root_ids`, `epoch`, `doc_heads` (hex heads identifying the freshly built epoch document), and `previous_heads`. Policy requires non-empty `doc_heads`, `previous_heads` empty iff `epoch == 0`, no epoch rewind, and identity changes only when `epoch` advances.

The runtime agent owns the authoritative replica (`crates/runtimed/src/bokeh_session/store.rs`), written only under the kernel actor. The room holds a non-writing hub replica per session that syncs with the runtime agent and each notebook peer.

Session documents plug into generic keyed-document sync (`crates/runtimed/src/keyed_doc/`) under kind `bokeh_session`. Generic code names no Bokeh types:

- **Room:** `BokehRoomKind` (`bokeh_session/hub.rs`) implements `KeyedDocKind` (record lookup, write permission, content filter, blob roots, data tail, agent-loss freeze, closed-session removal) and registers in `extensions.rs`.
- **Runtime agent:** `BokehAgentExtension` (`bokeh_session/agent.rs`) owns the store, registers it with `AgentDocs` as a keyed document, claims Bokeh runtime-agent requests, and freezes sessions on kernel loss via `RuntimeAgentExtension`.
- **Kernel:** `bokeh_session/kernel.rs` (`KernelExtension`) routes `nteract_bokeh_delta` from IOPub to ingest and sends patch, fold, and close requests via `KernelShellRequester`.
- **Outputs:** `bokeh_session/output_hook.rs` (`OutputHook`) strips `session_doc` before storage, writes the record in the output's transaction, hands the epoch-0 document to the store after commit, writes `snapshot` at save, declares `snapshot` as mutable replay state, and retires closed sessions.
- **Clients:** `BokehDocHandleExt` in `notebook-sync`, `BokehSessionDocHandle` over the WASM keyed replica, the output-session plugin (`src/components/isolated/bokeh-session-plugin.ts`), and launcher handlers registered via `NteractKernel.register_shell_handler` publishing deltas over `IOPubPublisher`.

### Transport: keyed document sync

Session documents sync over typed frame `0x0b KeyedDocSync` with header `{kind: "bokeh_session", id: <session_id>, epoch}` (`docs/adr/typed-frame-v4-wire-protocol.md`).

- **Capability negotiation.** The daemon advertises `bokeh_session` in `ProtocolCapabilities::keyed_doc_kinds` for local rooms; hosted rooms advertise none. Clients open session documents only when negotiated and otherwise render statically from the payload.
- **Agent gating.** The coordinator tells the runtime agent which kinds it routes via `runtime_agent_capabilities`. Without `bokeh_session` (including on cloud coordinators), the agent creates no session documents, writes no record, and sends no `0x0b`; outputs stay static while the kernel keeps running.
- **Lazy subscription.** A peer subscribes by sending any frame for a session, normally the first sync message of an empty replica for the epoch in `RuntimeStateDoc`. The daemon replies and pushes later changes. Old and Python clients that never send `0x0b` never receive it.
- **Per-epoch sync state.** The hub keeps one `sync::State` per `(connection, session)` and resets it on epoch advance. When the hub moves to a new epoch, it pushes a fresh sync with the new epoch header; peers start a new replica for any newer epoch and drop older frames.
- **Resync on refusal.** Any refusal resets that peer's sync state and sends `{"type": "doc_resync", "kind": "bokeh_session", "id", "epoch", "reason"}`. The peer drops its replica, syncs a fresh one for `epoch`, and rewrites only unaccepted local user edits.

One document per session enables replacement: a subtree inside `CommsDoc` or `RuntimeStateDoc` would retain every tick forever because neither document is pruned. It also aligns authorization with document boundaries ([ADR 0002](0002-comms-document-split.md)): `RuntimeStateDoc` stays read-only to clients, `CommsDoc` stays all-or-nothing for editors, and Bokeh checks its content rules cheaply against one small document (7 to 21 KB measured).

### Kernel to document

The kernel hop stays on Jupyter messages. The launcher (`python/nteract-kernel-launcher/nteract_kernel_launcher/_bokeh_session.py`) normalizes Bokeh document events into a delta and publishes it on IOPub from the calling thread:

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

- **Flush cadence.** The launcher flushes one delta per event-loop iteration while the loop is free. When a running cell blocks the loop, an event arriving after the scheduled flush has waited at least 50 ms flushes inline so intermediate values still stream.
- **Ordering guards.** Nothing flushes before the display message is sent (`_SessionAnnouncer` in `_panel.py`), and flushes wait while Bokeh holds document events so no model publishes before its reference.
- **Epoch-0 bootstrap.** The display payload carries `session_doc` (meta, models, and a `ColumnsFolded` per source at version 0) plus `session_doc_buffers`. The output committer builds the epoch-0 document in the same transaction as the output and `RuntimeStateDoc` record, then strips `session_doc` from the stored payload.
- **Agent ingest.** The runtime agent coalesces deltas per session over 16 ms, offloads large values and columns to the blob store, and commits one Automerge change per flush under the kernel actor (`bokeh_session/ingest.rs`, `store.rs::run_ingest`). Properties for missing models are dropped.
- **Transactional encoding and retries.** The launcher builds each delta atomically. Unencodable values, messages, or columns are logged and omitted; session state (known models, source versions) updates only after the full delta builds. A failed build commits nothing and retries on the next flush, dropping an event after three failures with one error log. Sources with dropped data events refold at their unchanged version to avoid version gaps or missing rows; a dropped property stays stale until it changes again.

### Peers to kernel

- **Property writes.** Browsers and agents write `models/{id}/props/{name}` directly to their replica. The runtime agent diffs keys whose winning actor is not the kernel actor (`receive_sync_and_foreign_props`) and sends `nteract_bokeh_patch_request {patch: {events: [ModelChanged ...]}}` with a fresh `transaction_id` on a dedicated serial shell connection (120 s timeout). The launcher derives the Bokeh setter from the transaction so accepted values are not echoed.
- **Serial outbox and coalescing.** Each kernel has one outbox allowing one patch in flight (`kernel.rs::BokehKernelOutbox`). While waiting, foreign property writes for a session merge into one pending patch with a fresh `transaction_id`, keeping the latest value per `(model, property)` ordered by last write. Dragging a slider during a long cell sends only its final value.
- **Shell reply isolation.** Each shell connection uses a fresh ZMQ identity and skips replies whose parent `msg_id` does not match, so a late reply to a timed-out request cannot satisfy the next request.
- **Correction rule.** After applying a foreign patch, the launcher compares Python's current value for every touched `(model, attr)` against the requested value and publishes every mismatch, even if Bokeh saw no change. On an apply error or pre-apply handler failure, it publishes Python's current value for every touched key so rejected callback values cannot linger in the document.
- **Callback output routing.** Stdout, stderr, and errors from a patch reply append to the session's owning execution.
- **One-off events and barriers.** Button clicks, Panel custom messages (`MessageSent`), and browser data edits go through `NotebookRequest::ApplyBokehSessionPatch {session_id, transaction_id, patch, buffers?, buffer_refs?}`, which accepts only `MessageSent`, `ColumnsStreamed`, and `ColumnsPatched` and replies `accepted | error` after the callback finishes.
  - The frame flushes pending property writes before sending a one-off event.
  - One-off events travel unmerged through the outbox as barriers: earlier property writes go before them, and later writes do not merge across them.
  - At most 256 one-off events queue per kernel; excess requests fail immediately.
  - `document_ready` is filtered in the browser.
- **Kernel broadcasts.** Python-originated messages and data events reach peers as `NotebookBroadcast::BokehSessionEvents {session_id, epoch, transaction_id, data_events?, messages?, buffers?}`, where `buffers` maps Bokeh buffer IDs to blob refs.

### Authority

The hub checks every peer frame in order (`keyed_doc/hub.rs` via `BokehRoomKind` callbacks):

1. **Epoch.** The frame's epoch must match the current epoch (the larger of the hub's epoch and `RuntimeStateDoc`'s record). The runtime agent may run one epoch ahead because it builds epoch `N+1` first.
2. **Write permission.** Viewers never write. Editors and owners write only while the session is `connected`. Only the runtime peer may write structure. Failed permission checks strip changes and continue syncing read-only.
3. **Content and actors (`receive_peer_sync_message_checked`).** The hub applies the message to a clone and decodes every op of every new change. Every op must satisfy all of these rules:
   - It is a string `Put` on the `props` map of a model that existed before the message.
   - Its property name is not in `ref_props`.
   - Its value parses as JSON and contains no model reference at any depth (no `ref` or `object` encoding, and no object with an `id` key lacking a string `type`).
   - Its value uses only Bokeh rep types both deserializers accept: `number`, `array`, `set`, `map`, `bytes`, `slice`, `typed_array`, `ndarray`, `value`, `field`, `expr` (unknown `type` values throw and break every peer's frame).
   - Its value is not shaped like a blob ref (an object with exact keys `blob`, `size`, and `media_type`).
   - Its change actor belongs to the connection's principal and is not the document's epoch (kernel) actor. Without this check, a local same-UID connection could author under operator-only labels such as `rt:kernel:<id>`, which readers trust as Python-authored.
   - Any violation rejects the whole message and leaves both the document and sync state unchanged.

Validating decoded ops instead of the visible diff prevents a losing concurrent op from resurfacing after a later delete. The client pre-check (WASM `set_props_json`, `notebook-sync` `write_peer_props`) shares the same value rules, ensuring only kernel-authored blob refs reach readers, GC roots, and the kernel forwarder.

### Column data

- **Event vocabulary.** Data events are one-off and versioned per source:
  - `ColumnsStreamed {source_id, base_version, new_version, data, rollover}` and `ColumnsPatched {..., patches}` apply via Bokeh's own stream and patch logic, including rollover.
  - `ColumnDataChanged {..., columns, columns_removed}` replaces whole columns and bumps the version.
  - `ColumnsFolded {source_id, version, columns}` carries every column at the current version.
- **Byte-ratio folding.** The launcher folds when stream and patch bytes since the last fold reach twice the last fold's size, after 2 s without events, or on `nteract_bokeh_fold_request`. Fixed event counts fail across table sizes (at 100k rows, folding every 600 events cost 6.1x the old patch size). The byte ratio keeps the kernel hop near 1.5x and connected peers at 1.04–1.06x of the old patch at both small and large sizes.
- **Storage and broadcast rules.** The runtime agent stores streams and patches as ephemeral buffer blobs, broadcasts them, and retains the tail per source since the last fold. A fold writes durable column blobs, updates `columns/` refs, and clears the tail without broadcasting (connected peers already applied the events). A full replacement writes ephemeral column blobs, updates refs, clears the tail, and broadcasts blob refs instead of raw payloads.
- **Late joiners.** Peers request missing tails via `NotebookRequest::GetBokehSessionData {session_id, source_ids?}` (allowed for viewers and without a kernel). If a source's tail exceeds its fold size, the reply lists it in `fold_requested` without events and the agent requests a kernel fold.
- **Deferred folds.** While Bokeh holds events or runs a foreign patch, the launcher replies `{status: "ok", source_ids: [], deferred: true}` and publishes `ColumnsFolded` under the request's `transaction_id` once free. The agent holds that source's fold pending until the reply. If deferred, it stays pending until a fold lands, the source is removed, the epoch advances, or 4 s (twice the quiet-fold interval) elapse. Repeated joins do not stack extra folds, and a lost fold delta cannot wedge later requests.
- **Backpressure and blob retirement.** Under backpressure, a pending full replacement supersedes pending events for a source when it covers every column they touch, keeping intermediate image frames out of the blob store. Superseded column blobs and cleared-tail buffers are deleted after a 60 s grace period so peers can finish fetching recent refs.
  - At deletion, the runtime agent skips hashes still referenced by its own sessions (column refs, offloaded properties, retained tails).
  - It cannot see other runtime agents' sessions or its own frozen sessions still held by the hub.
  - Any hash that becomes current again leaves the retirement list.
- **Browser data edits (Tabulator).** Edits travel to the kernel as one-off events. The launcher re-emits each edit with versions under the request's `transaction_id` and `echo_of` set to its request-patch index; callback-derived events omit `echo_of`. The originating frame adopts the version of marked echoes without re-applying them and applies all other events, including callback-derived ones in the same transaction. On a `base_version` gap, the frame reloads the source from column blobs plus the tail.

### Replacement

The runtime agent replaces a session document when raw change bytes since epoch start exceed `max(512 KiB, 4 × the epoch document's saved size)`, at most once per 60 s (`BokehReplacementPolicy`). On a 20 Hz callback this replaces roughly 0.7 times per minute and keeps the document under 17 KB instead of growing linearly.

- Before building the new document, all foreign-won properties forward to the kernel under the same lock because the replacement authors everything under the kernel actor.
- `build_replacement` builds deterministically from materialized state (identical state produces identical heads), bumps `epoch`, and writes `epoch`, `doc_heads`, and `previous_heads` to `RuntimeStateDoc`.
- Peers drop the old replica and sync the new one. If the browser's last delivered heads match `previous_heads`, it switches without touching BokehJS; otherwise it reconciles the mounted document in place and resets omitted properties to defaults.
- Writes against an old epoch are dropped by the filter. The host rewrites pending local values missing from the new replica only while connected, never for reference properties, and only for writes from the last 10 s.

### Frozen state and persistence

Desktop persists neither `RuntimeStateDoc` nor session documents; only outputs survive in `.ipynb`, so frozen state travels with the output.

- **Hub tail cap.** The room hub retains broadcast data events per source and drops each once its synced document reaches that column version. Retained bytes per source are capped at `max(1 MiB, 4 × the source's folded column bytes)` (twice the launcher's fold trigger). On overflow, the hub clears that source's tail and marks it lost up to the highest dropped version until a fold at or past it syncs. Leaving `connected` drops the session's hub tail.
- **Tail replay and failure modes (`materialize.rs::apply_tail`).** Freeze and save replay the retained tail over folded columns on a blocking thread, decoding and encoding each touched column once.
  - Typed patches cast numeric values like NumPy and fail otherwise.
  - Replay fails on version gaps, missing blobs, lost tails, unwritable values, or unsupported events (multi-dimensional patches, unknown dtypes).
  - On replay failure, freeze falls back to folded state with a warning (the stored payload predates any fold); save keeps the stored payload.
  - A missing value, column, or `doc_extras` blob outside the tail fails materialization completely. A dropped column breaks equal column lengths, and dropped `defs` break custom-model deserialization. Freeze or save keeps the stored payload with a warning; because peers cannot write blob refs, this can come only from a GC or cache bug.
- **Kernel death, restart, or shutdown.**
  - The runtime agent drains already-received ingest deltas, bounded by 5 s (plus 1 s for a lost signal). Restart and shutdown replies wait for this drain (normally milliseconds; slow only if blob writes or uploads stall). The hook cannot tell whether the kernel is restarting, and freezing early would drop final state.
  - The agent removes the kernel's sessions from the store, materializes each (with tail) into Bokeh DocJson (`materialize.rs`: roots expanded, models defined at first reference, columns and blob values inlined), writes that DocJson to `snapshot` (`{document, buffers: []}`), leaves `document` untouched, and marks the session `disconnected`.
  - The write re-reads the output inside its transaction: if the payload changed since read, the newer output wins; otherwise only the Bokeh MIME entry of the current manifest is replaced.
  - On runtime agent loss, the daemon runs the same freeze from the hub and re-saves durable execution records with the frozen `snapshot`.
- **Save path.** Before each save, `snapshot` is populated in memory from the hub's current state plus tail for `connected` sessions only; frozen payloads are already authoritative.
- **Replay compatibility.** Durable execution records keep `document` as displayed and store the latest re-saved `snapshot`. Because the Bokeh MIME declares `snapshot` as mutable replay state, load accepts a saved output differing from its record only in `snapshot` and adopts it; any other change (including `document` or `session_id`) fails with `source_degraded`. Readers (frame, MCP summary) prefer `snapshot.document` over `document`.
- **Read-only terminal states.** Disconnected and closed sessions are read-only: the hub refuses writes, the frame stops writing and shows the disconnected overlay, and a reloaded room renders `snapshot` (or `document` if absent). Rerunning the cell creates a fresh session; old documents are never re-adopted.
- **Blob GC and epochs.** Blob GC treats live session documents and retained tail buffers as roots (`keyed-docs`). Closed sessions drop their hub document and tail; disconnected sessions retain their hub document for mounted pages. Hub epochs never move backward across runtime-agent restarts, and a new agent never resumes an old session.

### Browser

- **Store (`src/components/isolated/bokeh-session-doc-store.ts`).** `BokehSessionDocStore` holds one WASM `BokehSessionDocHandle` per subscribed session, receives `bokeh_session` frames from keyed-document streams, handles resync and reconnect, and delivers ordered `full` and `delta` updates with decoded values to the frame bridge. Columns arrive as versions only; the frame fetches column blobs on demand via `nteract/bokehSessionData`.
- **Frame controller (`src/isolated-renderer/bokeh-session-controller.ts`).** Converts updates into Bokeh JSON patches applied via `deferExistingModelUpdates`, inlining new models at first reference. A live payload with out-of-band buffers mounts from the first full update; the retained tail replays before views are created because views such as Panel's Tabulator drop data changes that arrive before construction finishes.
- **Local writes and echo filtering.**
  - Local BokehJS changes to syncable, non-columnar properties of session-document models serialize with `Serializer({binary: false})`, batch for 50 ms, and write via `nteract/bokehSetProps`.
  - Each delta tags every changed property with its winning writer (`kernel`, `local`, or `peer`): kernel- and peer-won values always apply, remote values wait while a local edit for that property is still unsent, and locally won values match against recent writes for 500 ms after flush.
  - The frame skips property names listed in the document's `ref_props` rather than BokehJS's `may_have_refs`, because generically typed properties (such as panel-material-ui widget values) set `may_have_refs` without holding model references.
- **Viewers and reconnects.** Viewers get read-only replicas: the store neither writes nor rewrites pending values, the bridge refuses `setProps` and `applyPatch`, the frame sends nothing, and the output is labeled `"View only"`. Widgets and plots remain locally interactive until a document update overwrites the same property; a viewer promoted to editor writes only subsequent edits. Session state carries `live` and `writable`; a frame marked `connected` but not `live` (a new bridge after reconnect) reopens and reconciles from a full update.
- **Error recovery.** If the frame fails to build an update, the store marks the session missed and retries a full update with backoff (500 ms doubling to 8 s) while deltas continue flowing. A full update delivered while missed reconciles rather than switching without touching BokehJS.

### Agent access

- **Read.** MCP output summaries (`crates/runtimed-outputs/src/bokeh_summary.rs`) inspect the live replica (or the payload's `snapshot`/`document`) and report widgets (name, value, bounds), text, plots (glyphs, sources), data sources (columns, row counts), tables, and collapsed layouts. Password values are masked.
- **Write.** `set_bokeh_property(cell_id, model, property, value, output_id?, wait_ms?)` writes under the MCP connection's actor using the MCP server's own `0x0b` replica (`crates/notebook-sync/src/bokeh.rs`, `BokehDocHandleExt`). The hub enforces the same authority rules as for browsers, the runtime agent forwards the write to Python as foreign, and the tool description warns that writes execute Python callbacks. Within `wait_ms`:
  - A different kernel-authored value reports `kernel_overwrote` (validation, callbacks, and unrelated updates look identical).
  - Another client's value is reported as held by that client.
  - An unchanged value reports `"accepted by the daemon, not confirmed by Python"`.
  - Other properties changed by the kernel during the wait are listed as kernel changes observed while waiting, not callback effects.
  - If an epoch replacement occurs during the wait, the tool waits for the new document within the remaining time; the write is reported lost unless the new epoch holds the requested value, or unknown if the new document does not sync in time.

### Test-only replacement policy

`NTERACT_TEST_BOKEH_REPLACEMENT=<change bytes>[,<min interval ms>]` overrides the default policy with no saved-size factor so end-to-end tests can trigger replacements in seconds (the Playwright suite uses `16384,3000`). The runtime agent honors it only when `RUNTIMED_DEV=1`; otherwise it is ignored.

## Rejected Alternatives

### Revision counter, checkpoint, and patch tail

The previous protocol made the kernel the revision authority and every browser a hand-written replication client, rewrote the session record on every revision, and required a stale-revision path because Bokeh patches can carry structural changes that cannot merge at the envelope level. Keeping structure kernel-only and syncing property values as a CRDT eliminates the merge problem instead of detecting it.

### Session state inside `CommsDoc` or `RuntimeStateDoc`

Neither document is pruned, so replacement could not bound history, and all sessions would share one sync state. Editor-writable properties in `RuntimeStateDoc` would also reintroduce the carve-out removed by [ADR 0002](0002-comms-document-split.md).

### JSON sync bytes over `NotebookRequest`/`NotebookBroadcast`

Adds base64 overhead, lacks sync state, and mixes document sync onto broadcasts reserved for ephemeral events.

### Column data inside the document

Streaming plots would grow CRDT history on every tick. Versioned one-off events plus byte-ratio folds keep per-tick cost close to the old patch size while keeping the document small.

## Open Follow-ups

- **Cloud routing:** Cloud rooms do not route `bokeh_session`; outputs from a cloud runtime agent stay static until the cloud room host implements the kind.
- **No unsubscribe:** The protocol has no unsubscribe. Browser hosts and MCP connections keep receiving pushes for unmounted sessions, and the hub retains disconnected documents for the room's lifetime.
- **Unbounded agent tail and fold rate:** The runtime agent's retained data tail lives in memory and is bounded only by launcher folds (unlike the capped hub tail); on-demand folds trigger only on joins and are not rate-limited.
- **Live payload buffer GC gap:** Blob GC roots do not cover buffers referenced by a live payload's `buffers` descriptors; they currently rely on the 60 s GC grace period.
- **Lost one-off patch replies:** An `ApplyBokehSessionPatch` reply lost during a runtime-agent reconnect is not replayed; the request times out at the daemon.
- **Inline peer large values:** Browser- and agent-written property values larger than the blob cutoff stay inline in the document.
- **One-off event ordering:** Ordering between a one-off event and an immediately preceding property write relies on the frame flushing property writes first; no document heads travel with the event.
- **MCP unconfirmed writes:** Python never confirms a value it accepted unchanged, so `set_bokeh_property` can only report it as accepted by the daemon.
- **MCP password exposure in raw payloads:** Raw session payloads reach `structuredContent` as blob URLs, so passwords in saved documents are not masked there.
- **MCP large blob summaries:** Blob-backed values over 64 KB are summarized by size only.
- **Launcher unannounced sessions:** A Panel session whose mimebundle is formatted but never published stays unannounced and accumulates events.
- **Launcher `apply_patch` held events:** Deltas built inside `apply_patch` do not wait for held events.
- **Launcher Panel parameter drift:** A Panel parameter that diverges from its Bokeh model is invisible to the correction rule.
- **Frame initial reconcile race:** A live payload without out-of-band buffers mounts from the payload and then reconciles, so a data change in that first reconcile can reach a view before it finishes building.
- **Frame echo after gap reload:** A data edit whose echo arrives after a gap reload is adopted without being reapplied.
- **Automerge legacy op types:** The content filter uses `automerge::legacy` op types, which are public but `#[doc(hidden)]`; an Automerge upgrade could change them.
