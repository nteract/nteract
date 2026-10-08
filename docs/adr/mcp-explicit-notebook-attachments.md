# Explicit notebook attachments in MCP

**Status:** Accepted, 2026-10-08. The registry and mandatory attachment targeting
apply across initialize-based and native protocols. Qualification boundaries
are recorded below.

This decision supersedes active-notebook routing, connect supersession and
parked-cache ownership in [MCP Session Lifecycle and Daemon
Supervision](mcp-session-lifecycle.md). That record's daemon authority, source
recovery and readiness decisions remain in force.

## Context

An MCP stdio process can serve requests from unrelated chats. A mutable
process-wide current notebook cannot represent their separate intent. After
A connects to notebook A and B connects to notebook B, a later unqualified cell
creation from A would be routed to B. A cell ID belongs to a notebook; checking
that ID in the selected document cannot establish which notebook A intended.

A single daemon coordinates shared content and runtime ownership. It does not
repair an MCP request that already selected the wrong notebook. Protocol
negotiation, notebook identity, logical attachment ownership, backing peers and
runtime readiness have separate responsibilities.

The [MCP statelessness requirement](https://modelcontextprotocol.io/specification/2026-07-28/basic#statelessness)
requires state spanning requests to be referenced explicitly. Initialize-based
clients can also pass application identifiers in tool arguments; they do not
need to adopt a new MCP protocol revision to target notebooks safely.

## Decision 1: Every notebook operation names an attachment

Every notebook-scoped `tools/call` requires a nonempty `notebook_handle`, on
every supported protocol. Discovery and notebook acquisition do not require an
existing handle. The server advertises the required argument in live tool
schemas and the startup cache. Missing targets fail before notebook edits,
kernel control, execution, dependency changes, saves or window-opening effects.

Connect/create return a fresh logical attachment and its opaque handle. Calls
retain that handle and scope it to the request. Opening another notebook does
not alter its meaning. Concurrent acquisitions of different targets do not
supersede one another. Repeated acquisitions of the same notebook also produce
independent handles. Continuing an existing attachment uses its retained handle
rather than repeatedly acquiring more owners.

This application contract is independent of initialize-based or per-request
protocol negotiation. Client/process labels and optional metadata cannot stand
in for a notebook target. Older workers that lack attachment routing must not
silently ignore a supplied handle and execute against their active slot; the
proxy rejects unsupported notebook forwarding before side effects.

A handle is routing and ownership identity, not a new authentication credential.
Daemon/hosted admission remains authoritative. Requests still observe source,
document, runtime and causal execution gates. Execution references a synced
`cell_id`, never a separate code string.

Relevant source: `crates/runt-mcp/src/targets.rs`, `lib.rs`, `session.rs`,
`crates/mcp-transport/src/lib.rs`, and proxy `proxy.rs`.

## Decision 2: Logical ownership is separate from physical peers

The worker registry retains a handle until deliberate release or definitive
membership expiry. At most 128 logical attachments plus pending acquisitions
are retained; capacity refusal is explicit. Canceled/failed acquisitions return
their reservations. There is no TTL or arbitrary registry eviction.

A compatible healthy local backing peer may serve multiple logical handles.
Its reuse key includes canonical target, fixed endpoint, live daemon incarnation
and operator. Reuse requires healthy source/replica evidence and current daemon
path metadata; it cannot bind a stale saved-path alias to an old room. Optional
room-list lookup failure skips reuse and attempts guarded fresh admission using
the requested target. Hosted peers remain independent without a stable
authenticated principal/source key.

Releasing A1 removes only A1's ownership and capacity. A2 can keep the same
backing peer alive and continue reads, sync, edits and subscriptions. The last
owner releases the physical backing. The active slot and bounded parked cache
used by internal recovery are not the ownership registry.

Notebook-ID resource URIs identify a notebook explicitly and remain compatibility
addressing. Ambiguous identities require an exact handle. They never provide an
implicit target for notebook-scoped tool calls.

Relevant source: `crates/runt-mcp/src/attachments.rs`, `tools/session.rs`, and
`resources.rs`.

## Decision 3: Handles expire without rebinding

Release signals expiry immediately even while an admitted operation holds a
cloned payload. Successful handle-scoped tool/resource completion revalidates
membership. A side effect may already have occurred; expiry does not claim
rollback, and original failures or unknown outcomes remain intact.

Local daemon identity is `pid + started_at`. Confirmed absence or a replacement
incarnation expires affected local registry entries; an inconclusive identity
query alone does not. Hosted entries are separate from local-daemon expiry.
Worker replacement expires all of that worker's old handles. Clients reconnect
to the original target, obtain new handles and establish new baselines.

Internal source recovery retains its existing incarnation, intent-epoch and
publication gates. It can recover notebook availability without turning an old
public handle into a new peer. No operation missing a handle is completed by
selecting a recovered notebook. Ambiguous mutations are never automatically
replayed after lost replies.

Relevant source: `daemon_watch.rs`, `session_activation.rs`, proxy `proxy.rs`
and `circuit_breaker.rs`.

## Decision 4: Observation loss is distinct from ownership expiry

Resource reads and subscriptions capture their attachment identity. Native
listen requests own their URI leases, and the proxy reference-counts underlying
child watches. A canceled listener cannot unsubscribe another. Cached listener
admission rechecks the child. Native notifications carry the upstream
subscription ID.

Release or membership expiry uses `attachment_expired` and
`io.nteract/attachmentExpired`. Terminal backing loss uses
`attachment_unavailable` and `io.nteract/attachmentUnavailable`. The latter ends
observation of that peer while retaining logical ownership and capacity. Read
and admission errors preserve original code/message/readiness and add typed
code/handle data. Already-signaled expiry wins.

Only the affected URI retires. A mixed A/B listener continues B until its last
URI ends. Missing cells, pending readiness and untyped transient failures do
not end a healthy lease. An old observer cannot revive when a fresh attachment
joins the same notebook. Observation receivers do not independently keep peers
or kernels alive.

Relevant source: `subscriptions.rs`, `resources.rs`, proxy
`native_subscriptions.rs`, `observation_bridge.rs`, and `child.rs`.

## Compatibility and migration

Supported initialize-based protocol revisions remain supported. Their tool
arguments change: previously unqualified notebook operations now require the
handle from a successful connect/create. Cached tool definitions and old skill
examples must be refreshed along with the worker; app bundling alone does not
refresh a running host's model context.

Prefer in-place catalog refresh within the existing chat. The proxy publishes
the actual child's catalog, advertises `listChanged`, and uses standard catalog
notifications to ask supporting hosts to relist. Native clients receive these
notifications through an accepted catalog subscription. Publication requires
successful, nonempty discovery from the current connected child. Failed, empty,
stale or disconnected discovery retains prior definitions without publishing a
change or proving child capabilities. Cache freshness hints do not force a host
to replace schemas already supplied to its model.

A stale call without a handle must fail before effects and explain the required
target and catalog refresh. It must not be translated using the last-opened
notebook, the stdio connection or a guessed chat identity. If the host retains
old definitions, reconnect the MCP connection within that chat to load the new
proxy and relist; recreating the chat or notebook is not part of the migration.
The first upgrade cannot replace code in an already-running old proxy process.
After worker replacement, reacquire the explicitly intended notebook, read a
fresh baseline and resubscribe. Inspect an unknown mutation outcome before any
retry. A configuration reload alone is not proof that the host replaced its
connection or catalog.

The bundled Stable and Nightly REPL instructions retain each task's handle and
pass it on reads, edits, execution, dependency management, saves, show and
release. Unknown mutation/execution outcomes require state inspection before a
caller retry. Release applies only to the owner the caller intends to stop.

This changes previously accepted application-tool calls. The MCP interface is
bundled with the app and is not maintained as a public interface to build on;
the release owner has chosen a patch app release for this routing fix. Include
a migration note to refresh tool definitions and retain the returned handles.
No version bump or publication is implied by this ADR.

## Verification boundary

Tests use ordinary initialize-based wire without an attachment-mode opt-in,
interleave two notebook targets with matching cell IDs, reject missing handles
before edits/runtime effects, and preserve independent same-notebook release.
Proxy tests distinguish old protocol with an attachment-capable worker from an
old worker that cannot safely route notebook calls. Existing expiry, readiness,
subscription, unknown-outcome and recovery gates remain acceptance criteria.

Local source/isolated Unix daemon evidence does not qualify a particular MCP
host, GUI, Windows, authenticated hosted service, installed artifact or real
kernel execution. Notebook rendering is a separate feature.

## Open Follow-ups

- Many distinct physical peers retain a presence-frame size limit. Sharing a
  healthy local backing avoids per-handle amplification; it does not increase
  the protocol cap. Negotiated presence framing remains a separate change.
- Hosted pooling needs a stable authenticated principal/source key and its own
  admission proof.
- HTTP transport and additional upstream protocol features have their own
  lifecycle and authorization requirements.
