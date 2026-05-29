# Runtime State Document Identity

**Status:** Draft, 2026-05-29.

## Context

nteract already keeps notebook state and runtime state in separate Automerge
documents:

- `NotebookDoc` carries cells, source text, durable metadata, attachments, and
  the current per-cell `execution_id` pointer.
- `RuntimeStateDoc` carries kernel lifecycle, queue state, executions, outputs,
  widget comm state, environment state, trust state, and project context.

That split is still the right boundary. The missing piece is identity.

Desktop currently creates a `RuntimeStateDoc` because a `NotebookRoom` exists.
The room owns `doc: NotebookDoc` and `state: RuntimeStateDoc` as sibling fields.
Cloud similarly records a published snapshot pair by notebook id, notebook heads,
runtime-state heads, and object keys. In both cases, the runtime-state document is
paired operationally, but the notebook document itself does not identify the
runtime-state document that belongs with it.

That becomes brittle once hosted notebooks load Automerge directly:

- A browser bootstrap should not need a separate "outer document" just to know
  which runtime-state document resolves outputs and widgets for a notebook.
- Object storage wants document-id namespaces for snapshots and incrementals,
  not runtime-state snapshots nested forever under a notebook path.
- Auth and sharing remain notebook-oriented, but the host needs to fetch two
  Automerge documents as one authorized renderable pair.
- Desktop needs the same vocabulary before runtime state becomes more durable.

## Decision

`NotebookDoc` carries the authoritative pointer to its current runtime-state
document.

```text
NotebookDoc/
  schema_version
  notebook_id
  runtime_state_doc_id
  cells/
  metadata/

RuntimeStateDoc/
  schema_version
  runtime_state_doc_id
  notebook_id
  kernel/
  queue/
  executions/
  env/
  trust/
  project_context/
  display_index/
  comms/
```

The pointer is document identity. It is not a heads hash and it is not a storage
object key.

Heads remain version coordinates owned by checkpoint, publish, and storage
metadata:

```text
notebook_doc_id
notebook_heads_hash
runtime_state_doc_id
runtime_state_heads_hash
notebook_snapshot_key
runtime_state_snapshot_key
```

The canonical lookup direction is:

```text
NotebookDoc -> RuntimeStateDoc
```

`RuntimeStateDoc` may carry `runtime_state_doc_id` as its self identity and an
optional `notebook_id` backlink when it is attached to a notebook. The backlink
is provenance and validation context, not a required part of runtime-state
identity. Authorization for notebook-attached runtime state flows through the
notebook and its ACL.

## Consequences

### NotebookDoc schema changes

`NotebookDoc` needs a schema bump for `runtime_state_doc_id`.

The field belongs at the root next to `notebook_id`, not under user-facing
Jupyter metadata. It is CRDT topology: the identity of the second document
needed to render the first document's current runtime state.

Older `NotebookDoc` values that do not contain the field are migrated by minting
a runtime-state document id and writing it into the notebook document with the
daemon/system actor.

### RuntimeStateDoc schema changes

`RuntimeStateDoc` should gain root identity fields:

- `runtime_state_doc_id`
- `notebook_id` (optional backlink for notebook-attached runtime state)

These fields make storage, diagnostics, and cloud bootstrap validation cheaper.
The runtime-state id is the document's own identity. The notebook backlink is an
advisory check against loading the wrong pair and must remain optional so the
same document shape can support markdown-associated runtime state or standalone
runtime state.

### Desktop room construction changes

Desktop keeps `NotebookRoom { doc, state }`, but `state` is resolved through the
notebook document:

1. Load or create `NotebookDoc`.
2. Read `NotebookDoc.runtime_state_doc_id`.
3. If missing, mint a runtime-state document id and write it into `NotebookDoc`.
4. Load the matching `RuntimeStateDoc` if present; otherwise create one with the
   same runtime-state id and the optional notebook backlink.
5. Continue syncing `NotebookDoc` on frame `0x00` and `RuntimeStateDoc` on frame
   `0x05`.

This does not require combining the documents or changing the typed-frame
protocol.

### Cloud bootstrap changes

The hosted route remains notebook-oriented:

```text
/n/{notebookDocId}/{vanityName}
```

Bootstrap resolves the pair this way:

1. Authenticate the user.
2. Authorize the user against the notebook ACL.
3. Load the latest authorized `NotebookDoc` snapshot.
4. Read `runtime_state_doc_id` from `NotebookDoc`.
5. Load the checkpointed `RuntimeStateDoc` snapshot with that id and matching
   recorded heads. If the runtime-state snapshot has a `notebook_id` backlink,
   validate it against the loaded notebook; if it does not, treat the
   `NotebookDoc.runtime_state_doc_id` pointer as the association.
