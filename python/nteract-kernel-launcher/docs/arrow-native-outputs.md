# Arrow-Native Notebook Outputs

Issue: https://github.com/nteract/desktop/issues/1816

This plan updates the post-#2629/#2630/#2632 architecture direction. The short
version: Arrow IPC stream should become the canonical rich table output for
notebooks. Parquet should remain a supported input/rendering format and a
backward-compatibility path for already-saved notebooks, but new pandas, polars,
pyarrow, narwhals, and Hugging Face table outputs should converge on Arrow IPC.

## Research Constraints

- Arrow IPC has a streaming format for an arbitrary sequence of record batches
  and a file/random-access format for a fixed set of batches. The stream format
  is schema-first and must be read in order, which matches progressive notebook
  rendering better than parquet's footer-oriented layout.
  <https://arrow.apache.org/docs/python/ipc.html>
- Arrow IPC stream writers are intended to write batches to any writable sink,
  including sockets and other streaming IO. That is the right shape for a future
  kernel-to-daemon chunk protocol.
  <https://arrow.apache.org/docs/python/ipc.html>
- PyArrow preserves pandas index information in Arrow schema metadata. With the
  default `preserve_index=None`, RangeIndex is metadata-only, while other index
  types become physical columns tracked by the schema metadata.
  <https://arrow.apache.org/docs/python/pandas.html>
- Polars exposes Arrow IPC stream IO directly (`write_ipc_stream` /
  `read_ipc_stream`), so polars does not need parquet as an intermediate
  notebook output format.
  <https://docs.pola.rs/api/python/dev/reference/api/polars.DataFrame.write_ipc_stream.html>
  <https://docs.pola.rs/api/python/stable/reference/api/polars.read_ipc_stream.html>
- Jupyter-compatible incremental replacement is `display_id` plus
  `update_display_data`. It can carry the same MIME-bundle shape as
  `display_data`, so it is the compatibility bridge for progressive updates
  while plain notebooks keep `text/plain` / `text/html` fallbacks.
  <https://jupyter-client.readthedocs.io/en/latest/messaging.html>

## Current Merged State

The launcher registers lazy IPython `mimebundle_formatter` handlers in
`nteract_kernel_launcher/_bootstrap.py` for pandas, polars, narwhals,
`pyarrow.Table`, `pyarrow.RecordBatch`, and Hugging Face datasets.

Today rich table outputs are stored as content-addressed blobs via
`application/vnd.nteract.blob-ref+json`:

```json
{
  "application/vnd.nteract.blob-ref+json": {
    "hash": "sha256...",
    "content_type": "application/vnd.apache.arrow.stream",
    "size": 12345,
    "summary": {
      "total_rows": 1000,
      "included_rows": 1000,
      "sampled": false,
      "sample_strategy": "none"
    },
    "buffer_index": 0
  },
  "text/llm+plain": "..."
}
```

The daemon preflights attached buffers into the blob store, promotes the wrapped
`content_type` into the manifest data map, and lifts blob-ref `summary` / `query`
hints into `metadata[content_type].nteract`. Save resolution externalizes
`application/vnd.apache.arrow.stream` and `application/vnd.apache.parquet` back
to a single blob-ref MIME so saved `.ipynb` files do not base64-inline large
table bytes.

`application/vnd.apache.arrow.stream` is already first-class across runtime MIME
priority, notebook rendering, MCP rendering, Sift plugin loading, and Sift/WASM
schema hints. `nteract-predicate` now owns the canonical pandas/Hugging Face
schema interpretation for both parquet metadata and Arrow IPC schema metadata.

The remaining asymmetry is Python-side production:

- `pyarrow.Table`, `pyarrow.RecordBatch`, and materialized Hugging Face datasets
  emit Arrow IPC stream bytes.
- pandas and polars still emit parquet.
- Sift can render Arrow IPC, but buffers complete Arrow IPC bytes before loading
  them into WASM.
- The blob-ref MIME points at one complete blob, not a chunk manifest.

## Target Architecture

### Canonical Output Format

New rich table display outputs should prefer:

```text
application/vnd.apache.arrow.stream
```

for:

- pandas `DataFrame`
- polars `DataFrame`
- narwhals dataframes once normalized to an Arrow-capable backend
- `pyarrow.Table`
- `pyarrow.RecordBatch`
- Hugging Face datasets backed by an Arrow table

