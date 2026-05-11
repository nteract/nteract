# Arrow-Native Notebook Outputs

Issue: https://github.com/nteract/desktop/issues/1816

This plan updates the post-#2629/#2630/#2632 architecture direction. The short
version: Arrow IPC stream should become the canonical rich table output for
notebooks. Parquet should remain a supported input/rendering format and a
backward-compatibility path for already-saved notebooks, but new pandas, polars,
pyarrow, narwhals, and Hugging Face table outputs should converge on Arrow IPC.
The phases below are intended as targeted commits in this PR, not separate PRs.

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
  <https://docs.pola.rs/api/python/stable/reference/api/polars.DataFrame.write_ipc_stream.html>
  <https://docs.pola.rs/api/python/stable/reference/api/polars.read_ipc_stream.html>
- The Arrow PyCapsule interface standardizes Python export methods such as
  `__arrow_c_stream__()` and the `arrow_array_stream` capsule name. This gives
  the launcher a producer-neutral path for pandas, polars, pyarrow, DuckDB,
  cuDF, narwhals, and other Arrow-compatible DataFrames without depending on
  producer-specific `_export_to_c` or PyArrow-only object types.
  <https://arrow.apache.org/docs/format/CDataInterface/PyCapsuleInterface.html>
- The Arrow C stream interface is a pull stream of chunks with a shared schema:
  consumers call `get_next` serially until end-of-stream. That maps cleanly to a
  Python `RecordBatchReader`, but it also means a producer stream should be
  treated as single-pass unless a library documents replay support.
  <https://arrow.apache.org/docs/format/CStreamInterface.html>
- Polars, pandas, DataFusion, DuckDB relations, narwhals wrappers, pyarrow
  tables, and pyarrow record-batch readers all expose or consume this protocol
  in current releases. The implementation should therefore avoid hardcoding a
  small producer list and instead treat `__arrow_c_stream__()` as the broad
  dataframe/table acceptance path.
  <https://docs.pola.rs/user-guide/misc/arrow/>
  <https://pandas.pydata.org/docs/dev/reference/api/pandas.DataFrame.from_arrow.html>
  <https://datafusion.apache.org/python/user-guide/io/arrow.html>
- Nanoarrow is a useful reference for lightweight Python consumers/producers of
  Arrow PyCapsule streams. It reinforces that the PyCapsule protocol is the
  interchange surface, while IPC serialization is a separate transport/storage
  decision.
  <https://arrow.apache.org/nanoarrow/latest/getting-started/python.html>
- Jupyter-compatible incremental replacement is `display_id` plus
  `update_display_data`. It can carry the same MIME-bundle shape as
  `display_data`, so it is the compatibility bridge for progressive updates
  while plain notebooks keep `text/plain` / `text/html` fallbacks.
  <https://jupyter-client.readthedocs.io/en/latest/messaging.html>

## Current Merged State

The launcher registers lazy IPython `mimebundle_formatter` handlers in
`nteract_kernel_launcher/_bootstrap.py` for pandas, polars, narwhals,
`pyarrow.Table`, `pyarrow.RecordBatch`, and Hugging Face datasets.

Serialization helpers live in `nteract_kernel_launcher/_format.py`:

- `_serialize_pandas` writes parquet via
  `pa.Table.from_pandas(df, preserve_index=False)` plus
  `pq.write_table(..., compression="snappy")`.
- `_serialize_polars` writes parquet via
  `df.write_parquet(buf, compression="snappy")`.
- `_serialize_arrow_stream_table` already writes Arrow IPC stream bytes for
  `pyarrow.Table` and `pyarrow.RecordBatch`.
- `serialize_dataframe` returns `(bytes, PARQUET_MIME, included_rows)`. Phase 1
  flips that to `ARROW_STREAM_MIME` and removes `preserve_index=False`.

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

The primary producer contract should be the Arrow PyCapsule stream protocol:

```python
reader = pa.RecordBatchReader.from_stream(obj)  # consumes __arrow_c_stream__()
with pa.ipc.new_stream(sink, reader.schema) as writer:
    for batch in reader:
        writer.write_batch(batch)
```

This matches the DataFrame binding model used by Jupyter Scatter: pandas,
polars, and any DataFrame implementing the Arrow PyCapsule interface can be
handled through the same stream import path. Producer-specific logic should be
fallback or row-limiting glue, not the default serialization model.

