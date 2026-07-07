# BYOC Control Plane: Registry and Liveness

**Status:** Draft memo, 2026-07-07. Options and a recommendation for the
bring-your-own-compute (BYOC) control plane now that hosted runs on the
Cloudflare Workers paid plan instead of the free tier. Decision not yet made.
Companion to [compute-session-index.md](compute-session-index.md),
[aws-rust-room-host.md](aws-rust-room-host.md), and ADR
[deployment-topology.md](../adr/deployment-topology.md).

## Context

The workstation control plane was shaped for the Cloudflare free tier: poll on a
60s cadence, write to durable storage only on lifecycle edges, never on
heartbeats, and lean on lazy read-time staleness checks instead of scheduled
sweeps. That was the right call under free-tier request and storage ceilings. It
is no longer the constraint. Hosted is on the paid monthly plan with an overage
allowance, and the free-tier-shaped decisions are now the thing making
workstations feel unreliable.

The open question, in the operator's words: the biggest pain point is registering
nodes and handling them quickly. Redis is the instinct - a fast registry where
nodes register and expire on their own. This memo takes that instinct seriously
and lands somewhere else, because the Redis-shaped capabilities either already
exist in this codebase or do not survive contact with the Workers runtime.

## What "online" means today: three surfaces, three consistency models

Every liveness fact currently lives in one of three places, and no two agree on
the same definition of "connected":

- **D1 `workstations.last_seen_at` / `status`** (`apps/notebook-cloud/src/storage.ts`).
  Durable, cheap, lazy. `registerWorkstation` is a single UPSERT that always sets
  `status='online'` and `last_seen_at=now`; re-registration *is* the heartbeat,
  there is no separate verb. The `status` column is only ever written `'online'`
  and is never actively flipped to `'offline'`. Offline is derived at read time:
  `now - last_seen_at > WORKSTATION_HEARTBEAT_STALE_MS` (3 min).

- **`WorkstationEvents` DO in-memory socket count**
  (`apps/notebook-cloud/src/workstation-events.ts`). The only true "is this
  workstation connected right now" signal, read from `state.getWebSockets(tag).length`.
  It resets on DO hibernation or redeploy, and it is consulted only lazily, per
  workstation, after D1's timestamp already looks stale.

- **`RuntimeStateDoc.WorkstationAttachmentState`** (Automerge, durable via R2 +
  D1 revision metadata). The actual fencing authority for which runtime_peer a
  room accepts, cached per-DO-instance in `NotebookRoom.selectedRuntimePeerSessions`.

Nothing sweeps any of these on a schedule below the `NotebookRoom` DO, and even
that alarm only watches room-level runtime_peer membership, not workstation
presence, not the compute-session index, not the desktop bridge.

## This week's evidence

The reliability complaints all reduce to the same shape: reactive, event-driven
detection with no proactive liveness layer.

1. **No proactive dead-peer detection.** `WorkstationEvents` has no `alarm()`. It
   reacts only to Cloudflare's `webSocketClose`/`webSocketError` callbacks. In the
   tail capture a `ws-lab1` 1006 close surfaced 4.5 minutes late, because there is
   no independent wake to notice a dead transport. Issue #3942 normalized this as
   benign detection latency. It should not be the accepted status quo.

2. **Rail/toolbar attribution divergence** (#3942). Start-on-lab1 attached the
   owner's default box because the attach route substituted the default whenever
   `workstation_id` was absent. Write-side fixed in #3944 (id now required, 400/404/409
   instead of substituting). The read-side seam is still open: the rail reads
   `cloud-workstations-store.ts`, the toolbar reads RuntimeStateDoc, two derivations
   of overlapping facts.

3. **Polling with no backoff for a permanently-dead registration.** A defunct
   `ws-jupyter-rgbkrk...` registration was probed across 67 status polls, connected
   never once true. There is no cached "known dead" marker and no cap on repeat
   cross-DO round-trips for a registration that will provably never connect.

