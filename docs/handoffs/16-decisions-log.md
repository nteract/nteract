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
    dependency-light per decision 3), and the agent has exactly one transport per process
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
    consumer-side `receive_sync_message_with_changes` (decision 6) instead of the daemon's
    `receive_sync_and_foreign_comms_recovering`. Most critically, a cloud-WS EOF currently
    falls into `kernel.shutdown()` (lifecycle-analysis req 1), so spawning the agent on the
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
to *invoke* the cloud transport yet (decision 17).

## Phase 3a: transport-aware clean-EOF policy

21. **Phase 3 is split: 3a (transport-aware clean-EOF policy) lands now; 3b+ (spawn path,
    WS reconnect/re-auth specifics, cloud-room watchdog, policy relaxation, inbound request
    channel) are planned but not yet built.** Why: Phase 3 spans three codebases (Rust agent,
    TS Cloudflare worker, `runtime-doc` policy) and its safety-critical pieces (the DO
    watchdog, the policy relaxation) need integration/live verification that isn't fully
    headless. But lifecycle-analysis **req 1**, "a cloud-WS clean EOF must NOT fall into
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
    Phase 3a (decision 23) added the 1s reconnect floor only to the clean-EOF
    (`None`) arm. The framing-error (`Some(Err)`) arm plus `reconnect_with_backoff`
    only sleep between *failed* connects, so a cloud room that accepts the
    connection and then errors the stream every cycle would spin reconnects at RTT
    rate (a self-inflicted DoS on the room) — the same hazard 23 fixed for clean
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

## Phase 3b: WS reconnect/re-auth + full-resync on cloud reconnect (req 2)

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

**Deferred (3b):** the token-refresher seam is unit-tested but has no live
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
    authored under anything else — decision 6). Operator is a caller-supplied
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

**Deferred (3c):** the live cross-machine re-proof. `run_cloud_runtime_agent` is
built and unit-tested behind the transport gate, but nothing yet *calls* it from a
CLI/daemon command, and it has never run against a real room. To close req 2/3
end-to-end an interactive session with creds must: (1) deploy a preview room (or
use an existing one) and grant the agent's principal the explicit `runtime_peer`
ACL row (decision 9); (2) wire a CLI subcommand (e.g. `runtimed cloud-runtime-agent
--cloud-url --notebook-id --operator`, plus a `CloudAuth` source) — trivial, but
left out here since it can't be verified headlessly; (3) spawn it as `runtime_peer`
and confirm a cloud-submitted cell runs on the daemon-managed kernel and renders in
the viewer, through the *real* agent (not the `runt-cloud-peer` spike); (4) exercise
the 3b token-refresher against an actually-expiring token. None of this is possible
without preview deploy + staging creds, which this autonomous session does not have.
The code path is additive and gated, so it cannot affect the desktop/daemon path.

## Phase 3e: liveness model (`last_seen`) — the headless half of req 4

32. **3e is reordered ahead of 3d, and split: the headless model half
    (`last_seen`) lands now; the `Disconnected` variant + the policy relaxation
    defer to land *with* 3d under live verification.** The original plan put 3d
    (watchdog) before 3e and called 3e the thing that "gates 3d being legal." Two
    findings reshaped that:
    - **The watchdog's own write path does NOT go through the
      `validate_runtime_state_sync_scope` policy, so the policy relaxation is not
      actually on 3d's critical path.** `validate_runtime_state_sync_scope`
      (policy.rs:115) and its `validate_comm_state_only_runtime_delta` deadlock
      (policy.rs:403-405) gate only *incoming peer sync frames* — they run in
      `RoomHostHandle::receive_runtime_state_sync` (`runtimed-wasm/src/lib.rs:715`)
      before applying a peer's sync message. A DO-internal `alarm()` watchdog that
      authors *directly* on the room host's `state_doc` (the recommended 3d design,
      and the only place the net can live since the daemon's death is the trigger)
      bypasses that check entirely. The relaxation matters only for an alternative
      "Owner peer pushes the reconciliation" design — which 3d should avoid for
      exactly this reason. So 3e's policy half is deferred, not blocking.
    - **A new `RuntimeLifecycle::Disconnected` variant has a ~28-Rust-file + TS
      blast radius and its payoff is viewer-facing UX**, verifiable only against a
      deployed viewer (Deferred). Landing it unverified is higher
      risk than the watchdog needs. The lifecycle analysis explicitly sanctions a
      `last_seen` timestamp as the *alternative* form of req 4(b); that is the
      low-risk, fully-headless piece the watchdog actually reads.