Treat the imported `RecordBatchReader` as a potentially single-use source. For
the current one-shot path, it is fine to drain the reader into one complete IPC
stream. For the progressive path, the chunk writer should drain the same reader
incrementally and publish chunks as batches arrive; it should not first build a
complete IPC stream and then split the serialized bytes.

For older pandas versions that do not expose `__arrow_c_stream__`, convert
through PyArrow and write Arrow IPC stream bytes:

```python
table = pa.Table.from_pandas(df)  # keep pandas schema metadata
with pa.ipc.new_stream(sink, table.schema) as writer:
    writer.write_table(table)
```

Do not use `preserve_index=False` for the canonical path. It removes index
metadata that Arrow can preserve for us. Let the default preserve policy keep
RangeIndex metadata-only and materialize non-range indexes as tracked columns.

For older polars versions that do not expose `__arrow_c_stream__`, write Arrow
IPC stream bytes directly:

```python
df.write_ipc_stream(buf)
```

If polars compatibility or compression flags become unstable across versions,
the fallback should be text/HTML summary first, not silent metadata loss.
Parquet fallback is acceptable only as an explicit compatibility fallback with a
different `content_type`.

narwhals should prefer its native object when the native object implements
`__arrow_c_stream__`. Only fall back to pandas conversion if the backend lacks
a stable Arrow export.

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

`producer` is one of: `pandas`, `polars`, `pyarrow-table`,
`pyarrow-record-batch`, `huggingface`, or `narwhals/<backend>`. Renderers must
treat unknown values as opaque rather than failing.

Every manifest output must provide or preserve `text/plain` and
`text/llm+plain` summaries. `text/plain` is the user-facing fallback for
non-nteract Jupyter frontends. `text/llm+plain` stays the canonical short-form
summary for `repr_llm` and MCP, built from manifest `summary` / `table` facts so
consumers do not need to fetch chunk blobs. Manifest metadata is the source of
truth for row counts and shape; `text/llm+plain` is human-readable text derived
from those facts.

Follow-up after PR #2712: Arrow stream manifests now carry the first bounded
LLM hint directly on the manifest:

```json
{
  "schema": {
    "fields": 2,
    "columns": [
      { "name": "row_id", "type": "int64", "nullable": true },
      { "name": "event", "type": "large_string", "nullable": true }
    ]
  },
  "summary": { "total_rows": 2000000, "included_rows": 2000000 },
  "llm": {
    "content_type": "text/llm+plain",
    "text": "DataFrame (pyarrow): 2,000,000 rows × 2 columns\n..."
  }
}
```

This is intentionally small. It lets MCP / runtime bindings recover a useful
LLM table summary by reading only the manifest JSON if the sibling
`text/llm+plain` MIME is absent, without touching Arrow chunk blobs. If
`llm.text` is missing, the resolver can still synthesize a basic row/column/type
summary from `summary` and `schema.columns`. The richer future research path is
a structured `llm.columns[].stats` object derived from the existing Python-side
dataframe stat extractors and/or `nteract-predicate`, so consumers can avoid
parsing summary prose.

Follow-up after PR #2715: MCP already uses the LLM-selective resolver for cell
reads and execution results. Runtime bindings should expose the same cheap path
explicitly rather than asking consumers to call `get_cell()` / `getCell()` and
materialize every full output blob. The shared contract is:

- `runtimed-outputs::resolve_cell_output_texts_for_llm(raw_outputs, ctx)`
  resolves only LLM-facing text items.
- `runtimed-py` exposes `get_cell_output_text(cell_id)` and
  `get_cell_output_text_sync(cell_id)`.
- `@runtimed/node` exposes `getCellOutputText(cellId)`.

Those helpers return text items, not full MIME bundles. For Arrow manifest
tables, they read only the manifest JSON and use `llm.text` or the manifest
schema/summary fallback. Full-output APIs remain unchanged for UI clients and
users that need binary/image/table payloads.

### TABLE_REPR v1 Direction

The first richer LLM representation should still be cheap by default. Treat the
PyCapsule stream as the producer capture boundary, not as something to expose to
browser or agent clients. The wire artifact remains an Arrow stream manifest
plus derived text/JSON hints.

Proposed manifest shape:

```json
{
  "llm": {
    "repr_version": 1,
    "content_type": "text/llm+plain",
    "text": "TABLE_REPR v1\nshape: 2000000 rows x 10 columns\n...",
    "columns": [
      {
        "name": "row_id",
        "arrow_type": "int64",
        "nullable": false,
        "chunk_count": 16,
        "null_count": 0,
        "stats_quality": "cached"
      }
    ],
    "sample": {
      "strategy": "head+tail",
      "row_ranges": [[0, 4], [1999995, 1999999]]
    }
  }
}
```