Parquet remains supported for:

- old notebooks with parquet blob refs
- external parquet URLs/datasets opened in Sift
- explicit user persistence/export workflows
- fallback only when Arrow IPC serialization is unavailable but parquet succeeds

Do not make parquet a second preferred producer format for notebook display
outputs. Maintaining two first-class producer formats makes metadata and
streaming behavior harder to reason about.

### Python Serialization Policy

pandas should convert through PyArrow and write Arrow IPC stream bytes:

```python
table = pa.Table.from_pandas(df)  # keep pandas schema metadata
with pa.ipc.new_stream(sink, table.schema) as writer:
    writer.write_table(table)
```

Do not use `preserve_index=False` for the canonical path. It removes index
metadata that Arrow can preserve for us. Let the default preserve policy keep
RangeIndex metadata-only and materialize non-range indexes as tracked columns.

polars should write Arrow IPC stream bytes directly:

```python
df.write_ipc_stream(buf)
```

If polars compatibility or compression flags become unstable across versions,
the fallback should be text/HTML summary first, not silent metadata loss.
Parquet fallback is acceptable only as an explicit compatibility fallback with a
different `content_type`.

narwhals should prefer a backend-native Arrow path before converting to pandas.
Only fall back to pandas conversion if the backend lacks a stable Arrow export.

### Metadata Ownership

Keep metadata normalization out of TypeScript:

- Python emits source facts it knows cheaply: total rows, included rows, sample
  strategy, backend flavor, and source display type.
- Rust validates and canonicalizes schema-derived facts in `nteract-predicate`:
  pandas index columns, Hugging Face rich types, index display hints, semantic
  column types.
- WASM/Sift consumes canonical hints and applies user/display overrides after
  schema hints.
- `repr_llm` and MCP should use the same predicate crate rather than inventing a
  separate table-metadata parser.

The MIME metadata namespace should stay:

```json
{
  "metadata": {
    "application/vnd.apache.arrow.stream": {
      "nteract": {
        "summary": { "total_rows": 1000, "included_rows": 1000 },
        "table": {
          "format": "arrow-ipc-stream",
          "producer": "pandas",
          "schema_hash": "sha256..."
        }
      }
    }
  }
}
```

`summary` remains small and stable. `table` can evolve as a nteract-specific
metadata object without changing the raw Arrow IPC payload.

## Chunked Arrow Over CAS

The right streaming unit is not "chunked parquet." It is an ordered Arrow stream
manifest whose parts are content-addressed Arrow IPC chunks.

### Durable Manifest MIME

Add a new nteract-specific MIME:

```text
application/vnd.nteract.arrow-stream-manifest+json
```

Shape:

```json
{
  "version": 1,
  "content_type": "application/vnd.apache.arrow.stream",
  "schema": {
    "hash": "sha256...",
    "content_type": "application/vnd.apache.arrow.schema+json",
    "fields": 12,
    "metadata": {
      "pandas": true,
      "huggingface": true
    }
  },
  "chunks": [
    {
      "index": 0,
      "hash": "sha256...",
      "size": 98304,
      "row_count": 4096,
      "record_batch_count": 4,
      "encoding": "arrow-ipc-stream-fragment"
    }
  ],
  "complete": true,
  "summary": {
    "total_rows": 1000000,
    "included_rows": 4096,
    "sampled": true,
    "sample_strategy": "head"
  }
}
```

The manifest is JSON and can live inline in the output manifest. The large bytes
remain in ordinary CAS blobs. This keeps the notebook document small while still
giving renderers enough structure to fetch and append parts.

### Chunk Boundaries

Each chunk must be independently valid enough for Rust/WASM to validate:

- The first chunk should carry the stream schema and the first batch sequence.
- Later chunks should align to Arrow IPC message / record-batch boundaries.
- A chunk must never split an Arrow IPC message across blobs.
- If dictionary encoding is used, dictionary batches must be present before
  record batches that reference them in any independently decoded segment.

The first implementation can avoid the hard dictionary problem by making each
chunk a small self-contained Arrow IPC stream with the same schema. That is less
compact than one long stream, but it is much simpler for CAS, retries, and
renderer append. Once stable, we can consider a lower-level message-fragment
format.

### CAS Write Model

