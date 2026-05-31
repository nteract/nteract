# Notebook Identity and Environment Surfaces

**Status:** PRD draft, 2026-05-31.

**Owners:** nteract notebook UI, Cloud/Auth, Desktop runtime.

This PRD defines the user-facing language and shared UI contract for notebook
identity, agency, access, runtime, trust, and package environment surfaces. It
coordinates the shared desktop/cloud notebook shell with the Elements catalog so
Cloud/Auth work can land without creating another notebook UI model.

Related docs:

- `docs/architecture/identity-and-trust.md`
- `docs/architecture/hosted-room-authorization.md`
- `docs/architecture/hosted-sharing-invites.md`
- `docs/architecture/captured-environment-lifecycle.md`
- `docs/architecture/notebook-host-shell-convergence.md`
- `apps/elements/content/docs/identity-environment-surfaces.mdx`

Prototype and shared component surfaces:

- `src/components/notebook-shell/capabilities.ts`
- `src/components/notebook-shell/NotebookIdentity.tsx`
- `src/components/notebook-shell/NotebookEnvironmentSummary.tsx`
- `apps/elements/components/notebook-scenarios.ts`

## Problem

Desktop and cloud now share notebook shell and rail-forward cell surfaces, but
identity and environment facts still arrive from different host adapters:

- desktop knows about local files, daemon/runtime state, dependency trust, and
  package metadata;
- cloud knows about OIDC auth, public access, hosted room ACLs, published
  artifacts, and future runtime peers;
- Elements needs deterministic, runtime-free fixtures that show the same
  product states without importing daemon, sync, auth, or WASM boundaries.

If each host turns those facts into local strings and local UI affordances, the
shared shell will drift. The user-facing result is especially confusing around
agents: a user needs to know whether Kyle edited a notebook, Codex acted on
Kyle's behalf, an anonymous public viewer is present, or a runtime peer wrote
execution output.

## Goals

1. Establish shared product language for notebook actors, delegated agents,
   access scope, runtime availability, package state, and trust state.
2. Keep Cloud/Auth authorization decisions in the hosted room/ACL layer while
   giving shared components enough structured facts to render accurate UI.
3. Keep Desktop runtime/environment decisions in daemon-owned APIs while giving
   shared components the same projection shape used by cloud.
4. Make Elements the runtime-free visual inventory for these surfaces using
   fixture-backed scenarios, not schematic replacements.
5. Give short-term work enough guidance to ship compatible adapter props while
   preserving space for later ADRs when low-level identity or runtime contracts
   need to harden.

## Non-Goals

- This PRD does not change the actor-label, room ACL, or credential decisions in
  `identity-and-trust.md` and `hosted-room-authorization.md`.
- This PRD does not launch a new sharing product, invite flow, or organization
  permissions model.
- This PRD does not let shared React components import Cloudflare Worker,
  Tauri, daemon, generated WASM, sync, iframe, or auth-provider APIs.
- This PRD does not catalog generic shadcn primitives unless nteract wraps them
  with notebook-specific behavior.

## Product Language

Use these terms consistently in UI copy, component names, and docs.

| Term | Meaning |
|------|---------|
| Principal | Authenticated entity the trust gate enforces, such as a local user, Anaconda user, JupyterHub user, or system principal. |
| Operator | Client or process currently acting for the principal, such as desktop, browser, runtime, Codex, or a scheduled job. |
| Actor | UI projection of principal plus operator for attribution and presence. A human, agent, runtime, system process, or public viewer can all appear as actors. |
| Delegated agent | Agent operator acting on behalf of a human principal. The UI should show both the agent and the human subject. |
| Access scope | Host-derived authorization facts projected for UI rendering. `viewer`, `editor`, `owner`, and `runtime_peer` are room/ACL scopes; `none` is a UI-only display state for missing or rejected access. |
| Environment | Notebook execution context: runtime availability, package declarations, dependency trust, package sync, and captured environment state. |
| Public viewer | Authorized anonymous read access through an explicit public ACL row, not a fallback guest identity. |

The display string is never the authority. Display names, emails, avatars, and
labels are projections from authenticated/host-owned facts. Access scope and
capability projections are also advisory for rendering only; enforcement stays
in the host, room, or daemon authority.

A runtime operator projects to a runtime-kind actor when it is visible in the
UI. `runtime_peer` should not become a value in `NotebookShellAccessLevel`;
model it as a separate capability and actor kind because runtime peers author
execution lifecycle/output state, not notebook structure, sharing, or package
management.

## Target Roles and Scenarios