Tier the work so maintenance stays reasonable:

- Tier 0: shape, schema, chunk count, byte sizes, included rows, total rows,
  sample policy, and stable row ranges. This is metadata-only and should always
  be available.
- Tier 1: cached Arrow facts such as known `null_count`, dictionary length, and
  pandas/Hugging Face schema metadata. Do not force scans to produce them.
- Tier 2: bounded sample rows. Make sample policy explicit; do not imply the
  sample is representative unless the producer actually sampled that way.
- Tier 3: exact min/max/distinct or richer sketches only for small data, cached
  producer stats, or explicit opt-in analysis.

The chunked aspect matters for both correctness and cost. A manifest summary can
describe all chunks without fetching them, while optional per-chunk summaries can
support later retrieval/ranking by row range. Consumers should never need to
decode all Arrow chunks just to decide what text to show an LLM.

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
    "content_type": "application/vnd.apache.arrow.schema",
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
  "coalesced": {
    "kind": "single_blob",
    "hash": "sha256...",
    "content_type": "application/vnd.apache.arrow.stream",
    "size": 12345678
  },
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

Hash domains:

- `schema.hash` covers the Arrow IPC schema message bytes (the leading
  message of an Arrow IPC stream) or another stable schema fingerprint chosen
  by the manifest producer. In the current implementation it is a fingerprint
  only, not a CAS blob reference. Save/load and GC must not rewrite it until a
  future schema-blob design stores schema bytes separately.
- Each `chunks[].hash` covers the bytes of the chunk blob the daemon stored
  via `BlobStore::put`. With self-contained per-chunk Arrow IPC streams (see
  "Chunk Boundaries"), `hash` covers a complete decodable mini-stream
  including the schema and any dictionary batches.

For v1, "schema compatibility" between chunks means byte-equal schema
fingerprints against the manifest's top-level schema hash. Promotable type
checks are deferred until we have a concrete reason for them.

### Stored Forms

The architecture has three related storage forms:

- **Progressive manifest:** the authoritative display state. It owns chunk
  order, row counts, completion/abort state, table hints, and optional
  coalesced artifact references.
- **Progressive chunks:** immutable CAS blobs, targeting 8 MiB before encoding
  overhead, stored as independently decodable Arrow IPC mini-streams.
- **Coalesced artifact:** an optional derived artifact written after completion
  for reopen/export/full-table operations. It is one Arrow IPC stream blob if
  the stream fits under `BlobStore::MAX_BLOB_SIZE`; otherwise it is a coalesced
  segment manifest whose segments are larger ordered Arrow IPC blobs.

### Chunk Boundaries

The chunking unit is one or more `RecordBatch` values pulled from a
`RecordBatchReader`, encoded as a self-contained Arrow IPC mini-stream. Do not
split already-serialized IPC bytes after the fact; that risks cutting through
message boundaries and dictionary state. The producer should instead:

1. Import the source object as a `RecordBatchReader` via `__arrow_c_stream__()`.
2. Read batches in order.
3. Accumulate batches until a byte or row budget is reached.
4. Write those batches to a new `pa.ipc.new_stream` sink using the shared
   schema.
5. Store that complete mini-stream as one immutable CAS chunk before publishing
   a manifest revision that references it.

Each stored chunk must be independently valid enough for Rust/WASM to validate:

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

Because PyCapsule streams can be single-pass, failed upload or render
publication should not require rewinding the source. The safe retry boundary is
the completed mini-stream bytes for the current chunk, not the upstream
`RecordBatchReader`.

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

The producer-side handshake is strict: upload chunk N, get its content hash
from the daemon, only then publish the next manifest revision listing chunk N.
A failed upload means the manifest revision is not emitted, so renderers
never see a chunk reference whose bytes the daemon did not store.

### Save Resolution

When the daemon writes the notebook to disk, it walks the manifest:

1. For each `chunks[].hash`, ensure the blob is in CAS, and rewrite the entry
   to a blob-ref form the on-disk loader can resolve back into bytes.
2. Apply the same transform to `coalesced.hash` and
   `coalesced.segments[].hash` when present.
3. Leave `schema.hash` unchanged because it is a fingerprint, not a stored
   schema blob.
4. Write the rest of the manifest (chunk metadata, summary, table hints)
   inline in the saved output JSON.

