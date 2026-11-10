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
| Stored content | Automerge documents | The only source of truth. No stored Markdown |
| Sync | Plain Automerge sync messages over a WebSocket | No Repo layer, no Subduction |
| Host | One host per document | Identity, access, admission, persistence, receipts |
| Document type | A type module: `type` plus integer `format` | Genesis, admission checks, projections for readers |
| Rich text | Wordgard tree, memory only | Decoded from Automerge spans. No ProseMirror |
| Change flow | Automerge bytes, then patches, then a projection stream, then views | The same shape as nteract notebooks. Derived state lives in RxJS streams outside React |
| Agent edge | HTTP and MCP tools | Markdown and outline are projections. Writes are node operations |

The host does not need to understand a document's content to sync it. It asks
the type module whether a change is admissible. That boundary is what lets a
second document type arrive without a second host.

## The Page model

A Page document holds a map of blocks keyed by stable ID. Each block has a
fractional `position` and one Automerge text object. Structure lives in that
text as flat markers; formatting lives in marks. Moving a block changes its
`position` and nothing else. `decode(spans)` builds the Wordgard tree and
`encode(tree)` writes spans back ([model/wordgard-doc.mjs](model/wordgard-doc.mjs)).
Comments live in their own document and anchor to the Page with cursors.

## What changes from today

1. **Format 2 for `pages.page`.** A block stores `position` and `richText`
   only. Format 2 drops `kind`, `format`, `markdown` and `metadata`. New
   blocks get a fixed default for each ([model/page.mjs](model/page.mjs)).
   Older documents can hold other values, such as Markdown left from an
   import, but the content is `richText`. Tool responses stop reporting `kind`,
   `format` and `metadata`. The `markdown` a read returns is the projection,
   and it stays.
   Every node gets an explicit opening marker, including a block's first
   paragraph, so every node has an id.
2. **Sync without `automerge-repo`.** Pages uses the Repo package for CBOR,
   document ID helpers, record sizing, the Sedimentree backend interface in
   [sync/backend.mjs](sync/backend.mjs), and one `Repo` in the browser
   session. Replace those with direct Automerge calls and drop the pinned
   upstream checkout and its patches. Presence stays as it is: selections and
   agent progress travel as `eph` frames that the host relays and stamps with
   the sender ([sync/wire.mjs](sync/wire.mjs)). This is Pages' own presence,
   separate from the notebook protocol's.
3. **Type and format checked at the socket.** A client declares the formats
   it reads. The host refuses a socket that lacks the document's current
   format. Today the registry in
   [model/document-types.mjs](model/document-types.mjs) only describes.
4. **Agent writes merge by default.** An edit applies at the heads the agent
   read and merges with newer work. The receipt reports the merged result for
   the nodes the edit touched, so the agent sees what landed without another
   read. Whole-block Markdown rewrites are the exception: they are replaced by
   node-scoped writes, or stay fenced on current heads.
5. **One address for agents.** `node_id` replaces the mix of `block_id`,
   `node_id`, `node_index` and `image_id`. `edit_page` and `patch_page` become
   one tool with one operation list. Only the addressing changes. Every
   operation stays: text and formatting edits, images, Parquet dataframes,
   node insert, delete and retype, and block moves. Uploads keep their flow.

## Order of work

1. **The socket check and the release gate.** The host refuses a socket that
   lacks the document's format. A build's release receipt names the formats
   it writes, and a release to a target is refused when the target's
   documents are in another format. Both work on format 1, so they land
   first.
2. **Tag the last format 1 commit.** It is the parent of the first change
   that makes `main` unfit for `pages.runtimed.run`: the first delete below,
   or the format 2 block shape, whichever lands first. From the tag on,
   `main` is never promoted to that service. A fix for it goes on a
   maintenance branch cut from the tag.
3. **Delete what a new service does not need** (list below).
4. **Format 2**, deployed to a new, empty service. The block shape comes
   first. Explicit opening markers follow as their own change, because they
   move node ids, the golden node addresses and the editor's caret
   positions.
5. **Agent tools on format 2.**
6. **A second document type**, once Pages runs on the type boundary.

### Delete

| When | What | Why it can go |
| --- | --- | --- |
| Any time | A snapshot file with no regenerate command, or a test that compares against a fixed commit | It pins code that no longer exists and cannot follow an intended change |
| After the format 1 tag | `PageRecords`, `recordStorage` stamps and guards, `stored-form.mjs`, the old-encoder fixture in `test/` | They protect documents and open tabs on `pages.runtimed.run`. A new service has neither. The `PageRecords` Durable Object class stays declared, with an empty body, while a deployed target still binds it |
| With format 2 | The `pm` names in `model/node-registry.mjs`, `SUBDUCTION_LOG` in the cold-open benchmark, comments that name removed code | They are read by current code; rename them with the format change |

Keep tests that state behavior: concurrent edits, comment anchors, access
decisions, receipts, persistence and recovery, and the property tests.
`model/node-addresses.golden.json` stays: it has a regenerate command and
records the node addresses agents use.

## Rules for the work

- **The new service starts empty.** It needs no reader for any earlier stored
  form and no migration from an existing target. The host never loads a
  format 1 document beside format 2 ones, and never converts one in place.
- **A Project moves by copy, through the agent edge.**
  `scripts/project-transfer.mjs` reads a Project from one target's `/mcp`
  and writes it to another's, so it needs no code in the host and works
  across formats. It copies content, titles, images, dataframes and the Page
  tree. It does not copy comments, sharing, Trash or history. Copying more,
  such as comments, is a change to that script. Copying is optional and is
  not a gate.
- **`pages.runtimed.run` holds documents people use.** Do not reset it, and do
  not build a migration from it. A release in the stored form `main` writes
  today (format 1) may be promoted to it by hand, once `page10` runs the same
  build, up to the format 1 tag. Format 2 work never deploys to it.
- **Other deployed targets are demos.** Keep this list current.

  | Target | Host | State |
  | --- | --- | --- |
  | `pages` | lab1 | In use. Promoted by hand from the build `page10` runs |
  | `page10` | lab1 | Preview. Deployed from `main` automatically. Reset freely |
  | `pages2` (`page2.runtimed.run`) | lab2 | Demo. Reset freely |
  | `page11` | lab2 | Profile in source only; nothing is deployed |
- **Additive changes stay in the document. Structural changes get a new
  document.** New keys and new node types layer onto existing documents, and
  a reader keeps what it does not understand. A change that reshapes existing
  data never rewrites in place under the same document ID: it takes a new
  format number and a new document. This is nteract's notebook convention,
  from [schema evolution and genesis](../../docs/adr/schema-evolution-and-genesis.md):
  additive writes on a fixed root, and a separate document for a structural
  change.
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
- Whether marker `parents` becomes a scalar path, and how small blocks get.
