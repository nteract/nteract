# Decision log: transport-agnostic `runtime_agent`

A trail of the non-obvious calls behind making the daemon's `runtime_agent`
transport-agnostic, so a future reader understands *why*. One entry per
decision: what, the alternative, why.

## Design

1. **Make `runtime_agent` transport-agnostic; do not reimplement the kernel drive.**
   Alternative: ship a standalone runtime peer that launches its own kernel. Why:
   that's a second kernel driver to untangle later, and it bypasses the daemon's
   env pools, launcher cache, and supervision. Reusing the daemon and swapping only
   the sync transport is the smaller, more correct surface.

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
   proved the cloud wire and the full cross-machine lifecycle end to end, but it
   duplicates the daemon's kernel drive. Closed-but-linkable preserves the record
   without entrenching the duplicate on `main`.

6. **Consumer-side RuntimeStateDoc receive uses `receive_sync_message_with_changes`, not
   `receive_sync_message`.** Why: the plain receive is daemon-authoritative and *strips
   incoming changes*. A cloud peer is a consumer of the room's authoritative state, so
   stripping silently discards the room's queued executions and stalls convergence.

7. **A lifecycle safety net is required before relying on cloud hosting (Phase 3).**
   Why: `kernel.lifecycle` is `runtime_peer`-only-writable (`policy.rs:403-405`), so when
   the runtime itself vanishes no surviving room participant can correct the doc and the
   room has no watchdog. A dropped workstation strands the room with a phantom-live
   kernel. Needs a cloud-room watchdog plus a narrow policy relaxation (or a `Disconnected`
   lifecycle the room can stamp). See `16-lifecycle-analysis.md`.

8. **Output path: plain nbformat manifest + a minted `output_id` is sufficient.**
   Verified live: it persists across peer disconnect and renders in the cloud viewer
   without the daemon's richer `OutputManifest`/blob-store shape. Don't over-build the
   output side.

9. **A cloud `runtime_peer` needs an explicit `runtime_peer` ACL row** (owner alone is
   403; `aclRowsCoverScope` special-cases the scope). Grant via
   `POST /api/n/:id/acl {subject_kind:"principal", subject, scope:"runtime_peer"}`.

## Phase 1: FrameTransport trait + UDS impl + agent port

11. **Split the transport into `FrameSource` (recv) + `FrameSink` (send) halves, plus a
    `FrameTransport` connector that yields the pair, not a single combined transport
    object.** Alternative: one `trait FrameTransport { recv_frame(&mut self); send_frame(&mut self); }`
    held in one variable. Why: the agent's `tokio::select!` awaits the recv future in one arm
    (borrowing the read half for the whole `select!`) while other arms call send in their
    bodies. A single `&mut self` object makes those two borrows conflict; the existing code
    only compiles because `framed_reader` and `writer` are *separate* variables. Keeping
    two halves preserves that structure exactly and is the minimal, behavior-preserving
    shape. The connector (`connect() -> (Source, Sink)`) owns the transport-specific
    dial and handshake, which is what `reconnect_with_backoff` needs.

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
    failure of a `Handshake`. The message text is preserved; the sole caller only Displays
    it. Verified non-lossy.

14. **`FramedReader` capacity (16) hoisted to a named const `FRAME_READER_CAPACITY` in the
    transport module.** Why: the value was duplicated as a literal at the initial-connect
    and reconnect sites in `runtime_agent`; centralising it in the one place that now spawns
    the reader removes the duplication without changing the value.

Phase 1 verification (the contract): `cargo test -p runtimed` passes 944 tests (incl. the
`tokio_mutex_lint` and `tokio_select_cancel_safe` CI lints); `cargo clippy -p runtimed
--all-targets` and `-p notebook-protocol --all-targets` clean; `cargo build --workspace`
clean; `cargo fmt --check` clean. Net diff in `runtime_agent` is +48/-97 plus the new
`transport.rs`. Behavior-preserving.

## Phase 2: cloud-WS transport library