Load reverses the walk: blob refs in chunk/coalesced slots are resolved back
into hash + content_type before the manifest is handed to renderers. Missing
chunk blobs drop only the manifest MIME and preserve fallback siblings such as
`text/plain` / `text/llm+plain`. This keeps `.ipynb` files small without
inlining base64 chunk bytes.

### Coalesced Artifacts

After the progressive manifest reaches `complete: true`, the runtime may write a
derived coalesced artifact for efficient reopen, export, and full-table scans.
This is best-effort and must never block first render or progressive chunk
availability.

If the complete Arrow IPC stream is below `BlobStore::MAX_BLOB_SIZE`, the
coalesced artifact is a single CAS blob:

```json
{
  "kind": "single_blob",
  "hash": "sha256...",
  "content_type": "application/vnd.apache.arrow.stream",
  "size": 12345678
}
```

If the complete stream would exceed the blob limit, the coalesced artifact is a
segment manifest:

```json
{
  "kind": "segment_manifest",
  "content_type": "application/vnd.nteract.arrow-coalesced-segments+json",
  "segments": [
    {
      "index": 0,
      "hash": "sha256...",
      "content_type": "application/vnd.apache.arrow.stream",
      "size": 67108864,
      "row_count": 250000
    }
  ]
}
```

The progressive manifest remains the source of truth while output is still
growing. The coalesced artifact is derived and can be regenerated or omitted.

For kernel transport, there are two viable paths:

- **Near-term:** keep using attached Jupyter buffers and blob-ref preflight for
  each manifest update. This reuses the current kernel path.
- **Durable:** add a runtime request/typed frame such as `PutBlob` or
  `PutBlobChunk` so Python can upload chunk bytes directly to the daemon before
  publishing the display manifest.

The durable path is better because it removes large binary payloads from the
IOPub message stream and can be reused by other large-output producers.

### First Paint Strategy

Small tables should serialize once to Arrow IPC and emit a complete one-chunk
manifest. Large eager dataframes should emit `df.head(n)` as the first Arrow IPC
chunk, where `n` is chosen by byte budget, then continue producing chunks after
the first display is visible. Arrow-native and streaming sources should publish
the first available record batch or head chunk, then append later chunks as they
arrive.

The sub-200 ms first-render target applies after the dataframe/source object is
available and only to the head-sample path. pandas/polars cannot render before
an already-blocking dataframe conversion completes. The complete progressive
manifest and any coalesced artifact are follow-on work and must not block the
initial display.

### Display Update Flow

Use Jupyter-compatible display updates:

1. Formatter creates a display id, writes the first chunk, and emits
   `display_data` with:
   - `application/vnd.nteract.arrow-stream-manifest+json`
   - `text/plain` and/or `text/html` fallback
   - `transient.display_id`
2. As later chunks complete, Python emits `update_display_data` with the same
   display id and the full manifest revision, including every chunk emitted
   to date in order. Updates carry full state, not deltas. Renderers diff
   `chunks[].hash` against chunks they already loaded and fetch only the
   missing tail.
3. Daemon updates all matching output manifests through the existing
   `display_index` path.
4. Frontend sees the manifest revision and appends only new chunks.
5. The final update sets `complete: true`.

Plain Jupyter frontends will render the fallback MIME. nteract frontends will
prefer the manifest MIME.

Abort and recovery:

- A producer that cannot continue (kernel restart caught by the launcher,
  unrecoverable serialization error) emits a final `update_display_data`
  with `complete: true` plus an `aborted: { reason: "..." }` field.
  Renderers leave already-loaded rows intact and surface the reason instead
  of pretending the table is whole.
- An `update_display_data` whose `display_id` no longer maps to a live
  output (cell cleared, kernel restarted before the update lands) is
  dropped on the daemon side. This matches today's behavior and avoids
  resurrecting orphaned manifests.
- The daemon does not garbage-collect chunk blobs from CAS when a manifest
  is dropped; CAS retention is decided independently of display lifetime.

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

- fetch the first chunk immediately
- fetch more chunks as viewport scrolling or table operations need them
- fetch only chunks not already loaded
- preserve Sift engine state across manifest revisions
- avoid reloading the whole table when `chunks.length` grows
- use a coalesced artifact for full-table operations when present
- mark the table complete only when `complete: true`
- keep `text/plain` fallback available when the plugin fails

## Phased Implementation

Each phase below should land as an individual commit in this PR so the work can
be reviewed and tested incrementally.

