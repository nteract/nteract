# Notebook Host Shell Convergence

**Status:** Draft, 2026-05-30.

## Context

nteract now has multiple notebook hosts:

- the desktop app, backed by local files, Tauri commands, and the local daemon;
- the hosted cloud viewer/editor, backed by OIDC, hosted ACLs, object storage,
  and a durable room host;
- the elements catalog, which needs deterministic fixture hosts for design and
  component review.

Those hosts need different platform adapters, but they should not grow separate
notebook UIs. Cloud-specific markdown cells, outline navigation, presence UI,
package panels, and output frames have already shown the cost of divergence:
prototype fixes improve one host while desktop and elements keep different
behavior.

At the same time, permissions are not cloud-only. A desktop notebook can be
read-only because the file is not writable. A future desktop session can open a
hosted notebook and receive cloud ACLs. A hosted anonymous user can view but not
edit. These are the same product question: what can this host do with this
document right now?

## Decision

The shared notebook surface is the notebook document shell plus host-neutral
view-model and capability inputs.

```text
NotebookDocumentShell
  rail
  document stage
  NotebookDocumentHeader control slots
  NotebookToolbarFrame / NotebookCommandToolbar
  notice slots
  package/runtime/presence slots

NotebookShellCapabilities
  access
    level
    source
    actor
  auth
    canSignIn
    needsAttention
  runtime
    canWriteRuntimeState
    actor
  interaction
    selectedMode
    activeMode
    state
    canRequestEdit
  canRead
  canEditMarkdown
  canEditCells
  canEditStructure
  canRequestEdit
  canExecute
  canToggleCode
  canViewPackages
  canManagePackages
  canManageSharing
```

Desktop, cloud, and elements are hosts around that shell:

```text
desktop host adapter -> shared shell <- cloud host adapter
elements fixture host -> shared shell
```

The shell must stay free of platform side effects. It should not import Tauri,
Cloudflare, OIDC, generated WASM transport, room-host APIs, local filesystem
commands, or catalog routing. Those remain host adapters.

## Application-Level Notebook Catalogs

A notebook catalog exists before a notebook document is selected, so it is not
part of `NotebookDocumentShell`, its rail, or its toolbar. Local notebook
discovery, hosted catalog queries, cloud host configuration, credentials, and
the choice of where to open a hosted locator are application-level host chrome.

Desktop may eventually expose a separate singleton window, provisionally
called Notebook Home, that composes local recent or open-notebook facts with
hosted catalog rows grouped by configured origin. The exact product name,
filesystem discovery model, layout, discoverability, and default open action
remain product decisions. In particular, this ADR does not imply a
filesystem-wide notebook index or choose between opening a hosted notebook on
the web and opening it in a Desktop notebook window.

The Desktop capability may land headlessly before that UI. Its host adapter can
offer typed operations to list configured hosts, list notebooks for one
explicitly selected host, and open a hosted locator without a visible page or
menu entry. Hosted notebook identity at this boundary is the pair
`(normalized origin, notebook id)`, never the notebook id alone.

The hosted browser `/n` page and a future Desktop Notebook Home are separate
host adapters over common catalog concepts. Desktop must not depend on the
browser page's routing, cookies, `localStorage`, `window.location`, or
module-singleton stores. The two hosts may share typed DTOs, pure projections,
and host-neutral presentation components. Catalog, authentication, routing,
and host-configuration facts remain host-owned API state, not Automerge
document state or notebook-shell state.

The shared view model owns host-neutral projections:

- cell order, cell types, source text, outputs, and execution counts;
- outline items and selected outline state;
- canonical cell anchors based on `notebookCellAnchorId`;
- traceback navigation targets;
- package/runtime status projections once those are extracted.

The shared component surface should be the preferred place for:

- notebook rail and outline behavior;
- document header layout and capability-scoped control slots;
- shared command toolbar chrome, toolbar identity, and interaction-mode
  presentation;
