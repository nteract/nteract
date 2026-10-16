# Proposal: cloud compute admission

**Status:** Draft for discussion, October 16, 2026. This proposes a contract;
endpoint names, token formats, and provider APIs are not adopted. Source claims
below refer to nteract revision
`655b66d89a841953925d58ca38b4daa75c29ec17`, not verified deployment state.

## Experience and ownership

Open a notebook, choose an authorized compute target, and run a cell. Show
allocation and Python readiness separately. Managed compute should need no pairing
code, copied token, SSH command, or separate Attach action. A user-supplied native
workstation can be enrolled once and then selected the same way.

The runtime remains an outbound `runtime_peer` using nteract's shared execution
and output protocols. Execution references the synced `cell_id`; admission does
not introduce a second code-string RPC. The provider owns compute lifecycle; the
notebook room admits notebook work.

Keep three authorities distinct:

1. **Notebook access:** a verified principal may read, edit, or execute according
   to the notebook's permissions.
2. **Compute allocation:** the provider allows that principal to use a target,
   resource budget, and environment. Notebook sharing alone does not grant this.
3. **Runtime attachment:** the room admits the selected runtime session, permitting
   execution and publication only for its current generation.

An enrolled device, online machine, allocated container, attached runtime, and
ready kernel are different facts. The UI can present them simply without making
presence a credential or notebook access a license to allocate resources.

| Compute ownership | Enrollment and launch | End of notebook session |
| --- | --- | --- |
| Platform-managed | Provider workload identity; allocate or resume through the existing controller, then obtain a narrow attachment grant | Reconcile explicit terminal intent and confirm that application-owned compute reached the required stopped state |
| User-supplied or imported workstation | Revocable device enrollment once; the enrolled agent receives a notebook attachment | Detach and revoke that attachment only; do not delete, shut down, or unenroll the user's machine |

An imported machine remains imported unless the user explicitly adopts it into a
managed lifecycle. A managed launch should not pair a new human workstation on
every start. A native workstation's enrollment should outlive individual notebook
sessions.

## Current implementation and compatibility

[Workstation credentials](../../apps/notebook-cloud/src/workstation-credentials.ts)
already support short-lived pairing codes, hashed owner-bound credentials and
revocation. Those reusable credentials are not the proposed per-session grants.
[The compute index](../../apps/notebook-cloud/src/compute-session-index.ts)
already separates registry data, liveness leases and event sockets; rebuilding
registration around another cache is unnecessary for this proposal.

[NotebookRoom](../../apps/notebook-cloud/src/notebook-room.ts)
`runtimePeerAuthorityError` checks selected workstation and session identity and
allows a matching disconnected session to reconnect. It also has compatibility
paths with no selection or no selected session ID. `createWorkstationAttachJob`
provides the selected session identity for workstation attach. Preserve these
existing clients while negotiating the new contract explicitly: a managed grant
must fail closed without a current generation. This memo does not claim that
all current runtimes already enforce the proposed grant rules.

## Proposed launch and attachment contract

These are logical guarantees, not a new endpoint or SDK inventory:

- Admission carries verified platform context, notebook ID, requested resources
  and environment, and an idempotency key. Derive the acting principal from
  verified identity, never a caller-supplied identity header.
- Scope the idempotency key to the authenticated tenant/principal and notebook.
  Persist an operation with a canonical request fingerprint and assigned session
  generation **before** allocation. Concurrent requests with that key return the
  same operation; different parameters conflict. A lost response must not allocate
  twice. A deliberate new launch needs a new key.
- The provider returns stable resource identity, observed state, and a handle for
  reconcile/cancel. Browser request lifetime does not own that operation. The
  existing provider controller remains the only resource lifecycle writer.
- Issue a narrow, renewable runtime grant binding issuer, audience/deployment,
  authorized principal, notebook, resource, session generation, permitted runtime
  and blob actions, expiry, and revocation identity. Do not deliver human refresh
  tokens or infrastructure-admin credentials to the kernel.
