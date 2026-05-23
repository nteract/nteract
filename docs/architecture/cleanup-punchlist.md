# Architecture Cleanup Punchlist

**Status:** Living. 2026-05-22.
**Source:** Gaps surfaced while drafting `typed-frame-v4-wire-protocol.md`, `three-document-split.md`, `execution-pipeline.md`, and `blob-storage-and-content-addressing.md`.

This is a triage list, not a plan. Each item is a real smell found in code while writing the ADRs. Severity is intent-of-fix, not bug-blast-radius.

Severity legend:

- **Inline:** documentation correction, stale comment, dead row in a table. Safe to fix in this branch alongside the ADR.
- **Targeted PR:** a one-or-two-file behavior or invariant fix. Own PR after the ADRs land.
- **Design:** needs an ADR decision (or extension of one of the four) before code moves. Track here; do not touch code.

## Wire protocol

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| WP-1 | `crates/notebook-wire/AGENTS.md` documents a `Handshake::Blob` channel variant that does not exist. Blob uploads ride `NotebookSync` as `0x08`. | Inline | `crates/notebook-wire/AGENTS.md` |
| WP-2 | Two presence size caps disagree: `frame_size_limits(PRESENCE).cap = 1 MiB` (wire crate) vs `MAX_PRESENCE_FRAME_SIZE = 4 KiB` (`notebook-doc::presence`). A 5 KiB CBOR presence frame passes one layer and fails the next. | Targeted PR | `crates/notebook-wire/src/lib.rs`, `crates/notebook-doc/src/presence.rs` |
| WP-3 | Contract test `frame_type_constants_match_ts_transport` checks discriminants but not per-type caps. `packages/runtimed/src/transport.ts::frameSizeLimits` can silently diverge from the Rust table. | Targeted PR | `crates/notebook-protocol/src/protocol.rs`, `packages/runtimed/src/transport.ts` |
| WP-4 | `0x01`/`0x02` frame IDs are reused with different envelopes between `RuntimeAgent` and `NotebookSync` channels. Distinguishable only by handshake variant; a misrouted frame deserializes incorrectly with no protocol-level detection. | Design | `crates/notebook-protocol/`, `crates/runtimed/` |
| WP-5 | Integration test `test_pipe_mode_only_pipes_allowed_frame_types` excludes `RESPONSE` from pipe-mode while `crates/notebook-sync/src/relay_task.rs::pipe_frame` includes it for the relay-mode path. Different code paths, but naming overlap is misleading. | Inline | code comment + ADR cross-ref |
| WP-6 | `frame_size_limits` default fallback for unknown frame types is the outer 100 MiB ceiling. A typo in a new variant's cap clause silently lands on the ceiling. | Targeted PR | `crates/notebook-wire/src/lib.rs` |
| WP-7 | `PROTOCOL_VERSION` is `u32` but serialized as `u8`. Compile-time asserted to fit, but the 4-byte constant vs 1-byte wire field is a footgun. | Targeted PR | `crates/notebook-wire/src/lib.rs` |
| WP-8 | `ProtocolCapabilities.protocol_version: Option<u32>` is set, defaults to `Some(PROTOCOL_VERSION)`, but no client reads it differently from the preamble byte. Possibly vestigial. | Design | `crates/notebook-protocol/` |
| WP-9 | Pool and SettingsSync channels use untyped framing; the wire crate's AGENTS.md doesn't call out which channels use typed vs untyped frames. | Inline | `crates/notebook-wire/AGENTS.md` |
| WP-10 | No application-layer heartbeat for typed-frame connections. Presence has room-level heartbeats; the connection itself only has `daemon.idle_peer_timeout()`. | Design | `crates/runtimed/src/notebook_sync_server/peer_loop.rs` |
| WP-11 | `recv_typed_frame` reads and allocates the body buffer up to the per-type cap *before* `try_from` rejects the unknown type. For unknown frame types the cap falls back to the outer 100 MiB ceiling, so a v4 daemon receiving forward-compat unknown bytes can allocate up to 100 MiB before skipping. | Targeted PR | `crates/notebook-protocol/src/connection/framing.rs:204-222` |