33. **`last_seen: Option<String>` on `KernelState` (doc.rs), with a `set_last_seen`
    setter and `read_state` wiring.** ISO-8601 timestamp the runtime peer was last
    observed present, for the watchdog's staleness decision and for viewers to tell
    "peer reporting" from "peer silent since T". Design points:
    - **Not added to the frozen genesis scaffold** (`RUNTIME_STATE_GENESIS_V2_BYTES`),
      so a fresh doc reads `None` and the `runtime_state_genesis_artifact_matches_scaffold`
      test stays green — no genesis re-bake, no schema-version bump. Purely additive
      on the serde model (`#[serde(default)]`), so `..Default::default()` call sites
      in `runtimed-node`/`runtimed-py` are unaffected.
    - **Clears to CRDT `Null` → reads back `None`** (like `last_saved`), *not* the
      empty-string "scaffolded but unset" convention of `error_reason`/`error_details`,
      because a liveness field has no meaningful "" state.
    - **Idempotent**: re-stamping the current value is a no-op (no head churn), since
      a watchdog/peer stamps it frequently and must not trigger spurious sync rounds.
    - **No policy change needed yet**: `last_seen` lives under `state.kernel`, so the
      existing kernel-ownership rules already make it `runtime_peer`-writable and
      editor-blocked — pinned by a `last_seen_is_runtime_peer_writable_but_blocked_for_editor`
      test. The runtime peer stamps its own liveness; the room-host watchdog writes
      directly (bypassing the sync policy per 32).
    5 unit tests; runtime-doc 215 (was 211) + genesis tests green; dependent crates
    (`runtimed` 888, `notebook-sync`, `runtimed-py`, `runtimed-node`) green; clippy clean.

**Deferred (3e deferred halves):** (1) the `RuntimeLifecycle::Disconnected` variant —
defer to land with 3d so its viewer UX is validated against a live deployed viewer in
the same pass (the watchdog can already express "stale" via `last_seen` + flipping to
the existing `Error`/`Shutdown` terminal states in the meantime); (2) the
`policy.rs:403-405` relaxation — only needed if 3d is ever built as an Owner-peer-push
rather than a DO-internal watchdog; the recommended DO-internal design needs no policy
change. Decide (2) when 3d's mechanism is chosen.

## Phase 3f req 6: writer-error recovery (the headless half of 3f)

34. **3f is split: req 6 (writer-error must not kill the kernel on a recoverable
    transport) lands now; req 5 (inbound request channel) defers — it needs the
    3d worker.** req 5 routes interrupt/restart `RuntimeAgentRequest`s from the
    cloud room to the agent, which requires a hosted REQUEST dispatch on the
    DurableObject (3d, Deferred). req 6 is pure Rust in `runtime_agent` and is the
    last place a transient cloud blip still destroys a healthy kernel after 3a:
    the two outbound (writer) `select!` arms — the `state_changed_rx`
    RuntimeStateSync send and the `async_response_rx` reply send — `break` the loop
    (→ kernel shutdown) on a single `send_frame` error.

