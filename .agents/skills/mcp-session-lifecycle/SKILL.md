---
name: mcp-session-lifecycle
description: >
  Understand the MCP server session lifecycle: attachment ownership, proxy
  supervision, daemon reconciliation, explicit notebook routing, readiness,
  scoped subscriptions, rejoin races, and room eviction. Use when working on
  runt-mcp, runt-mcp-proxy, daemon_watch.rs, or notebook attachment lifetimes.
---

# MCP Session Lifecycle

Use this skill when debugging notebook routing, attachment ownership,
reconnection, observation, or proxy behavior. Read the owning source and tests;
a protocol version or a successful connect is not proof of notebook readiness.

The current routing decision is
[explicit notebook attachments](../../../docs/adr/mcp-explicit-notebook-attachments.md).
The earlier [lifecycle record](../../../docs/adr/mcp-session-lifecycle.md)
preserves daemon and recovery decisions; its active-selection routing is
superseded by the attachment contract.

## Three Layers

- **Process supervision:** installed `nteract mcp`/`nteract-mcp` and development
  `mcp-supervisor` use the `runt-mcp-proxy` library to supervise a worker. The
  library is not a standalone MCP entrypoint.
- **Notebook attachments:** the `runt mcp` worker retains a registry of logical
  notebook owners, each addressed by an opaque `notebook_handle`. Its active
  slot, parked map and activation helpers also support internal recovery; they
  do not supply a missing notebook target for public tool requests.
- **Daemon rooms:** `runtimed` owns notebook content, source recovery, runtime
  documents, kernels, saves and peer accounting.

Separate children can share one daemon. One stdio process can also receive
interleaved requests from unrelated chats. Neither the connection, process,
request ID nor client label identifies a chat's notebook. Attribution is not
an authorization boundary for same-user local clients.

## Explicit Targets on Every Protocol

Ordinary notebook calls require exactly one of `notebook_id` (plus configured
`domain` for hosted notebooks) or `notebook_handle`. Omitted domain is the fixed
local daemon. Disconnect and the hidden compatibility wait require an exact
handle. Missing/ambiguous targets fail before effects on every MCP protocol.

ID resolution uses already connected authorized replicas; it never opens a peer
or launches a kernel. The first ID call retains a separate shared address owner,
counted under the 128-owner limit, with no TTL/eviction. Local selection checks
daemon incarnation/operator; hosted selection checks pinned actual credentials,
operator and authenticated principal. Conflicting principal evidence fails closed.
Release of an explicit handle does not release the address owner. The ID result's
`target.notebook_handle` releases that shared retention, not a chat-private lease.

Each ID request captures its exact replica through completion, preserving known
cell/execution outcomes after retention release. Exact-handle calls retain their
membership fences. A `cell_id` is always resolved inside the supplied notebook.
Cold IDs require an explicit connect; expired handles never rebind as ID requests.

`targets::dispatch`, `notebook_target::acquire`, `session_access` and
`NotebookSession::access` separate selection from operation readiness. Preserve
source/runtime authority and causal execution gates. The proxy checks the exact
live child's target contract before forwarding; cache/schema rewriting cannot
prove support. Handle-only workers reject ID requests before dispatch.

Catalog migration and attachment recovery are separate. Prefer standard
`tools/list_changed` notification and native catalog subscription relisting
inside the existing chat. A server can invalidate its own cache and notify a
host; it cannot replace schemas already in the host's model context. If a host
keeps old definitions, reconnect its MCP connection and relist rather than
guess a target or restore implicit selection. An already-running old proxy may
need that reconnect to load new code. After child replacement, acquire the
intended notebook again, read a baseline and resubscribe; inspect ambiguous
mutations before retry. Configuration reload alone does not prove a catalog
refresh. Catalog publication requires successful discovery from the current
connected child; fallback or rewritten schemas never prove child capability.

Tool additions, removals, renames and schema changes publish catalog invalidation
without forcing a stdio exit. Relist to discover the current names; removed names
receive unknown-tool protocol errors. Fatal failures and crash-budget exhaustion
retain their own recovery policies.

Relevant source: `crates/runt-mcp/src/targets.rs`, `attachments.rs`, `lib.rs`,
`session.rs`, and `crates/mcp-transport/src/lib.rs`.

## Ownership and Retention

The registry retains at most 128 logical attachments plus pending acquisitions.
Reservations count toward that limit and return on cancellation or failure.
There is no TTL or arbitrary ownership eviction. Release removes only the named
handle, signals its expiry immediately, and returns its capacity slot.
Acquisition descriptions state retention; repeated connect creates a new owner
and must not advertise idempotence.

Logical ownership is separate from a physical peer. Compatible healthy local
acquisitions may share backing by canonical target, fixed endpoint, live daemon
incarnation and operator. Sharing never reuses an unhealthy or unready replica
or a stale saved-path alias. A failed optional room listing skips reuse and
attempts guarded fresh admission. Hosted peers are not pooled without a stable
authenticated principal/source key. Dropping the last owner releases the backing.

An address owner also retains the MCP peer after explicit handles are released.
This can postpone the local daemon's last-client idle teardown. Release that
shared retention with `disconnect_notebook(notebook_handle=target.notebook_handle)`
from the ID result, or find its handle through `resources/list`. Switching
request targets does not release another notebook's owners or runtime peer.

The bounded parked cache is not the ownership registry. Dropping a cache entry
must not release an independently retained attachment. Legacy notebook-ID
resource URIs still identify a notebook explicitly; ambiguous identities require
an exact handle. They never justify an implicit tool target.

## Readiness and Execution Gates

