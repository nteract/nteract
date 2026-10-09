# Explicit notebook attachments in MCP

**Status:** Accepted, 2026-10-08. Amended 2026-10-09 for notebook-ID targets. The registry and explicit targeting
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

## Decision 1: Every notebook operation names its target

Amended 2026-10-09: ordinary notebook calls accept exactly one of
`notebook_id` (with optional configured hosted `domain`) or an existing
`notebook_handle`, on every supported MCP protocol. Omitted domain always names
the worker's fixed local daemon, never a mutable default. `disconnect_notebook`
and the hidden compatibility wait remain exact-handle operations. Discovery and
connect/create do not need an existing attachment.

ID resolution currently uses already connected, authorized replicas only. A
cold, unknown, stale or unauthorized target returns explicit unavailability;
resolution does not open a peer, start a kernel, recover source or create an
empty notebook. Local candidates match the current daemon incarnation and
operator. Hosted candidates match the normalized configured domain and the
credentials/operator pinned to their actual authenticated connection. Conflicting
principal/scope evidence fails closed. Hosted scope stored here is requested
scope; the room host still decides effective permissions.

The first ID request retains a shared address owner over a compatible physical
replica. Subsequent requests reuse it under the same authority checks. This is
server retention, not per-chat ownership. Its release handle is returned under
`target.notebook_handle`; releasing it ends future retention, while already
admitted requests own their captured replica through completion. Existing
connect/create handles remain independently releasable. There is no TTL or
pressure eviction, and address owners count toward the same capacity limit.
A terminal disconnected physical connection ends its shared address retention
at the next valid tool admission, releasing that capacity. This does not expire
explicit/legacy handles, evict live peers, or discard a connected source-recovery
session. A credential change alone is not connection loss. Retained handles
remain discoverable through `resources/list` for deliberate release.

Connect/create still return a fresh logical attachment and its opaque handle.
Opening another notebook cannot alter a handle or an admitted request's target.
Repeated explicit acquisitions have independent lifetimes. Expired handles are
never translated into fresh ID lookups.

Missing, malformed, ambiguous, unknown or expired targets return actionable tool
errors before effects. The live worker catalog advertises the exact selector
contract. Proxy forwarding proves support from that child's live catalog;
cached or rewritten schemas are not evidence. Old handle-capable workers accept
handle requests only, and workers with implicit active selection are rejected.

Neither notebook IDs nor handles are authentication credentials. Daemon/hosted
admission, source recovery, readiness and causal execution gates remain in force.
Execution references a synced `cell_id`, never an independent code string.

Relevant source: `targets.rs`, `notebook_target.rs`, `attachments.rs`, `session.rs`,
`crates/mcp-transport/src/lib.rs`, and proxy `proxy.rs`.

## Decision 2: Logical ownership is separate from physical peers

The worker registry retains a handle until deliberate release or definitive
membership expiry. At most 128 logical attachments plus pending acquisitions
are retained; capacity refusal is explicit. Canceled/failed acquisitions return
their reservations. There is no TTL or arbitrary registry eviction.
Acquisition tool descriptions state this retention policy. Connecting again
creates another owner, so acquisition is not advertised as idempotent.

A compatible healthy local backing peer may serve multiple logical handles.
Its reuse key includes canonical target, fixed endpoint, live daemon incarnation
and operator. Reuse requires healthy source/replica evidence and current daemon
path metadata; it cannot bind a stale saved-path alias to an old room. Optional
room-list lookup failure skips reuse and attempts guarded fresh admission using
the requested target. Explicit hosted connects remain independent; ID retention can share an already
authorized hosted replica only under its pinned credential/principal binding.

Releasing A1 removes only A1's ownership and capacity. A2 can keep the same
backing peer alive and continue reads, sync, edits and subscriptions. The last
owner releases the physical backing. The active slot and bounded parked cache
used by internal recovery are not the ownership registry.

Notebook-ID resource URIs identify a notebook explicitly and remain compatibility
addressing. Ambiguous identities require an exact handle. They never provide an
implicit target for tool calls; explicit ID arguments use the address resolver.

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
public handle into a new peer. No operation missing an explicit target is completed by
selecting a recovered notebook. ID requests must reacquire an admitted replica;
worker recovery does not silently restore their old retention. Ambiguous mutations are never automatically
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
observation of that peer while retaining explicit/legacy logical ownership and
capacity. Shared address retention follows the terminal-connection cleanup rule
above. Read
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
arguments remain explicit: current ordinary calls accept ID/domain or an existing
handle. Previously unqualified calls still fail closed. Cached tool definitions and old skill
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

Adding, removing or renaming tools, or changing their schemas, refreshes the
catalog without forcing the proxy's stdio connection to exit. A call using a
removed name receives an unknown-tool protocol error. Fatal process failures
and crash-budget exhaustion retain their separate recovery policies.

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
