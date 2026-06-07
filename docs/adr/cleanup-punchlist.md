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
| ~~WP-1~~ | **Done** in #2813 + cleanup/inline-pass. `crates/notebook-wire/AGENTS.md` now states that blob uploads ride the `NotebookSync` channel as `PUT_BLOB` (`0x08`) frames, and that the localhost blob HTTP port is separate from handshake channels. | Done | `crates/notebook-wire/AGENTS.md` |
| ~~WP-2~~ | **Done** in cleanup/wp-2-presence-cap. Wire-layer cap dropped from 1 MiB / 256 KiB warn to 4 KiB / 1 KiB warn so it matches `notebook-doc::presence::MAX_PRESENCE_FRAME_SIZE`. TS `packages/runtimed/src/transport.ts::frameSizeLimits` updated to match. Doc comments on all three sites cross-reference each other. WP-3 contract test will catch future drift. | Done | `crates/notebook-wire/src/lib.rs:77`, `crates/notebook-doc/src/presence.rs:36`, `packages/runtimed/src/transport.ts:77` |
| ~~WP-3~~ | **Done** in cleanup/wp-3-cap-contract. New test `frame_size_limits_match_typescript` parses `transport.ts::frameSizeLimits` and compares `cap` + `warn` against `notebook_wire::frame_size_limits` value-for-value. Verified by drift-injection that the test fails when the two tables disagree. | Done | `crates/notebook-protocol/src/protocol.rs` |
| WP-4 | `0x01`/`0x02` frame IDs are reused with different envelopes between `RuntimeAgent` and `NotebookSync` channels. Distinguishable only by handshake variant; a misrouted frame deserializes incorrectly with no protocol-level detection. | Design | `crates/notebook-protocol/`, `crates/runtimed/` |
| ~~WP-5~~ | **Done** in cleanup/inline-pass. Doc comments on both call sites explain the distinction: daemon CLI "pipe mode" is a debug tap (drops `Response`); Tauri relay `pipe_frame` forwards `Response` because the frontend depends on it. | Done | `crates/runtimed/tests/integration.rs:3098`, `crates/notebook-sync/src/relay_task.rs:328` |
| WP-6 | `frame_size_limits` default fallback for unknown frame types is the outer 100 MiB ceiling. A typo in a new variant's cap clause silently lands on the ceiling. | Targeted PR | `crates/notebook-wire/src/lib.rs` |
| WP-7 | `PROTOCOL_VERSION` is `u32` but serialized as `u8`. Compile-time asserted to fit, but the 4-byte constant vs 1-byte wire field is a footgun. | Targeted PR | `crates/notebook-wire/src/lib.rs` |
| WP-8 | `ProtocolCapabilities.protocol_version: Option<u32>` is set, defaults to `Some(PROTOCOL_VERSION)`, but no client reads it differently from the preamble byte. Possibly vestigial. | Design | `crates/notebook-protocol/` |
| ~~WP-9~~ | **Done** in #2813 + cleanup/inline-pass. `crates/notebook-wire/AGENTS.md` now calls out that `NotebookSync`, `OpenNotebook`, `CreateNotebook`, and `RuntimeAgent` enter typed frames after handshake, while `Pool` and `SettingsSync` stay length-prefixed JSON or binary bodies with no typed-frame byte. | Done | `crates/notebook-wire/AGENTS.md` |
| WP-10 | No application-layer heartbeat for typed-frame connections. Presence has room-level heartbeats; the connection itself only has `daemon.idle_peer_timeout()`. | Design | `crates/runtimed/src/notebook_sync_server/peer_loop.rs` |
| WP-11 | `recv_typed_frame` reads and allocates the body buffer up to the per-type cap *before* `try_from` rejects the unknown type. For unknown frame types the cap falls back to the outer 100 MiB ceiling, so a v4 daemon receiving forward-compat unknown bytes can allocate up to 100 MiB before skipping. | Targeted PR | `crates/notebook-protocol/src/connection/framing.rs:204-222` |
| ~~WP-12~~ | **Done** in `quill/lab1/becca/wp12-wire-constants`. The existing `notebook-protocol` TypeScript generator now emits `packages/runtimed/src/wire-constants.ts` from `notebook_wire::{frame_types, frame_size_limits, MAX_FRAME_SIZE, MAX_CONTROL_FRAME_SIZE}`. `transport.ts` re-exports those generated values, and the old parser-based Rust drift test was removed because the duplicate TS table no longer exists. | Done | `crates/notebook-protocol/src/typescript.rs`, `packages/runtimed/src/wire-constants.ts`, `packages/runtimed/src/transport.ts` |