Elements and production host adapters should cover these states first:

| Scenario | Expected shared surface behavior |
|----------|----------------------------------|
| Desktop local owner | Shows local identity, editable notebook controls, executable runtime, and manageable packages when daemon state allows. |
| Desktop read-only file | Shows local identity, readable notebook state, disabled edit affordances, and environment facts that remain safe to inspect. |
| Desktop remote room | Shows desktop app plus local daemon/socket identity connecting to a remote service with a stored API key or credential, without treating cloud browser auth as the only remote identity model. |
| Cloud public viewer | Shows public viewer access, read-only controls, no collaborator identity leakage, and package/runtime facts safe for public notebooks. |
| Cloud authenticated editor | Shows signed-in identity, editor affordances allowed by ACL-derived capabilities, and gated sharing/package/runtime controls. |
| Cloud owner | Shows owner identity, sharing management, and the same notebook cells/header/rail as desktop. |
| Delegated agent | Shows the agent as the acting operator and the human subject it acts for; attribution should not collapse to a generic model selector. |
| One principal, multiple operators | Shows a human principal with multiple active operators, such as desktop plus an agent, without merging away operator-specific attribution. |
| Mixed-IdP room | Shows collaborators from multiple identity providers using display metadata without making provider-specific UI forks. |
| Credential needs attention | Shows expired, missing, or invalid auth as an attention state without implying the notebook content or local runtime is broken. |
| Runtime unavailable | Shows why execution is unavailable without implying the notebook itself is broken. |
| Runtime peer | Shows runtime attribution for execution/output state without granting notebook-editing affordances. |
| Untrusted dependencies | Shows dependency trust attention near package/runtime controls without making the shared UI mutate trust directly. |

## Requirements

### Identity and Agency

1. Shared UI consumes a structured actor projection. It must not parse raw
   Automerge actor labels as its only source of truth.
2. Raw actor-label parsing is transitional compatibility input for current
   adapters only. The target projection carries principal, operator,
   on-behalf-of, and display metadata as structured host-owned facts.
3. The actor projection must distinguish human, local, public, agent, runtime,
   system, and unknown actors.
4. Delegated agent UI must show both sides of the relationship, for example
   "Codex on behalf of Kyle". An agent avatar or icon can follow the visual
   pattern of model-selector components, but the semantic source is notebook
   actor state.
5. Public viewers render as public viewer state, not as collaborators. Anonymous
   public sessions should not expose per-user identity unless product later
   defines a separate public-presence policy.
6. Execution attribution, presence, and cell edit attribution should use the
   same actor projection so they do not disagree about who acted.

### Access and Capabilities

1. Host adapters derive `NotebookShellCapabilities` from the relevant authority:
   local file/runtime state for desktop, hosted ACL/auth state for cloud, and
   fixtures for Elements.
2. Shared components may hide or disable controls from capabilities, but write
   paths still must enforce authorization in the host/room/daemon layer.
3. `canRequestEdit` remains distinct from edit permission. It is a sign-in or
   request-access affordance, not a write grant.
4. Cloud and desktop should feed the same header, rail, identity, and package
   components whenever they are expressing the same notebook state.
5. Runtime-peer authority should not be collapsed into editor or owner UI.
   Runtime-peer capability is about lifecycle/output authorship, not notebook
   structure edits or ACL management.
6. Desktop remote rooms should use the same capability projection as cloud
   rooms while preserving their separate identity path: desktop app, local
   daemon/socket identity, and remote service credential or API key.

### Environment and Packages

1. Shared UI consumes an environment projection with runtime status, package
   summary, dependency source, sync status, trust status, and package-management
   capability.
2. Package metadata can be visible even when package mutation is unavailable.
   This matters for public notebooks, cloud editors, read-only local files, and
   runtime-unavailable states.
3. Trust state is host/daemon-owned. Shared UI can show attention, warnings, and
   action slots, but it should not directly rewrite dependency trust metadata.
4. Captured environment lifecycle actions remain daemon-owned. UI language
   should talk about declared dependencies, rebuild, refresh defaults, and
   runtime availability rather than internal cache hashes or `env_id`.
5. Sift/parquet/Arrow renderer examples belong with output-renderer fixtures;
   the environment summary should link package/runtime context without owning
   output transport.

### Elements Catalog

1. Elements should render the production nteract identity and environment
   components with fixture projections.
2. Elements scenarios should include at least: local owner, public viewer, cloud
   editor, cloud owner, delegated agent, runtime unavailable, read-only local,
   desktop remote room, one-principal/multiple-operator, mixed-IdP,
   credential-attention, runtime peer, and untrusted dependencies.
