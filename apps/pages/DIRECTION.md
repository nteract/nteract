# Pages direction

**Status:** the one direction for Pages work, set November 10, 2026. Where
another document or an older plan disagrees, this one wins.
[REFERENCE.md](REFERENCE.md) describes what the code does today.

## Destination

Pages becomes one document type in a service for shared work between people
and agents. A Page is a rich document. The notebook documents are the next
types: `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc` and `CommentsDoc` keep the
shapes they have in nteract. The service has no settled name. Its source
stays in this directory of the nteract monorepo.

| Layer | Owner | Rule |
| --- | --- | --- |
| Topology | Hub and spoke | The host holds the auditable record. No peer-to-peer sync |
| Offline work | Each client's local replica | Edits made offline merge when the client reconnects |
| Stored content | Automerge documents | The only source of truth for document content. No stored Markdown. Page tags are not content: they live only in D1 ([Where state lives](DEPLOYMENT.md#where-state-lives)) |
| Sync | Plain Automerge sync messages over a WebSocket | No Repo layer, no Subduction |
| Host | One host per document family: a Page's host holds the Page, its comments and its sources documents | Identity, access, admission, persistence, receipts |
| Document type | A type module: `type` plus integer `format` | Genesis, admission checks, projections for readers |
| Rich text | Wordgard tree, memory only | Decoded from Automerge spans. No ProseMirror |
| Change flow | Automerge bytes, then patches, then a projection stream, then views | The same shape as nteract notebooks. Derived state lives in RxJS streams outside React |
| Agent edge | HTTP and MCP tools | Markdown and outline are projections. Writes are node operations |

The host does not need to understand a document's content to sync it. It asks
the type module whether a change is admissible. That boundary is what lets a
second document type arrive without a second host.

## The Page model

A Page document holds a map of blocks keyed by stable ID. A block stores a
fractional `position` and one Automerge text object, `richText`; the key is
its ID. Structure lives in that
text as flat markers; formatting lives in marks. Moving a block changes its
`position` and nothing else. `decode(spans)` builds the Wordgard tree and
`encode(tree)` writes spans back ([model/wordgard-doc.mjs](model/wordgard-doc.mjs)).
Comments live in their own document and anchor to the Page with cursors.

## What changes from today

1. **Format 3 for `pages.page`, format 2 for `pages.comments`.** In place.
   A block stores `position` and `richText` only, and a response block is
   `id`, `position` and `markdown`, the projection of `richText`
   ([model/page.mjs](model/page.mjs)). Every node a writer writes opens with
   its marker, a block's first paragraph included, so every written node has
   a `node_id`: the cursor on its marker. A comment message holds the same
   rich text and no `format` field.
   A merge can leave content that no marker opens, for example when one
   person deletes a paragraph while another types or puts an image into it.
   That is unmarked text, an image or line break included. The stored
   format allows it and every reader reads it by one rule: content continues the node before it in its scope
   when that node can hold it, and otherwise opens a paragraph (in a table,
   a row and cell) with no marker. A code block holds text and line breaks;
   every other textblock holds every inline node; a leaf (a rule, a
   dataframe) holds nothing. Such a paragraph has `node_id` null. The next
   host write to the block marks it, and the editor marks it when a person
   types or formats inside it. A merge can also delete a container's marker
   while a node a peer added inside it survives. Readers draw the container
   from that node's `parents` and name it by that node's marker, and no
   writer restores the container's marker.
2. **Sync without `automerge-repo`.** Pages uses the Repo package for CBOR,
   document ID helpers, record sizing, the Sedimentree backend interface in
   [sync/backend.mjs](sync/backend.mjs), and one `Repo` in the browser
   session. Replace those with direct Automerge calls and drop the pinned
   upstream checkout and its patches. Presence stays as it is: selections and
   agent progress travel as `eph` frames that the host relays and stamps with
   the sender ([sync/wire.mjs](sync/wire.mjs)). This is Pages' own presence,
   separate from the notebook protocol's.
3. **Type and format checked at the socket.** A client declares the formats
   it reads. The host refuses a socket that sends none or lacks the
   document's current format. The registry is
   [model/document-types.mjs](model/document-types.mjs).
4. **Agent writes merge by default.** An edit applies at the heads the agent
   read and merges with newer work. The receipt reports the merged result for
   the nodes the edit touched, so the agent sees what landed without another
   read. Whole-block Markdown rewrites are the exception: they are replaced by
   node-scoped writes, or stay fenced on current heads.
   This comes after the contract change in item 5, and it needs its own
   design. Today the host applies every edit at current heads. Target scope
   only proves a passage unchanged since the heads the agent read, and only
   for `replace_match`, `format_match` and `set_node`. Nothing applies a
   move, an insert, a delete or an image change at an older revision and
   merges it. Because the request already names the revision, merging those
   later changes no request shape: agents see fewer refusals.
5. **One address and one envelope for agents.** One contract change, with
   today's refusal rules:
   - `node_id` is the one address for a block, a top-level node and an
     image. Done: it is the Automerge op id of the block's map object, the
     node's opening marker or the image's embed. Op ids are unique in the
     document, so an id names its block too. The host still needs a lookup:
     it resolves an id by comparing it against the ids minted from the live
     document ([model/addresses.mjs](model/addresses.mjs)). Each field takes
     the kinds it acts on and refuses another with `wrong_address_kind`.
   - `edit_page` and `patch_page` become one tool with one operation list. Done on `main`.
     Every operation stays: text and formatting edits, images, Parquet
     dataframes, node insert, delete and retype, and block moves. Uploads
     keep their flow.
   - Tool schemas stay in a portable subset: an operation is one object with
     an `op` enum, and no schema uses `oneOf`, `anyOf`, `allOf`, `const` or
     `$ref`. A test walks the schemas and enforces it.
   - A read returns a short revision handle, such as `r1842`, in place of
     64-hex heads. A write names the handle it read. Done: `r<n>` for the
     Page and `c<n>` for its comments, with browsers, sync and host-to-host
     calls still on heads.
   - A write carries a short nonce and no retry token. The host keeps the
     receipt under the account, the document and the nonce, and a retry of
     the same request returns that receipt. The handle's age bounds the retry
     window: a write that names a handle minted at or before the receipt
     horizon is refused with `resync_required`, and a read never hands one
     out. Done: one receipt lane kept for
     seven days, with a durable horizon behind the fence.
   - Writes with no revision (`create_page`, move, Trash, restore) carry the
     nonce alone. After its receipt is gone, a retried `create_page` can make
     a second Page. `purge_page` and `delete_project` keep their preview
     token. Done.

## Order of work

1. **The socket check and the release gate.** The host refuses a socket that
   lacks the document's format. A build's release receipt names the formats
   it reads, and a release to a target is refused when the target's
   documents are in a format the build does not read. Both landed on
   format 1.
2. **The last format 1 commit is tagged `pages-format-1`.**
   `pages.runtimed.run` runs that commit, and `main` is never promoted to
   that service. A fix for it goes on a maintenance branch cut from the tag,
   built from that branch and promoted by hand.
3. **Delete what a new service does not need** (list below).
4. **Formats 2 and 3**, deployed to a new, empty service. Done: `main`
   writes `pages.page` 3 and `pages.comments` 2, and `page10` is the lab
   target that takes them. A target is emptied for format 3, because its
   markers move node ids, the golden node addresses and the editor's caret
   positions. The host checks that go with it:
   - Plain sync admission checks the block shape, as registration does: a
     block holds exactly `position` and `richText`. Neither applies a
     marker rule to the text, since every reader reads unmarked text.
   - A Page's host record stores the format of each of its documents
     (`documentFormats`), and the host refuses a record in a format the
     build does not write, or a record without the stamp, while its owner
     can still delete the Page. `TARGET_DOCUMENT_FORMATS` stays the release
     gate. A missed reset is refused Page by Page.
5. **Agent tools on format 2.**
6. **A second document type**, once Pages runs on the type boundary. The
   host runs on it: plain sync asks each document's type module for its
   write access, feature gates, admission and revision handles
   ([worker/document-modules.mjs](worker/document-modules.mjs)), with the
   Page and comments documents as its first two modules. Started: a Page's
   named sources are a third module, `pages.sources`, a document only the
   host writes ([model/sources-doc.mjs](model/sources-doc.mjs)).

### Delete

| When | What | Why it can go |
| --- | --- | --- |
| Any time | A snapshot file with no regenerate command, or a test that compares against a fixed commit | It pins code that no longer exists and cannot follow an intended change |
| After the format 1 tag | The `PageRecords` declaration and binding, `recordStorage` stamps and guards, `stored-form.mjs` | They protect documents and open tabs on `pages.runtimed.run`. A new service has neither. The `PageRecords` Durable Object class already has an empty body and nothing calls it; it stays declared while a deployed target still binds it, because removing it takes a `deleted_classes` migration |

Keep tests that state behavior: concurrent edits, comment anchors, access
decisions, receipts, persistence and recovery, and the property tests.
`model/node-addresses.golden.json` stays: it has a regenerate command and
records the node addresses agents use.

## Rules for the work

- **Before production, a target changes format by deleting its old
  documents.** It needs no reader for any earlier stored form and no
  migration from an existing target, and the host never converts a document
  in place. Deleting means removing the old Pages, then their Projects: Trash
  and permanent deletion cover a Page's content and comments documents, and
  `delete_project` removes an emptied Project with its content. Sign-ins,
  grants and the deployment's secrets stay.
  A format 2 build opens a format 1 Page, because it reads `position` and
  `richText` and ignores the fields format 2 dropped. Nothing relies on that.
  Format 3 moves node ids, so a format 2 Page must be gone before it.
- **Format 3 is the format production starts on.** Once people's documents
  are in it, no target that holds them is emptied. A later stored change is
  additive under a schema feature, or it follows the structural rule below:
  a new format number and a new document for each Page, written from the old
  one.
- **From the format after 3, an older Page stays readable and its owner
  upgrades it.** A Page in an older format opens read-only: people can read
  and copy it, and nobody edits it in that format. Its owner upgrades it in
  place with one action, which writes the new document from the old one
  under the same Page. The service doesn't refuse an older Page outright,
  and nobody has to delete it to keep using Pages. What exists: the host
  record stamps each document's format (`documentFormats`, order of work,
  step 4), and when the host refuses a Page's format the viewer keeps
  its cached copy readable and copyable, read-only
  ([viewer/format-gate.mjs](viewer/format-gate.mjs)). What's
  missing: the host serving an older format for reading (today it refuses a
  record in a format the build doesn't write), and the upgrade action.
- **A Project moves by copy, through the agent edge.**
  `scripts/project-transfer.mjs` reads a Project from one target's `/mcp`
  and writes it to another's, so it needs no code in the host and works
  across formats. It copies content, titles, images, dataframes and the Page
  tree. It does not copy comments, sharing, Trash or history. Copying more,
  such as comments, is a change to that script. Copying is optional and is
  not a gate.
- **`pages.runtimed.run` holds documents people use.** Do not reset it, and do
  not build a migration from it. It runs the commit tagged `pages-format-1`.
  Nothing from `main` deploys to it: a fix is a commit on a maintenance
  branch cut from that tag.
- **The other targets in this list are demos.** Keep this list current.

  | Target | Host | State |
  | --- | --- | --- |
  | `pages` | lab1 | In use. Runs `pages-format-1`. Takes fixes from its maintenance branch only |
  | `page10` | lab1 | Preview. Deployed from `main` automatically. Reset freely |
  | `pages2` (`page2.runtimed.run`) | lab2 | Demo. Reset freely |
  | `page11` | lab2 | Profile in source only; nothing is deployed |
- **A deployment from the release package belongs to its operator.** It is not
  in the list above, it takes builds of `main`, and it can hold documents
  people use. Do not reset it or delete from it. A change on `main` that stops
  a stored document from opening says so in its PR, so the operator can decide
  before taking the release.
- **Additive changes stay in the document. Structural changes get a new
  document.** New keys and new node types layer onto existing documents, and
  a reader keeps what it does not understand. A change that reshapes existing
  data never rewrites in place under the same document ID: it takes a new
  format number and a new document. This is nteract's notebook convention,
  from [schema evolution and genesis](../../docs/adr/schema-evolution-and-genesis.md):
  additive writes on a fixed root, and a separate document for a structural
  change.
- **A request carries nothing the host already knows.** The host has the
  account, the document and the scope from the authenticated request, so a
  client never sends a signed copy of them back. In a scripted seven-call
  session, about 60% of the tokens were heads, idempotency keys and retry
  tokens. Count a tool call's envelope as part of its cost.
- **A retry of a write that landed returns its receipt.** An agent never
  learns from a refusal that its own write landed.
- **A revision handle belongs to a document, not to a Page.** Each
  document's host issues its own handles and keeps the table from handle to
  heads. A write names a document's handle only when it needs that
  document's revision. A comment on selected text names the Page's handle,
  to find that text; no other comment write names a revision, and none names
  the comments document's. A second document type, or a document nested in
  another, gets handles the same way. Handles are for the agent edge:
  browsers sync with Automerge heads and never see one.
- **No parity work.** No byte-for-byte comparison with an earlier encoder, no
  compatibility matrix, no readiness program. A demonstrated content-loss or
  access bug is a bug: fix it with a test that states the behavior.
- **Bring a choice to the maintainer** when it changes what people can do,
  who can reach the service, where it runs, or what happens to existing
  documents. Decide the rest in the pull request.

## Not decided

- The runtime and account system of the production service.
- The service name.
- Whether the source moves to another repository. That is a question of who
  owns the product, and no step in the order of work waits on it.
- What a client keeps when the host refuses its offline edits, for example
  after access is revoked or the format changes.
- Whether Pages supports an aside, and how: what people use one for, a
  Markdown form agents can read and write, and the effort. This is open
  research. Until it's settled, a paste from outside Pages unwraps an aside
  into its content, and a stored aside reads as a notice followed by its
  content.
- How a Page shows notebook work: a static output in a report, or a live
  cell that runs. `runtimed` keeps kernels, execution and outputs either way.
- Whether a document type's genesis is fixed the way the notebook's is.
- Whether the span codec and the agent projections move to Rust compiled to
  WASM. The editor already applies eligible Automerge text patches to its
  decoded block. It re-decodes the block for structure and formatting
  changes, and when a patch cannot be mapped
  ([viewer/wordgard-binding.mjs](viewer/wordgard-binding.mjs)). The host's
  admission checks and the Markdown and outline projections are the first
  candidates, because the host, the tools and a Rust client can then share
  one codec. Moving the editor's document into WASM is a larger step.
- How small blocks get. Marker `parents` stays a list: a scalar parents
  value and one path scalar for type and parents each merged no better in a
  census of concurrent writers. As lists, two writers that change one marker's parents at once merge into
  parents neither wrote. Every reader draws any stored spans, whatever their
  parents or values, and none throws; the next host write or editor edit to
  a block whose only problem is its nesting stores what they drew
  ([model/merge-readers.test.mjs](model/merge-readers.test.mjs)). A merge
  can still pair one writer's type with another's parents, or drop a
  structural edit.