## Three-document split

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| 3D-1 | `cells[cell_id].execution_count` lives in **both** `NotebookDoc` (legacy JSON-string) and `RuntimeStateDoc.executions[execution_id].execution_count` (live i64). Frontend consults live first, falls back to legacy. Two sources of truth for one number. | Targeted PR | `crates/notebook-doc/`, frontend reader |
| 3D-2 | `last_saved` lives in `RuntimeStateDoc`, which does not persist. A reopened room has no record of its last save time. | Targeted PR | `crates/runtime-state/` (move to `NotebookDoc` or use `.ipynb` mtime) |
| 3D-3 | `comms/*/outputs` inline output manifests, bypassing the blob path that `executions/*/outputs` uses. Two output-storage paths in one document. | Design | output manifest path |
| 3D-4 | `RuntimeStateDoc` editor-scope writes are restricted by client convention only. The daemon's ingress validator (`peer_runtime_sync.rs:80-107`) checks actor-principal forgery but not paths. A custom client crafting changes to `executions/*/status` would pass. | Design | `crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs` |
| 3D-5 | No cross-doc heads correlation is produced or stored. Snapshot/audit/replay flows need a `(notebook_heads, runtime_heads)` pair; nothing writes one. | Design | snapshot publishing path |
| 3D-6 | `PoolDoc` does not participate in the clone-preview validator. Mitigation is `strip_changes`, not `validate`. Future write-bearing pool features would need the validator path wired back in. | Design | `crates/runtimed/src/notebook_sync_server/` |

## Execution pipeline

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| EP-1 | `flush_then_signal_commits_stream_before_lifecycle_signal` test verifies signal arrival order, not durable Automerge change order. A refactor that re-routes `ExecutionDone` past the priority path would still pass. | Targeted PR | `crates/runtimed/src/stream_committer.rs` test |
| EP-2 | `is_lifecycle()` is `debug_assert!` only. No release-build enforcement, no CI lint. A `SendCommUpdate` accidentally routed onto the lifecycle channel passes in production. | Targeted PR | `crates/runtimed/src/stream_committer.rs` |
| EP-3 | No daemon-side execution watchdog. A panic or task drop between final output write and `set_execution_done` leaves execution in `running` forever; consumers time out client-side. | Targeted PR | `crates/runtimed/src/runtime_agent.rs` |
| EP-4 | Periodic-flush drop telemetry (`stream_committer.request_flush`, `try_send_comm_update`) logs at `debug`. Production-default log levels have no signal that replay or stream flushes are being shed. | Inline | log-level promotion |
| EP-5 | Capacity constants (`STREAM_COMMITTER_QUEUE_CAPACITY = 32`, `MAX_PENDING_DISPLAY_IDS = 128`, `DEFAULT_OUTPUT_SYNC_GRACE = 500ms`) picked by judgment. No benchmark, no drop-rate metric, no measured upper bound under load. | Design | telemetry + tuning pass |
| EP-6 | `required_heads` is `NotebookDoc`-only. No causal gate exists for requests that depend on recent `RuntimeStateDoc` writes. | Design | request handling |
| EP-7 | `update_display_data` buffer coalescing drops earlier binary buffers when two updates for the same display_id carry different sets. Correct per semantics; the contract isn't named anywhere. | Inline | doc comment on the coalescing path |
| EP-8 | "IOPub reader cannot block on bounded queues" is discipline, not a check. Adding `.await` on a bounded send in any IOPub handler arm would silently reintroduce the backpressure failure. | Targeted PR | IOPub handlers, lint or type-level enforcement |
| EP-9 | Run-all timeouts are shared across the batch; a long first cell starves the budget for later cells. No fairness mechanism. | Design | run-all path |
| EP-10 | Runtime agent `select!` is not `biased;`. Brief window where work could be selected before lifecycle drain. Drain inside the work-arm body closes this for already-pending signals, not for ones that arrive during work selection. | Targeted PR | `crates/runtimed/src/runtime_agent.rs` |
| EP-11 | `flush_then_signal` empty-flushes fast path: when `flushes` is empty, the signal is sent directly on `lifecycle_tx` bypassing the priority committer. A no-output execution's `ExecutionDone` races freely with `KernelIdle` on the same channel. | Targeted PR | `crates/runtimed/src/stream_committer.rs:106-109` |
| EP-12 | `KernelDied` is also sent from the committer supervisor on panic, not only from IOPub disconnect. The committer crash → queue release tie is load-bearing but not documented. | Inline | doc comment + ADR cross-ref |
| EP-13 | `try_send_comm_update` `Closed` arm logs at `warn`, while the `Full` arm logs at `debug`. Asymmetric severity for two paths that both represent loss of replay. | Inline | log-level consistency |

