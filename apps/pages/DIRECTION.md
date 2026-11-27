# Pages direction

Where another document disagrees, this one wins.
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

To people and agents, a Page is one flow of nodes: paragraphs, headings,
lists, images, views and dataframes in order. Blocks are a storage detail
(item 6 below). A Page made in the browser already has one block.

## What changes from today

1. **Format 3 for `pages.page`, format 2 for `pages.comments` (in place).**
   - A block stores `position` and `richText` only; response blocks project
     `id`, `position`, and `markdown` ([model/page.mjs](model/page.mjs)).
   - Every written node opens with its marker (including a block's first
     paragraph), so every written node has a `node_id` equal to the cursor on
     its marker. Comment messages store the same rich text with no `format`
     field.
   - **Unmarked text from concurrent merges:** Deleting a paragraph while
     another peer types or inserts an image can leave unmarked content. Every
     reader follows one rule: unmarked content continues the preceding node in
     scope when that node can hold it (code blocks hold text and line breaks;
     other textblocks hold all inline nodes; leaves such as rules and
     dataframes hold nothing). Otherwise it opens an unmarked paragraph (or a
     table row and cell) with `node_id: null`. The next host write or user
     edit inside that paragraph marks it.
   - **Deleted container markers:** If a merge deletes a container's marker
     while a child survives, readers reconstruct the container from the
     child's `parents`, name it by that child's marker, and never restore the
     deleted marker.
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
     Item 6 takes the block kind out of the agent contract, so the address
     becomes a node's or an image's.
   - `edit_page` and `patch_page` become one tool with one operation list. Done on `main`.
     Every operation stays: text and formatting edits, images, Parquet
     dataframes, node insert, delete and retype, and block moves, until
     item 6 retires the block operations. Uploads keep their flow.
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
6. **One flow per Page.** The stored model is node-first: structure lives in
   markers. An insert without a node anchor still makes a block, so a Page
   an agent builds in pieces is stacked editors. A selection can't cross
   them, Backspace can't join them, and a person can't remove an empty one.
   On a 15-Page sample, a block is in practice one agent write, not a unit
   anyone chose.
   - **Inserts go in place.** Done for an anchor node:
     `insert_markdown`, `insert_image` and `insert_node` write after a
     top-level node inside its block
     ([model/insert-in-place.mjs](model/insert-in-place.mjs)), with no text moved and every
     node id and comment anchor kept. Done without one too: an omitted
     `after_node_id` writes after the last node of the last block, and `null`
     before the first node of the first
     ([model/flow-placement.mjs](model/flow-placement.mjs)). Such an insert
     makes a block only where it can't go inside: the Page has none, the
     content would join a list of the same kind at that end, a later operation
     in the batch names the edge block by its id, or that block is past the passage
     limit or holds content this build can't write in. A block's id as `after_node_id` still makes one, until block
     ids leave the contract.
   - **`node_id` names nodes only.** Block ids leave the agent contract.
     `replace_block_markdown` gives way to node-scoped writes (item 4),
     `delete_block` to `delete_node` over a range, and `move_block` to a
     section move (below). The block key stays the internal name in
     storage, sync, presence and the comments document.
   - **The browser makes no block.** "Continue writing" adds an empty
     paragraph at the end of the last block
     ([viewer/writing-continuation.mjs](viewer/writing-continuation.mjs)),
     not an empty block. It still makes one when the Page has no block or
     this build can't write the last one.
   - **Large Pages are fixed in the decoder, not with more blocks.** The
     host reads each block once per batch
     ([model/block-reads.mjs](model/block-reads.mjs)). On one block of
     112 KB, a batch of 20 `format_match` takes 0.1 s (7.0 s before; 0.03 s
     split across 85 blocks), 20 `replace_match` 0.2 s (5.7 s before), and
     20 target-scoped `replace_match` 0.9 s (21.6 s before)
     ([scripts/edit-batch-benchmark.mjs](scripts/edit-batch-benchmark.mjs),
     on a laptop; the Workers host is slower).
     The editor still reads the whole block again for every structural or
     formatting write ([viewer/wordgard-binding.mjs](viewer/wordgard-binding.mjs)):
     one block of about 115 KB costs 199 ms per line break (17 ms at
     16 KB). Carry the editor's tree through structural and formatting
     writes as it already does for typing. If a measured Page
     still needs it after that, the host starts a new block when the last
     one passes a size, on append only. The host never splits existing
     text on its own, since a split detaches the comments on the moved tail
     and drops edits in flight to it.
   - **Per-block limits become per-Page limits.** Passage operations
     search a block of up to 262,144 UTF-16 units
     ([model/replace-match.mjs](model/replace-match.mjs)). Page scope could
     take four times that (20 `replace_match` in 3.2 s at 1,035,285
     units), but the target-scope guard
     ([model/passage-edits.mjs](model/passage-edits.mjs)) takes 12.6 s
     there: it views and clones the whole document and reads the block at
     the base revision, the current one and a dry run. Raising the limit
     waits on a guard whose cost doesn't follow the whole document. A
     batch's in-place inserts and moves count up to 3,000,000 units of the
     blocks they write into
     ([model/insert-in-place.mjs](model/insert-in-place.mjs)). Each insert
     still reads its block back to check it, at about 1.2 µs a unit (8 µs
     before the host read once per batch), so a full budget of inserts
     takes about 4 s on a laptop. Moves between two large blocks cost 1.8
     to 2 µs for each unit they count, so a full budget of them takes about
     5.5 to 6 s. One
     node from a newer build makes in-place inserts and Markdown rewrites
     of its block refuse with `newer_content`.
     In one flow each of these covers the whole Page: about 15 inserts
     into a 200 KB Page per batch, and no passage edit on a Page past
     262,144 units.
   - **A join costs what a split costs.** Writing later blocks into the
     first deletes their text objects, so an edit in flight to them is lost,
     a comment made offline on them detaches, and their nodes get new ids.
     The host never joins on its own. A join is an explicit action that
     refuses at a stale revision, rewrites the comment anchors it can see,
     and returns the new ids. Multi-block Pages that nobody joins stay
     readable and editable node by node. A join is a content edit inside
     format 3, as a section move is, not a format conversion: it needs no
     format number or new document.
   - **Re-anchoring is a host write.** A peer may move a thread's anchor
     only if it wrote the thread
     ([model/comment-authority.mjs](model/comment-authority.mjs)). A join or
     a section move puts the anchor on the same text at its new place, so
     the host writes it as its own write for the same request as the
     content change, outside that rule. Moving an anchor to different text
     stays the author's alone. An author's own anchor move that lands
     between the host's read of the threads and its rewrite is overwritten.
   - **A section moves with a host move.** Automerge text has no move, so
     `move_nodes` deletes a run of nodes and writes the same spans after
     another node: characters, marks and attributes come back as stored, the
     moved nodes get new ids, and the host re-anchors the comment threads on
     the moved text. In an eval of 100 agent runs (five move tasks on
     commented Pages, two models, a local celld and Pages), agents with it
     kept every thread on the moved text. With today's tools they kept them
     in 18 of 50 runs, and telling them to keep comments doubled their calls
     and cost without closing the gap.
     - The host journals the planned rewrites with the Page change and
       writes them to the comments document as a second write for the same
       request. Every retry runs that write, so a restart between the two
       leaves the threads detached only until the retry. One journal entry
       for both documents would close that window. It changes the rule that
       an entry covers one document, and is open.
     - Text someone types into a moved node while the move lands is kept at
       the end of the node before the run's old place, as for `delete_node`.
       The eval had one writer; a concurrent-writer task is still to run.
     - A thread that crosses the run's edge loses its anchor and is
       reported. Whether a move should refuse instead is open.

