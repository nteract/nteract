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

Every notebook-scoped `tools/call` requires a nonempty `notebook_handle`,
including initialize-based clients. This is an application argument, separate
from MCP protocol negotiation. Missing targets fail before notebook or runtime
side effects. Discovery and connect/create do not require an existing handle.

Connect/create return a fresh logical attachment and its exact handle. Retain
that handle for subsequent operations. Repeated same-notebook acquisitions have
independent ownership and release. Opening B never changes what an A-qualified
request means. A `cell_id` is resolved inside the explicitly selected notebook.

`targets::dispatch` scopes the handle to the request. Access goes through
`NteractMcp::session_access` and `NotebookSession::access`, cloning owned state
before awaits. Successful handle-scoped completions revalidate membership;
expired completion does not claim rollback of already-admitted side effects.
Original failures, including unknown outcomes, remain intact.

Tool schemas advertise the required handle, including the startup cache. A
proxy must not silently discard it when forwarding to an older worker that
cannot route attachments. Read the proxy's admission checks and version-skew
fixtures before changing compatibility behavior.

Catalog migration and attachment recovery are separate. Prefer standard
`tools/list_changed` notification and native catalog subscription relisting
inside the existing chat. A server can invalidate its own cache and notify a
host; it cannot replace schemas already in the host's model context. If a host
keeps old definitions, reconnect its MCP connection and relist rather than
guess a target or restore implicit selection. An already-running old proxy may
need that reconnect to load new code. After child replacement, acquire the
intended notebook again, read a baseline and resubscribe; inspect ambiguous
mutations before retry. Configuration reload alone does not prove a catalog
refresh.

Relevant source: `crates/runt-mcp/src/targets.rs`, `attachments.rs`, `lib.rs`,
`session.rs`, and `crates/mcp-transport/src/lib.rs`.

## Ownership and Retention

The registry retains at most 128 logical attachments plus pending acquisitions.
Reservations count toward that limit and return on cancellation or failure.
There is no TTL or arbitrary ownership eviction. Release removes only the named
handle, signals its expiry immediately, and returns its capacity slot.

Logical ownership is separate from a physical peer. Compatible healthy local
acquisitions may share backing by canonical target, fixed endpoint, live daemon
incarnation and operator. Sharing never reuses an unhealthy or unready replica
or a stale saved-path alias. A failed optional room listing skips reuse and
attempts guarded fresh admission. Hosted peers are not pooled without a stable
authenticated principal/source key. Dropping the last owner releases the backing.

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

`wait_for_notebook_change` is the bounded fallback: explicit handle, optional
cursor/execution ID, 25-second default and 50-second maximum, with eight waits
per connection. Canceling observation does not interrupt the kernel.

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

Only the last physical peer leaving schedules kernel teardown after keepalive.
Teardown and room reaping separately revalidate ownership/generation and
persistence. Kernel teardown is not proof that notebook source is unavailable.
See `runtimed/src/notebook_sync_server/peer_eviction.rs` and `runtimed/src/daemon.rs`.

The transport supports initialize-based MCP revisions through `2025-11-25` and
native per-request `2026-07-28` metadata. The private worker handshake uses
`2025-11-25`; it still requires explicit notebook arguments. Invalid native
metadata must not start recovery/setup or dispatch an application operation.
Request cancellation and transport teardown have separate owned scopes.

Source and isolated Unix wire tests do not qualify Codex rendering, Windows,
live hosted authentication, installed package delivery or real kernel execution.
Many distinct physical peers also retain a separate presence-frame protocol
limit; logical peer sharing is not a protocol-cap increase.
