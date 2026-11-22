# Explicit notebook attachments in MCP

**Status:** Accepted, 2026-10-08 (amended 2026-10-09 for notebook-ID targets).

Every ordinary MCP notebook call targets a notebook explicitly by `notebook_id` (with optional hosted `domain`) or opaque `notebook_handle`. This applies across initialize-based and native protocols. Logical ownership lives in the worker registry separately from shared backing peers, and handles expire without rebinding on release, daemon restart, or worker replacement. Qualification boundaries are under [Verification boundary](#verification-boundary).

This decision supersedes active-notebook routing, connect supersession, and parked-cache ownership in [MCP Session Lifecycle and Daemon Supervision](mcp-session-lifecycle.md). That record's daemon authority, source recovery, and readiness decisions remain in force.

## Context

An MCP stdio process can serve requests from unrelated chats. A mutable process-wide current notebook cannot represent their separate intent. If chat A connects to notebook A and chat B connects to notebook B, a later unqualified cell creation from A routes to B. Checking a cell ID against the selected document cannot prove which notebook A intended.

A single daemon coordinates shared content and runtime ownership. It cannot repair an MCP request that already selected the wrong notebook. Protocol negotiation, notebook identity, logical attachment ownership, backing peers, and runtime readiness have separate responsibilities.

The [MCP statelessness requirement](https://modelcontextprotocol.io/specification/2026-07-28/basic#statelessness) requires explicit references for state spanning requests. Initialize-based clients can pass application identifiers in tool arguments without adopting a new MCP protocol revision.

## Decision 1: Every notebook operation names its target

### Target arguments
- Ordinary notebook calls accept **exactly one** of `notebook_id` (with optional configured hosted `domain`) or an existing `notebook_handle`, on every supported MCP protocol.
- Omitting `domain` always names the worker's fixed local daemon, never a mutable default.
- `disconnect_notebook` and the hidden compatibility wait remain exact-handle operations.
- Discovery and connect/create operations do not require an existing attachment.

### ID resolution
- Resolves against already connected, authorized replicas only.
- Cold, unknown, stale, or unauthorized targets return explicit unavailability. Resolution never opens a peer, starts a kernel, recovers source, or creates an empty notebook.
- Local candidates match the current daemon incarnation and operator.
- Hosted candidates match the normalized configured domain and the credentials/operator pinned to their authenticated connection.
- Conflicting principal or scope evidence fails closed.
- Hosted scope stored here is requested scope; the room host decides effective permissions.

### Shared address retention
- The first ID request retains a **shared address owner** over a compatible physical replica. Subsequent ID requests reuse it under the same authority checks.
- This is server retention, not per-chat ownership.
- Its release handle returns under `target.notebook_handle`. Releasing it ends future retention while already-admitted requests keep their captured replica through completion.
- Explicit connect/create handles remain independently releasable.
- No TTL or pressure eviction applies; address owners count toward the same capacity limit as explicit handles.
- A terminal disconnected physical connection ends its shared address retention at the next valid tool admission, freeing that capacity.
- That cleanup does **not** expire explicit/legacy handles, evict live peers, or discard a connected source-recovery session.
- A credential change alone is not connection loss.
- Retained handles remain discoverable through `resources/list` for deliberate release.

### Explicit acquisition, validation, and security
- Connect and create return a fresh logical attachment and opaque handle. Opening another notebook cannot alter a handle or an admitted request's target.
- Repeated explicit acquisitions have independent lifetimes. Expired handles are never translated into fresh ID lookups.
- Missing, malformed, ambiguous, unknown, or expired targets return actionable tool errors before effects.
- The live worker catalog advertises the exact selector contract. Proxy forwarding proves support from that child's live catalog; cached or rewritten schemas are not evidence.
- Old handle-capable workers accept handle requests only. Workers with implicit active selection are rejected.
- Neither notebook IDs nor handles are authentication credentials. Daemon/hosted admission, source recovery, readiness, and causal execution gates remain in force.
- Execution references a synced `cell_id`, never an independent code string.

### Durable execution result reads
- Durable execution results carry a daemon-written `notebook_id` separately from the path context used for validated file reload.
- Tool and blob-resource reads require this `notebook_id`, or an exact UUID context in an older record; a matching path alone never grants access.
- The daemon may qualify a recovered execution for its current room after validating and restoring its cell, source, and output state, preserving the execution ID.
- Older path-only records remain unavailable to scoped durable reads until the daemon qualifies them; live runtime results remain readable through their admitted notebook.

Relevant source: `targets.rs`, `notebook_target.rs`, `attachments.rs`, `session.rs`, `crates/mcp-transport/src/lib.rs`, and proxy `proxy.rs`.

## Decision 2: Logical ownership is separate from physical peers

### Registry retention and capacity
- The worker registry retains a handle until deliberate release or definitive membership expiry.
- Capacity is capped at **128** logical attachments plus pending acquisitions; capacity refusal is explicit.
- Canceled or failed acquisitions return their reservations.
- No TTL or arbitrary registry eviction applies. Acquisition tool descriptions state this retention policy.
- Connecting again creates another owner, so acquisition is not advertised as idempotent.

### Physical backing reuse
- One healthy local backing peer may serve multiple logical handles.
- Its reuse key combines canonical target, fixed endpoint, live daemon incarnation, and operator.
- Reuse requires healthy source/replica evidence and current daemon path metadata; it never binds a stale saved-path alias to an old room.
- If the optional room-list lookup fails, the worker skips reuse and attempts guarded fresh admission using the requested target.
- Explicit hosted connects remain independent. ID retention shares an already-authorized hosted replica only under its pinned credential/principal binding.

### Release and kernel lifetime
- Releasing handle A1 removes only A1's ownership and capacity. Handle A2 keeps the backing peer alive for reads, sync, edits, and subscriptions.
- The last owner releases the physical backing. Internal recovery's active slot and bounded parked cache are not the ownership registry.
- An address owner also retains that backing. Releasing every explicit handle can leave the MCP peer connected through an address owner, postponing local daemon last-client idle teardown. Call `disconnect_notebook` with `target.notebook_handle` (also listed by `resources/list`) to release shared retention.
- Switching targets never releases other owners or disconnects their runtime peers.
- Kernel lifetime stays daemon-owned. The runtime agent owning a Python kernel is a separate sync peer outside the ordinary client-peer count.
- When the last counted client leaves, the local daemon waits its keepalive delay and rechecks connections, generation, and persistence before requesting kernel shutdown through the runtime peer.
- Other client peers, retained owners, and already-admitted requests can still hold a connection, so releasing an address owner releases MCP retention without unconditionally stopping a kernel. Hosted kernel lifetime follows the room host's policy.
- Notebook-ID resource URIs identify a notebook explicitly for compatibility addressing; ambiguous identities require an exact handle. They never supply an implicit target for tool calls; explicit ID arguments use the address resolver.

Relevant source: `crates/runt-mcp/src/attachments.rs`, `tools/session.rs`, and `resources.rs`; daemon `notebook_sync_server/peer_connection.rs`, `peer_runtime_agent.rs`, and `peer_eviction.rs`.

## Decision 3: Handles expire without rebinding

- Release signals expiry immediately, even while an admitted operation holds a cloned payload.
- Successful handle-scoped tool or resource completion revalidates membership.
- A side effect may already have occurred; expiry never claims rollback, and original failures or unknown outcomes stay intact.
- Local daemon identity is `pid + started_at`. Confirmed absence or a replacement incarnation expires affected local registry entries; an inconclusive identity query alone does not.
- Hosted entries are isolated from local-daemon expiry.
- Worker replacement expires all of that worker's old handles. Clients reconnect to the original target, obtain new handles, and establish fresh baselines.
- Internal source recovery keeps its incarnation, intent-epoch, and publication gates. It restores notebook availability without turning an old public handle into a new peer.
- No operation missing an explicit target completes by selecting a recovered notebook.
- ID requests must reacquire an admitted replica; worker recovery never silently restores prior retention.
- Ambiguous mutations are never automatically replayed after lost replies.

Relevant source: `daemon_watch.rs`, `session_activation.rs`, proxy `proxy.rs`, and `circuit_breaker.rs`.

## Decision 4: Observation loss is distinct from ownership expiry

### Lease ownership
- Resource reads and subscriptions capture their attachment identity.
- Native listen requests own their URI leases, and the proxy reference-counts underlying child watches so a canceled listener cannot unsubscribe another.
- Cached listener admission rechecks the child. Native notifications carry the upstream subscription ID.

### Expiry vs. backing loss
- Release or membership expiry uses `attachment_expired` and `io.nteract/attachmentExpired`.
- Terminal backing loss uses `attachment_unavailable` and `io.nteract/attachmentUnavailable`.
- Terminal backing loss ends observation of that peer while retaining explicit/legacy logical ownership and capacity.
- Shared address retention follows the terminal-connection cleanup rule in Decision 1.
- Read and admission errors preserve original code, message, and readiness while adding typed code and handle data.
- Already-signaled expiry always wins.

### Isolation guarantees
- Only the affected URI retires; a mixed A/B listener continues B until B's last URI ends.
- Missing cells, pending readiness, and untyped transient failures do not end a healthy lease.
- An old observer cannot revive when a fresh attachment joins the same notebook.
- Observation receivers do not independently keep peers or kernels alive.

Relevant source: `subscriptions.rs`, `resources.rs`, proxy `native_subscriptions.rs`, `observation_bridge.rs`, and `child.rs`.

## Compatibility and migration

### Protocol and schema refresh
- Supported initialize-based protocol revisions stay supported, with explicit arguments (`notebook_id`/optional `domain` or an existing `notebook_handle`). Unqualified calls fail closed.
- Cached tool definitions and old skill examples must refresh alongside the worker; app bundling alone does not refresh a running host's model context.
- Prefer in-place catalog refresh within the existing chat:
  - The proxy publishes the active child's catalog, advertises `listChanged`, and sends standard catalog notifications asking supporting hosts to relist.
  - Native clients receive these notifications over an accepted catalog subscription.
  - Publication requires successful, nonempty discovery from the current connected child.
  - Failed, empty, stale, or disconnected discovery keeps prior definitions without publishing a change or proving child capabilities.
  - Cache freshness hints do not force a host to replace schemas already supplied to its model.
- Adding, removing, or renaming tools, or changing schemas, refreshes the catalog without dropping the proxy's stdio connection. Calling a removed tool returns an unknown-tool protocol error.
- Fatal process failures and crash-budget exhaustion keep their separate recovery policies.

### Stale callers and upgrade recovery
- A stale call missing a target fails before effects and explains both the required target and catalog refresh. It never translates using the last-opened notebook, the stdio connection, or a guessed chat identity.
- If a host retains old definitions, reconnect the MCP connection within that chat to load the new proxy and relist; recreating the chat or notebook is unnecessary.
- The first upgrade cannot replace code inside an already-running old proxy process.
- After worker replacement, reacquire the intended notebook, read a fresh baseline, and resubscribe.
- Inspect any unknown mutation outcome before retrying.
- A configuration reload alone does not prove the host replaced its connection or catalog.

### Bundled agent guidance and interface boundary
- The bundled agent instructions for the Stable and Nightly notebook MCP servers retain each task's handle and pass it on reads, edits, execution, dependency management, saves, show, and release.
- Unknown mutation or execution outcomes require state inspection before caller retry; release applies only to the owner the caller intends to stop.
- This change breaks previously accepted unqualified tool calls. Because the MCP interface ships bundled with the app rather than as a standalone public API, migration notes must instruct callers to refresh tool definitions and retain returned handles.

## Verification boundary

- Tests run over ordinary initialize-based wire without an attachment-mode opt-in. They interleave two notebook targets with matching cell IDs, reject missing handles before edits or runtime effects, and verify independent same-notebook release.
- Proxy tests distinguish an old protocol backed by an attachment-capable worker from an old worker that cannot safely route notebook calls.
- Existing expiry, readiness, subscription, unknown-outcome, and recovery gates remain acceptance criteria.
- Local source and isolated Unix daemon evidence does not qualify a specific MCP host, GUI, Windows, authenticated hosted service, installed artifact, or real kernel execution. Notebook rendering is a separate feature.

## Open Follow-ups

- Many distinct physical peers retain a presence-frame size limit. Sharing a healthy local backing avoids per-handle amplification without raising the protocol cap; negotiated presence framing remains a separate change.
- Hosted pooling needs a stable authenticated principal/source key and its own admission proof.
- HTTP transport and additional upstream protocol features carry their own lifecycle and authorization requirements.
