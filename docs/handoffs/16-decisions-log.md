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

### Phase 1 session (2026-06-05, lab2, branch `quod/16-frame-transport`)

11. **Split the transport into `FrameSource` (recv) + `FrameSink` (send) halves, plus a
    `FrameTransport` connector that yields the pair — not the single
    `recv_frame`/`send_frame` object the handoff sketched.** Alternative: one
    `trait FrameTransport { recv_frame(&mut self); send_frame(&mut self); }` held in one
    variable. Why: the agent's `tokio::select!` awaits the recv future in one arm
    (borrowing the read half for the whole `select!`) while other arms call send in their
    bodies. A single `&mut self` object makes those two borrows conflict; the existing code
    only compiles because `framed_reader` and `writer` are *separate* variables. Keeping
    two halves preserves that structure exactly and is the minimal, behavior-preserving
    shape. The connector (`connect() -> (Source, Sink)`) owns the transport-specific
    dial+handshake, which is what `reconnect_with_backoff` needs.

12. **Traits use `async fn` in trait consumed through generics, not `#[async_trait]` or
    `Box<dyn>`.** Alternative: `Box<dyn FrameTransport>` for runtime polymorphism. Why:
    matches the neighbouring `KernelConnection` pattern in `runtimed`, keeps
    `notebook-protocol` free of an `async-trait` dependency (stays wasm-safe and
    dependency-light per decision #3), and the agent has exactly one transport per process
    so monomorphisation at the single call site is free. The cloud transport (Phase 2) is a
    second impl selected at construction, not at runtime per-call.

13. **`UdsFrameTransport::connect` normalises the `send_json_frame` anyhow error to
    `io::Error::other`.** Alternative: make the trait's `connect` return `anyhow::Error`.
    Why: keeps the whole transport surface io-typed (`recv_frame`/`send_frame` are already
    `io::Result`), and the only error source is the effectively-impossible serialization
    failure of a `Handshake`. The message text is preserved; the sole caller
    (`main.rs`) only Displays it. Verified non-lossy by adversarial review.

14. **`FramedReader` capacity (16) hoisted to a named const `FRAME_READER_CAPACITY` in the
    transport module.** Why: the value was duplicated as a literal at the initial-connect
    and reconnect sites in `runtime_agent`; centralising it in the one place that now spawns
    the reader removes the duplication without changing the value.

Phase 1 verification (the contract): `cargo test -p runtimed` → 944 passed, 0 failed
(incl. `tokio_mutex_lint` and `tokio_select_cancel_safe` CI lints); `cargo clippy -p
runtimed --all-targets` and `-p notebook-protocol --all-targets` clean; `cargo build
--workspace` clean; `cargo fmt --check` clean. Net diff: +48/-97 in runtime_agent +
new transport.rs. Adversarial subagent review found zero behavioral differences.

Note for Phase 2: `/tmp/stage-oidc.txt` **is present on lab2**, so the live cross-machine
re-proof is runnable from this host once the cloud transport lands. `pi`/`opencode` CLIs
are **not** installed here — used a spawned subagent for adversarial review instead.

15. **Push to fork `quillaid/desktop` and open the PR against the `nteract/nteract`
    handoff branch from there.** Alternative: push the branch directly to `origin`
    (nteract/nteract), as the prior `quod/*` branches were. Why: the `quillaid` git
    identity this run commits under has **no push access** to `nteract/nteract`
    (`{push:false, pull:true, triage:true}`); both HTTPS and SSH pushes 403. The existing
    `quod/*` branches were pushed by Kyle (repo owner), not reproducible here. GitHub's
    fork of `nteract/nteract` under this account already exists as `quillaid/desktop`
    (a rename of the fork; `push:true`), so the standard fork-PR flow is the only headless
    path. **Phase 1 PR: nteract/nteract#3409** (base `quod/runtime-agent-transport-handoff`,
    head `quillaid:quod/16-frame-transport`). A `fork` git remote
    (`git@github.com:quillaid/desktop.git`) is configured in the worktree for subsequent
    phase pushes. The takeback session (if it has direct push) may re-push these branches
    to `origin` and retarget the PRs; optimize for the reviewable trail, not remote
    identity. Stack Phase 2 on `quod/16-frame-transport` and PR it against this same branch
    or #3409's head.
