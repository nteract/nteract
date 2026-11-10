# Pages direction

**Status:** the one direction for Pages work, set November 9, 2026. Where
another document or an older plan disagrees, this one wins.
[REFERENCE.md](REFERENCE.md) describes what the code does today.

## Destination

Pages becomes one document type in a service for shared work between people
and agents. A Page is a rich document. The notebook documents are the next
types: `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc` and `CommentsDoc` keep the
shapes they have in nteract. The service has no settled name. It moves to its own repository; this
directory is the source until then.

| Layer | Owner | Rule |
| --- | --- | --- |
| Topology | Hub and spoke | The host holds the auditable record. No peer-to-peer sync |
| Offline work | Each client's local replica | Edits made offline merge when the client reconnects |
| Stored content | Automerge documents | The only source of truth. No stored Markdown |
| Sync | Plain Automerge sync messages over a WebSocket | No Repo layer, no Subduction |
| Host | One host per document | Identity, access, admission, persistence, receipts |
| Document type | A type module: `type` plus integer `format` | Genesis, admission checks, projections for readers |
| Rich text | Wordgard tree, memory only | Decoded from Automerge spans. No ProseMirror |
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
   only. `kind`, `format`, `markdown` and `metadata` hold constants today
   ([model/page.mjs](model/page.mjs)). Every node gets an explicit opening
   marker, including a block's first paragraph, so every node has an id.
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

1. **Pare down here.** Delete what the destination does not need (list
   below). This makes the move smaller.
2. **Move to the new repository** with history. Shared sign-in code and
   shared UI arrive as packages nteract publishes. Vendor a file only until
   its package exists; never import across repositories by path.
3. **Format 2 and the socket check**, deployed to a new, empty service.
4. **Agent tools on format 2.**
5. **A second document type**, once Pages runs on the type boundary.

### Delete

| When | What | Why it can go |
| --- | --- | --- |
| Any time | A snapshot file with no regenerate command, or a test that compares against a fixed commit | It pins code that no longer exists and cannot follow an intended change |
| Any time, profiles before host files | Deployment profiles for `page3`–`page9` and `pages-next`, the frozen-neighbor lists that name them, and the `PAGES_EDITOR` setting | Those services are stopped. Publishing to `pages` or `page10` reads each listed neighbor's unit file, so remove the profiles here before deleting unit files, `/opt` and `/etc` directories, tunnels and DNS records on lab1 |
| When this source stops deploying to `pages.runtimed.run` | `PageRecords`, `recordStorage` stamps and guards, `stored-form.mjs`, the old-encoder fixture in `test/` | They protect documents and open tabs on that service. A new service has neither |
| With format 2 | The `pm` names in `model/node-registry.mjs`, `SUBDUCTION_LOG` in the cold-open benchmark, comments that name removed code | They are read by current code; rename them with the format change |

Keep tests that state behavior: concurrent edits, comment anchors, access
decisions, receipts, persistence and recovery, and the property tests.
`model/node-addresses.golden.json` stays: it has a regenerate command and
records the node addresses agents use.

## Rules for the work

- **The new service starts empty.** It needs no reader for any earlier stored
  form and no migration from an existing target.
- **`pages.runtimed.run` holds documents people use.** Do not reset it or
  deploy this work to it. It does not need migrating either. Copying a Project
  across with `scripts/project-transfer.mjs` is optional and is not a gate.
- **Other deployed targets are demos.** Keep this list current.

  | Target | Host | State |
  | --- | --- | --- |
  | `pages` | lab1 | In use. Deployed by hand |
  | `page10` | lab1 | Preview. Deployed from `main` automatically. Reset freely |
  | `pages2` (`page2.runtimed.run`) | lab2 | Demo. Reset freely |
  | `page11` | lab2 | Profile in source only; nothing is deployed |
  | `page3`–`page9`, `pages-next` | lab1 | Stopped and disabled. Do not restart; files await removal |
- **Additive changes stay in the document. Structural changes get a new
  document.** New keys and new node types layer onto existing documents, and
  a reader keeps what it does not understand. A change that reshapes existing
  data never rewrites in place under the same document ID: it takes a new
  format number and a new document. This is nteract's notebook convention,
  from [schema evolution and genesis](../../../../adr/schema-evolution-and-genesis.md):
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
- The service and repository name.
- What a client keeps when the host refuses its offline edits, for example
  after access is revoked or the format changes.
- How a Page shows notebook work: a static output in a report, or a live
  cell that runs. `runtimed` keeps kernels, execution and outputs either way.
- Whether a document type's genesis is fixed the way the notebook's is.
- Whether marker `parents` becomes a scalar path, and how small blocks get.
