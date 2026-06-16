# Hosted Markdown Documents

**Status:** PRD draft, 2026-06-15.

**Owners:** Markdown document surface, Cloud/Auth, Desktop document hosting,
shared editor/projection UI.

This PRD defines the first-class Markdown document product surface for nteract.
It promotes the product-facing parts of
`docs/memos/markdown-plan-documents.md` into requirements while leaving low-level
sync and storage decisions to ADRs and implementation plans.

Related docs:

- `docs/memos/markdown-plan-documents.md`
- `docs/adr/identity-and-trust.md`
- `docs/adr/hosted-room-authorization.md`
- `docs/adr/hosted-output-origin-isolation.md`
- `docs/adr/notebook-comments-document.md`
- `docs/plans/notebook-surface-library-refactor-checklist.md`

Prototype and shared component surfaces:

- `src/lib/markdown-projection.ts`
- `src/components/markdown/ProjectedMarkdownView.tsx`
- `src/components/markdown/markdown-typography.ts`
- `src/components/editor/codemirror-editor.tsx`
- `apps/elements/content/docs/markdown-typography.mdx`

## Problem

nteract notebooks are live, executable documents with explicit runtime state.
That is the right model for code, outputs, widgets, kernels, and workstations,
but it is too much surface area for calm long-form Markdown authoring.

Users and agents also need documents that do not require compute:

- product and architecture notes;
- ADR drafts and implementation plans;
- collaborative prose with comments, outline, and source-aware review;
- published read-only pages with stable links;
- eventually, explicit output snapshots or component regions that are attached
  artifacts rather than live execution.

If Markdown documents are implemented as notebooks with one giant Markdown cell,
the product inherits cell chrome, runtime affordances, notebook-specific
presence targets, and runtime state confusion. If Cloud implements Markdown as a
private route and Desktop stays notebook-only, nteract grows a second document
protocol. The product needs a first-class document kind with shared source,
projection, editor, and authorization concepts across Cloud and Desktop.

## Goals

1. Create a first-class Markdown document surface that does not imply kernels,
   workstations, package management, or execution.
2. Let Cloud users create, list, open, edit, share, and publish Markdown
   documents with OIDC-backed identity and hosted ACLs.
3. Let Desktop grow the same surface for local `.md` files, using the same
   document model and shared React/projection code rather than a separate app
   protocol.
4. Reuse existing Markdown projection, typography, CodeMirror editor, outline,
   presence, and security primitives where they fit.
5. Preserve raw HTML and MDX safety boundaries by treating unapproved regions as
   isolated or inert.
6. Leave room for future comments, source-range review, output artifacts,
   component artifacts, and MCP authoring tools without overbuilding them in
   the first slice.

## Non-Goals

- This PRD does not make Markdown executable.
- This PRD does not replace notebooks or turn notebooks into Markdown files.
- This PRD does not enable arbitrary MDX JavaScript execution in the host app.
- This PRD does not require all notebook sharing, publishing, or room protocol
  code to become generic in the first PR.
- This PRD does not require a separate repository or separately packaged app
  before the document model is proven.
- This PRD does not define the final comments protocol. It only requires that
  document anchors and source ranges are compatible with a future comments
  document.

## Product Language

| Term | Meaning |
|------|---------|
| Markdown document | A first-class nteract document whose source of truth is Markdown text plus document metadata and optional artifact references. |
| MarkdownDoc | The shared logical document model for Markdown source, metadata, artifact references, and future comments identity. |
| View mode | A zen reading view derived from Markdown projection. It has no cell rows and no runtime controls. |
| Edit mode | A CodeMirror-backed Markdown editor for the same document body. |
| Outline | A projection of headings from the current Markdown body. |
| Published revision | A stable, read-only hosted snapshot of a Markdown document. |
| Artifact reference | A durable reference from Markdown source or metadata to an attached output, component, image, or asset. |

## Target Scenarios

| Scenario | Expected behavior |
|----------|-------------------|
| Cloud owner creates a doc | Owner opens the hosted dashboard, creates a Markdown document, edits Markdown text, sees view mode and outline update, and can rename/share/publish without compute UI. |
| Cloud editor | Editor can open an invited Markdown document, edit body/title if allowed, and see the same projected view mode. |
| Cloud viewer | Viewer can read the rendered document and inspect safe source where product allows, but cannot mutate body, sharing, or publish state. |
| Public published reader | Anonymous or signed-out reader can view only explicitly published/public content. Private body, comments, and collaborator identity do not leak through metadata. |
| Desktop local author | User opens a `.md` file and gets the same edit/view/outline shell, backed by local file sync rather than hosted ACLs. |
| Agent collaborator | An authorized local or hosted agent can read and update Markdown source through the same document model as the UI, with principal/operator attribution when available. |

## Requirements

### Document Model

1. Markdown documents must be first-class documents, not hidden notebooks.
2. The logical source of truth is `MarkdownDoc.body`, an Automerge text value.
   Frontmatter remains Markdown source when present.