## Implementation Progress

Keep this section current as the PR evolves. It is the durable working memory
for the staged implementation.

- Done: `6166a6a8 feat(outputs): emit dataframe arrow streams`
  - pandas, polars, pyarrow tables, record batches, and PyCapsule-compatible
    dataframe objects now emit `application/vnd.apache.arrow.stream` through the
    launcher.
  - `serialize_dataframe` prefers `__arrow_c_stream__()` and falls back to
    pandas/polars-specific Arrow IPC writers for older library versions.
  - Tests cover pandas IPC output, pandas index metadata, polars IPC output, and
    a protocol-only PyCapsule stream object.
- Done: `f039cd2b docs(outputs): clarify arrow stream chunking`
  - researched current PyCapsule producers/consumers and documented the
    `RecordBatchReader` chunking model.
  - chunking must happen at record-batch boundaries by writing self-contained
    IPC mini-streams; do not split already-serialized IPC bytes.
- Done: `feat(outputs): emit arrow stream manifest sidecars`
  - add `application/vnd.nteract.arrow-stream-manifest+json` as an emitted
    sidecar while keeping direct Arrow IPC selected for rendering.
  - this commit should not change the UI path yet; Sift manifest routing comes
    in a later Phase 2 commit.
- Review: `pr-reviewer` found two sidecar-stage issues. Disposition:
  - confirmed-fix: polars must keep its native IPC writer path so polars-only
    environments do not require pyarrow just because modern polars exposes
    `__arrow_c_stream__()`.
  - confirmed-fix: one-chunk manifest construction must not re-read the whole
    IPC blob just to count record batches; omit `record_batch_count` unless the
    writer already knows it.
- Review rerun: `pr-reviewer` found the known pyarrow table paths should not
  depend on PyCapsule import support. Disposition:
  - confirmed-fix: pandas and `pyarrow.Table` paths write Arrow IPC directly
    through `pa.ipc.new_stream` / `writer.write_table` again.
  - confirmed-fix: the private `_import_from_c_capsule` fallback is documented
    as a compatibility bridge only for generic PyCapsule sources on PyArrow
    14/15; known table paths bypass it.
- Review rerun: `pr-reviewer` found the generic PyCapsule path should not
  replay a potentially single-pass stream during downsampling. Disposition:
  - confirmed-fix: generic PyCapsule objects serialize once only; if the
    complete stream exceeds `max_bytes`, the formatter rejects rich output for
    now and relies on summary fallback. Progressive chunking is the intended
    rich path for large single-pass sources.
- Review rerun: `pr-reviewer` reported `verdict: clear` for `68750098`.
- Done: `feat(outputs): render arrow stream manifests`
  - notebook and MCP MIME priority now prefer
    `application/vnd.nteract.arrow-stream-manifest+json` over the direct Arrow
    stream sidecar.
  - manifest resolution attaches blob URLs to `chunks[].hash`, and the Sift
    renderer loads the first complete chunk through its existing Arrow IPC path.
- Review rerun: `pr-reviewer` reported `verdict: clear` for `a95e61db`.
- Done: `feat(sift): add arrow stream chunk store`
  - sift-wasm can create an empty Arrow stream store, append self-contained IPC
    stream chunks, reject schema mismatches, and mark the store complete.
  - this is only the WASM/store seam; React still uses the existing one-shot
    Arrow IPC load path until the next commit wires manifest chunk appends.
- Review rerun: `pr-reviewer` reported `verdict: clear` for `dac07571`.
- Done: `feat(sift): append arrow manifest chunks`
  - Sift React accepts a normalized `source` union, including Arrow stream
    manifests, while keeping `data` and `url` as compatibility props.
  - Manifest sources fetch complete chunk URLs in order, append them through the
    WASM stream store, and mark the table complete when the manifest is
    complete.
  - Manifest loading is keyed by completion state and chunk URLs/row counts, so
    recreating an equivalent `source` object does not reload the table.
  - the isolated renderer now passes manifest objects to Sift instead of
    collapsing them back to a direct URL.
- Review rerun: `pr-reviewer` reported `verdict: clear` for `f62da4f6`.
- Done: `feat(outputs): add arrow stream chunk writer`
  - Python can drain an Arrow PyCapsule-compatible source once as a
    `RecordBatchReader` and yield independently decodable Arrow IPC mini-stream
    chunks on record-batch boundaries.
  - the existing dataframe/table display formatter still emits one complete
    chunk; the chunk writer is the Phase 4 producer seam before display-id
    updates are wired into the formatter path.