- markdown editing and preview rendering;
- read-only and editable cell chrome;
- output frame policy and widget-state rendering;
- package and runtime controls;
- presence display primitives;
- auth and capability affordances that are not tied to a specific provider.

## Capability Semantics

Capabilities are not "cloud auth flags." They are the common answer to what the
current host and document allow.

Examples:

- a local writable file can edit markdown and execute if the daemon is ready;
- a local read-only file can read and execute only if the host intentionally
  supports scratch execution without saving;
- an anonymous hosted user can read public notebooks but cannot edit;
- an authenticated hosted user can edit only when the room ACL grants editor or
  owner scope;
- a desktop client opening a hosted notebook should consume the same hosted ACL
  projection rather than inventing a desktop-only permission model.

The room or document authority should provide the source facts. Host adapters
translate those facts into `NotebookShellCapabilities`.

`NotebookShellCapabilities.access.level` is document UI access only:
`none | viewer | editor | owner`. Room-level `runtime_peer` is modeled through
`NotebookShellCapabilities.runtime.canWriteRuntimeState` and a runtime actor
projection, not by adding another document access level. This keeps runtime
output/lifecycle authorship separate from editing, package management, and
sharing controls.

Actor labels remain durable attribution keys, but shared UI should consume
structured actor projections when hosts can provide them. Raw label parsing in
React is a compatibility fallback while desktop, cloud, and Elements converge on
principal/operator projections.

`canRequestEdit` is distinct from `canEditCells`. A host can show an edit
request/sign-in affordance before the room grants editor access. The write path
must still check `canEditMarkdown`/`canEditCells` and the room's authorization
policy before mutating Automerge.

`NotebookInteractionModeProjection` separates what the user selected from what
the host can actively perform. `selectedMode = "edit"` with
`state = "requested"` is an edit request or sign-in/request-access state, not a
write grant. `activeMode = "edit"` and the `canEdit*` booleans are still
display affordances; room, daemon, and filesystem authorities enforce the write
path.

`NotebookDocumentHeader` owns shared slot visibility for document-level
controls:

- runtime controls render when execution or package viewing is available;
- code controls render when the host can toggle source visibility;
- sharing controls render only when the host can manage sharing;
- edit controls render only when the host can request edit access;
- auth controls render when sign-in, signed-in identity, or auth attention is
  relevant.

The controls themselves can stay host-specific while the visibility policy stays
in the shared shell contract.

The split should be explicit in code review. If a branch needs a new notebook
presentation pattern for cloud, first ask whether desktop and Elements should
consume the same component. If a branch needs a new desktop control, first ask
whether cloud should receive the same typed projection and provide different
callbacks. Divergence is justified for authority and side effects, not for
duplicating notebook chrome.

### Case study: outline interaction wiring (2026-06)

