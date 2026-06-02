# Notebook Identity and Environment Surface Audit

**Status:** Audit, refreshed 2026-06-01.

**Related:**

- `docs/adr/notebook-identity-environment-surfaces.md`
- `docs/adr/notebook-host-shell-convergence.md`
- `docs/adr/identity-and-trust.md`
- `docs/adr/hosted-room-authorization.md`
- `apps/elements/content/docs/identity-environment-surfaces.mdx`
- `apps/elements/content/docs/notebook-shell-capabilities.mdx`

This audit captures where the shared notebook shell, Elements catalog, desktop
adapter, and cloud adapter currently stand against the notebook identity and
environment PRD. It is intentionally an audit, not a new decision: follow-up
PRs should use this to pick concrete slices without changing the identity,
room ACL, or daemon-owned environment decisions.

`docs/adr/identity-and-trust.md` remains the source of truth for
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
| Shell capabilities | `NotebookShellCapabilities` is the shared input for read/edit/execute/package/share/auth affordances. Desktop, cloud, and Elements already feed it, including separate `access.actor`, `runtime.actor`, and `interaction` projections. | Capability projection is in good shape; the next risk is making sure new sharing/activity controls consume it instead of reintroducing host-specific gates. |
| Identity badge/group | `NotebookIdentityBadge`, `NotebookIdentityGroup`, and actor projection helpers render current actor, public viewer, local identity, delegated agent, runtime, and system states. | React still has fallback parsing for raw actor labels while hosts finish sending structured projections. Presence, execution attribution, and future activity surfaces do not yet all consume the same projection. |
| Interaction mode and command toolbar | `NotebookInteractionModeProjection` is now the shared selected/active/requested view-edit projection. Desktop, cloud, and Elements feed it into shared toolbar chrome: `NotebookToolbarFrame`, `NotebookCommandToolbar`, `NotebookToolbarIdentity`, and the edit-mode button. | Keep interaction state host-neutral. It should drive labels and affordances, not become the authority for writes or replace room/daemon enforcement. |
| Environment summary | `NotebookEnvironmentSummary` consumes `NotebookEnvironmentSurface`, a typed shared projection with access, runtime, package, sync, and trust sections. Elements scenarios build it through `createNotebookEnvironmentSurface()`. Cloud no longer renders the environment summary in its package rail after #3273; the cloud rail is package-only. | Desktop/cloud still need to keep mapping real daemon, ACL, credential, and package facts into this surface wherever they intentionally render an environment summary, instead of passing ad hoc labels at page boundaries. |
| Desktop adapter | `desktopNotebookShellCapabilities()` maps local sessions and remote connection scopes into the shared shell. Local notebooks default to owner-level local access, and `runtime_peer` maps to viewer document access plus runtime write capability. | Desktop remote room identity is still only distinguished by actor/source shape. The product model is desktop app plus local daemon/socket identity plus remote service credential or API key. Auth attention is always false. |
| Cloud adapter | `cloudNotebookShellCapabilities()` maps hosted auth and ACL scope into the shared shell. `invalid` and `oidc_expired` modes set auth attention. Public viewers become read-only cloud viewers, and `runtime_peer` maps to runtime authorship rather than document edit access. | Cloud still exposes credential transport metadata such as `anaconda-api-key`; shared UI should continue deriving principal authority from the principal namespace/projection, not from that transport field. |
| Hosted authority | Cloud auth and storage treat `runtime_peer` as a first-class current scope, public viewers are explicit ACL rows, and anonymous public viewer presence is local/aggregate-only today. | Request-scope enforcement and hosted execution-intent semantics still need clearer current-vs-target documentation across the architecture docs. |
| Elements scenarios | `ElementsNotebookScenario` centralizes fixture cells, package state, trust state, outputs, variables, renderers, shell capabilities, and the typed environment surface. Scenario ids now cover desktop local owner, desktop read-only, desktop remote room, cloud public viewer, cloud editor, cloud owner, agent on behalf, credential attention, one principal with multiple operators, mixed-IdP, runtime peer, system schema, runtime unavailable, and untrusted dependencies. | Scenario coverage is now adequate; the gap is keeping new catalog pages and production adapters on these fixtures/projections rather than adding page-local mock state. |
| Elements catalog | The catalog already covers cell anatomy, editor, runtime, package manager, identity/environment, search, output renderers, output isolation, read-only notebooks, toolbar, theme, and widget surfaces with runtime-free fixtures. | Identity/environment guidance is newer than many pages, so pages do not all name how their state should flow through actor, access, environment, package, and trust projections. |
| Cell attribution | Code cells can receive submitted durable actor labels, and Elements shows an agent badge in the current-line example. | Execution attribution, presence, editor attribution, and activity are not yet driven by one structured actor projection. |
| Package rail direction | Package-manager docs render current app dependency components with fixture metadata, and the shell has `NotebookDocumentRail` plus `NotebookPackageSummaryPanel` for host-neutral package viewing. Cloud now keeps the package rail package-only, while Elements can still render `NotebookEnvironmentSummary` in dedicated identity/environment and rail examples. | The remaining work is connecting more production rail actions to host-owned callbacks while keeping Elements inert, and deciding where environment summaries should appear outside the package-only rail. |