3. `MarkdownDoc` carries document metadata such as title and optional sidecar
   identifiers. Derived facts such as headings and outline are projections, not
   stored UI state.
4. The shared model must be usable by both hosted Cloud documents and Desktop
   `.md` files.
5. Markdown body must be Automerge-backed. Hosted catalog rows may store
   searchable summaries, titles, ACLs, and published revision metadata, but the
   live body is not a D1 text column pretending to be collaborative state.
6. Live body writes use text splices:
   `splice_body(index, delete_count, text)`. Projection and export read the
   current body through `body()` or `slice_body(start, end)`. Whole-body
   replacement is import/bootstrap sugar only, not the steady-state editor
   synchronization primitive.
7. Exactly one authority creates the root MarkdownDoc structure for a document.
   Other peers bootstrap an empty handle, receive the structure through
   Automerge sync, then apply splices. This keeps document lineage meaningful
   and avoids duplicate root object creation.
8. A Desktop implementation must be able to map a canonical `.md` path to a
   document room or equivalent live document session without treating the file
   as `.ipynb`.

### Editing And Rendering

1. Edit mode uses the shared CodeMirror editor stack and Markdown language
   support.
2. View mode uses the shared Markdown projection and
   `ProjectedMarkdownView` typography where host-safe.
3. Edit and view modes operate on the same body value. Switching modes
   must not remount the entire app shell unnecessarily.
4. Edits from CodeMirror are translated into MarkdownDoc body splices,
   matching the existing notebook source-edit path. The UI must not diff and
   replace the entire body on each keystroke.
5. The outline is derived from projected headings and updates when the body
   changes.
6. The UI must remain useful at wide desktop, half-width desktop, tablet, and
   mobile widths.
7. The surface must not show runtime, workstation, kernel, dependency, run,
   interrupt, restart, or output-clearing controls.

### Cloud Hosting

1. Cloud provides authenticated create/list/open routes for Markdown documents
   under `/m`. `/n` remains the notebook route family.
2. Cloud ACLs support owner, editor, and viewer scopes for Markdown documents.
   Markdown documents do not have a `runtime_peer` scope.
3. Owner can share a Markdown document with another principal through the same
   identity/profile principles used by hosted notebooks.
4. Owner can publish a read-only revision when publish is implemented for the
   slice. Public access must be represented explicitly, not by falling through
   to anonymous access.
5. Dashboard and navigation should make Markdown documents visually distinct
   from notebooks while preserving a coherent nteract document home.
6. Private documents must not leak body content through public OG metadata,
   screenshots, or unauthenticated route bootstrap data.

### Desktop Local Files

1. Desktop should be able to open `.md` files through a dedicated Markdown
   document path, not by importing them into notebook cells by default.
2. The local file path is the persistence anchor. External file changes should
   be imported as document changes when safe.
3. Saving writes Markdown body back to the `.md` file without adding notebook
   metadata unless the user explicitly exports to another format.
4. Desktop and Cloud should share editor, projection, outline, and rendered view
   components. Host adapters own filesystem or hosted side effects.
5. Desktop does not need hosted ACL or publish UI for local-only files, but the
   same document model should allow future remote sync.

### Security

1. Raw HTML, MDX, and component-like regions are preserved but not host-executed
   unless an approved component registry or isolated renderer exists.
2. Rendered Markdown must not read app credentials, localStorage tokens,
   cookies, or hosted room credentials.
3. Public documents expose only explicitly public body/revision data.
4. Agent and MCP write paths must use the same authorization model as UI edits.
5. Artifact references must be explicit and content-addressed or otherwise
   authority-checked before rendering private assets.

### Future Comments And Artifacts

1. Projection must preserve enough source positions and stable block anchors for
   future comments on source ranges, headings, projected blocks, artifacts, and
   components.
2. Output snapshots are attached artifacts, not live execution. A code block may
   later reference an output artifact with explicit metadata.
3. Component artifacts and MDX-like regions remain future work until the
   registry and sandbox model are defined.

## Launch Criteria For First Usable Slice

1. A user can create a hosted Markdown document from the app.
2. A user can open the document, edit Markdown source, and see rendered view and
   outline update.
3. The document can be listed from a hosted document home or dashboard.
4. An owner can grant at least viewer/editor access to another authenticated
   principal, or the PR explicitly records the missing share slice as blocked by
   existing sharing abstractions.
5. The UI has no runtime/workstation/kernel affordances.
6. The shared source/projection/editor pieces are used in a way Desktop can
   consume for `.md` files.
7. Focused route/projection tests and at least one browser smoke cover
   create/open/edit/render behavior.

## Open Questions

1. How should Desktop resolve conflicts when an open `.md` file changes on
   disk while the user is editing?
2. Should comments become a generic `DocumentCommentsDoc`, or should Markdown
   add a sibling comments document while notebook comments remain notebook
   named?
