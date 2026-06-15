# Hosted Markdown Documents Implementation Plan

- Status: Implementation plan, 2026-06-15.
- Product: [Hosted Markdown Documents](../prd/hosted-markdown-documents.md)
- Seed memo: [Markdown Plan Documents](../memos/markdown-plan-documents.md)

This plan scopes the first first-class Markdown document slice. It keeps Cloud
and Desktop aligned by introducing a shared Markdown document model and shared
projection/editor shell before the hosted route becomes product surface.

## Goal

Ship a usable hosted Markdown document prototype that can create, open, edit,
render, outline, share, and publish Markdown without compute, while preserving a
Desktop path for local `.md` files through the same model and UI primitives.

## Architecture Posture

Markdown documents are not notebooks. They get a separate document identity and
surface:

```text
MarkdownDoc
  id
  title
  body
  metadata
  artifact_refs
  comments_doc_id?
```

The live body must be Automerge-backed from the start. D1 may hold catalog,
ACLs, searchable summaries, titles, and published revision metadata, but it must
not be the live collaborative body store. Code should keep body/title/access
operations behind shared `MarkdownDoc` types and host adapters so Desktop can
add a file-backed session without rewriting the UI.

Body mutation uses the same terms as notebook source text:

```text
write: splice_body(index, delete_count, text)
read:  body() / slice_body(start, end)
```

Whole-body update is import/bootstrap sugar only. The steady-state editor bridge
must send ordered text splices from CodeMirror into Automerge and project reads
from the current body. Exactly one authority creates the root MarkdownDoc
structure; peers bootstrap empty, sync the structure in, and then write splices.

Use the existing local-first loading lesson for browser clients: hydrate from a
local IndexedDB save first when available, paint the document from that local
copy, then catch up over sync. Hosted catalog/API fetches are for identity,
ACLs, revision metadata, and room bootstrap; they should not be the only path to
render existing body content after the first visit.

Cloud owns OIDC, ACL rows, publish storage, and hosted routing. Desktop owns
filesystem, local window commands, and `.md` file watching. Shared code owns
Markdown projection, source/rendered view state, outline projection, editor
composition, and security defaults for rendered Markdown.

## Phase 0: Product And Boundary Docs

- [x] Create this implementation plan.
- [x] Add the hosted Markdown PRD.
- [x] Update docs indexes.
- [ ] Record nonblocking follow-ups in `.context/hosted-markdown-documents.md`.

## Phase 1: Shared Markdown Document Surface

Files are tentative and may change during implementation.

- [ ] Add shared TypeScript model/projection helpers, likely under
      `src/components/markdown-document/` or `src/lib/markdown-document.ts`.
- [ ] Add shared Rust/WASM `MarkdownDoc` body operations:
      `splice_body`, `slice_body`, `body`, save/load, and actor-safe
      constructors.
- [ ] Add or reuse browser persistence around the MarkdownDoc save bytes so
      repeat visits can hydrate from IndexedDB before live sync catches up.
- [ ] Define `MarkdownDocumentSnapshot`, `MarkdownDocumentAccessLevel`, and
      route/view projections without importing Cloud or Tauri APIs.
- [ ] Add a pure projection helper that takes body/title/access and returns:
      rendered projection plan, outline items, editability, publish state, and
      unsafe-region summary.
- [ ] Add focused Vitest coverage for title/body/outline/access projection.
- [ ] Confirm Desktop can import these helpers without importing
      `apps/notebook-cloud`.

Acceptance:

- Rust/WASM tests prove body splices and save/load round trips.
- Browser-side plan or code hydrates MarkdownDoc from IndexedDB before sync for
  repeat visits.
- Shared helpers compile in the main frontend package.
- Tests prove outline/render projection updates from body changes.
- No runtime/workstation/kernel types appear in Markdown document projection.

## Phase 2: Cloud Storage And API

Add hosted catalog storage in `apps/notebook-cloud/src/storage.ts`, Automerge
body sync/storage, and route handlers in `apps/notebook-cloud/src/index.ts`.

Initial catalog tables are Markdown-specific to keep the first slice narrow:

```sql
markdown_documents(id, owner_principal, title, body_doc_id, created_at, updated_at, ...)
markdown_document_acl(document_id, subject_kind, subject, scope, ...)
markdown_document_revisions(id, document_id, title, body_doc_hash, snapshot_key, ...)
```

