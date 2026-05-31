# Notebook Identity and Environment Surface Audit

**Status:** Audit, 2026-05-31.

**Related:**

- `docs/architecture/notebook-identity-environment-surfaces.md`
- `docs/architecture/notebook-host-shell-convergence.md`
- `docs/architecture/identity-and-trust.md`
- `docs/architecture/hosted-room-authorization.md`
- `apps/elements/content/docs/identity-environment-surfaces.mdx`
- `apps/elements/content/docs/notebook-shell-capabilities.mdx`

This audit captures where the shared notebook shell, Elements catalog, desktop
adapter, and cloud adapter currently stand against the notebook identity and
environment PRD. It is intentionally an audit, not a new decision: follow-up
PRs should use this to pick concrete slices without changing the identity,
room ACL, or daemon-owned environment decisions.

`docs/architecture/identity-and-trust.md` remains the source of truth for
durable Automerge actor labels. Those labels use the `<principal>/<operator>`
shape: the principal is enforced by auth and room ACL, while the operator is
used for attribution. The UI gap in this audit is not that durable labels
exist; it is that React components still parse some raw labels directly instead
of consuming a structured host/backend actor projection.

## Scope Checked

Current evidence came from:

- shared shell contracts in `src/components/notebook-shell/**`;
- desktop capability mapping in
  `apps/notebook/src/lib/desktop-shell-capabilities.ts`;
- cloud capability mapping in `apps/notebook-cloud/viewer/shell-capabilities.ts`;
- hosted auth/ACL code in `apps/notebook-cloud/src/**`;
- Elements fixtures and pages in `apps/elements/components/**` and
  `apps/elements/content/docs/**`.

## Current State

| Surface | Current state | Gap |
|---------|---------------|-----|
| Shell capabilities | `NotebookShellCapabilities` is the shared input for read/edit/execute/package/share/auth affordances. Desktop, cloud, and Elements already feed it, including separate `access.actor` and `runtime.actor` projections. | Environment and package state are still spread across strings and package view models rather than a typed shared environment projection. |
| Identity badge/group | `NotebookIdentityBadge`, `NotebookIdentityGroup`, and actor projection helpers render current actor, public viewer, local identity, delegated agent, runtime, and system states. | React still has fallback parsing for raw actor labels while hosts finish sending structured projections. Presence, execution attribution, and future activity surfaces do not yet all consume the same projection. |
| Environment summary | `NotebookEnvironmentSummary` renders runtime label, package source label, sync label, trust label, and package access from existing package view models. | Runtime status, package source, sync state, and trust state are still string props. There is no shared environment surface model with typed status. |
| Desktop adapter | `desktopNotebookShellCapabilities()` maps local sessions and remote connection scopes into the shared shell. Local notebooks default to owner-level local access, and `runtime_peer` maps to viewer document access plus runtime write capability. | Desktop remote room identity is still only distinguished by actor/source shape. The product model is desktop app plus local daemon/socket identity plus remote service credential or API key. Auth attention is always false. |
| Cloud adapter | `cloudNotebookShellCapabilities()` maps hosted auth and ACL scope into the shared shell. `invalid` and `oidc_expired` modes set auth attention. Public viewers become read-only cloud viewers, and `runtime_peer` maps to runtime authorship rather than document edit access. | Cloud exposes credential transport metadata such as `anaconda-api-key`; shared UI should continue deriving principal authority from the principal namespace/projection, not from that transport field. Elements does not yet render a dedicated credential-attention scenario. |
| Hosted authority | Cloud auth and storage treat `runtime_peer` as a first-class current scope, public viewers are explicit ACL rows, and anonymous public viewer presence is local/aggregate-only today. | Request-scope enforcement and hosted execution-intent semantics still need clearer current-vs-target documentation across the architecture docs. |
| Elements scenarios | `ElementsNotebookScenario` centralizes fixture cells, package state, trust state, outputs, variables, renderers, and shell capabilities. Current scenario ids include desktop local owner, cloud public viewer, cloud editor, cloud owner, agent on behalf, runtime peer, system schema, and runtime unavailable. | Missing PRD scenarios: desktop read-only, desktop remote room, credential attention, one principal with multiple operators, mixed-IdP room, and a dedicated untrusted-dependency scenario separate from the shared trust fixture. |
| Elements catalog | The catalog already covers cell anatomy, editor, runtime, package manager, identity/environment, search, output renderers, output isolation, read-only notebooks, toolbar, theme, and widget surfaces with runtime-free fixtures. | Identity/environment guidance is newer than many pages, so pages do not all name how their state should flow through actor, access, environment, package, and trust projections. |
| Cell attribution | Code cells can receive submitted durable actor labels, and Elements shows an agent badge in the current-line example. | Execution attribution, presence, editor attribution, and activity are not yet driven by one structured actor projection. |
| Package rail direction | Package-manager docs render current app dependency components with fixture metadata, and the shell has `NotebookDocumentRail` plus `NotebookPackageSummaryPanel` for host-neutral package viewing. | The rail package/environment panel is not yet a single shared environment surface fed by typed runtime/package/trust state. |