- Review rerun: `pr-reviewer` reported `verdict: clear` for `f8a02ed8`.
- Done: `feat(outputs): add progressive arrow display helper`
  - `nteract_kernel_launcher.display_arrow_stream(...)` uses the chunk writer
    to publish an initial raw MIME bundle with a Jupyter `display_id`, then
    emits full manifest revisions with `DisplayHandle.update(...)`.
  - the helper is explicit; automatic dataframe reprs remain one-shot until the
    formatter/displayhook boundary can own display ids without surprising bare
    expression output.
- Review rerun: `pr-reviewer` reported `verdict: clear` for `1bb09116`.
- Post-rebase review found one Sift renderer hook-order regression introduced
  while merging the manifest source path with `origin/main`'s notebook-aware
  sizing/focus renderer. Disposition:
  - confirmed-fix: keep all React hooks in `SiftRenderer` before the invalid
    manifest fallback return.
- Review rerun: `pr-reviewer` reported `verdict: clear` for `a2944dd0`.
- Review rerun found two progressive-helper performance concerns. Disposition:
  - confirmed-fix: single-chunk sources publish one complete `display_data`
    bundle instead of an incomplete display followed by a duplicate completion
    update.
  - confirmed-fix: completion-only manifest updates do not resend chunk bytes,
    and progressive manifest construction reuses the first chunk schema instead
    of reparsing it for every revision.
- Manual QA on `66829fd` found two stacked large-table truncations.
  Disposition:
  - confirmed-fix: automatic `pyarrow.Table` outputs that exceed the one-shot
    payload cap now emit a complete multi-chunk Arrow stream manifest over the
    original table instead of silently keeping only `head(n)`. The manifest
    summary carries `total_rows`, `included_rows`, and `sampled: false`.
  - confirmed-fix: the launcher/daemon attached-buffer path now accepts a
    multi-ref blob envelope so every manifest chunk can be sent with the same
    display message and preflighted into CAS before render resolution.
  - confirmed-fix: `_progressive.py` is included in the vendored launcher file
    list so `import nteract_kernel_launcher` succeeds after vendoring.
  - confirmed-defer: Sift's scroll spacer can still hit browser element-height
    limits for million-row tables. That is independent of the Arrow producer
    fix and should land as a Sift virtual-scroller follow-up before marketing
    arrow-native tables as production-ready for very large local data.
- Done in PR #2715: durable manifest save/load and GC collection follow-up.
  - runtime save rewrites `chunks[].hash`, `coalesced.hash`, and
    `coalesced.segments[].hash` to nested `{blob, size, content_type}` refs
    while preserving the manifest MIME and fallback siblings.
  - runtime load restores those nested refs back to renderer-facing `hash`
    entries; missing chunk blobs drop only the manifest MIME.
  - active-room blob GC now marks Arrow manifest chunk/coalesced hashes.
  - `schema.hash` intentionally remains a plain fingerprint until schema bytes
    become their own stored artifact.
- In progress: runtime consumer audit follow-up.
  - shared output resolution now has a direct
    `resolve_cell_output_texts_for_llm` helper.
  - runtimed Python and Node bindings expose explicit output-text helpers for
    agent/runtime consumers that need compact LLM text instead of full blobs.
  - keep richer `TABLE_REPR v1` stats as a tiered manifest-design follow-up
    rather than scanning large tables inside runtime consumers.

### Phase 1: Canonical Arrow For DataFrames

Goal: all new dataframe display outputs use Arrow IPC stream by default.

Changes (all in `python/nteract-kernel-launcher/nteract_kernel_launcher/_format.py`
unless noted):

- `_serialize_pandas` switches to `pa.Table.from_pandas(df)` (drop
  `preserve_index=False`) plus `pa.ipc.new_stream` writing into a
  `pa.BufferOutputStream`.
- `_serialize_polars` switches to `df.write_ipc_stream(buf)`.
- `serialize_dataframe` first checks for `__arrow_c_stream__()` and imports via
  `pa.RecordBatchReader.from_stream(obj)` / PyCapsule fallback. The pandas and
  polars helpers remain compatibility fallbacks for older library versions.
- `serialize_dataframe` returns `ARROW_STREAM_MIME` instead of `PARQUET_MIME`.
  Drop `PARQUET_MIME` from the dataframe return path; keep the constant for
  parsing old fixtures only.