## Blob storage

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| BS-1 | `GET /blob/<hash>` loads the entire payload into `Vec<u8> -> Full<Bytes>`. A 100 MiB output allocates the full payload on every fetch instead of streaming from disk. | Targeted PR | blob HTTP server |
| BS-2 | `put_disk` fast-path rewrites the sidecar `media_type` when a duplicate write disagrees. Intentional for anywidget `_esm`, but means any authenticated peer can change the served `Content-Type` of an existing blob. | Design | `crates/runtimed/src/blob/` |
| BS-3 | `MULTIPART_UPLOAD_TTL = 1h` only sweeps on the next Create/Complete/Abort. An idle daemon retains expired staging dirs forever. | Targeted PR | multipart sweep |
| BS-4 | `NotebookHandle.load_snapshot` and the publish artifacts spec assume the destination can resolve every `ContentRef::Blob`. Nothing walks a saved `RuntimeStateDoc` and confirms its blob hashes exist before declaring publish complete. | Design | publish path |
| BS-5 | Blob HTTP responds with `Access-Control-Allow-Origin: *` plus loopback only. Fine for single-user desktop; the moment a daemon serves more than one OS user or accepts a remote peer, any peer that knows a hash gets the blob regardless of room ownership. Hash unguessability is the only mitigation. | Design | identity gate on blob HTTP |
| BS-6 | `BlobStore` hard-codes the filesystem. `hosted-notebook-artifacts.md` says R2 dedupes on the same keys, but `runtimed` has no `BlobBackend` trait or paginated `list()` that would survive on an object store. | Design | abstraction layer |
| BS-7 | GC mark walks rooms and persisted docs producing one combined hash set with no per-ref provenance. Any mark-miss is a silent data-loss bug at sweep time, with no debug surface to audit. | Targeted PR | GC instrumentation |
| BS-8 | `BlobStore` in-memory cache is referenced as "LRU" in source comments and AGENTS.md but eviction is insertion-order FIFO; `get` never refreshes recency. Either fix the name or fix the algorithm. | Inline | `crates/runtimed/src/blob_store.rs:174-201` |
| BS-9 | `MAX_BLOB_SIZE = 100 MiB` only gates the in-process `BlobStore::put()` API. The multipart finalize path validates against the caller's `expected_size` and the per-peer 256 MiB staging budget but does not enforce a 100 MiB ceiling on the completed blob. A peer can multipart-upload a 200 MiB blob today. | Design | `crates/runtimed/src/blob_upload.rs` finalize path |
| BS-10 | Save-to-`.ipynb` externalizes Arrow IPC and Parquet only via `BLOB_REF_MIME`; every other binary MIME is base64-inlined in the saved file. A user opening the saved `.ipynb` outside nteract gets self-contained binary for non-Arrow/Parquet but broken refs for the rest unless they keep the colocated blob store. | Design | `output_store.rs:62-89` |
| BS-11 | `COMM_STATE_BLOB_THRESHOLD = 1024` and `DEFAULT_INLINE_THRESHOLD = 1024` are two independent constants that happen to share the same value. A future tune to one will not move the other. | Inline | constant cross-reference comment |

## Triage summary

- **Inline (this branch, alongside ADRs):** WP-1, WP-5, WP-9, EP-4, EP-7. Five total.
- **Targeted PRs (one per smell after ADRs land):** WP-2, WP-3, WP-6, WP-7, 3D-1, 3D-2, EP-1, EP-2, EP-3, EP-8, EP-10, BS-1, BS-3, BS-7. Fourteen total.
- **Design (resolve in ADR before code moves):** WP-4, WP-8, WP-10, 3D-3, 3D-4, 3D-5, 3D-6, EP-5, EP-6, EP-9, BS-2, BS-4, BS-5, BS-6. Fourteen total.

## Next steps

1. Reviewer agents (Claude + Codex per ADR) may surface more smells. Append them here.
2. Apply Inline fixes on this branch before the ADRs leave Draft.
3. After ADRs land, open one targeted PR per Targeted PR row, smallest-blast-radius first.
4. Design items either get extended into the existing ADR or become their own ADR.