The existing `BlobStore::put(bytes, media_type)` is correct for complete chunks.
It is not enough for progressive writes because the final hash is known only
after bytes are complete.

Add a small daemon-side staging API:

1. Python emits or uploads one complete chunk at a time.
2. Daemon stores each chunk with ordinary `BlobStore::put`.
3. Daemon returns the content hash, size, and media type.
4. Python sends `display_data` for the first manifest and `update_display_data`
   for later manifest revisions.

This avoids "mutable blobs" and keeps CAS immutable. We do not need a provisional
hash if the staging unit is a complete Arrow chunk.

For kernel transport, there are two viable paths:

- **Near-term:** keep using attached Jupyter buffers and blob-ref preflight for
  each manifest update. This reuses the current kernel path.
- **Durable:** add a runtime request/typed frame such as `PutBlob` or
  `PutBlobChunk` so Python can upload chunk bytes directly to the daemon before
  publishing the display manifest.

The durable path is better because it removes large binary payloads from the
IOPub message stream and can be reused by other large-output producers.

### Display Update Flow

Use Jupyter-compatible display updates:

1. Formatter creates a display id, writes the first chunk, and emits
   `display_data` with:
   - `application/vnd.nteract.arrow-stream-manifest+json`
   - `text/plain` and/or `text/html` fallback
   - `transient.display_id`
2. As later chunks complete, Python emits `update_display_data` with the same
   display id and a manifest containing the appended chunk list.
3. Daemon updates all matching output manifests through the existing
   `display_index` path.
4. Frontend sees the manifest revision and appends only new chunks.
5. The final update sets `complete: true`.

Plain Jupyter frontends will render the fallback MIME. nteract frontends will
prefer the manifest MIME.

## Sift/WASM Runtime Plan

Today `SiftTable` buffers Arrow IPC bytes and calls `load_ipc(bytes)`. The
streaming path needs a store that can append batches:

```ts
const handle = mod.create_arrow_stream_store(schemaBytes);
for (const chunk of chunks) {
  mod.append_arrow_stream_chunk(handle, chunk.bytes);
  tableData.rowCount = mod.num_rows(handle);
  engine.onBatchAppended();
}
mod.finish_arrow_stream_store(handle);
```

Rust/WASM responsibilities:

- validate schema compatibility for each chunk
- append record batches into the existing store
- update row counts and summary invalidation incrementally
- expose chunk-level errors without destroying already-rendered rows
- keep the parquet row-group append path for old parquet inputs

Frontend responsibilities:

- fetch only chunks not already loaded
- preserve Sift engine state across manifest revisions
- avoid reloading the whole table when `chunks.length` grows
- mark the table complete only when `complete: true`
- keep `text/plain` fallback available when the plugin fails

## Phased Implementation

### Phase 1: Canonical Arrow For DataFrames

Goal: all new dataframe display outputs use Arrow IPC stream by default.

Changes:

- Change pandas `_serialize_pandas` to `pa.Table.from_pandas(df)` plus
  `pa.ipc.new_stream`.
- Change polars `_serialize_polars` to `df.write_ipc_stream`.
- Rename Python helpers from parquet-specific names to table/Arrow names where
  the behavior is now generic.
- Keep parquet deserialization/rendering paths untouched.
- Extend tests to assert pandas schema metadata survives and pandas index hints
  are promoted through `nteract-predicate`.
- Add polars IPC test coverage when polars is installed.

Acceptance:

- pandas, polars, pyarrow table, record batch, and Hugging Face dataset outputs
  all produce `application/vnd.apache.arrow.stream`.
- Existing parquet notebook fixtures still render.
- Saved notebooks still contain simple `text/plain` / `text/html` fallbacks plus
  nteract blob refs.

### Phase 2: Manifest MIME Without Streaming

Goal: introduce the manifest shape without changing producer timing.

Changes:

- Add `application/vnd.nteract.arrow-stream-manifest+json` to MIME priority and
  Sift routing.
- Allow a manifest with exactly one complete Arrow IPC chunk.
- Teach runtime save/load to externalize manifest chunk blobs.
- Teach Sift to load a single manifest chunk into the existing `load_ipc` path.

Acceptance:

- Manifest output and direct Arrow IPC output render identically.
- Saved notebooks round-trip manifest outputs.
- MCP/repr paths can summarize from the manifest metadata without fetching all
  bytes.