## Order of work

1. **The socket check and the release gate.** The host refuses a socket that
   lacks the document's format. A build's release receipt names the formats
   it reads, and a release to a target is refused when the target's
   documents are in a format the build does not read. Both landed on
   format 1.
2. **Delete what a new service does not need** (list below).
3. **Formats 2 and 3**, deployed to a new, empty service. Done: `main`
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
4. **Agent tools on the current format.** Done on `main`: agent tools run on
   format 3 with `node_id` addressing, unified `edit_page`, revision handles,
   and nonces (item 5 above).
5. **A second document type**, once Pages runs on the type boundary. The
   host runs on it: plain sync asks each document's type module for its
   write access, feature gates, admission and revision handles
   ([worker/document-modules.mjs](worker/document-modules.mjs)), with the
   Page and comments documents as its first two modules. Started: a Page's
   named sources are a third module, `pages.sources`, a document only the
   host writes ([model/sources-doc.mjs](model/sources-doc.mjs)).
6. **One flow per Page** (item 6 above). Done: in-place insert after a
   node and at either end of the Page, "Continue writing" adds a paragraph,
   and `move_nodes` moves a section with its comments
   ([model/move-nodes.mjs](model/move-nodes.mjs)).
   Then, each its own change:
   1. The host reads each block once per batch, and the editor carries its
      tree through structural and formatting writes. Measure the 115 KB
      case again after, and restate the per-block limits for a Page.
      Done on the host, with the limits restated above. Left: the editor.
      `A.spans` alone costs about 80 ms on a 100,000-unit block, and a
      structural write in the editor calls it twice (in
      `updateSpansExactly` and in the read that checks the write) after a
      whole-block `updateSpans`.
   2. Omitted and `null` `after_node_id` write into the last and first
      blocks. Done. Left: the guides still teach a block's id as an
      insert's anchor.
   3. The explicit join for multi-block Pages, with comment re-anchoring.
   4. Block ids leave the agent contract. This waits on node-scoped writes
      (item 4 above), which need their own design first.
   `scripts/project-transfer.mjs` writes a body with
   `replace_block_markdown` and `delete_block`, then inserts with no anchor,
   which a host that writes in place keeps in one block. It moves off the
   block operations with step 6.4.