| Requirement | Gate |
|-------------|------|
| `ProjectionRead` | Retained projection or interactive document |
| `DocumentRead`, `DocumentMutation` | Interactive document with source/readiness evidence |
| `KernelControl` | Interactive document; kernel need not already run |
| `RuntimeRead` | Connected, ready local RuntimeStateDoc |
| `Execute` | Interactive document and ready runtime, plus causal `required_heads` |

Retained projection reads do not authorize mutation or execution. Local connect
may return before interactivity with a heads-qualified control-plane projection.
Create and internal rejoin await their readiness paths. Hosted readiness uses
its connected-replica contract. Execute synced notebook cells by `cell_id`; never
send a separate code string that can diverge from the document.

## Scoped Observations

Handle-qualified resources use `nteract://sessions/{notebook_handle}/cells`,
`/cells/{cell_id}`, and `/comments`. Observers capture identity before waiting
and subscribe before baseline capture. Cursors belong to an exact observation
journal; stale/foreign cursors require a fresh baseline.

Legacy `resources/subscribe` and native `subscriptions/listen` watch their
captured attachment. The proxy reference-counts child URI leases: canceling or
releasing one listener cannot unsubscribe another. Cached acquisition rechecks
child admission before acknowledging a new listener. Native notifications
preserve the upstream subscription ID. Child replacement ends old streams;
clients obtain new handles and baselines rather than rebinding old ones.

Membership expiry and terminal observation loss are distinct:

- Release/incarnation expiry produces `attachment_expired` and the metadata key
  `io.nteract/attachmentExpired`.
- A terminal disconnected backing produces `attachment_unavailable` and
  `io.nteract/attachmentUnavailable`. Its watch ends, but registry ownership and
  capacity remain until deliberate release or membership expiry. Read/admission
  errors preserve their original code/message/readiness and add typed data.

Already-signaled expiry wins. Pending readiness, missing cells and untyped
transient failures do not end a live URI lease. A mixed listener survives until
its last URI ends. Observation receivers do not independently keep notebook
peers or kernels alive.

Resources/subscriptions remain the ongoing observation API. `inspect_notebook`
returns bounded cells/source/readiness and a matching cursor; `after` plus
`timeout_secs` waits for notebook-wide changes. `get_results` waits for an exact
execution without submitting another run, preserves executed source after edits,
and checks durable result context against the target notebook. Both default to
zero and cap at 50 seconds, sharing eight wait permits with the hidden legacy
`wait_for_notebook_change` (whose 25-second default and handle contract remain).
Cancellation ends observation, not computation. Retained projections have no
live cursor; pagination reads live state and callers must compare cursors.

Relevant source: `resources.rs`, `subscriptions.rs`, `tools/observation.rs`,
proxy `native_subscriptions.rs`, `observation_bridge.rs`, and `child.rs`.

## Recovery and Daemon Incarnation

Local handles carry daemon identity `pid + started_at`. The watcher queries
live identity directly; cached heartbeat events only wake reconciliation.
Failed identity lookup alone does not prove loss. Confirmed absence or a
replacement incarnation expires affected local registry handles; hosted
attachments survive local-daemon reconciliation. Healthy same-incarnation
heartbeats do not expire ownership.

Preserve original source recovery. Prefer a canonical saved path; UUID admission
remains daemon-authoritative and may recover from resident rooms, persisted
untitled content or UUID/path bindings. A missing source is not permission to
invent an empty notebook or load a stale mirror. Do not use `list_rooms` as an
existence precheck. `NotebookUnavailable` is definitive; transient failures
retain internal recovery context.

Internal rejoin captures the intent epoch and daemon incarnation, connects
outside locks, rechecks incarnation, then publishes under the slot write lock
only if intent and slot ownership still permit it. Explicit disconnect must not
be undone by late background work. These helpers preserve internal recovery;
they never make an old public handle name a new peer.

Proxy restart re-resolves the child executable. Exit 75 is an intentional
upgrade handoff, separate from crash budget. `reconnect` replaces the worker,
not the daemon. A recovery banner is not proof of notebook readiness. All old
worker handles expire. No ambiguous mutation is automatically replayed;
`outcome_unknown` requires state inspection before any caller retry.

Relevant source: `daemon_watch.rs`, `session_activation.rs`, proxy `proxy.rs`,
`session.rs`, `version.rs`, and `circuit_breaker.rs`.

## Daemon Room Lifetime and Protocol Limits

The local daemon schedules idle kernel teardown when the last counted client
peer leaves. The runtime agent that owns a Python kernel is a separate sync
peer, outside that ordinary client-peer count. After keepalive, the daemon
rechecks connections, generation and persistence before requesting shutdown
through the runtime peer. Releasing an MCP handle does not unconditionally stop
the kernel: other owners, admitted requests or client peers may retain a
connection, and hosted lifetime follows the room host's policy. Room reaping is
a separate decision; kernel teardown does not prove source unavailability.
See `runtimed/src/notebook_sync_server/peer_connection.rs`, `peer_runtime_agent.rs`,
`peer_eviction.rs`, and `runtimed/src/daemon.rs`.

The transport supports initialize-based MCP revisions through `2025-11-25` and
native per-request `2026-07-28` metadata. The private worker handshake uses
`2025-11-25`; it still requires explicit notebook arguments. Invalid native
metadata must not start recovery/setup or dispatch an application operation.
Request cancellation and transport teardown have separate owned scopes.

Source and isolated Unix wire tests do not qualify Codex rendering, Windows,
live hosted authentication, installed package delivery or real kernel execution.
Many distinct physical peers also retain a separate presence-frame protocol
limit; logical peer sharing is not a protocol-cap increase.
