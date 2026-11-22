# Runtime State Document Identity

**Status:** Accepted, 2026-05-29. Implemented with schema v5 (`NotebookDoc.runtime_state_doc_id` and `RuntimeStateDoc` self-identity).

## Context

nteract keeps notebook state and runtime state in separate Automerge documents:

- `NotebookDoc` holds cells, source text, durable metadata, attachments, and each cell's current `execution_id` pointer.
- `RuntimeStateDoc` holds kernel lifecycle, queue state, executions, outputs, widget comm topology, environment state, trust state, and project context. Mutable widget comm state lives in `CommsDoc`.

That split is the right boundary. Before schema v5, the missing piece was identity.

Previously, desktop created a `RuntimeStateDoc` whenever a `NotebookRoom` opened, storing `doc: NotebookDoc` and `state: RuntimeStateDoc` as sibling fields. Cloud recorded published snapshot bundles by notebook id, notebook heads, runtime-state heads, optional `CommsDoc` heads, and object keys. Both paired the two documents operationally, but `NotebookDoc` did not identify its `RuntimeStateDoc`.

That operational pairing broke down once hosted notebooks loaded Automerge directly:

- Browser bootstrap should not need an outer record just to find which runtime-state document resolves outputs and widgets.
- Object storage needs document-id namespaces for snapshots and incrementals, not runtime-state snapshots nested under a notebook path forever.
- Auth and sharing stay notebook-oriented, yet the host must fetch both Automerge documents as one authorized renderable pair.
- Desktop needed the same identity vocabulary before runtime state could become durable.

## Decision

`NotebookDoc` carries the authoritative pointer to its current runtime-state document.

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
  kernel/
  queue/
  executions/
  env/
  trust/
  project_context/
  display_index/
  comms/
