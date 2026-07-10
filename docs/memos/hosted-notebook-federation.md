# Hosted Notebook Accounts and Compute Federation

**Status:** Exploratory memo, 2026-07-10. This is a working model, not an
accepted architecture decision or product requirement.

**Product surface:** Notebook Home, presented to users as **Notebooks**. This
work should not add a separate menu command for opening hosted notebooks.

Related:

- [Identity and Trust](../adr/identity-and-trust.md)
- [Deployment Topology](../adr/deployment-topology.md)
- [Cloud-Connected Local MCP Clients](../adr/cloud-connected-local-mcp.md)
- [Remote Workstation Doc Agents](../adr/remote-workstation-doc-agents.md)
- [Desktop Cloud Sessions Mediated by the Daemon](desktop-cloud-daemon-bridge.md)
- [AWS Rust Room Host](aws-rust-room-host.md)

## Intent

Desktop should give a user one place to find notebooks hosted by the services
they use, while keeping notebook hosting and compute placement separate.

The first deployment shapes are:

1. `n.anaconda.com`, a multitenant nteract service that replaces
   `preview.runt.run`;
2. private deployments such as `n.someinfra.com`, where members collaborate
   inside one organization and public access is disabled; and
3. existing JupyterHub deployments used primarily as compute providers for an
   nteract notebook room.

The first two are notebook services. They own catalogs, room locators, access
policy, and live nteract document sessions. A JupyterHub is not an nteract
catalog or Automerge room host by default in this model. It supplies an
already-running or allocatable compute environment that can attach to a
notebook whose room is hosted elsewhere.

## Five meanings of federation

The word federation covers several different boundaries. They should not share
one implicit implementation.

| Term | Meaning in this memo |
| --- | --- |
| Account and catalog federation | Notebook Home combines notebook summaries from several configured hosted accounts. |
| Cross-provider identity | One room host directly validates issuer credentials from more than one configured upstream identity authority. |
| Host assertion trust | One notebook host trusts identity assertions made by another notebook host. This remains outside V1. |
| Runtime federation | A notebook room uses compute supplied by another system, such as JupyterHub. |
| Document federation | Two systems participate in the same live nteract Automerge document set. A file import or Jupyter kernel connection is not document federation. |

This memo is mainly about account/catalog federation for nteract services and
runtime federation for JupyterHub. Direct cross-provider credential validation
and host-to-host assertion trust remain distinct identity decisions in the
identity ADR.

## Vocabulary

- **deployment**: a service and policy boundary, including its full base URL.
  Examples are `https://n.anaconda.com`, `https://n.someinfra.com`, and a Hub
  installed below `https://science.example.edu/jupyter/`.
- **hosted notebook account**: one locally configured, credentialed identity
  for a notebook deployment. More than one account may exist for the same
  deployment.
- **compute provider account**: one locally configured, credentialed identity
  for a compute control plane. A JupyterHub account is this kind by default.
- **adapter**: provider-specific code that implements a normalized notebook or
  compute contract.
- **notebook reference**: an account-scoped key used to select a catalog item.
  It is not automatically a durable document identity.
- **room locator**: the address of an nteract room host. Per the identity ADR,
  it does not grant access and does not encode compute placement.
- **runtime allocation**: a provider-owned server, container, process, or
  kernel resource being prepared for one attachment.
- **runtime attachment**: the room-authorized, session-fenced relationship
  between a runtime peer and a notebook room.

This use of account is a client configuration concept. It is distinct from
server-side principal account linking, which relates verified authentication
identities for one human.

## Working model

Notebook accounts and compute provider accounts are parallel inputs. A Hub
should not be forced through the hosted notebook catalog contract merely
because both kinds of connection require credentials.

Hosted notebook accounts produce Notebook Home rows. Compute provider accounts
feed account setup and runtime selection; they do not produce notebook rows by
default.

```text
Notebook Home (feature flagged)
  |
  +-- daemon federation service
        |
        +-- hosted notebook accounts
        |     +-- n.anaconda.com
        |     +-- n.someinfra.com
        |     +-- another nteract-compatible deployment
        |
        +-- compute provider accounts
              +-- local daemon
              +-- JupyterHub
              +-- registered workstation
              +-- future managed runtime

notebook room host <---- runtime_peer attachment ----> allocated compute
```

The local daemon owns account credentials, provider adapters, catalog refresh,
and compute-provider control calls. React consumes normalized projections. It
does not receive long-lived provider credentials or call arbitrary provider
APIs directly.