### Delete

| When | What | Why it can go |
| --- | --- | --- |
| Any time | A snapshot file with no regenerate command, or a test that compares against a fixed commit | It pins code that no longer exists and cannot follow an intended change |
| After the format 1 tag | The `PageRecords` declaration and binding, `recordStorage` stamps and guards, `stored-form.mjs` | They protect documents and open tabs on the deployed targets that still hold format 1. A new service has neither. The `PageRecords` Durable Object class already has an empty body and nothing calls it; it stays declared while a deployed target still binds it, because removing it takes a `deleted_classes` migration |

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
- **After format 3, older Pages stay readable and owners upgrade them in
  place.** An older-format Page opens read-only (readable and copyable, not
  editable), and its owner upgrades it with one action that writes the new
  document from the old one under the same Page, with no outright refusal or
  forced deletion.
  - *In place:* host records stamp `documentFormats` (order of work, step 3),
    and the viewer keeps cached copies readable and copyable when the host
    refuses a Page's format ([viewer/format-gate.mjs](viewer/format-gate.mjs)).
  - *Remaining:* host read-only serving for older formats (currently refused)
    and the in-place upgrade action.
- **A Project moves by copy, through the agent edge.**
  `scripts/project-transfer.mjs` reads a Project from one target's `/mcp`
  and writes it to another's, so it needs no code in the host and works
  across formats. It copies content, titles, images, dataframes and the Page
  tree. It does not copy comments, sharing, Trash or history. Copying more,
  such as comments, is a change to that script. Copying is optional and is
  not a gate.
- **The targets in this list are demos.** Keep this list current.

  | Target | Host | State |
  | --- | --- | --- |
  | `page10` | lab1 | Preview. Deployed from `main` automatically. Reset freely |
  | `pages2` (`page2.runtimed.run`) | lab2 | Demo. Reset freely |
  | `page11` | lab2 | Profile in source only; nothing is deployed |
  | `page12` (`page12.runtimed.run`) | lab2 | Demo. Format 3 / 2 (`pages.page` 3, `pages.comments` 2). Reset freely |
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
- How marker nesting merges. Marker `parents` stays a list: a scalar parents
  value and one path scalar for type and parents each merged no better in a
  census of concurrent writers. As lists, two writers that change one marker's parents at once merge into
  parents neither wrote. Every reader draws any stored spans, whatever their
  parents or values, and none throws; the next host write or editor edit to
  a block whose only problem is its nesting stores what they drew
  ([model/merge-readers.test.mjs](model/merge-readers.test.mjs)). A merge
  can still pair one writer's type with another's parents, or drop a
  structural edit.