- Audit `_bootstrap.py` formatter registrations and tests in
  `python/nteract-kernel-launcher/tests/` for any callers that branch on
  `PARQUET_MIME` for pandas/polars output and update them.
- Rename helpers from parquet-specific names to Arrow/table names where the
  behavior is now generic. A single `serialize_table` codepath shared by
  pandas/polars/pyarrow is fine.
- For narwhals, dispatch on backend: prefer the native object's
  `__arrow_c_stream__()` protocol, fall back to pandas conversion only if no
  Arrow export is available.
- Hugging Face: keep the Arrow-table-backed path. `IterableDataset` and other
  streaming HF objects materialize a head sample then fall through to
  `text/llm+plain`; do not silently consume the stream.
- Keep parquet deserialization/rendering paths untouched.
- Extend tests to assert pandas schema metadata survives and pandas index
  hints are promoted through `nteract-predicate`.
- Add polars IPC test coverage when polars is installed.

Acceptance:

- pandas, polars, pyarrow table, record batch, and Hugging Face dataset outputs
  all produce `application/vnd.apache.arrow.stream`.
- Existing parquet notebook fixtures still render.
- Saved notebooks still contain simple `text/plain` / `text/html` fallbacks plus
  nteract blob refs.

### Phase 2: Manifest MIME Without Streaming

Goal: introduce the manifest shape without changing producer timing. Launcher
formatters from Phase 1 switch to emitting the manifest MIME with
`chunks: [single_chunk]` and `complete: true`. The raw
`application/vnd.apache.arrow.stream` MIME stays valid for direct producers
(external tools, tests, and old fixtures), but the launcher always wraps in a
manifest from Phase 2 onward.

Changes:

- Add `application/vnd.nteract.arrow-stream-manifest+json` to MIME priority and
  Sift routing.
- Switch launcher producers to emit one-chunk manifests by default.
- Teach runtime save/load to externalize manifest chunk/coalesced blobs by
  walking `chunks[].hash`, `coalesced.hash`, and
  `coalesced.segments[].hash` (see "Save Resolution").
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
- For pandas/polars eager dataframes, emit `df.head(n)` first, then chunk rows
  after conversion for the remaining data.
- For Arrow-native and PyCapsule-compatible sources, import a
  `RecordBatchReader`, then write the first record batch or bounded mini-stream
  chunk directly.
- For large or lazy sources, publish completed mini-stream chunks as batches are
  produced. Do not require a replayable source.

Acceptance:

- A large Arrow table displays first rows before the whole table is serialized.
- For a table where full serialization takes more than 1 second, the head chunk
  renders within 200 ms after the dataframe/source object is available when the
  head-sample path can produce `df.head(n)` without forcing full conversion.
- Final manifest is complete and durable.
- Vanilla notebook fallback remains simple and stable.

### Phase 5: Viewport-Driven Fetch

Goal: Sift renders the first chunk immediately and fetches more data only as the
user or operation needs it.

Changes:

- Load chunk 0 immediately when the manifest arrives.
- Fetch additional chunks as the viewport nears unloaded rows.
- For full-table sort/filter/search/export, request all missing chunks unless a
  coalesced artifact is already available.
- Preserve loaded table state while new chunks append.

Acceptance:

- Scrolling beyond loaded rows fetches the next chunk without reloading chunk 0.
- Full-table operations either load all chunks or use the coalesced artifact.
- A missing later chunk surfaces a recoverable table error and keeps loaded rows.

### Phase 6: Direct Daemon Blob Upload

Goal: avoid pushing large binary chunks through Jupyter IOPub buffers. This is
a performance and scaling optimization, not a prerequisite for Phase 4.
Progressive output ships first on the existing attached-buffer path; Phase 6
swaps the transport without changing the manifest format.

Changes:

- Add a daemon/client request for content-addressed blob upload.
- Expose it through the Python runtime package or launcher bootstrap.
- Keep the attached-buffer path as a compatibility fallback.
- Consider shared protocol with planned `PutBlob` typed frames.

Acceptance:

- Chunks can be stored before the display message references them.
- Hash mismatch, missing blob, and upload failure are explicit errors.
- The manifest never references bytes that the daemon failed to store.

### Phase 7: Coalesced Artifacts

Goal: write a derived full-table artifact after completion without changing the
progressive manifest contract.

Changes:

- If the full Arrow IPC stream fits under `BlobStore::MAX_BLOB_SIZE`, write one
  coalesced Arrow IPC blob and reference it from `coalesced`.