## What Is Already Solid

The repo now has a useful convergence spine:

- `NotebookDocumentShell`, rail surfaces, cell surfaces, and read-only notebook
  surfaces are shared enough for Elements to render production components.
- `NotebookShellCapabilities` is the common adapter vocabulary for desktop,
  cloud, and catalog fixtures, including the separate runtime-authority
  projection that keeps `runtime_peer` out of document access.
- `NotebookInteractionModeProjection`, `NotebookToolbarFrame`,
  `NotebookCommandToolbar`, and `NotebookToolbarIdentity` are shared across
  desktop, cloud, and Elements, so toolbar interaction language is no longer
  a cloud-only or desktop-only concern.
- Elements is using fixture-backed scenarios rather than daemon, sync,
  generated WASM, Cloudflare, or local filesystem dependencies.
- Elements now covers the identity/environment PRD scenario set, including
  desktop remote, credential attention, mixed-IdP, multi-operator, runtime-peer,
  and untrusted dependency states.
- `NotebookEnvironmentSurface` exists as a typed shared projection consumed by
  `NotebookEnvironmentSummary`.
- Cloud already owns the authority decisions for hosted ACL scope, public
  viewer rows, anonymous public viewer presence policy, and runtime-peer
  capability.
- Desktop already maps local mutability and session readiness into the same
  shell capability object.

## Cross-Host Convergence Notes

Cloud should keep converging toward the desktop/shared shell by moving notebook
presentation into `src/components/notebook-shell/**` whenever the behavior is
not inherently hosted:

- command toolbar chrome, identity controls, interaction mode, and cell surfaces
  should stay shared;
- package rail rendering should use shared package components with cloud-owned
  callbacks and authority checks;
- presence, activity, execution attribution, and sharing surfaces should consume
  the same actor/access/interaction projections instead of cloud-local labels;
- hosted auth, ACL, public viewer policy, credential refresh, and room mutation
  should remain cloud adapter responsibilities.

Desktop should be more explicit about the facts it projects into the same shell:

- local file mutability, daemon/session readiness, package trust, and dependency
  sync should map into shell/environment projections rather than toolbar-local
  booleans;
- desktop remote rooms should project a distinct identity path: desktop app,
  local daemon/socket identity, and remote service credential or API key;
- remote credential attention should eventually be represented instead of
  leaving desktop auth attention always false;
- local read-only notebooks should continue to distinguish readable notebook
  state from writable document/package/runtime capabilities.

The maintainability rule is: duplicate host adapters when the host authority is
different; do not duplicate notebook presentation just because the source facts
come from different authorities. Shared components should receive typed
projections plus host callbacks, while desktop/cloud keep enforcement, auth,
filesystem, daemon, and room-host side effects outside the shared shell.

## Highest-Leverage Follow-Up Slices

### 1. Finish Structured Actor Projection Adoption

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

### 2. Keep Runtime Peer Semantics Explicit

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

### 3. Keep Interaction And Command Chrome Host-Neutral

`NotebookInteractionModeProjection` now separates requested edit state from
active edit permission and host support. Keep new toolbar, presence, and
activity work on that projection:

- selected mode says what the user asked for;
- active mode and `canEdit*` say what this host can currently perform;
- room, daemon, or filesystem authorities still enforce all writes;
- shared toolbar chrome should keep receiving capabilities and callbacks rather
  than importing cloud or desktop state directly.

### 4. Keep Environment Projection Typed End-To-End

`NotebookEnvironmentSurface` now exists, so the follow-up is not inventing the
shape. It is mapping every host source into it consistently:

- runtime status: ready, detached, unavailable, launching, error;
- package summary and source;
- package sync status;
- trust status and attention;
- package view/manage capabilities.

`NotebookEnvironmentSummary` is the first renderer. The facts should continue to
come from the shared projection rather than page-local strings.

### 5. Keep Package Rail Package-Focused

The rail-forward direction is right: outline, packages, variables, renderers,
and future activity belong beside the notebook, not inside cell chrome. After
#3273, cloud's package rail is deliberately package-only. Environment/access,
runtime, sync, and trust summary facts should render through
`NotebookEnvironmentSummary` or a sibling shared component where product wants
that summary, not by overloading the package panel.

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

1. Keep interaction-mode and command-toolbar semantics aligned across desktop,
   cloud, and Elements.
2. Finish projection adoption for presence, execution attribution, editor
   attribution, and activity.
3. Keep runtime-peer shell projection and architecture docs aligned with
   `NotebookShellCapabilities.runtime`.
4. Keep desktop/cloud environment facts flowing through
   `NotebookEnvironmentSurface`.
5. Refactor package rail actions onto package-focused host callbacks and decide
   where environment summaries belong.
6. Start activity and sharing composites once actor/access/interaction
   projection is stable.

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