## What Is Already Solid

The repo now has a useful convergence spine:

- `NotebookDocumentShell`, rail surfaces, cell surfaces, and read-only notebook
  surfaces are shared enough for Elements to render production components.
- `NotebookShellCapabilities` is the common adapter vocabulary for desktop,
  cloud, and catalog fixtures, including the separate runtime-authority
  projection that keeps `runtime_peer` out of document access.
- Elements is using fixture-backed scenarios rather than daemon, sync,
  generated WASM, Cloudflare, or local filesystem dependencies.
- Cloud already owns the authority decisions for hosted ACL scope, public
  viewer rows, anonymous public viewer presence policy, and runtime-peer
  capability.
- Desktop already maps local mutability and session readiness into the same
  shell capability object.

## Highest-Leverage Follow-Up Slices

### 1. Complete Elements Scenario Coverage

Add missing fixture scenarios without changing production behavior:

- desktop read-only file;
- desktop remote room with local daemon/socket identity plus remote service
  credential;
- credential needs attention;
- one principal with multiple operators;
- mixed-IdP room;
- dedicated untrusted dependencies.

This should update `apps/elements/components/notebook-scenarios.ts`, the
identity/environment page, and the notebook shell capabilities page. It is the
smallest PR that makes the PRD visible in the catalog.

### 2. Finish Structured Actor Projection Adoption

The shared component contract now has structured actor projections. The next
step is to remove remaining page-local/raw-label assumptions:

- keep durable `<principal>/<operator>` actor labels as backend/CRDT
  attribution;
- make host adapters, backend projections, or a shared identity module parse and
  enrich durable labels into structured actor projections before React renders
  them;
- feed the same projection into identity badges, active actor groups, cell
  current-line attribution, presence, and future activity surfaces.

This should continue in `src/components/notebook-shell/**` and host adapters,
then feed the same projection to Elements fixtures. The important direction is
shared projection, not cloud-specific display fixes.

### 3. Keep Runtime Peer Semantics Explicit

`runtime_peer` is now intentionally outside `NotebookShellAccessLevel`.
Continue treating it as runtime authorship/capability that lets UI show runtime
output and lifecycle attribution without granting notebook edit, package, or
sharing affordances.

This matters for BYOC and JupyterHub-shaped deployments: the runtime is acting
with delegated compute authority and authoring runtime/output lifecycle state,
not becoming a notebook editor.

Keep the docs and adapters reconciled across:

- hosted `ConnectionScope = "viewer" | "editor" | "runtime_peer" | "owner"`;
- shell display level `none | viewer | editor | owner`;
- runtime actor badges and output/lifecycle attribution.

