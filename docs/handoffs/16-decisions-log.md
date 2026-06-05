# Decision log — transport-agnostic `runtime_agent` (#16)

A running trail of non-obvious calls so any session can take the work back and
understand *why*. One entry per decision: what, the alternative, why. Append as you go;
commit alongside the code that realizes each decision. Newest at the bottom.

## Seeded from the design session (2026-06-05)

1. **Make `runtime_agent` transport-agnostic; do not reimplement the kernel drive.**
   Alternative: ship the spike's `kernel_host.rs` (a working standalone runtime_peer
   that launches its own kernel). Why: that's a second kernel driver to untangle later,
   and it bypasses the daemon's env pools / launcher cache / supervision. Reusing the
   daemon and swapping only the sync transport is the smaller, more correct surface.

2. **The daemon stays the kernel manager; the runtime is a peer of the cloud *room*,
   not an unmanaged process.** Why: "peer" is about the transport (how it reaches the
   cloud), not the absence of a supervisor. Lifecycle events (death, hang, error) flow
   through the daemon's existing `handle_lifecycle_signal` path; a bare peer with no
   manager misses them.

3. **`FrameTransport` trait + UDS impl live in `notebook-protocol`; the cloud-WS impl
   lives in a separate lib crate.** Alternative: put the WS impl in `notebook-protocol`.
   Why: keeps `notebook-protocol` tungstenite-free and wasm-safe, and avoids the daemon
   depending on a binary. The trait belongs next to the framing it abstracts.

4. **Phase 1 is behavior-preserving (UDS impl only), gated by `cargo test -p runtimed`.**
   Why: de-risk the extraction with zero functional change before any cloud code touches
   the load-bearing daemon agent. The daemon tests are the contract.

5. **The kernel-host spike is a closed reference PR (#3408), not merged.** Why: it
   proved the cloud wire + the full cross-machine lifecycle end to end, but it
   duplicates the daemon's kernel drive. Closed-but-linkable preserves the record
   without entrenching the duplicate on `main`.

6. **Consumer-side RuntimeStateDoc receive uses `receive_sync_message_with_changes`, not
   `receive_sync_message`.** Why: the plain receive is daemon-authoritative and *strips
   incoming changes*; a cloud peer is a consumer of the room's authoritative state, so
   stripping silently discards the room's queued executions and stalls convergence. This
   cost hours to diagnose in the spike — carry it forward.

7. **A lifecycle safety net is required before relying on cloud hosting (Phase 3).**
   Why: `kernel.lifecycle` is `runtime_peer`-only-writable (`policy.rs:403-405`), so when
   the runtime itself vanishes no surviving room participant can correct the doc and the
   room has no watchdog — a dropped workstation strands the room with a phantom-live
   kernel. Needs a cloud-room watchdog + a narrow policy relaxation (or a `Disconnected`
   lifecycle the room can stamp). See `16-lifecycle-analysis.md`.

8. **Output path: plain nbformat manifest + a minted `output_id` is sufficient.**
   Verified live: it persists across peer disconnect and renders in the cloud viewer
   without the daemon's richer `OutputManifest`/blob-store shape. Don't over-build the
   output side.

9. **A cloud `runtime_peer` needs an explicit `runtime_peer` ACL row** (owner alone is
   403; `aclRowsCoverScope` special-cases the scope). Grant via
   `POST /api/n/:id/acl {subject_kind:"principal", subject, scope:"runtime_peer"}`.

10. **Stack one branch/PR per phase; this log + PR STATUS are the trail.** Why: headless
    with no reviewer between phases, stacking keeps each phase independently reviewable
    and lets the takeback session merge/rebase in order.

## Appended by subsequent sessions

<!-- Add entries here as you make decisions. Format: N. **Decision.** Alternative. Why. -->