4. **No deregistration path.** Repo-wide there is no
   `deregister|removeWorkstation|pruneWorkstation|markGone`. The
   `compute-session-index.md` Option A design proposed `markGone` and
   `cleanupExpired` on the index DO; neither shipped. Index correctness depends
   entirely on the room remembering to call delete on a lifecycle edge.

5. **Dead systemd unit, stuck-starting on reattach** (#3938, fixed). The quoted
   `WorkingDirectory` bug left every Linux service unit in bad-setting, so
   workstations survived only as long as a manual `runt workstation run` shell.
   The lazy attach-job expiry underneath remains: a `pending` job whose peer never
   comes online sits indefinitely from the client's view, because
   `expireStaleWorkstationAttachJobs` only runs at the top of the *next*
   `createWorkstationAttachJob`, never on the poll path.

6. **Room-link visibility** (#3943, landed). Cloud runtime peers now heartbeat
   room-link health into `RuntimeStateDoc.kernel.last_seen` every 15s, projected as
   structured `roomLink` state in the workstation panel. The desktop app's own
   connection dot is still blind to bridge health (issue #3599 remainder).

7. **Silent kernel-launch failure** (observed live today, new). This is the one
   that stuck the `yep` notebook this morning: everything queued, nothing running,
   no logs in the browser. Root cause was not the control plane at all. The
   workstation's "Current Python" (`uv:current_python`) resolves to system
   `/usr/bin/python3`, which had no `ipykernel`. Launch-on-attach `LaunchKernel`
   failed, the runtime peer stayed connected, and the UI reported "Kernel running"
   with cells stuck at "queued" and no surfaced error. A failed launch renders as a
   healthy running kernel. This is a runtime-state health-propagation gap adjacent
   to the liveness theme: same class of bug as items 1 and 6, one layer up. Tracked
   separately as a fixable product bug; see the issue linked at the end.

## The Redis question, answered

The instinct is to reach for Redis: register nodes, let keys expire, get a fast
sorted-set query for "who is stale." Three things make it the wrong tool at this
scale, and they map directly to the ingress/egress worry.

**Cost is inverted here, not in Redis's favor.** At 200 workstations heartbeating
every ~20s that is ~26M writes/month. That sits under DO-SQLite's and D1's 50M
included row-writes/month, so it is effectively $0 marginal on infrastructure
already paid for. The same 26M operations on Upstash pay-as-you-go is ~$52/month
for heartbeats alone, before registry reads, before attach-job traffic, before the
$0.03/GB bandwidth line item Cloudflare does not charge (zero egress on DO, D1,
R2). Redis is a new recurring bill for a job the paid plan already covers inside
its allowance.

**Redis's two headline features do not work cleanly from Workers.** Pub/sub needs
a persistent `SUBSCRIBE` connection a stateless Worker invocation cannot hold;
Upstash's own guidance is to use QStash (HTTP webhooks) for serverless push, so
Redis pub/sub does not replace the `WorkstationEvents` push channel, it just
leaves it unbuilt. TTL auto-expiry is passive: no callback fires on key expiry
without keyspace notifications, which themselves need a persistent subscriber. So
an active sweep still has to be built either way, and this codebase already has
one: the single-earliest-alarm arm/disarm in `notebook-room.ts:2258-2314` that
fires `RUNTIME_PEER_GONE_GRACE_MS` after a peer drops.

**This is the ingress/egress concern, concretely.** `cloudflare:sockets`
`connect()` is GA for outbound public TCP, so raw-wire Redis is technically
reachable. But opening a socket from *inside a DO* keeps that DO resident and
duration-billed for up to 15 minutes per connection, turning a cheap serverless
call into a billed process. From a stateless Worker there is no pooling: a fresh
TCP handshake per invocation, worse latency than a keep-alive REST connection for
no gain over what DO storage gives for free. So the separate ingress/egress path
Redis implies is not just a second network hop, it is a billing and pooling
penalty the current architecture avoids by keeping state in the same thread as
compute.

## Options

**A. All-Cloudflare, paid-tier primitives, minimal change.** Keep the three
surfaces, add an alarm to `WorkstationEvents`. Cheapest to write. Leaves the
D1-vs-socket split-brain in place: two surfaces keep disagreeing about "online,"
neither swept authoritatively. Rejected as the endpoint, not because it is wrong
but because it is incomplete.

**B. External Redis (Upstash or self-managed).** Rejected above: cost inverts at
this scale, the headline features do not survive the Workers runtime, and it adds
a second vendor, secret, incident surface, and pricing page for a single operator
to carry.

**C. Consolidate to two purposeful Durable Objects.** Recommended. Fold the D1
`last_seen_at` staleness logic and the `OwnerComputeIndex` KV cache into one
SQLite-backed fleet-registry DO, sharded by owner (reuse the existing
`ownerComputeIndexObjectName` convention, which bounds each object's write rate to
one owner's machines). Store `last_seen_at` and `lease_expires_at` per workstation
with an indexed column, and run the single-earliest-alarm pattern already shipped
in `notebook-room.ts`. Leave `WorkstationEvents` as-is: it is a distinct concern
(live push to attached listeners), it already works, and it costs nothing while
hibernating. The registry DO's alarm calls the `WorkstationEvents` stub's existing
`/notify` on lease expiry, so listeners get a real "went offline" push instead of
inferring it from socket presence.

## Recommendation

Option C. For tens-to-hundreds of nodes, single-operator ops load, and a
latency-sensitive execute path, Redis is a net cost and complexity add with no
capability this codebase does not already have proven in-repo. The registry
problem is not "we lack a fast key-value store," it is "liveness is smeared across
three surfaces with no scheduled sweep." Consolidating the surfaces and applying
the alarm pattern that already works for rooms fixes the actual problem without a
platform bet.

This is what makes "register nodes and handle them quickly" true: a lease with an
`alarm()`-bounded expiry gives detection an upper latency bound instead of waiting
on Cloudflare's socket-close callback (the 4.5-minute-late 1006), and a real
`went_offline` push replaces read-time staleness inference.

Constraints that must survive the rewrite, from the deployment-topology ADR: the
room locator is not authority, ACL is not runtime attachment, execution intent
originates only from an authorized room request and reaches the peer via CRDT
convergence, never direct RPC. Any redesign that shortcuts `execute_cell` straight
to the peer socket reintroduces exactly the coupling this architecture avoids.

## Concrete next step

Sized as a same-codebase refactor, not a platform migration:

1. Add `lease_expires_at` and an `alarm()` to `OwnerComputeIndex` (or a renamed
   `FleetRegistry` DO). Copy the earliest-wins alarm arm/disarm from
   `notebook-room.ts:2258-2314`.
2. Migrate the D1 `workstations.last_seen_at` staleness logic into it. Registration
   writes a lease; the alarm sweeps expired leases and transitions them to a
   visible `offline` with a reason string.
3. On expiry, fire `/notify` into the corresponding `WorkstationEvents` stub
   (reuse the existing `fetch()`-to-stub pattern) so listeners get a push.
4. Ship the `markGone` / `cleanupExpired` surface the compute-session-index memo
   already designed, so index staleness self-heals instead of depending on the room
   remembering to call delete.

Then close the read-side seams the liveness work exposes: collapse rail, toolbar,
and the desktop connection dot onto one durable compute-session/bridge-health fact
(the #3944 write-side fix plus the #3599 desktop-bridge remainder).

## When to revisit Redis

If a single owner's workstation count moves from hundreds toward low thousands and
the fleet-registry DO's single-threaded write rate becomes measurable (shardable
further by owner-cohort before that bites), or if a non-Workers component needs
direct registry access without going through a Cloudflare API. Neither holds
today. That second condition is also the trigger for the broader
[aws-rust-room-host.md](aws-rust-room-host.md) direction; if hosted ever moves the
room engine off Workers, the registry follows it, and Redis or Postgres becomes
the natural store at that point. This memo is the Workers-native answer for as long
as Workers is the platform.
