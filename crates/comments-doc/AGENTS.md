# CommentsDoc Agent Notes

`comments-doc` owns the durable per-notebook CommentsDoc model. It is not
runtime state, widget state, output transport, or execution transport.

- `comments_doc_id` is required identity for every materialized CommentsDoc.
  A missing id is a resolver/seeding failure, not optional comments state.
- Attribution comes from change authorship, not stored fields. A thread's or
  message's author is read from the Automerge actor that created the object
  (`actor_label_of`); a thread's resolver is read from the actor that wrote the
  winning `status` value. The document stores no `created_by`/`resolved_by`
  field, because a stored one would be client-writable and therefore worthless.
- Actor ids are not authentication on their own. The model is sound only because
  the sync ingress that accepts `COMMENTS_DOC_SYNC` binds each connection to its
  own actor id and rejects changes that claim a different one. That gate is the
  trust boundary and lives in the sync layer, not this crate. This crate reads
  attribution from actor ids already admitted into the document.
- Do not reintroduce a daemon "finalization" or `authority_*` keyspace. If a
  field can be overwritten by any peer, do not treat it as trusted; derive trust
  from change authorship instead. Add authority-stamped fields back only for a
  concept attribution cannot express (e.g. moderation accept/reject), never for
  who-authored or who-resolved.
- Keep optimistic comments inside Automerge. Do not add a parallel optimistic
  store.
- Comments outlast runtime state. Do not route comment persistence through
  `RuntimeStateDoc`.
- The thread/message/projection machinery is document-agnostic; only
  `CommentAnchor` and `NotebookCommentRef` carry notebook shape. To comment on a
  non-notebook document (a markdown file), add a cell-free anchor variant
  (e.g. a text/source range without `cell_id`) rather than overloading the
  cell-scoped variants. `NotebookCommentRef::LocalPath` is the file-backed seam.