For managed deployments, an adapter may instead run as a hosted service or
inside the provider. The same normalized contracts and room invariants should
apply.

## Account and registry contract

The existing `CloudRegistry` is an origin registry. It maps one normalized
origin to one credential reference and rejects duplicate origins. That is a
useful V1 routing seam, but it is not an account model:

- it cannot represent two accounts at `n.anaconda.com`;
- it has no stable account id, provider kind, display label, auth state, or
  capability projection;
- origin normalization drops path prefixes, which is incompatible with Hubs
  installed below a base path; and
- hosted URL parsing recognizes the native `/n/<id>` room shape only.

A future machine-local registry should preserve the distinction between the
two account kinds. This is an illustrative shape, not a settled wire schema:

```text
HostedNotebookAccount
  id                  stable, opaque local id
  deployment_id       stable deployment record
  provider_kind       nteract_hosted
  base_url             full deployment base URL
  credential_ref      secret reference, never the secret value
  display_label
  principal_projection
  auth_state
  capabilities

ComputeProviderAccount
  id                  stable, opaque local id
  deployment_id       stable deployment record
  provider_kind       local | jupyterhub | workstation | managed
  base_url             full provider base URL when applicable
  credential_ref
  display_label
  principal_projection
  auth_state
  capabilities
```

An account id, not an origin alone, must namespace cached catalog rows, open
windows, daemon bridges, and reconnect state. Current locators already separate
different origins. The missing case is two accounts at the same origin, which
may see the same provider notebook id under different principals and must not
collapse into one local session.

Credential references remain machine-local and daemon-owned. Synced settings
may hold the feature flag and non-secret preferences, but not bearer values,
Hub tokens, or refresh tokens.

## Notebook catalog projection

Native nteract deployments expose the first notebook adapter. The current
`/api/n` response and pure dashboard projection provide most of the source
material, but the normalized row needs account identity and capability data.

An illustrative result is:

```text
HostedNotebookSummary
  key
    account_id
    provider_resource_id
  document_id?         provider-stamped durable identity when one exists
  room_locator?        present only when live nteract room sync is available
  title
  owner
  updated_at
  access
  is_public             current notebook state
  runtime_summary?
  capabilities
    open_live
    rename
    create
    share
    manage_public_access
    attach_compute
```

The provider resource id is an opaque lookup key. A path returned by a
Jupyter Server Contents API is not a durable nteract document id, and matching
titles or paths across providers must never merge document histories.

Catalog refresh should be independently fallible per account. An expired or
offline account produces an account-level status while healthy accounts remain
usable. The daemon should cache only non-secret summaries and record which
account produced each row.

## Deployment policy

`n.anaconda.com` and `n.someinfra.com` can share one nteract hosted adapter and
the same room protocol. Their policy capabilities may differ.

For a private single-tenant deployment, "colleagues only" must be enforced by
the service, not inferred from the hostname and not implemented only by hiding
UI. At minimum:

- the deployment admission policy restricts which principals may sign in;
- anonymous public ACL rows cannot be created;
- invite redemption is restricted to admitted principals or groups;
- account capabilities report `supports_public_access = false` and notebook
  capabilities report `manage_public_access = false`;
- every notebook projects `is_public = false`; and
- the UI omits public-link actions because the server reports them as
  unsupported.

Per-room ACLs still decide which admitted colleagues can read or edit each
notebook. Tenant admission and notebook ACLs are separate gates.

## JupyterHub is a compute provider first

The primary JupyterHub contract is to attach to or provision compute. Notebook
discovery through JupyterHub and its Contents API is outside the first contract.

The integration has three planes:

1. **Control plane:** find or start a user server, select an approved runtime
   profile, watch readiness, and stop or release the allocation.
2. **Kernel plane:** start, interrupt, restart, and shut down kernels near the
   allocated Jupyter Server, and carry Jupyter messages.
3. **nteract runtime data plane:** join the notebook room as `runtime_peer`,
   consume accepted execution by synced cell id, and publish runtime lifecycle,
   output, comm, and blob state.

JupyterHub authorization controls access to Hub servers and services. It does
not grant an nteract room role. The room host still owns:

- the selected compute target;
- runtime attachment and session fencing;
- execution intent;
- accepted `RuntimeStateDoc` and output mutations; and
- detach, replacement, and stale-peer rejection.

