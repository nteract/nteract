# CommentsDoc Agent Notes

`comments-doc` owns the durable per-notebook CommentsDoc model. It is not
runtime state, widget state, output transport, or execution transport.

- `comments_doc_id` is required identity for every materialized CommentsDoc.
  A missing id is a resolver/seeding failure, not optional comments state.
- Client-authored comment content may be pending and local-first, but
  policy-bearing fields (`authority_mutation_state`, `authority_status`,
  `authority_created_by_*`, `authority_resolved_by_*`, delete/archive fields,
  and authority markers) are trusted only when the visible field winner was
  authored by a comments authority actor.
- Actor ids are not authentication. The sync ingress layer that accepts
  `COMMENTS_DOC_SYNC` must bind connection identity to allowed authority actor
  ids before applying changes. This crate only projects trust from Automerge
  actor ids already admitted into the document.
- Do not copy `CommsDoc` authorization policy. Runtime peers may participate in
  widget state, but they must not create, edit, resolve, reopen, delete, or
  authority-finalize comments.
- Keep optimistic comments inside Automerge. Do not add a parallel optimistic
  store.
- Comments outlast runtime state. Do not route comment persistence through
  `RuntimeStateDoc`.
- The thread/message/authority/projection machinery is document-agnostic; only
  `CommentAnchor` and `NotebookCommentRef` carry notebook shape. To comment on a
  non-notebook document (a markdown file), add a cell-free anchor variant
  (e.g. a text/source range without `cell_id`) rather than overloading the
  cell-scoped variants. `NotebookCommentRef::LocalPath` is the file-backed seam.