## Three-document split

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| 3D-1 | `cells[cell_id].execution_count` lives in **both** `NotebookDoc` (legacy JSON-string) and `RuntimeStateDoc.executions[execution_id].execution_count` (live i64). Frontend consults live first, falls back to legacy. Two sources of truth for one number. | Targeted PR | `crates/notebook-doc/`, frontend reader |
| 3D-2 | `last_saved` lives in `RuntimeStateDoc`, which does not persist. A reopened room has no record of its last save time. | Targeted PR | `crates/runtime-state/` (move to `NotebookDoc` or use `.ipynb` mtime) |
| 3D-3 | `comms/*/outputs` inline output manifests, bypassing the blob path that `executions/*/outputs` uses. Two output-storage paths in one document. | Design | output manifest path |
| ~~3D-4~~ | **Done** in #3031 plus follow-up tightening. Shared `RuntimeStateDoc` policy rejects viewer writes, editor/owner `RuntimeStateDoc` writes, and runtime-peer attempts to create execution intent; mutable widget state lives in `CommsDoc`, and `runtime_peer` can publish progress/output for accepted executions but not `NotebookDoc`. | Done | `crates/runtime-doc/src/policy.rs`, `crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs`, `crates/runtimed/src/notebook_sync_server/peer_comms_sync.rs` |
| 3D-5 | No cross-doc heads correlation is produced or stored. Snapshot/audit/replay flows need a `(notebook_heads, runtime_heads)` pair; nothing writes one. | Design | snapshot publishing path |
| 3D-6 | `PoolDoc` does not participate in the clone-preview validator. Mitigation is `strip_changes`, not `validate`. Future write-bearing pool features would need the validator path wired back in. | Design | `crates/runtimed/src/notebook_sync_server/` |
| 3D-7 | Hosted runtime execution needs a request-routing contract that targets the active `runtime_peer` through the room host or `RuntimeStateDoc`, not the local `RuntimeAgent` socket. The audit in `runtime-peer-and-blob-authority-audit.md` narrows this to contract work before code, and `remote-workstation-doc-agents.md` sketches the provider-neutral workstation/doc-agent path. | Design | hosted runtime request dispatch |
| 3D-8 | The first peer-egress lane split has landed: `PeerWriter` separates reliable sync/response traffic from ephemeral presence/broadcast traffic. Remaining design work is reserved control capacity, explicit session-control barriers, and RuntimeStateDoc catch-up when reliable runtime traffic saturates. See `peer-egress-lanes.md`. | Design | `crates/runtimed/src/notebook_sync_server/peer_writer.rs` |