The runtime adapter cannot edit `NotebookDoc` and cannot create execution
intent. Code execution continues to reference a cell that already exists in
the synced notebook document.

### Current workstation shape

The current workstation flow runs a long-lived connector in the compute
environment. It registers and heartbeats, waits for attach jobs over an event
socket with polling fallback, then spawns a per-room `cloud-runtime-agent` that
dials the room as `runtime_peer`.

[#3608](https://github.com/nteract/nteract/issues/3608) tracks the focused
JupyterHub version of that shipped model: attach to an already-running
single-user server with kernelspec and working-directory support. Hub spawning
is intentionally outside that issue.

That remains a useful fallback for arbitrary machines. It need not be the
primary JupyterHub shape. A Hub already has a control plane for users, servers,
spawning, readiness, and scoped access. Requiring every Hub user server to
behave as a permanently registered workstation would duplicate part of that
control plane.

### JupyterHub attachment options

These options share room authority and runtime-peer invariants. They differ in
where the provider adapter runs and which network direction it requires.

#### A. Direct standard-API attachment from the local daemon

```text
local daemon -> Hub proxy -> existing user Jupyter Server
local daemon -> nteract room as the runtime adapter/runtime peer
```

The daemon uses a scoped user credential to locate or start the server, calls
standard Jupyter Server session/kernel APIs, and bridges kernel WebSockets into
nteract runtime state.

The daemon's runtime-peer connection is separate from the Desktop editor
bridge. It requests `runtime_peer` scope and is fenced by the current runtime
attachment session.

This is the least deployment-specific experiment for "compute is already stood
up." It is not the smallest implementation change because nteract does not yet
have a remote Jupyter Server REST/kernel-WebSocket adapter. It requires no
nteract process inside the Hub and no Hub-to-nteract egress. The user's Hub
credential stays on the local machine. The costs are that Desktop must remain
online, the daemon must implement that remote adapter, and Hub access is often
coarse at the user-server boundary.

#### B. nteract Jupyter Server extension

```text
local or hosted adapter -> Hub proxy -> user Jupyter Server + nteract extension
```

An administrator installs an authenticated nteract extension in the
single-user environment. The extension runs beside the kernel managers and can
offer a narrower runtime attachment API than a generic user-server credential.

This keeps the adapter close to kernels and can support richer, longer-lived
sessions. It requires deployment cooperation, explicit handler authorization,
and a server image rollout or restart.

#### C. Hub-proxied nteract service

```text
desktop or nteract host -> /services/nteract -> Hub API -> user server
```

A Hub-managed or externally managed service authenticates the user through Hub
OAuth, selects or starts a default or named server, follows spawn progress, and
brokers attachment. It is a good place for deployment policy and version
normalization, but it still needs either standard Jupyter APIs or an extension
inside the user server.

Prefer delegated user credentials for user-server actions. A central service
credential with broad cross-user server access has a much larger blast radius.

#### D. Per-user sidecar or agent dialing the room

```text
nteract room <- outbound runtime_peer <- sidecar beside the user server
```

This is closest to the current workstation data plane. A KubeSpawner deployment
can add a sidecar to newly spawned user pods; other Spawners need their own
equivalent hook. It works well behind private ingress because only outbound
connectivity is required, but it needs cluster egress, deployment packaging,
and an explicit sidecar identity.

### Provisioning an nteract-enabled runtime

JupyterHub can start default or named user servers through its REST API. A
named server such as `nteract` can select an administrator-approved runtime
profile without replacing the user's ordinary server.

The spawn body becomes provider-specific `user_options`, so it may contain only
validated, non-secret hints such as an approved profile name. Hub deployments
must explicitly validate and apply those options. They may be persisted, so
room credentials and attachment secrets do not belong there.

A safe high-level flow is:

1. The room creates a new attachment session and a short-lived enrollment
   grant scoped to that room, compute account, and session id.
2. The adapter locates an existing compatible server or requests an approved
   `nteract` server profile.
3. The adapter follows provider readiness without holding a document lock or
   blocking the room loop.
4. The near-kernel component redeems the enrollment grant, or the local daemon
   assumes the runtime adapter role in the direct-API topology.
5. The room admits the `runtime_peer` only for the current attachment session.
6. Detach or replacement revokes the enrollment path and fences late peers.

The room enrollment grant should be single use or short lived and should never
appear in argv, notebook metadata, `user_options`, ordinary sync frames, or
provider progress logs.

### Recommended prototype order

1. Define the provider-neutral allocation and attachment contract against
   fakes, before choosing one Hub topology as the interface.
2. Establish the existing sidecar/dial-home path inside a Hub as the smallest
   in-repo baseline. It reuses the shipped workstation agent and
   `cloud-runtime-agent`, with the focused adapter work tracked in #3608.
3. Time-box direct attachment to an already-running Jupyter Server using
   standard Hub and Jupyter APIs. This tests the desired zero-install shape but
   requires a new remote Jupyter transport. Hub API allocation and spawning are
   a separate exploratory topology, not an expansion of #3608.
4. Use the comparison to choose whether an in-server extension or Hub service
   is needed for longer-lived sessions, centralized provisioning, or policy.

This order separates "smallest code change" from "least deployment-specific."
It does not decide which topology becomes the production default.

## Provider-neutral compute contract

The first code slice should define and test a provider contract without adding
Notebook Home UI. An illustrative contract is:

```text
list_targets(account) -> [ComputeTarget]
allocate(account, target, environment_spec) -> AllocationOperation
watch(operation) -> pending | ready | failed | cancelled
attach(allocation, room_attachment) -> RuntimeAttachment
stop(attachment or allocation)
```

The normalized projections need enough information to render and fence state,
not provider secrets:

```text
ComputeTarget
  account_id
  provider_target_id
  display_label
  state
  capabilities
  environment_options

RuntimeAttachment
  provider_kind
  provider_target_id
  allocation_id
  runtime_session_id
  state
  status_message?
```

Allocation and attachment are separate because a Hub server may be ready while
no runtime peer is attached to a room. Retry must be idempotent by allocation
operation and attachment session id.

## `preview.runt.run` migration

Desktop session persistence stores the literal room locator, while daemon bridge
reuse indexes its in-memory, ephemeral bridges by that locator. Replacing
`preview.runt.run` with `n.anaconda.com` therefore needs an explicit
compatibility plan. Changing a display label is insufficient.

Viable mechanisms include:

- keep the old host serving the native HTTP and WebSocket protocol as a
  compatibility proxy during migration, without asking the client to replay an
  authorization header to another origin;
- add a signed deployment alias response that maps the retired deployment to
  the canonical deployment before credentials are selected; or
- perform an explicit local account and locator migration with user-visible
  confirmation.

Do not silently send an old deployment's credential to a replacement origin.
The new origin must already be trusted by the account configuration or by a
verified migration response.

## Fundamentals audit

| Foundation | Current state | Consequence |
| --- | --- | --- |
| Host-neutral typed-frame room protocol and `runtime_peer` scope | In place | Native deployments and provider runtimes can share room semantics. |
| Daemon-mediated hosted room bridge | In place for `NotebookDoc` and cloud-authoritative `RuntimeStateDoc` | Desktop has a reusable live-room open primitive. Comms, comments, persistence, and credential lifecycle remain incomplete. |
| Daemon-owned credential references | In place for environment-backed native hosted credentials | Secrets stay out of React and the desktop handshake, but keychain, OAuth, refresh, and account auth status remain open. |
| Native hosted catalog and pure dashboard projection | In place for one same-origin account | Useful source material, but not yet account-keyed or federated. |
| Stable hosted account identity | Missing | Two accounts on one origin cannot be represented safely; naïvely aggregated dashboard rows can also collide on provider ids. |
| Daemon provider-adapter and catalog aggregation API | Missing | Notebook Home should not be wired directly to several provider APIs yet. |
| Server-enforced private-tenant policy | Missing | Hiding public sharing in UI would not meet the private deployment requirement. |
| Provider-labelled compute and attachment session fencing | Shipped for registered workstations through `RuntimeStateDoc` | Hub-specific allocation and remote Jupyter adapters remain absent. |
| JupyterHub control-plane adapter | Missing | Server discovery, spawn/readiness, scoped credentials, and cleanup need a provider implementation. |
| Remote Jupyter Server adapter | Missing | The local `JupyterKernel` path already translates local Jupyter traffic, but direct Hub attachment still needs REST and kernel-WebSocket transport. |
| UI feature-flag mechanism | Generic machinery in place; Notebook Home flag not added | Provider contracts can be tested before adding the default-off entry surface. |

## Test contract before UI

Account and catalog tests:

- two accounts on one origin remain distinct;
- identical notebook ids from two accounts or deployments do not collide;
- a Hub base path is preserved exactly;
- an expired or offline account does not hide healthy accounts;
- secrets never appear in normalized summaries, locators, logs, or persisted
  window state;
- a private tenant rejects public ACL creation server-side; and
- old-host migration never forwards credentials to an untrusted origin.

Compute-provider tests:

- a fake Hub can return an already-running server or an asynchronous spawn;
- `201`, `202`, progress, timeout, cancellation, and provider failure map to
  stable allocation states;
- retries reuse an allocation operation instead of spawning duplicates;
- non-secret `user_options` are validated and unknown profiles are rejected;
- attachment tickets are room- and session-scoped and cannot be replayed;
- a stale runtime peer cannot write after attachment replacement;
- execution references a synced cell id rather than a side-channel code string;
- interrupt, restart, shutdown, output, comms, and blob behavior converge
  through the runtime model; and
- detaching compute does not change notebook ACL or document ownership.

All initial tests should run against fake HTTP and WebSocket providers. A real
Hub smoke test can follow after the contract is stable.

## Suggested slices

1. Add account ids and provider kinds above the current domain registry, with
   tests for multiple accounts on one origin and full Hub base URLs.
2. Define normalized hosted catalog and compute-provider contracts in daemon
   code, backed by fakes. Do not add UI in this slice.
3. Adapt the native `/api/n` catalog and current hosted-room opener to the new
   account contract.
4. Add server-enforced deployment capabilities for private-only tenants.
5. Compare the existing Hub sidecar baseline with a time-boxed direct JupyterHub
   compute adapter against standard Hub and Jupyter Server APIs.
6. Add the default-off Notebook Home feature flag and render normalized native
   notebook accounts. Do not add a menu item.
7. Evaluate an in-server extension or Hub service using evidence from the
   direct adapter prototype.

## Open questions

1. Which machine-local store owns stable account ids and credential references,
   and how are keychain records migrated?
2. Does `n.anaconda.com` preserve old room ids from `preview.runt.run`, or does
   migration create new room identities?
3. Which server-side policy represents a private-only deployment, and which
   invitation domains or groups may it admit?
4. For a direct Hub adapter, does the local daemon stay online for the lifetime
   of the runtime attachment?
5. Which Hub scopes are the least-privilege set for locating, starting,
   accessing, and stopping only the current user's servers?
6. Does a Hub allocation reuse an existing server, create an `nteract` named
   server, or allow both by deployment policy?
7. Does the near-kernel adapter use Jupyter Server kernel/session APIs, launch a
   native `runtimed` child, or support both?
8. Which deployments can install a Jupyter Server extension, Hub service, or
   sidecar, and which must remain zero-install?
9. Should the local daemon or a hosted nteract service orchestrate a private
   Hub that is not reachable from the public internet?
10. Which parts of this memo graduate into an account/catalog ADR, a compute
    provider ADR, and Notebook Home product requirements after prototypes?

## External references

- [JupyterHub REST API](https://jupyterhub.readthedocs.io/en/stable/reference/rest-api.html)
- [JupyterHub services](https://jupyterhub.readthedocs.io/en/stable/reference/services.html)
- [JupyterHub scopes](https://jupyterhub.readthedocs.io/en/stable/rbac/scopes.html)
- [JupyterHub Spawner API](https://jupyterhub.readthedocs.io/en/stable/reference/api/spawner.html)
- [JupyterHub URL scheme](https://jupyterhub.readthedocs.io/en/stable/reference/urls.html)
- [JupyterHub single-user server authentication](https://jupyterhub.readthedocs.io/en/stable/explanation/singleuser.html)
- [Jupyter Server REST API](https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html)
- [Jupyter Server kernel WebSocket protocol](https://jupyter-server.readthedocs.io/en/stable/developers/websocket-protocols.html)
- [Jupyter Server extensions](https://jupyter-server.readthedocs.io/en/stable/developers/extensions.html)
- [KubeSpawner configuration](https://jupyterhub-kubespawner.readthedocs.io/en/stable/spawner.html)
- [JupyterLab real-time collaboration](https://jupyterlab-realtime-collaboration.readthedocs.io/en/stable/)

JupyterLab RTC is a separate Yjs-based collaboration stack. It may coexist in a
Hub deployment, but it does not make JupyterHub or JupyterLab an nteract
Automerge room peer.
