# Pages stored-form migrations, November 2026

Archived 2026-11-08: superseded by apps/pages/pages/DEPLOYMENT.md ("Stored forms and rollback rules") and DIRECTION.md; historical only.

The record of the one-shot migrations that moved pages and page10 to the v1 stored forms: rich-text blocks, the comments document, plain Automerge sync, and the PageRecords sweep.

## Stored forms this build refuses

Every Page on pages and page10 was rewritten to the current stored forms on
2026-11-05: rich-text blocks, comments in their own document, `comments_doc`
in every live or trashed host record. On pages, the verifying dry run at 19:27
UTC reported 137 Pages unchanged, 1 deleted, 0 writes pending and 0 problems,
with `comments_doc` on every host record. On page10, the run from 22:24 to
22:27 UTC reported 86 unchanged, 19 deleted (their tombstones finished), 0
problems, no preserved blocks and no pending comments move.

This build doesn't read the earlier forms. A Page that still holds one answers
`409 stored_form_unsupported` on the read or write that meets it, and a live or
trashed Page's host record without `comments_doc` fails at boot. A deleted
Page's record needs none: it names no comments document and answers as deleted.
page10 holds one such record (59361b99-fc53-40ec-a733-a74a4db24630). Don't
restore a backup taken before 2026-11-05 onto a target running this build.

## Comments migration

Every comment message on pages and page10 is in the form this build writes:
rich text in the editor's spans, the form every Page body is in, with no
`body` copy. Earlier builds stored plain messages as a bare `body`, and rich
messages in the ProseMirror adapter's span form beside a `body` copy of the
Markdown they were first written from. An owner and operator migration
rewrote both forms in one journaled host change per Page. Its verifying dry
runs on 2026-11-06 were clean: pages reported 142 Pages unchanged and 0
writes, page10 86 unchanged and 0 writes. The migration's code and routes are
gone. A Page that wrote a migration change keeps its revert records in
`host/comments-migration/revert`, and each owner's Catalog keeps
`host/comments-migration/state` and `result/*`; nothing reads them.

This build reads and admits neither old form. A read that meets a message
with no rich text or with a `body` returns it with an empty body and
`content_error: "stored_form_unsupported"`, and the viewer shows a
placeholder in its place; the rest of the thread and the Page stay readable.
The tools refuse to edit one with `409 stored_form_unsupported`. A replica
that missed the migration can still hold one: its concurrent `body` write
survives a merge with the migration's delete. Admission keeps that write off
the host, so only the replica that wrote it shows the placeholder. Admission refuses, as
`outdated_form`, a change that creates or touches a message with a `body` or
without the rich format, a soft delete included, and a new message or content
write whose spans are out of the editor's form.
That refusal never blocks the sender: earlier viewers write those forms, so
`MIN_VIEWER_PROTOCOL` is 3 and their tabs must reload.

**Rollback rule.** Every message this build writes has no `body`. A build
before the comments change (#4884) reads such a message (it ignores
`bodyFormat`, so a plain message reads as escaped Markdown), but its
admission requires `body` on every message: its host would refuse a later
edit or deletion of one. Roll back only to a build that has #4884. A build
between #4884 and this one still reads the old forms, so rolling back to it
is safe.

Reverting #4884 on `main` is a forbidden rollback, not a fix. page10 deploys
`main` automatically, so a revert would ship the earlier admission to a target
whose comments documents already hold messages without `body`. Fix forward on
`main` instead.

## Plain sync on pages.runtimed.run

Every Page on pages.runtimed.run is on plain Automerge sync: an operator
conversion on 2026-11-05 left 136 active and 3 trashed Pages on `automerge`, 0
remaining and 0 unreadable. Page10 was converted the same way. The conversion's
own operator route is gone. This build has no Subduction code: it can't open
or convert a Subduction Page, and refuses one with "Unsupported Page record
storage mode".

The first install of this build restarts the service with
`restart_reasons: ["config"]`: the configured `wrangler.json` drops the
`PAGES_ASYNC_PERSISTENCE`, `PAGES_COMPACT_RECORDS` and `PAGES_RECORD_STORAGE`
vars. Bindings and migrations are unchanged. Pages that converted from
Subduction keep their old records in their own storage (`repo/`,
`host/actor/`, `host/binding/`, `host/signer`) until they are purged, which
deletes them; nothing reads them.

## Old PageRecords objects

A `buffered` Page kept its Subduction records in a separate PageRecords
object, named by its Page id. Conversion copied the history into the Page's
plain storage and left the PageRecords object as it was. An operator sweep
cleared those objects on both targets: 138 Pages on pages and 79 on page10,
and the verifying dry runs found nothing left. The sweep's code and route are
gone.

The comments migration and this sweep were the last users of the lab operator
gate, so it is gone with them. The first install of this build on pages and
page10 restarts the service once with `restart_reasons: ["config"]`: the
configured `wrangler.json` drops `PAGES_OPERATOR_SECRET`. The root-only
`/etc/<service>/operator-secret` file stays on each host; nothing reads it.

This build keeps the `PageRecords` class and `PAGE_RECORDS` binding
delete-only (worker/page-records.mjs): `inspect` counts keys and bytes,
`clear` deletes everything. No read or write path is left. Purge uses it:
deleting a Page converted from `buffered` storage clears its PageRecords
object with the rest of its converted records (`purgeConvertedRecords`).
Purge stays permanent.

**Removing the class.** Deleting `PageRecords`, its binding and
worker/page-records.mjs needs a `deleted_classes` migration. celld 0.6.3 has
no sign of supporting one: its binary knows `new_sqlite_classes`, `old_tag`,
`new_tag` and `steps`, not `deleted_classes`, and it already refuses
`renamed_classes` (see the Space binding in scripts/build.mjs). Until celld
accepts it, the class stays delete-only and empty, and the
`v2 new_sqlite_classes: ["PageRecords"]` migration tag stays too.