16. **`runt-cloud-peer` already exists on `main` (merged #3397) as the WS-sync *binary*,
    without kernel hosting.** Phase 2 lifts the merged binary's WS wire (dial + header auth
    + `cloud_room_ready` + one-frame-per-binary-message) into a **library**,
    `notebook-cloud-transport`, that implements the Phase 1 `FrameTransport` trait. The
    binary keeps working unchanged; the library is what the daemon's `runtime_agent` will
    write to.

17. **Phase 2 ships the cloud transport *library only*; the daemon spawn-path wiring moves
    to Phase 3.** Why deferred: wiring the spawn path requires two agent-loop changes that
    are unsafe before Phase 3's fixes: (a) authoring the NotebookDoc/RuntimeStateDoc under
    the `cloud_room_ready` principal (not the daemon's `runtime_agent_id`), and (b) the
    consumer-side `receive_sync_message_with_changes` (decision #6) instead of the daemon's
    `receive_sync_and_foreign_comms_recovering`. Most critically, a cloud-WS EOF currently
    falls into `kernel.shutdown()` (lifecycle-analysis req #1), so spawning the agent on the
    cloud transport *before* the EOF-policy-by-transport split would let a transient WS blip
    kill a healthy kernel. Shipping the transport alone keeps each PR independently safe and
    reviewable; Phase 3 adds the spawn path together with the EOF fix that makes it correct.
    A compile-time assertion (`cloud_transport_is_a_frame_transport`) proves the library is
    already drop-in for the agent's generic bound, so Phase 3 is purely additive.

18. **The cloud `connect()` reads up to `cloud_room_ready` and surfaces the room principal
    via an `OnceLock` getter, rather than widening the `FrameTransport` trait.** Alternative:
    add a `principal()`/`on_ready()` method to the trait. Why: the UDS transport has no such
    concept, so the principal is cloud-specific and lives on the concrete
    `CloudWsFrameTransport`. Data frames that arrive before `cloud_room_ready` are buffered in
    the source's `pending` queue and drained first, so the ready-wait loses no frames.

19. **Frame decode skips empty/unknown frame types (returns `None`, keeps reading) to mirror
    the UDS `FramedReader`/`recv_typed_frame` forward-compat behavior.** Why: a cloud room on
    a newer protocol may send frame types this peer doesn't know; dropping them (with a warn)
    matches the local path rather than erroring the stream.

20. **The connect-time ready-wait surfaces `cloud_frame_rejected` as a `PermissionDenied`
    connect error, and warns on a principal mismatch across reconnect.** The original loop
    silently ignored every non-`cloud_room_ready` control frame, so a room rejection delivered
    as a `cloud_frame_rejected` control frame (auth/ACL failure surfaced *after* a successful
    WS upgrade) would hang the connect until the socket closed, then return an opaque EOF that
    discards the room's stated `reason`. Now `classify_ready_control` returns
    `Ready(principal)` / `Rejected(reason)` / `Other`, and `connect_cloud` returns
    `Err(PermissionDenied: "room rejected attach before ready: <reason>")` on a rejection.
    Separately, the `OnceLock` principal cache warns if a reconnect observes a *different*
    principal than the one the agent is authoring under (silent staleness would otherwise make
    the room drop all the agent's changes). Pre-ready data frames are still buffered.

Phase 2 verification: `cargo test -p notebook-cloud-transport` passes 11 tests; clippy clean;
`cargo test -p runtimed` still 944 (no regression from the new workspace member). Live
cross-machine re-proof is deferred with the Phase 3 spawn path, since there is no daemon path
to *invoke* the cloud transport yet (decision #17).

## Phase 3a: transport-aware clean-EOF policy

21. **Phase 3 is split: 3a (transport-aware clean-EOF policy) lands now; 3b+ (spawn path,
    WS reconnect/re-auth specifics, cloud-room watchdog, policy relaxation, inbound request
    channel) are planned but not yet built.** Why: Phase 3 spans three codebases (Rust agent,
    TS Cloudflare worker, `runtime-doc` policy) and its safety-critical pieces (the DO
    watchdog, the policy relaxation) need integration/live verification that isn't fully
    headless. But lifecycle-analysis **req #1**, "a cloud-WS clean EOF must NOT fall into
    `kernel.shutdown()`", is a clean, behavior-preserving, unit-testable Rust change and is
    the keystone that makes spawning the agent on the cloud transport *safe*. Landing it
    first de-risks 3b and keeps each PR independently reviewable.

22. **The clean-EOF teardown policy is a defaulted trait method
    `FrameTransport::clean_eof_is_recoverable()` (default `false`), overridden to `true` by
    the cloud transport.** Alternative: a runtime flag threaded through `run_runtime_agent`,
    or a per-call parameter. Why a defaulted trait method: the policy is an intrinsic property
    of the transport (the daemon socket's clean close means "daemon gone, tear down"; a cloud
    WS clean close means "blip/eviction, reconnect"), so it belongs on the transport. Default
    `false` keeps the UDS/desktop path byte-for-byte unchanged (944 runtimed tests still
    green). The agent's `None` (clean-EOF) arm now consults it and, when recoverable, runs the
    *same* reconnect+resync dance as the existing framing-error (`Err`) arm: drop source,
    `reconnect_with_backoff`, reset `coordinator_sync_state`, kick `state_kick_tx`. This
    mirrors the deliberate "kernel stays running" policy the framing-error branch already
    applies.

23. **The recoverable clean-EOF arm enforces a 1s reconnect floor
    (`CLEAN_EOF_RECONNECT_FLOOR`).** `reconnect_with_backoff` only sleeps between *failed*
    connects, so a cloud sink that accepts the connection and then immediately closes cleanly
    every cycle (a flapping/evicting room) would spin a reconnect storm at network-RTT rate (a
    self-inflicted DoS on the room). The fix: track the last clean-EOF reconnect time and, if a
    clean EOF recurs within the floor, sleep the remainder before redialing. Only the
    recoverable (cloud) path uses it; the UDS path never reconnects on clean EOF, so its
    `last_clean_reconnect` stays `None`. The room-side watchdog (3d) and a fuller
    circuit-breaker remain future work.

Phase 3a verification: `cargo test -p runtimed` passes 944 (UDS default unchanged);
`cargo test -p notebook-protocol` 89; `cargo test -p notebook-cloud-transport` 12; clippy
clean across all three; `cargo fmt --check` clean.

## Phase 3b warm-up: two connect-hardening gaps pullfrog flagged on #3411

24. **Bounded ready-wait timeout in `CloudWsFrameTransport::connect`
    (`READY_WAIT_TIMEOUT`, 30s).** The connect-time `cloud_room_ready` wait
    blocked on `recv_frame()` with no deadline: a room that completes the WS
    upgrade but never sends `cloud_room_ready`/`cloud_frame_rejected` and never
    closes would hang `connect` forever — and since `reconnect_with_backoff`
    calls `connect()` with no per-attempt timeout of its own, the whole recovery
    path would wedge on one silent room. Fix: the ready loop is extracted into a
    `wait_for_ready<S: FrameSource>` helper (no deadline of its own, so it's
    unit-testable against a mock source) that `connect` wraps in
    `tokio::time::timeout(READY_WAIT_TIMEOUT, …)`; on elapse it returns a
    `TimedOut` io error, which `reconnect_with_backoff` already treats as a
    failed connect and retries. Alternative considered: a per-frame idle timeout
    rather than a total deadline — rejected as more complex and unnecessary, since
    a room mid-handshake either reaches a terminal control frame promptly or is
    wedged. Extracting the helper also fixed a latent bug: the old loop pushed
    pre-ready data frames back into `source.pending` while *reading via*
    `source.recv_frame()` (which pops `pending` first), so the buffer now uses a
    separate deque assigned into `pending` only after ready. 4 new unit tests
    (timeout under `start_paused`, rejection, clean-EOF-before-ready, pre-ready
    data buffering); `notebook-cloud-transport` now 16 tests.

25. **Flap floor extended to the framing-error reconnect arm
    (`RECOVERABLE_RECONNECT_FLOOR`, renamed from `CLEAN_EOF_RECONNECT_FLOOR`).**
    Phase 3a (decision #23) added the 1s reconnect floor only to the clean-EOF
    (`None`) arm. The framing-error (`Some(Err)`) arm plus `reconnect_with_backoff`
    only sleep between *failed* connects, so a cloud room that accepts the
    connection and then errors the stream every cycle would spin reconnects at RTT
    rate (a self-inflicted DoS on the room) — the same hazard #23 fixed for clean
    EOF, on the other arm. Fix: a pure `reconnect_floor_delay(recoverable,
    since_last_reconnect, floor) -> Option<Duration>` helper, called by *both*
    arms; the timestamp variable is renamed `last_recoverable_reconnect` and set
    after every recoverable reconnect. The helper returns `None` immediately when
    `!recoverable`, so the UDS framing-error path is byte-for-byte unchanged (no
    sleep, never records a timestamp) — verified by the 944→881-lib runtimed suite
    staying green and a dedicated `floor_never_delays_a_non_recoverable_transport`
    test. Alternative considered: a separate accept-then-immediate-error counter
    per arm — rejected; a single shared floor on the combined reconnect rate is
    simpler and is exactly the throttle wanted regardless of which failure mode
    recurs. 4 new unit tests for the policy.

Phase 3b warm-up verification: `cargo test -p notebook-cloud-transport` 16;
`cargo test -p runtimed` 881 lib + integration suites green (UDS unchanged);
`cargo xtask lint --fix` clean; clippy `-D warnings` clean on both crates. No new
workspace crate (no bump-targets change).

## Phase 3b: WS reconnect/re-auth + full-resync on cloud reconnect (req #2)

26. **The reconnect *mechanism* was already complete after 3a; 3b adds the
    re-auth seam and the missing test coverage.** `reconnect_with_backoff` is
    generic over `FrameTransport` and the cloud `connect()` re-dials + re-reads
    `cloud_room_ready`; both reconnect arms (clean-EOF and framing-error) already
    reset `coordinator_sync_state` and fire `state_kick_tx` (verified by
    inspection at `runtime_agent.rs` — the kick drives a full RuntimeStateDoc
    re-send on *every* recoverable reconnect, cloud included, because the kick is
    transport-agnostic). So 3b is two concrete deliverables, not a rewrite:
    a fresh-token seam and unit tests for the backoff loop.

27. **Re-auth uses an optional `TokenRefresher` closure, not a widened
    `CloudAuth`.** `CloudAuth` holds a *static* token, fine for a short session
    but wrong for a long-lived peer: its OIDC token expires mid-session, and a
    reconnect that re-presents the expired token is rejected at the upgrade, so
    `reconnect_with_backoff` would burn all 10 attempts and give up. Fix:
    `CloudWsFrameTransport::with_token_refresher(config, refresher)` takes an
    `async` closure (`TokenRefresher = Arc<dyn Fn() -> Future<io::Result<String>>>`)
    that the transport calls *before each connect* via `effective_auth()`; the
    returned token is re-wrapped in the configured auth variant by
    `CloudAuth::with_token` (preserving the variant and any `Dev` user label).
    `None` (the default `new()`) keeps the static-token behavior byte-for-byte.
    Alternative considered: store an `Arc<Mutex<String>>` the agent mutates —
    rejected; a pull-on-connect closure has no lock-ordering hazard and keeps the
    refresh policy (cache, retry, endpoint) entirely on the agent side. The
    closure's error surfaces as a connect error (kind preserved) so the backoff
    loop treats it as a retryable failed connect. Wiring this into a daemon spawn
    path is 3c; this PR ships the seam + tests only.

28. **`reconnect_with_backoff` is unit-tested with a mock `FlakyTransport`.** A
    `FrameTransport` whose `connect` fails the first N calls (with
    `ConnectionRefused`) then succeeds, counting attempts. Three tests under
    `start_paused` time (so the exponential sleeps are instant): recovers after 3
    transient failures (4 total attempts), recovers on the final allowed attempt
    (9 fail → success on the 10th), and gives up after exactly `MAX_ATTEMPTS`
    (10) with the last error preserved so a genuinely-gone room lets the agent
    exit rather than spin forever.

Phase 3b verification: `cargo test -p notebook-cloud-transport` 20 (was 16);
`cargo test -p runtimed` 884 lib (was 881) + integration suites green (UDS
unchanged); `cargo xtask lint --fix` clean; clippy `-D warnings` clean on both.
No new workspace crate.

**NEEDS US (3b):** the token-refresher seam is unit-tested but has no live
re-auth proof — that needs a long-lived session against a preview room where an
OIDC token actually expires and the refresher mints a new one. Fold this into
the 3c cross-machine re-proof (same creds/deploy). Nothing in 3b changes the
static-token path, so this is a forward-looking validation, not a regression risk.

## Phase 3c (CODE ONLY): daemon spawn path + doc-actor identity

29. **Premise (b) of the original 3c plan — "swap the daemon's stripping receive
    for `receive_sync_message_with_changes`" — was a misreading; the agent is
    ALREADY consumer-side, and the swap would be a regression. Dropped.** The
    plan assumed the agent's receive path
    (`runtime_agent.rs` RuntimeStateSync arm → `receive_sync_and_foreign_comms_recovering`)
    *strips* incoming changes the way the server-toward-viewer
    `RuntimeStateDoc::receive_sync_message` (doc.rs:2980) does. It does not. Reading
    `receive_sync_and_foreign_comms` (doc.rs:3127-3219): it calls **raw**
    `self.doc.sync().receive_sync_message` (doc.rs:3140), which *applies* every
    incoming change to the main doc, and then additionally computes a
    *foreign-comms* fork purely for kernel-echo suppression (the doc comment at
    3120-3122 states it outright: "The main doc still absorbs every applied change
    (including kernel echoes)"). So the agent already has the consumer semantics a
    cloud peer needs. Swapping it for plain `receive_sync_message_with_changes`
    would *lose* the per-change `rt:kernel:` echo filter and re-introduce the
    widget-amplification loop that method was written to break — a regression, not
    a fix. Verified by code-read + the existing echo-suppression tests. Net: 3c's
    real surface is only premise (a), the doc-actor identity.

30. **The spawn path is a generic inner `run_runtime_agent_on_transport<T, F>`
    that both entry points funnel through; the transport-kind discriminant is a
    `resolve_actor: FnOnce(&T) -> Result<String>` closure, not a runtime enum or a
    trait method.** `run_runtime_agent` (UDS) passes `move |_| Ok(runtime_agent_id)`
    — the resolver ignores the transport and returns the daemon-supplied id, the
    exact value the bootstrap used inline before, so the desktop/daemon path is
    byte-for-byte unchanged (verified: full runtimed suite green, 884→888 only by
    added tests). `run_cloud_runtime_agent` builds a `CloudWsFrameTransport` and
    passes a resolver that reads `transport.principal()` *after* connect. Why a
    closure, not an enum discriminant in the loop: the only thing that actually
    differs by transport is the actor label, and it's needed exactly once at
    bootstrap; a closure localises that one difference without threading a
    `TransportKind` through the 1400-line loop or widening `FrameTransport`.
    Alternative considered: resolve the actor *before* connect — impossible for
    cloud, the principal is only known from `cloud_room_ready`, which is why the
    resolver runs post-`connect()`.

31. **Cloud doc-actor label is `<principal>/<operator>:<nonce>` via
    `cloud_actor_label`.** Principal from `transport.principal()` (the room's
    authenticated identity; `validate_room_notebook_change_actors` drops changes
    authored under anything else — decision #6). Operator is a caller-supplied
    role suffix (e.g. `agent:runt`). The nonce is a per-process random suffix
    because reusing one actor label across separate doc instances collides at
    `(actor, seq 1)` → Automerge `DuplicateSeqNumber` when the room syncs the prior
    change back (the exact hazard the `runt-cloud-peer` spike documented). The
    resolver *errors* if the principal is absent rather than authoring under a bogus
    actor, since a wrong actor fails silently (the room discards every change).
    Unit-tested: label format/uniqueness, the no-principal error path, and the UDS
    pass-through property.

Phase 3c verification: `cargo test -p runtimed` 888 lib (was 884) + integration
suites green (UDS byte-for-byte unchanged); `cargo test -p xtask` 28 (bump-targets
guard green — `notebook-cloud-transport` was already registered, now also a
`runtimed` dep); `cargo xtask lint --fix` clean; clippy `-D warnings` clean.

**NEEDS US (3c):** the live cross-machine re-proof. `run_cloud_runtime_agent` is
built and unit-tested behind the transport gate, but nothing yet *calls* it from a
CLI/daemon command, and it has never run against a real room. To close req #2/#3
end-to-end an interactive session with creds must: (1) deploy a preview room (or
use an existing one) and grant the agent's principal the explicit `runtime_peer`
ACL row (decision #9); (2) wire a CLI subcommand (e.g. `runtimed cloud-runtime-agent
--cloud-url --notebook-id --operator`, plus a `CloudAuth` source) — trivial, but
left out here since it can't be verified headlessly; (3) spawn it as `runtime_peer`
and confirm a cloud-submitted cell runs on the daemon-managed kernel and renders in
the viewer, through the *real* agent (not the `runt-cloud-peer` spike); (4) exercise
the 3b token-refresher against an actually-expiring token. None of this is possible
without preview deploy + staging creds, which this autonomous session does not have.
The code path is additive and gated, so it cannot affect the desktop/daemon path.

## Phase 3 remaining plan (3d+)

Ordered by the lifecycle analysis. 3a (req #1), 3b (req #2), and 3c CODE (doc-actor
identity; live re-proof is NEEDS-US) are done. Remaining, in dependency order:

- **3d: cloud-room DurableObject watchdog (reqs #3, #7; the safety net the daemon can't
  provide).** TypeScript in `apps/notebook-cloud/`. Thread peer **scope** through
  `removePeer` → `room-materializer.removePeer` → `RoomHostHandle.remove_peer`
  (`notebook-room.ts:635`, `runtimed-wasm/src/lib.rs:523`), give `RoomHostHandle` a
  reconciliation mutator (it has none), and use a DO `alarm()` with a grace period to
  terminalize running/queued executions and flip lifecycle when a `runtime_peer` departs.

- **3e: policy relaxation (req #4; gates 3d being legal).** `crates/runtime-doc/src/policy.rs:403-405`
  blocks editor/owner from writing `state.kernel` ("daemon-owned"). The watchdog (room host)
  needs a *narrow* authority to terminalize lifecycle on `runtime_peer` departure. Recommended:
  both (a) a scoped relaxation for the lifecycle-to-terminal transition, and (b) a model-level
  `Disconnected` `RuntimeLifecycle` / `last_seen` on `KernelState`
  (`crates/runtime-doc/src/types.rs:272`) so viewers distinguish gone-but-recoverable from dead.

- **3f: inbound request channel (req #5) + terminal-delta buffering (req #6).** Route
  interrupt/restart `RuntimeAgentRequest`s to the cloud agent (hosted REQUEST dispatch), and
  don't `break` the agent loop on a single writer error (`runtime_agent.rs` outbound arm);
  buffer and replay across a blip. 3f's req #6 is partly addressed by 3a (the loop no longer
  tears down on a clean close), but the writer-error `break` in the `state_changed_rx` arm
  remains.