## Execution pipeline

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| EP-1 | `flush_then_signal_commits_stream_before_lifecycle_signal` test verifies signal arrival order, not durable Automerge change order. A refactor that re-routes `ExecutionDone` past the priority path would still pass. | Targeted PR | `crates/runtimed/src/stream_committer.rs` test |
| ~~EP-2~~ | **Done** in cleanup/ep-2-lifecycle-split. The old `QueueCommand` + `debug_assert!(signal.is_lifecycle())` shape was replaced by a structural `LifecycleSignal` / `WorkCommand` split, so non-lifecycle work can no longer compile on the lifecycle channel. | Done | `crates/runtimed/src/stream_committer.rs`, `crates/runtimed/src/output_prep.rs` |
| EP-3 | **Reframed.** Daemon view of execution state can diverge from kernel reality. A wall-clock watchdog is the wrong fix - multi-hour training jobs are legitimate Jupyter usage and nteract's resume-by-reconnect is a feature. The real signal is divergence between `RuntimeStateDoc.status` and live IOPub / heartbeat / committer state. See design memo `docs/adr/execution-liveness.md`. Code is a follow-up after the memo is reviewed. | Design | memo `docs/adr/execution-liveness.md` |
| ~~EP-4~~ | **Refuted.** Per `.claude/rules/logging.md`, per-operation drops belong at `debug`. Flush drops are per-operation. The visibility concern is real but the fix is metrics, not a log-level change — reclassified to a future Targeted PR for instrumentation. | Refuted | (was `stream_committer.request_flush`) |
| EP-5 | Capacity constants (`STREAM_COMMITTER_QUEUE_CAPACITY = 32`, `MAX_PENDING_DISPLAY_IDS = 128`, `DEFAULT_OUTPUT_SYNC_GRACE = 500ms`) picked by judgment. No benchmark, no drop-rate metric, no measured upper bound under load. | Design | telemetry + tuning pass |
| EP-6 | `required_heads` is `NotebookDoc`-only. No causal gate exists for requests that depend on recent `RuntimeStateDoc` writes. | Design | request handling |
| ~~EP-7~~ | **Done** in cleanup/inline-pass. `DisplayUpdateCommitterHandle::request_update` now carries a doc comment naming the latest-wins-including-buffers contract. | Done | `crates/runtimed/src/display_update_committer.rs:49` |
| EP-8 | "IOPub reader cannot block on bounded queues" is discipline, not a check. Adding `.await` on a bounded send in any IOPub handler arm would silently reintroduce the backpressure failure. | Targeted PR | IOPub handlers, lint or type-level enforcement |
| EP-9 | Run-all timeouts are shared across the batch; a long first cell starves the budget for later cells. No fairness mechanism. | Design | run-all path |
| EP-10 | Runtime agent `select!` is not `biased;`. Brief window where work could be selected before lifecycle drain. Drain inside the work-arm body closes this for already-pending signals, not for ones that arrive during work selection. | Targeted PR | `crates/runtimed/src/runtime_agent.rs` |
| EP-11 | `flush_then_signal` empty-flushes fast path: when `flushes` is empty, the signal is sent directly on `lifecycle_tx` bypassing the priority committer. A no-output execution's `ExecutionDone` races freely with `KernelIdle` on the same channel. | Targeted PR | `crates/runtimed/src/stream_committer.rs:106-109` |
| ~~EP-12~~ | **Done** in cleanup/inline-pass. Both `start_stream_committer` and `start_display_update_committer` now carry doc comments on the panic-supervisor branch explaining the `KernelDied` → queue-release tie. | Done | `crates/runtimed/src/stream_committer.rs:227`, `crates/runtimed/src/display_update_committer.rs:259` |
| ~~EP-13~~ | **Refuted.** The asymmetry is correct severity-matching, not a bug. `Full` is expected backpressure under load (the work channel saturates under widget storms — per `.claude/rules/logging.md`, that's `debug`). `Closed` means the work receiver is gone, which is a real anomaly worth `warn`. Different conditions, different levels. | Refuted | (was `jupyter_kernel.rs:208-220`) |
| TMD-1 | The Tokio mutex lint at `crates/runtimed/tests/tokio_mutex_lint.rs:18` uses `std::fs::read_dir` (no recursion). Only top-level files in `crates/runtimed/src/*.rs` are scanned. The 25-file `notebook_sync_server/` subdirectory plus `runtime_agent/`, `requests/`, etc. are silently invisible. The "zero violations" claim is scoped to top-level files only. One-line fix: switch to `walkdir`. | Targeted PR | `crates/runtimed/tests/tokio_mutex_lint.rs` |
| TMD-2 | `crates/runtimed-py/src/session_core.rs:59-63, :214-240` holds `Arc<tokio::sync::Mutex<SessionState>>` live across `connect_with_socket` awaits. The lint does not scan `runtimed-py`. Discipline violation, but the cure (restructure or extend lint) is non-trivial. | Targeted PR | `crates/runtimed-py/src/session_core.rs` |
| MSL-1 | `ApproveProjectEnvironment` writes the allowlist but does not broadcast or call `check_and_update_trust_state` (`approve_project_environment.rs:38`). User must trigger a subsequent sync-driving action before the verdict updates. Other approval entry points (`ApproveTrust`, `seed_trust_from_doc_metadata`) do broadcast. | Targeted PR | `crates/runtimed/src/requests/approve_project_environment.rs` |
| MSL-2 | `seed_defaults` seeds startup base packages into `pypi` and `conda` only — not into the channel ecosystems (`conda-channel`, `pixi-channel`). A user with a notebook on a non-default channel will see all channel approvals as fresh prompts even after several uses. | Design | `crates/runtimed/src/daemon.rs:1436-1450` |
| FSB-1 | `notebook-sync-store-bridge.ts:163-167` swallows `applyOutputChangeset` failures at `warn`. There is no retry, banner, or in-flight error count. A partial output projection silently shows a stale manifest. | Targeted PR | `apps/notebook/src/lib/notebook-sync-store-bridge.ts` |
| FSB-2 | Stable DOM order invariant lives in three places — `stableDomOrder` memo (`NotebookView.tsx:519`), `order: index` style (`:307`), parent `flex-direction: column` (`:952`) — with no CI guard. Regressing any of the three silently reintroduces the iframe-loss flash that the invariant exists to prevent. | Targeted PR | `apps/notebook/src/components/NotebookView.tsx` |
| FSB-3 | `[...cellIds].sort()` uses default JS string sort, not locale-aware. Works under the current UUID-only ID format; breaks if non-UUID IDs are ever introduced. No assertion of "IDs are UUIDs" exists in the bridge or the materialiser. | Inline | comment + sanity assertion |
| MSL-3 | `tool_list_changed` divergence reports `Incompatible` with a single "reinstall the nteract extension" error string, hard-coded for the MCPB bundle install path. The `nteract-dev` supervisor-managed path gets the same message even though the recovery action is different (relaunch the dev daemon, not reinstall an extension). | Targeted PR | `crates/runt-mcp-proxy/src/proxy.rs` `should_exit` text |
| MSL-4 | When a dev worktree daemon's socket path changes (worktree switch in isolated mode, manual relocation), `mcp-supervisor` compares daemon versions across child restart but not socket paths. The `McpProxy.last_notebook_id` from the old daemon is meaningless in the new daemon's room space; rejoin fails with `SessionDropReason::Evicted` and the agent sees a confusing trail. | Design | `crates/runt-mcp-proxy/src/proxy.rs` |

## Hosted/cloud authority

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| HCA-1 | Mixed hosted credentials are documented as reject-by-default in `hosted-credential-transport.md`, but the current notebook-cloud prototype still needs complete mixed-credential rejection coverage. The direct-OIDC implementation should reject mixed identity-bearing credentials unless a deployment proves they are one credential. | Targeted PR | `apps/notebook-cloud/src/identity.ts`, `apps/notebook-cloud/test/identity.test.ts`, `docs/adr/hosted-direct-oidc-demo-runbook.md` |
| HCA-2 | Capability naming still needs product polish: `editor`/`owner` can write allowed `NotebookDoc` fields and mutable widget state in `CommsDoc`, while runtime lifecycle/progress/output authority requires explicit `runtime_peer` and execution intent requires the request API. Align UI copy, request-role wording, and authorization helpers so "can edit notebook" never reads as "can author runtime state." | Design | `apps/notebook-cloud/src/authorization.ts`, `apps/notebook-cloud/src/room-materializer.ts`, `crates/nteract-identity/src/lib.rs`, `docs/adr/hosted-room-authorization.md` |
| HCA-3 | Editor blob-upload authority is unresolved. The runtime/blob audit allows editor uploads as precursors to authorized references, while current cloud code and README deny editor uploads. Staged policy should be explicit: editors cannot upload until server-side reference-path validation lands, or editor upload and path validation must ship together. | Design | `apps/notebook-cloud/src/identity.ts`, `apps/notebook-cloud/README.md`, `docs/adr/runtime-peer-and-blob-authority-audit.md` |
| HCA-4 | Live peer validators must reject incoming changes authored by `system`/legacy schema actors. Schema/system actors are tolerated only as trusted seed or import history already present before peer ingress, not as newly received peer-authored deltas. | Targeted PR | `crates/notebook-doc/src/lib.rs`, `crates/runtime-doc/src/doc.rs`, `docs/adr/identity-and-trust.md` |
| ~~HCA-5~~ | **Done** in the ADR alignment pass. The durable blob-ref contract is bare lowercase SHA-256 hex, matching `blob-storage-and-content-addressing.md`, local CAS keys, hosted storage keys, and blob-ref/chunk manifest examples. `sha256:` remains valid only for non-blob semantic hashes such as traceback source hashes. | Done | `docs/adr/blob-storage-and-content-addressing.md`, `docs/adr/blob-ref-and-chunk-manifest-protocol.md`, `docs/adr/hosted-notebook-artifacts.md`, `apps/notebook-cloud/src/storage.ts` |
| HCA-6 | Private hosted blob-read authority is split between future capability URLs and current viewer-authenticated app-origin routes with public CORS. Before private sharing ships, choose and enforce the credential/CORS or signed-capability policy for `/api/n/:id/blobs/:hash`. | Design | `docs/adr/hosted-room-authorization.md`, `docs/adr/hosted-output-origin-isolation.md`, `apps/notebook-cloud/src/index.ts` |

## Schema evolution

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| ~~SE-1~~ | **Done** in fix/se1-schema-version-monotonic-read. `schema_version` is now resolved read-side over its full Automerge conflict set (max of `get_all`) at both read sites: the `schema_version()` accessor and the `load_or_create_inner` classifier. A stale peer's concurrent write still lands in the CRDT, but every reader sees the newest version, so a backward stamp is never observed or persisted to `.ipynb`. The classifier keeps its tri-state (empty = absent, non-empty-no-integer = malformed, else max = valid). Chosen over write-back reconciliation (op-history growth on every restart, daemon-authored merge change desyncs peer sync state) and host-only write auth (no room-host concept exists; nothing for desktop or already-diverged docs). Guarded by `test_cross_version_schema_version_resolves_to_max_not_lww`, `test_load_resolves_schema_version_conflict_to_max`, `test_load_malformed_in_conflict_set_uses_valid_max`. | Done | `crates/notebook-doc/src/lib.rs`, `docs/adr/schema-evolution-and-genesis.md` |

## Environment lifecycle

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| KE-1 | Captured env has no user-initiated rebuild/reset surface. Daemon lifecycle owns automatic repair, but lacks a `ResetNotebookEnvironment { RebuildSame | RefreshDefaults }` request for manual recovery and defaults refresh. | Design | `crates/runtimed/src/requests/`, `apps/notebook/src/components/DependencyHeader.tsx` |
| ~~CEL-1~~ | **Done** in quill/lab1/miles/cel1-env-state. Captured unified env disk state is now typed as `Missing`, `Partial`, or `Usable`; source-resolution, launch-config filtering, and eviction preservation consume the typed state instead of probing `unified_env_on_disk(...).is_some()`. `Missing` preserves the previous fallback path, while both `Partial` and `Usable` route through captured prewarmed/unified handling so partial dirs reach captured repair and usable dirs remain cache hits. Guarded by UV and Conda tests for Missing/Partial/Usable disk states. | Done | `crates/runtimed/src/notebook_sync_server/metadata.rs`, `crates/runtimed/src/requests/launch_kernel.rs`, `docs/adr/captured-environment-lifecycle.md` |

## Blob storage

| ID | Smell | Severity | Where |
|----|-------|----------|-------|
| ~~BS-1~~ | **Done** in cleanup/bs-1-streaming-blob-http. `BlobStore::open_reader` returns either an in-memory `Bytes` (memory-layer hit) or an open `tokio::fs::File` (disk-only); the HTTP server uses `StreamBody<ReaderStream<File>>` for the disk variant so a 100 MiB blob streams instead of buffering. Regression guard: `test_serve_blob_streams_from_disk_for_large_payloads` rounds 2 MiB through the server and asserts byte equality + correct Content-Length. | Done | `crates/runtimed/src/blob_server.rs`, `crates/runtimed/src/blob_store.rs:open_reader` |
| BS-2 | `put_disk` fast-path rewrites the sidecar `media_type` when a duplicate write disagrees. Intentional for anywidget `_esm`, but means any authenticated peer can change the served `Content-Type` of an existing blob. | Design | `crates/runtimed/src/blob/` |
| BS-3 | `MULTIPART_UPLOAD_TTL = 1h` only sweeps on the next Create/Complete/Abort. An idle daemon retains expired staging dirs forever. | Targeted PR | multipart sweep |
| BS-4 | `NotebookHandle.load_snapshot` and the publish artifacts spec assume the destination can resolve every `ContentRef::Blob`. Nothing walks a saved `RuntimeStateDoc` and confirms its blob hashes exist before declaring publish complete. | Design | publish path |
| BS-5 | Blob HTTP responds with `Access-Control-Allow-Origin: *` plus loopback only. Fine for single-user desktop; the moment a daemon serves more than one OS user or accepts a remote peer, any peer that knows a hash gets the blob regardless of room ownership. Hash unguessability is the only mitigation. | Design | identity gate on blob HTTP |
| BS-6 | `BlobStore` hard-codes the filesystem. `hosted-notebook-artifacts.md` says R2 dedupes on the same keys, but `runtimed` has no `BlobBackend` trait or paginated `list()` that would survive on an object store. | Design | abstraction layer |
| BS-7 | GC mark walks rooms and persisted docs producing one combined hash set with no per-ref provenance. Any mark-miss is a silent data-loss bug at sweep time, with no debug surface to audit. | Targeted PR | GC instrumentation |
| ~~BS-8~~ | **Done** in cleanup/inline-pass. `MemoryLayer` now carries a doc comment naming the FIFO semantics explicitly, and the misleading `lru_eviction_oldest_first` test is renamed `fifo_eviction_oldest_first`. Algorithm unchanged. | Done | `crates/runtimed/src/blob_store.rs:89, :1175` |
| BS-9 | `MAX_BLOB_SIZE = 100 MiB` only gates the in-process `BlobStore::put()` API. The multipart finalize path validates against the caller's `expected_size` and the per-peer 256 MiB staging budget but does not enforce a 100 MiB ceiling on the completed blob. A peer can multipart-upload a 200 MiB blob today. | Design | `crates/runtimed/src/blob_upload.rs` finalize path |
| BS-10 | Save-to-`.ipynb` externalizes Arrow IPC and Parquet only via `BLOB_REF_MIME`; every other binary MIME is base64-inlined in the saved file. A user opening the saved `.ipynb` outside nteract gets self-contained binary for non-Arrow/Parquet but broken refs for the rest unless they keep the colocated blob store. | Design | `output_store.rs:62-89` |
| ~~BS-11~~ | **Done** in cleanup/inline-pass. `COMM_STATE_BLOB_THRESHOLD`'s doc comment now explicitly cross-references `DEFAULT_INLINE_THRESHOLD` and explains that the shared value is coincidence, not coupling. | Done | `crates/runtimed/src/output_prep.rs:143` |
| BS-12 | `PutBlob` frames and multipart upload requests are not scope-gated in the local daemon peer loop today. Local same-UID clients authenticate as owner, but hosted multi-user rooms must reject viewer uploads and allow editor/runtime-peer uploads only as precursors to authorized references. | Design | `peer_loop.rs`, `peer_writer.rs`, hosted room host |
| BS-13 | Blob metadata such as `media_type` is mutable on duplicate put. That is intentional for single-user desktop, but a hosted or remote-peer backend must prevent a lower-scope peer from changing how an existing hash is served to other users. | Design | blob backend / hosted resolver |

## Triage summary

**Status legend:** Done = landed; Refuted = examined and rejected with rationale; Inline / Targeted / Design = open.

- **Done:** WP-1, WP-2, WP-3, WP-5, WP-9, EP-2, EP-7, EP-12, BS-1, BS-8, BS-11, SE-1, CEL-1, HCA-5. Fourteen landed across #2813, cleanup/inline-pass, targeted cleanup stacks, the SE-1 read-side fix, CEL-1 typed captured-env disk state, and the ADR alignment pass.
- **Refuted:** EP-4 (log levels are correct per `.claude/rules/logging.md`), EP-13 (warn/debug asymmetry matches the actual severity of `Full` vs `Closed`).
- **Targeted PRs (one per smell):** WP-6, WP-7, WP-11, 3D-1, 3D-2, EP-1, EP-8, EP-10, EP-11, BS-3, BS-7, TMD-1, TMD-2, MSL-1, MSL-3, FSB-1, FSB-2, HCA-1, HCA-4. Nineteen open.
- **Design (resolve in ADR or memo first):** WP-4, WP-8, WP-10, 3D-3, 3D-5, 3D-6, 3D-7, 3D-8, EP-3, EP-5, EP-6, EP-9, BS-2, BS-4, BS-5, BS-6, BS-9, BS-10, BS-12, BS-13, MSL-2, MSL-4, HCA-2, HCA-3, HCA-6, KE-1. Twenty-six open.

## Next steps

1. Reviewer agents (Claude + Codex per ADR) may surface more smells. Append them here.
2. Apply Inline fixes on this branch before the ADRs leave Draft.
3. After ADRs land, open one targeted PR per Targeted PR row, smallest-blast-radius first.
4. Design items either get extended into the existing ADR or become their own ADR.