### 4. Type The Environment Projection

Replace loose runtime/package/trust strings with a typed environment surface
that can be shared by Elements, desktop, and cloud:

- runtime status: ready, detached, unavailable, launching, error;
- package summary and source;
- package sync status;
- trust status and attention;
- package view/manage capabilities.

`NotebookEnvironmentSummary` can remain the first renderer, but the facts should
come from a shared projection rather than page-local strings.

### 5. Move Package/Environment Rail Toward The Shared Surface

The rail-forward direction is right: outline, packages, variables, renderers,
and future activity belong beside the notebook, not inside cell chrome. The next
package rail slice should consume the shared environment projection and reuse
existing dependency components through adapters.

Keep daemon-owned actions inert in Elements and host-owned in production:

- dependency trust mutation;
- package sync;
- environment rebuild/reset;
- runtime launch;
- remote credential refresh.

### 6. Name The Activity And Sharing Surfaces

Identity work will quickly need two missing composites:

- notebook activity feed for saves, runs, sharing changes, trust changes, and
  runtime events;
- sharing controls for collaborators, public viewer state, pending invites, and
  owner-only ACL management.

These should not start as generic cards. They should consume the same actor,
access, and environment projections as the header and rail.

## Adjacent Documentation Drift Found In This Pass

This pass also tightened nearby docs that affect identity/environment work:

- `apps/notebook-cloud/README.md`, `hosted-notebook-artifacts.md`, and
  `runtime-state-document-identity.md` now describe the current hybrid snapshot
  layout: notebook snapshots under the compatibility notebook path and
  runtime-state snapshots under `docs/{runtimeStateDocId}/...`.
- `crates/notebook-wire/AGENTS.md` now names protocol v4, NotebookDoc schema v5,
  and `PUT_BLOB` frame `0x08`.
- `crates/notebook-doc/AGENTS.md` now treats `RuntimeStateDoc` as the durable
  execution/output record instead of teaching broadcast-driven output state.
- `three-document-split.md` now names schema v5 and current runtime-doc policy
  enforcement.

Remaining follow-up: `hosted-room-authorization.md` should keep current
frame-level gating clearly separated from future semantic execution-intent
dispatch once the next hosted mutation/runtime slices land.

## Guardrails

- Do not import `apps/elements`, Fumadocs, or catalog-only dependencies into
  `apps/notebook`.
- Do not vendor old `nteract/elements` components.
- Do not catalog raw shadcn primitives unless wrapped by notebook semantics.
- Do not make React components authoritative for auth, ACL, trust, package
  mutation, runtime launch, or filesystem writes.
- Do not solve runtime-peer by making it a fifth document access level.
- Keep Elements runtime-free and fixture-backed.

## Suggested Next PR Order

Slices 1 and 2 can land in either order. If shared identity work is already in
flight, prefer landing runtime/system/delegated-operator support before adding
decorative Elements scenarios that cannot yet consume faithful projections.

1. Add missing Elements scenarios and update identity/capability catalog pages,
   or land immediately after slice 2 if the actor projection is actively
   changing.
2. Finish projection adoption for presence, execution attribution, editor
   attribution, and activity.
3. Keep runtime-peer shell projection and architecture docs aligned with
   `NotebookShellCapabilities.runtime`.
4. Introduce a typed `NotebookEnvironmentSurface` view model.
5. Refactor package/environment rail rendering onto that model.
6. Start activity and sharing composites once actor/access projection is stable.

## Open Questions

1. Should the structured actor projection live next to
   `NotebookShellCapabilities`, or as a separate notebook activity/identity
   module?
2. Should desktop remote rooms expose a distinct access source, such as
   `remote`, instead of reusing `cloud`?
3. Which environment facts should come from `NotebookViewModel`, and which
   should remain host adapter facts?
4. How much of activity/sharing should be cataloged in Elements before cloud
   owns the production interaction model?