```

The pointer is document identity, not a heads hash or storage object key.

Heads remain version coordinates owned by checkpoint, publish, and storage metadata:

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

`RuntimeStateDoc` carries `runtime_state_doc_id` as its self-identity when known. It carries no notebook backlink. Authorization for notebook-attached runtime state flows through the notebook and its ACL because `NotebookDoc` owns the association.

## Consequences

### NotebookDoc schema

`NotebookDoc` schema v5 stores `runtime_state_doc_id` at the root next to `notebook_id`, not under user-facing Jupyter metadata. The field is CRDT topology: it names the second document required to render current runtime state.

Older `NotebookDoc` documents missing the field migrate on load. The daemon or system actor mints a runtime-state document id and writes it into `NotebookDoc`.

### RuntimeStateDoc schema

`RuntimeStateDoc` carries a root `runtime_state_doc_id` field for its own identity. This simplifies storage, diagnostics, and cloud bootstrap validation.

Notebook association remains in `NotebookDoc.runtime_state_doc_id` and catalog or checkpoint metadata. That keeps the same `RuntimeStateDoc` shape usable for markdown-associated or standalone runtime state later.

### Desktop room construction

Desktop keeps `NotebookRoom { doc, state }`, resolving `state` through `NotebookDoc`:

1. Load or create `NotebookDoc`.
2. Read `NotebookDoc.runtime_state_doc_id`.
3. If missing, mint a runtime-state document id and write it into `NotebookDoc`.
4. Load the matching `RuntimeStateDoc` if present, or create one with that id.
5. Sync `NotebookDoc` on frame `0x00` and `RuntimeStateDoc` on frame `0x05`.

The documents stay separate and the typed-frame wire protocol does not change.

### Cloud bootstrap

Hosted routes remain notebook-oriented:

```text
/n/{notebookDocId}/{vanityName}
```

Bootstrap resolves the document pair in seven steps:

1. Authenticate the user.
2. Authorize the user against the notebook ACL.
3. Load the latest authorized `NotebookDoc` snapshot.
4. Read `runtime_state_doc_id` from `NotebookDoc`.
5. Load the checkpointed `RuntimeStateDoc` snapshot with that id and matching recorded heads. Use `NotebookDoc.runtime_state_doc_id` as the association; do not require or write a notebook backlink.
6. Render from the two local Automerge documents.
7. Open live sync for both documents.

The checkpoint or catalog row remains required. A runtime-state document id alone does not pin a point-in-time rendering; coherent state requires both document ids and their heads.

### Object storage

Target object storage uses document-id namespaces:

```text
docs/{docId}/snapshot/{headsHash}
docs/{docId}/incremental/{chunkHash}
blobs/{sha256}
```

This mirrors upstream `automerge-repo` logical storage: keys are grouped by document id, snapshots load before incrementals, and Automerge materializes from that byte stream. Path segments are the convention; this ADR defines no `.amdelta` file extension.

Hosted storage writes compact snapshots only. Incremental object chunks wait until snapshot-pair bootstrap is measured; live deltas stay in room sync-protocol memory until then.

Cloud R2 storage currently uses a hybrid layout. Notebook snapshots keep the compatibility path while runtime-state snapshots use the first-class document-id namespace:

```text
n/{notebookId}/snapshots/{notebookHeadsHash}.am
docs/{runtimeStateDocId}/snapshots/{runtimeHeadsHash}.am
```

Legacy nested runtime-state keys remain read-only fallbacks for older revision rows. New writes never deepen the old nesting because `RuntimeStateDoc` is a first-class Automerge document associated by `NotebookDoc`, not a file inside the notebook.

## Rejected Alternatives

### Keep the association only in the cloud catalog

Rejected. Desktop and cloud terminology would stay divergent, and an outer bootstrap record would own a relationship that belongs in `NotebookDoc`. The catalog still tracks checkpoint heads and storage keys, not document association alone.

### Store runtime-state heads in NotebookDoc

Rejected. Runtime heads change on every progress bar, output stream, widget update, and status transition. Storing them in `NotebookDoc` would cause write amplification and dirty the notebook document on runtime churn. `NotebookDoc` holds document identity; checkpoints hold heads.

### Use Automerge refs as the association

Rejected for now. Automerge refs fit intra-document paths and fixed-head views. The notebook-to-runtime link is a typed cross-document association with authorization impact. A plain root field is simpler to validate, migrate, and expose across Rust, WASM, Python, and cloud workers.

### Combine NotebookDoc and RuntimeStateDoc

Rejected for four reasons:

- Notebook edits and runtime outputs have different write cadences.
- Notebook fields and runtime fields have different write authorities.
- `.ipynb` export needs durable cell and source metadata without queue or kernel state.
- Hosted authorization lets editors write notebook fields without gaining runtime authority.

The identity pointer fixes association without erasing that boundary.

## Migration Plan

Status as of 2026-05-31:

1. `NotebookDoc.runtime_state_doc_id` shipped in `NotebookDoc` schema v5.
2. `RuntimeStateDoc` carries its self-identity when known.
3. Room creation and load mint and persist a runtime-state document id for older notebook documents.
4. Typed-frame streams remain split: `NotebookDoc` and `RuntimeStateDoc` sync over separate frame types.
5. Cloud revision and catalog metadata record `runtime_state_doc_id` and the concrete `runtime_snapshot_key`.
6. New cloud runtime snapshots write to `docs/{runtimeStateDocId}/snapshots/{headsHash}.am`; notebook snapshots remain under `n/{notebookId}/snapshots/{headsHash}.am`.
7. Legacy nested runtime-state snapshot keys remain readable when recorded on existing revision rows.
8. Incremental object chunks remain deferred until snapshot-pair bootstrap is measured.

## Compatibility

Older notebooks without `runtime_state_doc_id` remain valid. The daemon mints and writes the missing id before peers rely on runtime state.

Existing cloud revisions remain readable by synthesizing a stable legacy runtime-state id from the notebook id while reading older nested R2 keys. New revisions write the explicit id.

The typed-frame wire format is unchanged. Peers continue syncing `NotebookDoc` and `RuntimeStateDoc` over separate frame types.

## Open Follow-ups

- Decide whether public notebook routes keep the nteract UUID/ULID style while Automerge references accept or normalize Automerge's base58check `automerge:` URL format at API boundaries. Keep a typed `RuntimeStateDocId` wrapper and never expose storage paths as ids.
- Decide whether "clear outputs/runtime state" clears the existing `RuntimeStateDoc` or rotates `runtime_state_doc_id`. Kernel restarts must not rotate the id.
- Define product behavior for duplicate and fork flows: copy `RuntimeStateDoc` for a snapshot fork, or mint a fresh `RuntimeStateDoc` for a clean working copy.
- Decide how durable desktop runtime state should become. Identity is now durable; persistence can follow without changing the association model.

## References

- [The Document Split](document-split.md)
- [ADR 0002: CommsDoc split](0002-comms-document-split.md)
- [Hosted Notebook Artifacts](hosted-notebook-artifacts.md)
- [Blob Storage and Content Addressing](blob-storage-and-content-addressing.md)
- [Typed-frame v4 wire protocol](typed-frame-v4-wire-protocol.md)
- `crates/notebook-doc/src/lib.rs`
- `crates/runtime-doc/src/doc.rs`
- `crates/runtimed/src/notebook_sync_server/room.rs`
- `apps/notebook-cloud/src/storage.ts`
- `apps/notebook-cloud/src/room-materializer.ts`