The 2026-06 outline iteration (#3553–#3564) showed a subtler divergence mode
than duplicated components: **shared components, unshared wiring.** The outline
data model, rail panel, and rail wrapper were all shared and both hosts shipped
the new rendering — but the *interaction* layer (scroll-synced active item,
outline↔focused-cell selection coupling, execution status labels via
`getOutlineStatusLabel`) lived as ~150 lines of hooks and callbacks inside
`apps/notebook/src/App.tsx`. Cloud rendered the same rail with a thinner prop
set and read as "the old outline," even though its deployed bundle contained
all the new shared code.

The lesson extends the decision above: a shared component whose behavior
depends on host-side hooks is only half-shared. When iterating on a shared
surface, interaction state machines (scroll observers, selection coupling,
status projection) belong next to the component — as shared hooks with
host-neutral inputs — not in a host shell. Optional props on a shared
component (`activeOutlineItemId?`, `outlineCellIds?`) are a divergence smell:
each optional interaction prop is a behavior one host will silently lack.

Intentional asymmetries still exist and should be recorded rather than
"fixed": e.g. desktop currently does not render the workstations rail panel
while remote-compute UX evolves on hosted first (`workstationsPanel` stays an
optional slot by design). The test for "is this divergence intentional?" is
whether someone can point to a product reason, not whether the code happens
to compile on both hosts.

## Anchor And Navigation Contract

Every rendered notebook cell surface that participates in outline or traceback
navigation exposes the canonical cell anchor:

```text
id = notebookCellAnchorId(cellId)
data-cell-id = cellId
```

Hosts may choose different URL hash behavior for headings, but they should not
need different DOM lookup strategies. Desktop currently keeps heading outline
navigation at the cell anchor for compatibility with its notebook viewport.
Hosted pages keep heading hrefs in the browser URL because public links should
be deep-linkable to markdown headings. Both scroll through the same shared
outline navigation helper.

## Elements Catalog

The elements catalog should pressure-test the same host shape with deterministic
fixtures instead of page-local component mocks.

Recommended fixture scenarios:

- desktop writable notebook;
- desktop read-only notebook;
- desktop remote room with local daemon/socket identity plus remote credential;
- cloud public viewer;
- cloud authenticated editor;
- cloud owner;
- delegated agent for a human principal;
- one principal with multiple operators;
- mixed-IdP room;
- credential attention;
- runtime peer;
- runtime unavailable;
- package management unavailable;
- untrusted dependencies;
- output frame domains allowed or blocked.

Catalog pages should render `NotebookDocumentShell`, `NotebookDocumentRail`,
`NotebookDocumentHeader`, and `NotebookCellList` through those fixtures when
they need notebook-level context. Lower-level fixtures remain useful for
isolated component tests, but they should not become a second app model.

When a catalog page needs toolbar or header context, it should use
`NotebookDocumentHeader`, `NotebookToolbarFrame`, `NotebookCommandToolbar`, and
`NotebookToolbarIdentity` with fixture capabilities rather than inventing
page-local visibility rules. This keeps the catalog useful as an early warning
when shared shell controls are still coupled to desktop or cloud specifics.

## Consequences

- New cloud notebook UI should be justified as host adapter UI, not as another
  cell/editor/output implementation.
- Desktop cloud operations enter through `@nteract/notebook-host` and its Tauri
  implementation rather than direct platform imports in React.
- Visible Notebook Home work is app chrome and should be reviewed independently
  from shared notebook presentation.
- Catalog projections preserve normalized host origin as part of notebook
  identity even when a UI groups local and hosted rows together.
- Shared components should receive host capabilities and callbacks instead of
  importing host state directly.
- Desktop should adopt the same capability vocabulary for local read/write,
  runtime, package, and future hosted-file states.
- Hosted ACL work should feed the common capability model, including read-only
  package details and non-editable notebook surfaces.
- Future convergence work should move materialization and projections into
  shared view-model code before adding new cloud-specific props.

## Rejected Alternatives

### Keep cloud as a separate notebook UI

Rejected. It makes the hosted app faster to prototype, but every improvement to
markdown editing, outline scrolling, output rendering, presence, and package UI
then has to be rediscovered or reimplemented.

### Put platform behavior into NotebookDocumentShell

Rejected. The shell becomes impossible to reuse in elements, desktop, and hosted
flows if it owns Tauri commands, OIDC refresh, Cloudflare routing, or local
daemon side effects.

### Put notebook discovery and catalogs in NotebookDocumentShell

Rejected. Catalogs precede document selection and combine host-owned local and
remote sources. They belong to application chrome, not the open document's
rail, toolbar, or capability model.

### Reuse the hosted browser dashboard as the Desktop portal

Rejected. The hosted dashboard's authentication, routing, storage, and
lifecycle assumptions belong to its browser host. Desktop should reuse only
host-neutral contracts, projections, and presentation components.

### Treat ACLs as hosted-only

Rejected. Read, write, execute, package, and share capabilities also describe
local files and future desktop-hosted notebooks. ACLs are one source of those
facts, not a separate UI model.