### Phase 3: Appendable Sift Store

Goal: Sift can append Arrow chunks without reloading prior data.

Changes:

- Add WASM APIs for `create_arrow_stream_store`, `append_arrow_stream_chunk`,
  and `finish_arrow_stream_store`.
- Implement schema compatibility checks in Rust.
- Update Sift table data to invalidate summaries incrementally.
- Add tests for two chunks, schema mismatch, partial failure, and preserving
  sort/filter state across appends.

Acceptance:

- A table can show the first chunk and grow as subsequent chunks arrive.
- Existing row-group parquet loading is unaffected.

### Phase 4: Python Progressive Producer

Goal: Python can publish first page quickly, then append chunks.

Changes:

- Add a chunk writer abstraction in `nteract_kernel_launcher`.
- Use `display_id` and `update_display_data` for progressive manifest updates.
- For pandas/polars eager dataframes, chunk rows after conversion.
- For Arrow-native sources, write record batches directly.
- For large or lazy sources, publish batches as they are produced.

Acceptance:

- A large Arrow table displays first rows before the whole table is serialized.
- Final manifest is complete and durable.
- Vanilla notebook fallback remains simple and stable.

### Phase 5: Direct Daemon Blob Upload

Goal: avoid pushing large binary chunks through Jupyter IOPub buffers.

Changes:

- Add a daemon/client request for content-addressed blob upload.
- Expose it through the Python runtime package or launcher bootstrap.
- Keep the attached-buffer path as a compatibility fallback.
- Consider shared protocol with planned `PutBlob` typed frames.

Acceptance:

- Chunks can be stored before the display message references them.
- Hash mismatch, missing blob, and upload failure are explicit errors.
- The manifest never references bytes that the daemon failed to store.

## Backward Compatibility

- Existing `.ipynb` files with parquet blob refs continue to load and render.
- Existing `.ipynb` files with direct Arrow IPC blob refs continue to load and
  render.
- New manifest outputs must save as ordinary JSON plus nteract blob refs, with
  fallback text/html MIME for non-nteract frontends.
- The old parquet MIME stays in Sift and MIME priority, but new Python producers
  stop choosing it by default.
- `update_display_data` without a matching display id should keep current
  behavior: no destructive append, no new orphaned manifest.

## Testing Strategy

Python:

- pandas Arrow IPC output includes pandas schema metadata.
- pandas RangeIndex remains metadata-only; non-range index is represented and
  hinted correctly.
- polars output emits Arrow IPC stream.
- downsampled outputs carry consistent `included_rows` and `sampled` hints.
- fallback still produces `text/llm+plain` when Arrow serialization fails.

Rust:

- `nteract-predicate` parses Arrow IPC schema metadata for pandas and Hugging
  Face hints.
- output store save/load externalizes direct Arrow IPC, parquet, and manifest
  chunks.
- update-display-data preserves metadata hints for manifest revisions.
- blob upload rejects hash mismatches and missing chunks.

WASM/Sift:

- direct Arrow IPC renders.
- one-chunk manifest renders.
- multi-chunk manifest appends without full reload.
- filters/sorts survive append or are explicitly invalidated.
- schema mismatch produces a visible table error with already-loaded rows left
  intact.

Notebook/E2E:

- plain pandas display renders in nteract and saves with fallback MIME.
- old parquet notebook fixture renders.
- progressive output displays first chunk, then final row count after updates.
- reopened notebook resolves manifest chunk blobs from CAS.

## Open Decisions

- Compression: use uncompressed Arrow IPC first for simpler chunk validation, or
  enable lz4/zstd once reader support is confirmed across Rust/WASM.
- Chunk unit: start with self-contained Arrow IPC streams per chunk, then
  optimize to lower-level IPC message fragments later if needed.
- Index display: preserve pandas metadata by default, but decide whether
  non-range index columns should be hidden, pinned, or visibly labeled in Sift.
- Upload API: attached Jupyter buffers are enough for Phase 2/3; direct daemon
  blob upload should be the durable design before large streaming ships.
- Maximum chunk size: choose a target well below `BlobStore::MAX_BLOB_SIZE`
  (for example 4-16 MiB) to balance CAS overhead, first paint, and WASM append
  cost.