6. Render from the two local Automerge documents.
7. Open live sync for both documents.

The checkpoint/catalog row is still necessary because a runtime-state document
id alone does not identify a point-in-time rendering. The coherent renderable
state is the pair of document ids plus their heads.

### Object storage changes

Object storage should move toward document-id namespaces:

```text
docs/{docId}/snapshot/{headsHash}.am
docs/{docId}/incremental/{chunkHash}.amdelta
blobs/{sha256}
```

This mirrors the upstream `automerge-repo` storage shape: storage is organized
by document id, snapshot chunks are loaded before incremental chunks, and
`loadIncremental` can materialize the document from that byte stream.

The current cloud R2 layout remains a compatibility path:

```text
n/{notebookId}/snapshots/{notebookHeadsHash}.am
n/{notebookId}/snapshots/runtime-state/{runtimeHeadsHash}.am
```

New code should not deepen that nesting. It makes the runtime-state document
look like a file inside the notebook instead of a first-class Automerge document
associated by the notebook model.

## Rejected Alternatives

### Keep the association only in the cloud catalog

Rejected. It keeps desktop and cloud terminology divergent and requires an
outer bootstrap record to answer a model question the notebook document should
own.

The catalog still records exact checkpoint heads and storage keys, but it should
not be the only place that knows which runtime-state document belongs to a
notebook.

### Store runtime-state heads in NotebookDoc

Rejected. Heads change whenever runtime state changes. Storing runtime heads in
`NotebookDoc` would create write amplification and would make every progress
bar, output stream, widget update, and execution-status transition potentially
dirty the notebook document.

The notebook needs to know the document id. Checkpoints need to know heads.

### Use Automerge refs as the association

Rejected for now. Automerge refs are useful for paths inside an Automerge
document and for fixed-head views, but the notebook/runtime association is a
typed cross-document relationship with authorization consequences. A plain root
field is easier to validate, migrate, and expose across Rust, WASM, Python, and
cloud workers.

### Combine NotebookDoc and RuntimeStateDoc

Rejected. The split is load-bearing:

- notebook edits and runtime outputs have different write cadence;
- notebook fields and runtime fields have different write authorities;
- `.ipynb` export needs durable cell/source metadata without queue/kernel state;
- hosted authorization needs editors to write notebook fields without gaining
  runtime authority.

The identity pointer fixes association without erasing the boundary.

## Migration Plan

1. Add typed accessors for `NotebookDoc.runtime_state_doc_id` and bump the
   notebook schema.
2. Add typed self-identifying fields to `RuntimeStateDoc`.
3. During room creation/load, mint and persist a runtime-state document id when
   opening an older notebook document.
4. Keep the existing sync streams and room shape while changing how
   `NotebookRoom.state` is initialized.
5. Add `runtime_state_doc_id` to cloud revision/catalog metadata.
6. Teach cloud materialization to prefer the pointer and retain legacy nested
   runtime-state snapshot fallback.
7. Move new object snapshots toward `docs/{docId}/snapshot/{headsHash}.am`.
8. Evaluate incremental object chunks only after snapshot-pair bootstrap is
   measured.

## Compatibility

Older notebooks without `runtime_state_doc_id` remain valid. The daemon mints
and writes the missing id before peers rely on runtime state.

Existing cloud revisions remain readable by synthesizing a stable legacy
runtime-state id from the notebook id while continuing to read the old nested R2
keys. New revisions should write the explicit id.

The typed-frame wire format does not change. Peers still sync the notebook doc
and runtime-state doc over separate frame types.

## Open Questions

1. Should document ids use the existing nteract UUID/ULID style or Automerge's
   base58check document id format? The first implementation should choose one
   typed `RuntimeStateDocId` wrapper and avoid exposing storage paths as ids.
2. Does "clear outputs/runtime state" clear the existing runtime-state document
   or rotate `runtime_state_doc_id`? Restarting a kernel should not rotate it.
3. Should duplicate/fork notebook flows copy the runtime-state document for a
   snapshot fork or mint a fresh runtime-state document for a clean working
   copy? This likely needs explicit product behavior.
4. How durable should desktop runtime state become? This ADR makes identity
   durable first; persistence can follow without changing the association model.

## References

- [The Three-Document Split](three-document-split.md)
- [Hosted Notebook Artifacts](hosted-notebook-artifacts.md)
- [Blob Storage and Content Addressing](blob-storage-and-content-addressing.md)
- [Typed-frame v4 wire protocol](typed-frame-v4-wire-protocol.md)
- `crates/notebook-doc/src/lib.rs`
- `crates/runtime-doc/src/doc.rs`
- `crates/runtimed/src/notebook_sync_server/room.rs`
- `apps/notebook-cloud/src/storage.ts`
- `apps/notebook-cloud/src/room-materializer.ts`
