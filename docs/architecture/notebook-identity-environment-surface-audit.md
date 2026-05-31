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
| Shell capabilities | `NotebookShellCapabilities` is the shared input for read/edit/execute/package/share/auth affordances. Desktop, cloud, and Elements already feed it. | Access is still a scalar document display level; runtime-peer authority and richer actor data are not represented as first-class projection fields. |
| Identity badge/group | `NotebookIdentityBadge`, `NotebookIdentityGroup`, and `notebookActorFromAccess()` render current actor, public viewer, local identity, and simple agent-on-behalf states. | `NotebookActorKind` only covers agent, human, local, public, and unknown. Runtime and system actors are not represented. The agent path still parses raw actor labels. |
| Environment summary | `NotebookEnvironmentSummary` renders runtime label, package source label, sync label, trust label, and package access from existing package view models. | Runtime status, package source, sync state, and trust state are still string props. There is no shared environment surface model with typed status. |
| Desktop adapter | `desktopNotebookShellCapabilities()` maps local sessions and remote connection scopes into the shared shell. Local notebooks default to owner-level local access. | A `runtime_peer` connection currently collapses to viewer. Desktop remote room identity is not distinguished from cloud source beyond `source: "cloud"`. Auth attention is always false. |
| Cloud adapter | `cloudNotebookShellCapabilities()` maps hosted auth and ACL scope into the shared shell. `invalid` and `oidc_expired` modes set auth attention. Public viewers become read-only cloud viewers. | `runtime_peer` also collapses to viewer. Cloud has the raw facts for credential attention, but Elements does not yet render a dedicated credential-attention scenario. |
| Hosted authority | Cloud auth and storage already treat `runtime_peer` as a first-class current scope, and public viewers are explicit ACL rows. | Shared UI projection has not caught up to those authority facts; this is a UI/model gap, not an auth gap. |
| Elements scenarios | `ElementsNotebookScenario` centralizes fixture cells, package state, trust state, outputs, variables, renderers, and shell capabilities. Current scenario ids are desktop local owner, cloud public viewer, cloud editor, cloud owner, agent on behalf, and runtime unavailable. | Missing PRD scenarios: desktop read-only, desktop remote room, credential attention, one principal with multiple operators, mixed-IdP room, runtime peer, and explicit untrusted-dependency scenario. |
| Elements catalog | The catalog already covers cell anatomy, editor, runtime, package manager, identity/environment, search, output renderers, output isolation, read-only notebooks, toolbar, theme, and widget surfaces with runtime-free fixtures. | Identity/environment guidance is newer than many pages, so pages do not all name how their state should flow through actor, access, environment, package, and trust projections. |
| Cell attribution | Code cells can receive submitted actor labels, and Elements shows an agent badge in the current-line example. | Execution attribution, presence, editor attribution, and activity are not yet driven by one structured actor projection. |
| Package rail direction | Package-manager docs render current app dependency components with fixture metadata, and outline rail docs name the packages panel direction. | The rail package/environment panel is not yet a single shared environment surface fed by typed runtime/package/trust state. |

## What Is Already Solid

The repo now has a useful convergence spine:

- `NotebookDocumentShell`, rail surfaces, cell surfaces, and read-only notebook
  surfaces are shared enough for Elements to render production components.
- `NotebookShellCapabilities` is the common adapter vocabulary for desktop,
  cloud, and catalog fixtures.
- Elements is using fixture-backed scenarios rather than daemon, sync,
  generated WASM, Cloudflare, or local filesystem dependencies.
- Cloud already owns the authority decisions for hosted ACL scope, public
  viewer rows, and runtime-peer capability.
- Desktop already maps local mutability and session readiness into the same
  shell capability object.

## Highest-Leverage Follow-Up Slices

### 1. Complete Elements Scenario Coverage

Add missing fixture scenarios first, without changing production behavior:

- desktop read-only file;
- desktop remote room with local daemon/socket identity plus remote service
  credential;
- credential needs attention;
- one principal with multiple operators;
- mixed-IdP room;
- runtime peer;
- explicit untrusted dependencies.

This should update `apps/elements/components/notebook-scenarios.ts`, the
identity/environment page, and the notebook shell capabilities page. It is the
smallest PR that makes the PRD visible in the catalog.

### 2. Promote Structured Actor Projection

Move from raw label parsing toward a structured actor surface:

- add runtime and system actor kinds;
- carry principal, operator, and on-behalf-of display fields separately;
- keep raw actor labels as compatibility input at host-adapter edges;
- feed the same projection into identity badges, active actor groups, cell
  current-line attribution, presence, and future activity surfaces.

This should start in `src/components/notebook-shell/NotebookIdentity.tsx` and
tests, then adapt Elements fixtures. Production adapters can follow after the
component contract is clear.

### 3. Keep Runtime Peer Out Of Document Access Level

Do not add `runtime_peer` to `NotebookShellAccessLevel`. Instead, add a separate
runtime-peer capability or actor projection that lets UI show runtime authorship
without granting notebook edit, package, or sharing affordances.

This should reconcile:

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

1. Add missing Elements scenarios and update identity/capability catalog pages.
2. Extend `NotebookActorIdentity`/actor rendering for runtime and system actors.
3. Add a runtime-peer shell projection separate from document access level.
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