3. Elements must remain runtime-free: no daemon, sync, generated WASM,
   iframe-host, Cloudflare, auth-provider, or local filesystem side effects.
4. Elements should document the source boundary for every surface: which facts
   come from host adapters, which belong in shared view models, and which stay
   in product-specific control slots.
5. Current Elements visuals, including the surfaces introduced around #3240,
   are illustrative scenario chrome. They should validate semantics and
   component composition, not freeze final production appearance.

## Shared Surface Projection

This is a product contract, not a final TypeScript API. Implementation can land
incrementally, but adapter props should move toward these shapes.

```ts
type NotebookActorKind =
  | "human"
  | "local"
  | "public"
  | "agent"
  | "runtime"
  | "system"
  | "unknown";

interface NotebookActorSurface {
  id: string;
  kind: NotebookActorKind;
  label: string;
  detail: string | null;
  imageUrl?: string | null;
  status?: "active" | "attention" | "idle" | "offline";
  principalLabel?: string | null;
  operatorLabel?: string | null;
  onBehalfOf?: {
    label: string;
    imageUrl?: string | null;
  } | null;
}

interface NotebookEnvironmentSurface {
  runtimeLabel: string;
  runtimeStatus: "ready" | "detached" | "unavailable" | "launching" | "error";
  packageSummary: string;
  packageSourceLabel: string | null;
  packageSyncLabel: string | null;
  trustLabel: string | null;
  trustStatus: "trusted" | "untrusted" | "attention" | "unknown";
  canViewPackages: boolean;
  canManagePackages: boolean;
  canExecute: boolean;
}
```

Short-term code can keep the smaller existing `NotebookActorIdentity` and
`NotebookEnvironmentSummary` props, but new host adapter work should avoid
adding more page-local strings that cannot map into the structured projection.
The projection uses `imageUrl` to stay aligned with the existing
`NotebookActorIdentity` field name.

## Placement

| Surface | Placement |
|---------|-----------|
| Current actor | Notebook header identity group and presence slots. |
| Delegated agent | Header identity badge, cell attribution, and activity/presence surfaces. |
| Access scope | Header/share/edit affordances and read-only notices. |
| Runtime state | Header runtime controls, rail package/environment panel, and execution controls. |
| Package state | Rail package/environment panel and future package management drawer. |
| Trust state | Package/environment panel and runtime launch affordance. |
| Public viewer state | Header identity/access area and share controls for owners. |

## Acceptance Criteria

1. Elements has fixture scenarios for every role listed in this PRD.
2. Desktop and cloud pass identity, access, and environment facts through shared
   shell props or shared view-model projections instead of duplicating component
   logic.
3. `NotebookIdentityBadge`, `NotebookIdentityGroup`, and
   `NotebookEnvironmentSummary` can render the cloud owner, public viewer,
   delegated agent, local owner, desktop remote room, read-only,
   credential-attention, mixed-IdP, runtime-unavailable, runtime-peer, and
   untrusted states without host imports.
4. Code-cell current-line, execution attribution, and presence can be pointed at
   the same actor projection.
5. The hosted public viewer path does not display anonymous viewers as named
   collaborators, and public viewer presence remains connection-local or
   aggregate-only until a separate public-presence policy changes it.
6. Shared components stay presentational. Auth, ACL mutation, trust mutation,
   package install, runtime launch, and file-system writes stay in host
   adapters or daemon/room authorities.

## Suggested Work Slices

1. Expand the Elements scenario layer to include read-only local, desktop
   remote room, credential-attention, mixed-IdP, one-principal/multiple-operator,
   runtime peer, and untrusted dependency fixtures.
2. Extend the shared actor projection to represent runtime and system actors
   without parsing demo-only agent labels.
3. Teach desktop and cloud adapters to map their current facts into the shared
   identity/environment projection.
4. Move package/environment rail content onto `NotebookEnvironmentSummary` or a
   sibling shared component.
5. Connect execution/cell attribution to the shared actor projection.
6. Revisit this PRD and split out an ADR only when a durable code-level boundary
   needs acceptance, such as the final TypeScript projection API or a runtime
   peer capability extension.

## Open Questions

1. Which actor fields should be persisted in room activity/audit events versus
   derived only for UI display?
2. Should public viewer presence remain completely local, aggregate-only, or
   eventually become full cursor/cell presence?
3. Where should package/environment actions live when the rail is collapsed:
   header slot, rail popover, or dedicated drawer?
