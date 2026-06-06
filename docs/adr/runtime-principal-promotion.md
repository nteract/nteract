# Runtime Principal Promotion

**Status:** Draft, 2026-06-06.

## Context

nteract now has two runtime shapes that should converge without hiding their
different authorities:

- Local notebooks execute through a daemon-owned kernel on the user's machine.
- Hosted rooms can accept a separate `runtime_peer` connection that observes
  accepted execution intent and writes runtime lifecycle, output, and widget
  state back to the room.

The identity model already separates principal and operator. A principal is the
authority the trust gate enforces; an operator is the process acting for that
principal. The missing contract is what happens to a local runtime when it is
used only locally, and what happens when that same workstation is promoted into
a hosted room.

This matters for execution controls and future workstation UI. A browser owner
should be able to request execution when an authorized runtime peer is attached,
but that does not mean the browser becomes the runtime peer or that the runtime
peer gains notebook-editing authority. Likewise, a local kernel should have a
principal for attribution before it ever talks to the hosted room.

## Decision 1: Local runtime connections have local principals

A local-only kernel or daemon runtime uses a local principal and a runtime
operator even when no hosted credential exists:

```text
local:<stable-local-subject>/runtime:<session-id>
```

The exact local subject is host-owned. It may be a local account, a local
daemon identity, or another stable local authority, but it must not impersonate
an Anaconda, OIDC, JupyterHub, or hosted account principal.

Local runtime identity is useful for attribution, diagnostics, presence, and
future UI, but it is not remote room authorization. A hosted room must not infer
remote write authority from a local principal string.

## Decision 2: Promotion adopts the remote room principal

Promotion is a new authorized attachment to the hosted room, not an in-place
rewrite of local identity.

When a local workstation or daemon runtime is promoted into a hosted room, it
opens a room connection as `runtime_peer` with a credential or attachment ticket
accepted by the hosted control plane. The room host validates that credential,
looks up the room ACL, and stamps the runtime-peer actor with the remote
principal it trusts:

```text
user:anaconda:<subject>/runtime:<workstation-session>
hub:<hub-host>:<subject>/runtime:<workstation-session>
```

The local principal remains local history. It can be shown as provenance for
the workstation itself, but room-authored runtime state uses the promoted remote
principal because that is the identity the room can validate and authorize.

Promotion therefore has three explicit identities:

- the local workstation identity;
- the remote principal granted room access; and
- the runtime operator session used for this attachment.

## Decision 3: Execution intent and runtime authorship stay separate

The browser, desktop, or agent connection that has request authority creates
execution intent. For the current hosted room this is owner authority; editor
execution can be added only where the product and room policy explicitly allow
it. The runtime peer executes only intent accepted by the room host.

For hosted execution:

1. An authorized request-capable connection asks the room host to execute a
   synced cell.
2. The room host validates scope, required heads, and runtime availability.
3. The room host writes the queued execution record to `RuntimeStateDoc`.
4. The runtime peer observes the queued record and runs the cell.
5. The runtime peer writes allowed lifecycle, output, blob, and comm state.

This preserves the existing split:

- owner/editor authority controls notebook edits and execution requests;
- `runtime_peer` authority controls runtime-state authorship for accepted work;
- neither authority silently implies the other.

An owner may hold both owner and runtime-peer grants for the same principal, but
those grants still appear as distinct operators/connections in the room.

## Decision 4: Execution controls derive from request authority plus runtime availability

Shared UI should show execution controls when the current user can request
execution and the host projects an executable runtime attachment. In a hosted
room, that means:

- the current connection has a request-authorized scope, initially owner and
  later editor where the product allows it;
- a compatible runtime peer or workstation is attached or selectable; and
- the host exposes a transport that sends execution requests to the room host,
  not directly to the runtime peer.

A `runtime_peer` connection by itself does not receive notebook editing or
execution-request controls. A viewer that can see runtime status does not gain
execute controls unless the room grants request authority.

## Decision 5: Workstation UI shows attachment, not ownership transfer

The rail or workstation surface should represent workstations as runtime
resources owned by a principal and attached to a room as runtime operators. The
minimum projection should distinguish:

- local-only runtime available;
- remote workstation available but not attached;
- runtime peer attached to this room;
- runtime peer attached under a different remote principal; and
- credential or ticket attention needed before promotion.

This gives desktop and cloud the same vocabulary. Desktop can show a local
runtime with local principal attribution. Cloud can show attached runtime peers
and future selectable workstations. A promoted workstation can show both "this
machine/runtime" and "acting in this room as <remote principal>" without
collapsing those facts.

## Rejected Alternatives

### Treat local principals as remote principals

Rejected. A local account can prove access to a local daemon, but it cannot
prove authority in a hosted room. Remote room writes must be stamped with the
principal the hosted room authenticated.

### Collapse owner and runtime_peer into one scope

Rejected. Owner controls notebook sharing, publishing, and structural notebook
authority. Runtime peers write runtime state and output for accepted executions.
Combining them would make it too easy for a compute sidecar to gain document or
ACL authority, and too easy for a browser owner to fabricate runtime state.

### Let runtime peers create execution intent directly

Rejected for hosted rooms. Runtime peers may run queued work and report
progress, but the room host coordinates execution intent so required heads,
cell identity, source, and request attribution stay tied to synced notebook
state.

## Consequences

- Local runtime projections need a principal/operator shape even before hosted
  attachment exists.
- Hosted promotion needs an explicit credential or attachment-ticket path that
  maps to a remote principal and `runtime_peer` ACL row.
- Execution controls should not be keyed only on kernel presence; they require
  request authority plus an available runtime attachment.
- Future workstation rail work should project local identity, remote principal,
  attachment state, and credential attention separately.
- Historical actor labels should remain historical. Promotion creates new
  remote room authorship; it should not rewrite existing local-attributed
  runtime events.

## Related Documents

- [Identity and Trust](identity-and-trust.md)
- [Hosted Room Authorization and Cloud Room Host](hosted-room-authorization.md)
- [Notebook Identity and Environment Surfaces](notebook-identity-environment-surfaces.md)
- [Remote Workstation Doc Agents](remote-workstation-doc-agents.md)