Use Markdown-specific tables for v0. They avoid coupling the first Markdown
document slice to a generic document-catalog migration before the document model
is proven. A later migration can promote notebook and Markdown catalogs into a
shared `documents` table once both products have stable revision and publish
semantics.

Expected routes:

- [ ] `GET /m` serves the markdown document home shell.
- [ ] `GET /m/:documentId/:slug?` serves a markdown document shell.
- [ ] `GET /api/m` lists Markdown documents visible to the current principal.
- [ ] `POST /api/m` creates a document and owner ACL row.
- [ ] `GET /api/m/:documentId` returns authorized document catalog/title/access
      plus the body sync endpoint/bootstrap needed by the client.
- [ ] Body edits sync through the MarkdownDoc Automerge channel for editor/owner
      as text splices.
- [ ] `POST /api/m/:documentId/publish` creates a published revision if the
      first slice reaches publish.
- [ ] Share routes either reuse hosted sharing helpers or record a scoped
      follow-up if notebook-specific sharing abstractions need refactoring.

Acceptance:

- Owner/editor/viewer authorization is enforced server-side.
- Body state is Automerge-backed, not a D1 text column.
- Anonymous access only works through explicit public/published state.
- Worker route tests cover create/list/open/edit authorization.

## Phase 3: Cloud Markdown UI

Add a Cloud route that reuses shared Markdown document components.

- [ ] Extend cloud viewer route detection for `/m` and `/m/:id`.
- [ ] Add a Markdown document home/list view or integrate a document tab into
      the existing dashboard without making notebooks and Markdown documents
      visually indistinguishable.
- [ ] Add the editor/reader route:
      - title line and dashboard navigation;
      - rendered view;
      - source edit mode;
      - outline rail;
      - share/publish affordances where API support exists;
      - no compute UI.
- [ ] Handle loading, not-found, no-access, read-only, save-pending, and save
      failed states.
- [ ] Verify wide, half-width, and mobile screenshots.

Acceptance:

- A signed-in user can create/open/edit/read a Markdown document on preview.
- The rendered view and outline update from source edits.
- Viewers cannot mutate the body.
- Runtime/workstation/kernel controls are absent.

## Phase 4: Desktop Compatibility Slice

This phase may be a follow-up PR if the hosted slice is already large, but the
first PR should leave code boundaries ready for it.

- [ ] Add a CLI/opening plan for `.md` paths, likely through `runt open`.
- [ ] Add a Desktop route or mode that mounts the shared Markdown document
      surface for local `.md` files.
- [ ] Add a daemon/file-backed adapter that loads body from disk and saves body
      back to disk.
- [ ] Add a file watcher conflict policy note or ADR before automatic
      bidirectional sync ships.

Acceptance:

- Desktop code consumes shared Markdown document projection/editor helpers.
- No hosted ACL or Cloud route imports are required for local `.md` rendering.
- Any unimplemented Desktop behavior is explicitly tracked, not hidden behind a
  Cloud-only API.

## Phase 5: Comments, Artifacts, And Agents

These are not required for the first usable route.

- [ ] Generalize comments locators from notebook/cell to document/source/block.
- [ ] Parse `<!-- nteract:output ... -->` style artifact references into the
      Markdown projection schema.
- [ ] Add safe rendered placeholders for attached output and component
      artifacts.
- [ ] Sketch MCP tools for create/get/update/publish Markdown documents only
      after the UI/API path works.

## Validation

Run the narrowest relevant checks while iterating:

```bash
pnpm test:run src/lib/__tests__/markdown-projection.test.ts
pnpm --dir apps/notebook-cloud test
pnpm --dir apps/notebook-cloud typecheck
pnpm --dir apps/notebook-cloud build:viewer
cargo xtask lint --fix
```

Browser checks:

- create a hosted Markdown document;
- edit source and confirm rendered text/outline updates;
- reload and confirm body persists;
- open as viewer and confirm edit controls are unavailable;
- inspect narrow and mobile screenshots.

## Follow-Up Decisions

- Whether comments become `DocumentCommentsDoc` or a Markdown-specific sibling.
- Whether `/m` remains the permanent product route after a broader document
  dashboard exists. For v0, `/m` is the Markdown document route family and `/n`
  remains notebooks.