- Check the current selected generation when admitting the peer and on subsequent
  authority-bearing actions, including blob publication. A valid token signature
  alone cannot authorize a superseded session. Define bounded revocation latency
  for open sockets and uploads as well as fresh connections.
- Renewal cannot change generation, allocate more compute, extend resource
  ownership, or revive a terminal session. Keep notebook authority renewal separate
  from provider cloud-data credential renewal.
- Project allocation, connection, kernel readiness, busy, transient reconnect and
  terminal state into the UI. A successful health probe is not proof of readiness.

## Stop, reconnect, and replacement

A network disconnect is not a stop request. A peer disappearing does not prove
its container stopped. Conversely, a restarted container cannot recover authority
merely because it still has an old credential.

Persist terminal intent for a generation, with a reason such as user stop, idle
expiry, revocation or replacement. Fence execution authority immediately. For
managed compute, reconcile until the provider acknowledges the required stopped
state; display cleanup pending if confirmation is unavailable. For imported
compute, complete detach without invoking resource stop/delete. Keep this policy
separate from disconnect detection.

A transient reconnect within a valid session lease may keep its generation.
Runtime process replacement receives a new generation and fences the old one.
A controller process restart does not itself replace a still-valid runtime.
Late allocation results after cancellation are recorded and reconciled only for
resources this application owns; they cannot attach to the retired generation.
Do not automatically replay accepted code whose external side effects are unknown.

## State placement

| State | Authority or storage |
| --- | --- |
| Notebook content and accepted execution/output provenance | Notebook host and its durable document/journal storage |
| Current session selection and generation | Authoritative room/session record |
| Compute resource and desired lifecycle | Existing provider controller |
| Device enrollment and revocation | Device/enrollment registry |
| Presence and readiness projection | Bounded lease/cache, derived from authoritative state |
| Large outputs, source snapshots and checkpoints | Object storage or local filesystem, referenced by small metadata |

Redis may be a reconstructable index or notification channel if measurements
justify it. A TTL cache cannot be the sole proof of which runtime may publish or
which resource may be destroyed. It cannot supply principal delegation, generation
fencing or allocation idempotency by itself. Preserve one authority for each
fact. See the dated [BYOC control-plane memo](byoc-control-plane.md) for the
registry discussion; this proposal makes no current pricing claim.

## First implementation and acceptance

Start with idempotent managed admission against one existing provider and a
conformance fixture. Persist the launch operation before its allocation side
effect, and reconcile unknown outcomes by its stable identity. Then integrate
narrow grants and terminal acknowledgement. Keep activation opt-in until the host
and provider pass the paired contract. No new provider controller, Redis service
or kernel transport is required.

Qualify the boundary with observable scenarios:

- Concurrent duplicate Run and a lost allocation response produce one operation
  and one resource; a conflicting fingerprint is rejected.
- Cancellation followed by late ready and controller restart during allocation
  cannot attach retired compute or leak an application-owned allocation.
- Two identities prove notebook access does not grant compute; incorrect issuer,
  audience, principal, notebook, resource or generation is rejected.
- Old sockets and blob publications are fenced after replacement; renewal works
  without restarting Python, and revoke takes effect within the stated bound.
- Stop/idle/cancel survives controller failure without a supervisor restart loop;
  imported detach never invokes destructive provider operations.
- Existing enrollment records and running imported workstations continue working.
  Negotiated managed-grant rules cannot silently downgrade to legacy admission.
- Completed outputs and exact accepted execution provenance survive runtime
  replacement. Python memory and working files have separate lifecycle policies.
- Pin the application, WASM/protocol, native runtime and provider revisions; verify
  login, allocation, attachment, Python readiness, execution, rich output,
  reconnect and restore separately. Source review is not deployment acceptance.

Before using a non-DO host with multiple replicas, independently qualify fenced
room ownership and checkpoint writes. Sticky routing or a cache lock alone is not
that proof.

Open decisions: token/grant representation, delegated launch identity,
idempotency-record retention, revocation latency, imported-machine warm policy,
and transport of provider lifecycle events to the room. Resolve these with the
first concrete adapter before expanding a public provider API.
