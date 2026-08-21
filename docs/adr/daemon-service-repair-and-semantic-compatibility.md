# Daemon Service Repair and Semantic Compatibility

**Status:** Accepted, 2026-08-21.

## Context

The desktop updater replaces the application bundle while the old app process
continues coordinating the upgrade. That old process can launch the new
`runtimed` sidecar from the replaced bundle while an older daemon still owns
the stable socket. Service configuration is not proof of process ownership:
the socket owner may come from a legacy launchd registration, SMAppService, a
manual start, or an orphaned process even when the current service artifact is
missing.

Commit equality also answers a different question from compatibility. Two
builds can implement the same supported daemon behavior, while an older daemon
can share the current wire framing but lack behavior required by a new client.

## Decision 1: Compatibility has separate wire and semantic versions

`PROTOCOL_VERSION` and `MIN_PROTOCOL_VERSION` continue to describe framing and
serialization compatibility. `DAEMON_API_VERSION` and
`MIN_DAEMON_API_VERSION` describe the semantic Pool/daemon behavior required by
clients.

`GetDaemonInfo` reports both. The semantic field defaults to zero when absent,
so new clients can inspect and repair daemons that predate the field without
breaking the version-tolerant Pool channel. Adding an optional response field
does not require a wire-version bump. A daemon API bump is required when a new
client depends on behavior that cannot be represented as an optional
capability and old behavior would be unsafe or incorrect.

Normal desktop admission uses the supported wire range and semantic daemon API
range. Build and commit identity remain diagnostic facts, not connection
compatibility gates.

## Decision 2: The new sidecar owns the repair transaction

The `runtimed install` sidecar performs the complete repair, including when no
recognized service artifact exists:

1. Inspect the live stable-socket owner and capture its process incarnation.
2. Request graceful shutdown over the Pool channel and allow the daemon to
   finish its notebook durability barriers. If clean shutdown is refused or
   exceeds the repair patience bound while the daemon remains responsive,
   abort repair without stopping the service or process.
3. After clean shutdown completes, or after the daemon becomes unresponsive,
   stop the registered service as a compatibility fallback.
4. If the captured process remains, stop that specific process and confirm the
   socket owner is gone.
5. Install or normalize the service definition using the sidecar's own binary.
6. Start the service.
7. Exit successfully only after the stable socket reports a different daemon
   incarnation running the sidecar's exact build and current semantic API.

The old app process asks for this operation but does not decide the target
version. This makes the repair implementation upgrade with the newly installed
bundle and preserves the stable `runtimed install` command older apps already
invoke.

## Decision 3: Retry and repair are distinct user actions

Retry reconnects the current notebook transport. Repair replaces and
re-registers the local runtime through the same sidecar transaction used by an
upgrade, then reconnects. Native hosts expose repair as a capability; hosts
that do not own a local service do not display the action.

The app must not emit or render `Ready` after a failed repair or an incompatible
daemon admission result.

## Consequences

- Compatible builds can coexist without commit-gated reconnect loops.
- Old-but-wire-readable daemons are repaired using an explicit semantic
  version rather than accidental build identity.
- launchd/SMAppService configuration and live socket ownership are inspected
  independently.
- Repair never escalates process termination merely because a responsive
  daemon is still completing or has rejected its durability-safe shutdown.
- Exact build equality remains a required postcondition of an explicit repair,
  where it proves that the intended sidecar actually took ownership.
- Cross-version updater tests must include a live orphan daemon with no current
  service artifact.