- If the full stream is too large, write larger ordered segment blobs and attach
  a `segment_manifest` coalesced artifact.
- Keep the progressive chunk manifest authoritative if coalescing fails.

Acceptance:

- Small completed tables get a single coalesced blob.
- Too-large completed tables get a coalesced segment manifest.
- Coalescing failure does not affect display, save, or reopen from progressive
  chunks.

## Backward Compatibility

Desktop client and runtime daemon ship together. There is no supported
configuration where a release-N client talks to a release-M daemon, so the
manifest MIME, blob-ref shape, attached-buffer protocol, and output store
schema can change in a single release without compatibility shims. The only
durable compatibility surface is saved `.ipynb` files on disk and the old
parquet/Arrow IPC blob payloads users may still have in CAS.

- Existing `.ipynb` files with parquet blob refs continue to load and render.
- Existing `.ipynb` files with direct Arrow IPC blob refs continue to load and
  render.
- New manifest outputs save as ordinary JSON plus nteract blob refs (chunks
  and schema, plus coalesced artifacts when present), with `text/plain` /
  `text/html` fallbacks for non-nteract frontends.
- The old parquet MIME stays in Sift and MIME priority for old fixtures, but
  new launcher producers do not choose it.
- `update_display_data` without a matching display id keeps current behavior:
  no destructive append, no new orphaned manifest.

## Testing Strategy

Python:

- pandas Arrow IPC output includes pandas schema metadata.
- pandas RangeIndex remains metadata-only; non-range index is represented and
  hinted correctly.
- polars output emits Arrow IPC stream.
- downsampled outputs carry consistent `included_rows` and `sampled` hints.
- fallback still produces `text/llm+plain` when Arrow serialization fails.
- Arrow stream manifests carry schema column descriptors and precomputed
  `llm.text` when the launcher generated a table summary.

Rust:

- `nteract-predicate` parses Arrow IPC schema metadata for pandas and Hugging
  Face hints.
- output store save/load externalizes direct Arrow IPC, parquet, and manifest
  chunks.
- LLM-selective output resolution uses manifest-level `llm.text` before any
  Arrow chunk fetch if the sibling `text/llm+plain` MIME is missing, then falls
  back to a manifest-derived row/column/type summary.
- update-display-data preserves metadata hints for manifest revisions.
- blob upload rejects hash mismatches and missing chunks.
- coalesced artifact generation chooses a single blob below
  `BlobStore::MAX_BLOB_SIZE` and a segment manifest above it.

WASM/Sift:

- direct Arrow IPC renders.
- one-chunk manifest renders.
- multi-chunk manifest appends without full reload.
- viewport-driven fetch loads later chunks only when needed.
- filters/sorts survive append or are explicitly invalidated.
- full-table operations use the coalesced artifact when present or fetch all
  chunks when absent.
- schema mismatch produces a visible table error with already-loaded rows left
  intact.

Notebook/E2E:

- plain pandas display renders in nteract and saves with fallback MIME.
- old parquet notebook fixture renders.
- progressive output displays first chunk, then final row count after updates.
- reopened notebook resolves manifest chunk blobs and coalesced artifacts from
  CAS.

## Open Decisions

- Compression: ship uncompressed Arrow IPC in Phase 2/3 for simpler chunk
  validation. Phase 4 revisits lz4/zstd once Rust/WASM reader support is
  confirmed end-to-end.
- Chunk unit: Phase 2/3 use self-contained Arrow IPC streams per chunk.
  Lower-level IPC message-fragment encoding stays deferred until measured
  chunk bloat justifies the complexity.
- Index display: pandas metadata is preserved by default starting in Phase 1.
  Sift's presentation of non-range index columns (hidden, pinned, or visibly
  labeled) is a Phase 3 UX decision, not a serialization decision.
- Upload API: attached Jupyter buffers carry through Phase 4. Phase 6 swaps to
  a direct daemon blob upload path; the manifest format does not change.
- Maximum chunk size: `BlobStore::MAX_BLOB_SIZE` is 100 MiB
  (`crates/runtimed/src/blob_store.rs:25`). Default to 8 MiB per chunk in
  Phase 4 to balance CAS overhead, first paint, and WASM append cost.
- Categoricals: pandas `Categorical` and polars `Categorical`/`Enum` columns
  emit dictionary batches inside each self-contained chunk. The bloat from
  recomputing dictionaries per chunk is the explicit tradeoff for chunk
  independence in Phase 2/3 and is revisited only if it shows up in profiles.