35. **On a recoverable transport, a writer send error reconnects + resyncs instead
    of `break`ing; the UDS path keeps the historical teardown byte-for-byte.** A
    new writer-only helper `reconnect_after_writer_error` applies the shared flap
    floor, calls `reconnect_with_backoff`, and stamps `last_recoverable_reconnect`
    (so writer-triggered reconnects share the read arms' throttle). Both writer
    arms now branch on `transport.clean_eof_is_recoverable()`: `false` (UDS) →
    `break` exactly as before; `true` (cloud) → drop source, reconnect, reset
    `coordinator_sync_state`, kick `state_kick_tx`, continue. Why no explicit
    buffer-and-replay (the analysis's "buffer the change and replay"): the failed
    RuntimeStateSync delta is *durable in the local doc*, and the fresh sync state
    + resync kick re-send it on reconnect — **Automerge's own resync IS the replay**,
    the same mechanism the framing-error arm has always relied on (decision 22/3a).
    The one genuinely-lost item is the one-shot `async_response` reply envelope
    (not re-derived by resync), but its *effect* (env progress/state from
    SyncEnvironment) is in the RuntimeStateDoc and does resync; only the reply
    envelope is dropped — acceptable, and documented at the site. A dedicated
    egress buffer was considered and rejected as redundant with Automerge resync
    and a new source of ordering bugs. 3 unit tests on the helper (recover+stamp,
    give-up propagation, the UDS discriminant the loop branches on); the read arms
    are left byte-for-byte unchanged.

Phase 3f(req 6) verification: `cargo test -p runtimed` 891 lib (was 888) +
integration suites green (UDS unchanged); `cargo xtask lint --fix` clean; clippy
`-D warnings` clean.

**Deferred (3f req 5):** the inbound request channel — needs the 3d DurableObject
hosted REQUEST dispatch to deliver interrupt/restart `RuntimeAgentRequest`s to the
cloud agent. Detection of the kernel-side *effect* already survives (decision/req
analysis); only the trigger path is missing, and it can't be built or verified
without the worker (3d) + a live room. Build it alongside 3d.

## Phase 3d (CODE): cloud-room DurableObject watchdog

36. **3d's DO-internal watchdog is built and unit-tested; the deploy + the
    live peer-drop re-proof are Deferred.** Implements the safety net the daemon
    structurally cannot provide (reqs 3, 7): when the room's `runtime_peer`
    (the daemon) vanishes, the room itself terminalizes the orphaned state. Three
    layers, each verifiable headlessly:
    - **Rust (`runtimed-wasm`): `RoomHostHandle::reconcile_runtime_peer_gone(reason)`**
      — the reconciliation mutator `RoomHostHandle` previously lacked. Marks all
      in-flight (`running`/`queued`) executions failed, clears the queue, and flips
      a *still-live* kernel (`Running`/any starting phase) to `Error` with an
      `error_details` note — leaving an already-terminal `Error`/`Shutdown`/`NotStarted`
      untouched so a clean shutdown that raced the disconnect isn't relabeled. Then
      broadcasts the corrected state to surviving peers. Authoring is **direct** on
      the room host's `state_doc`, which doesn't pass through
      `validate_runtime_state_sync_scope` (decision 32), so no policy relaxation is
      needed. Native-testable via `reconcile_runtime_peer_gone_inner` (rlib `cargo
      test`, no wasm/node): 4 tests (terminalize+error, idempotent no-op,
      clean-shutdown-not-relabeled, broadcast-to-survivors).
    - **TS materializer**: `reconcileRuntimePeerGone(reason)` forwards to the wasm
      mutator and normalizes the result.
    - **TS DurableObject (`notebook-room.ts`)**: a `runtime_peer`-departure watchdog.
      `removePeer` and the attach path now branch on `peer.identity.scope`; when the
      last `runtime_peer` leaves, `refreshRuntimePeerWatch` arms a DO `alarm()`
      `RUNTIME_PEER_GONE_GRACE_MS` (30s) out and persists the notebook id under
      `RUNTIME_PEER_WATCH_KEY`; a `runtime_peer` rejoining inside the window disarms
      it. `alarm()` re-checks membership (no-op if a peer returned), else reconciles
      and broadcasts. The grace window is what makes a transient blip recover rather
      than terminalize. The `DurableObjectStorage` type gained optional
      `setAlarm`/`getAlarm`/`deleteAlarm` (Cloudflare-provided; optional so test
      fakes need not implement them, and the watchdog feature-detects before arming).
      3 node tests (arm+fire reconciles, rejoin disarms, present-peer fired-alarm
      no-op) with an alarm-capable fake state.

37. **Scope threading was simpler than the plan anticipated: the DO already had
    `peer.identity.scope` at every `removePeer`/attach site, so it did NOT need to be
    threaded through `room-materializer.removePeer` → `RoomHostHandle.remove_peer`.**
    The original plan (and lifecycle-analysis req 3 bullet 1) assumed the watchdog
    had to learn the departing peer's scope by passing it down through those layers,
    because `removePeer(peerId)` is scope-blind. But the *decision* — "was that a
    runtime_peer? then arm the watchdog" — is made in the DO, which holds the full
    `Peer` (incl. `identity.scope`). The sync-state cleanup in `remove_peer(peer_id)`
    genuinely only needs the id, so it's left unchanged. Avoiding the unnecessary
    signature churn through two layers keeps the diff smaller and the wasm boundary
    stable.

Phase 3d verification: `cargo test -p runtimed-wasm` 26 (was 22, +4 reconciliation);
`node --import tsx --test test/notebook-room.test.ts` 19 (+3 watchdog);
`test/room-materializer.test.ts` 25 pass / 4 fail — the 4 failures are a
**pre-existing environmental baseline** (published-snapshot fixtures; reproduced on a
clean `origin/main` worktree, unrelated to this change); `tsc --noEmit` clean; clippy
`-D warnings` clean.

**Deferred (3d):** (1) deploy the worker to preview (the `alarm()` handler + the
`DurableObjectStorage` alarm methods only execute on a real Cloudflare DO; the unit
tests use a fake clock/storage). (2) Live peer-drop re-proof: with a real runtime_peer
attached to a preview room running a cell, kill the peer, and confirm after the 30s
grace the viewer sees the spinning cell go to error and the kernel flip to Error —
and that a reconnect *within* 30s does NOT terminalize. (3) Tune `RUNTIME_PEER_GONE_GRACE_MS`
against real reconnect latencies. None of this is possible without a preview deploy and live credentials. The code is gated behind the alarm API feature-detect, so a
storage backend without alarms (or the desktop/UDS path) is unaffected.

## Phase 3 remaining (3f req 5 only)

3a (req 1), 3b (req 2), 3c CODE (doc-actor identity), 3d CODE (watchdog), 3e model
half (`last_seen`), and 3f req 6 (writer-error recovery) are done. Remaining:

- **3f req 5: inbound request channel.** Route interrupt/restart
  `RuntimeAgentRequest`s to the cloud agent via the 3d DurableObject hosted REQUEST
  dispatch. req 6 (don't tear the kernel down on a writer error) is DONE
  (decisions 34–35); req 5's trigger path needs the worker + a live room.

## Workstation endpoint (the second half of 16): scoping

The first half (transport-agnostic `runtime_agent` + `run_cloud_runtime_agent`)
is merged (#3426). This is the daemon-side **workstation endpoint**: list the
environments it has, and allocate/start a runtime in env X for room Y, driving
`run_cloud_runtime_agent`. Full scope: `docs/handoffs/16-workstation-endpoint.md`.

38. **Endpoint "start a runtime" is designed as launch-on-attach (option A), not
    wait-for-req-5 (option B).** The cloud agent attaches as a `runtime_peer` and
    then *waits for an inbound `RuntimeAgentRequest::LaunchKernel`* before it starts
    a kernel (`runtime_agent.rs:1082`). Over the daemon UDS that frame comes from the
    daemon; over the cloud transport it must come from the room — and that inbound
    channel is req 5, **Deferred** (needs the 3d worker + a live room, decision 34).
    So a cloud agent spawned today *attaches but is never told to launch*. The ADR
    says the endpoint *allocates **and starts*** a runtime in env X. The only way to
    honor "start" headlessly while req 5 is deferred is to resolve env X up front
    (reusing the launcher) and hand the agent an *initial* `KernelLaunchConfig` it
    applies right after bootstrap. Alternative (B, attach-only until req 5) was
    rejected as not meeting "start" and leaving the endpoint un-demonstrable
    headlessly. Why still safe: land launch-on-attach as a separate gated commit
    *after* the lower-risk CLI + list-environments pieces, mirroring the
    decision-22 recoverable-transport gate so the UDS/desktop path is byte-for-byte
    unchanged. Until it lands, the CLI subcommand attaches only.

39. **list-environments is a projection over the existing `PoolDoc`, not a new
    enumerator.** `PoolDoc::read_state()` (`pool_state.rs:248`) already publishes
    available/warming/health per env kind (synced to peers over PoolStateSync). The
    endpoint maps that to a `WorkstationEnvironment` list. Alternative: a fresh disk
    walk / pool inspection — rejected, it would duplicate `update_pool_doc`
    (`daemon.rs:5423`) and drift from the authoritative state. Captured/inline named
    envs (the `runt env list` cache-dir enumeration, `runt/src/main.rs:4126`) are a
    second, optional projection behind the same `WorkstationEnvironment` shape so it
    can later back both the workstation-target API and the Content-rail catalog
    (ADR decision 8).

40. **The missing invocable caller for `run_cloud_runtime_agent` is closed with a
    hidden `runtimed cloud-runtime-agent` subcommand**, mirroring the internal
    `runtime-agent` subcommand (`main.rs:126`). Auth token comes from the
    environment (`RUNT_CLOUD_TOKEN` + an auth-kind selector), never argv — the ADR
    security constraint ("never put API keys in URLs/argv for the long-running
    process"). Alternative: a `runt` (user-facing) subcommand — deferred; the first
    need is an internal/automation entry the control plane and the deferred live
    proof drive, matching how `runtime-agent` is shaped.

41. **Deferred (workstation endpoint): the live attach re-proof.** Spawning
    `runtimed cloud-runtime-agent` against a real preview room (with the
    `runtime_peer` ACL row, decision 9) and confirming a cell runs on the
    daemon-managed kernel and renders in the viewer needs staging creds + a deployed
    worker this autonomous session does not have. Exact run steps are in
    `16-workstation-endpoint.md` ("Deferred — needs us"). Not attempted headlessly.
    The hosted-side pieces (workstation registry D1 + routes, doc-agent control
    channel, room target-selection APIs) are Worker build items (ADR sequence
    3–9), out of scope for this daemon-side headless slice.

### Workstation endpoint: Phase B (built, headless)

Built as a stack of four PRs, each gated/additive (the desktop/UDS path is
byte-for-byte unchanged): B1 `cloud-runtime-agent` CLI (#3428), B2
`list_environments` (#3429), B3 launch-on-attach (#3430), B4
`allocate_runtime_for_room` (#3431). All live under `crates/runtimed/src/workstation/`.

42. **`allocate_runtime_for_room` resolves only the `current_python` policy
    headlessly; prewarmed-pool allocation is a follow-up.** `current_python` is the
    ADR's first-class Outerbounds policy (Decision 5): launch against an explicit
    interpreter the connector already has, with no daemon env pool — so the launch
    needs no `Daemon::take_uv_env` and the planning step is a pure mapping
    (`RoomTarget` + auth + interpreter + reserved ports → `Allocation`), unit-tested
    without a live daemon or a dialed room. Allocating a *prewarmed-pool* env
    additionally needs a live daemon (the pool + `take_uv_env`) and its attach can't
    be verified headlessly, so it's deferred. The launch trigger reuses B3's
    launch-on-attach (the same `handle_runtime_agent_request` path an inbound RPC
    uses), and the `cloud-runtime-agent` CLI exposes it via `--python-path` /
    `--notebook-path`, making the full "allocate and start" path invocable for the
    deferred live proof. The kernel-port reservation is held for the agent's whole
    lifetime because, unlike the daemon UDS path, the cloud agent has no separate
    coordinator holding the ports.
