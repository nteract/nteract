# Arrow Manifest Durable Storage Design

**Status:** Implemented, 2026-05-24 — save/load transforms, active-room GC,
and characterization coverage landed; closed-room asset index remains open.

## Objective

PR #2658 made Arrow stream manifests renderable and added complete multi-chunk
automatic `pyarrow.Table` output for oversized tables. This memo defined and
tested the saved-notebook durability contract for those manifests.

The implementation built save/load transforms and active-room GC but did not
cover direct daemon upload, coalesced artifacts, or viewport-driven fetch.
The closed-room output asset index remains an open gap.

## Current State

Runtime output manifests store display data as `ContentRef` values. A selected
binary table payload such as `application/vnd.apache.arrow.stream` or
`application/vnd.apache.parquet` saves as:

```json
{
  "application/vnd.nteract.blob-ref+json": {
    "hash": "chunk-hash",
    "content_type": "application/vnd.apache.arrow.stream",
    "size": 1234
  }
}
```

That path works for a single selected table blob because
`resolve_data_bundle()` rewrites the selected binary `ContentRef::Blob` to a
top-level blob-ref MIME, and `convert_data_bundle()` reverses it on load.

Arrow stream manifests are different. The selected MIME is JSON:

```json
{
  "application/vnd.nteract.arrow-stream-manifest+json": {
    "version": 1,
    "content_type": "application/vnd.apache.arrow.stream",
    "chunks": [
      {
        "index": 0,
        "hash": "chunk-hash",
        "size": 1234,
        "row_count": 4096
      }
    ],
    "complete": true
  }
}
```

The manifest JSON can already round-trip while the same blob store still has
`chunks[].hash`, because the frontend resolves chunk URLs from those hashes at
render time. That is not enough as a durability contract. Plain hash strings in
nested JSON are not self-describing blob references, are not validated at save,
and are easy for GC/reference walkers to miss.

## Durable Shape

Saved `.ipynb` output JSON should make every manifest-owned blob explicit. The
durable form replaces hash string slots with nteract blob-ref objects in those
slots.

Runtime/render shape:

```json
{
  "hash": "chunk-hash",
  "size": 1234,
  "content_type": "application/vnd.apache.arrow.stream"
}
```

Saved shape:

```json
{
  "blob": "chunk-hash",
  "size": 1234,
  "content_type": "application/vnd.apache.arrow.stream"
}
```

This deliberately uses the existing recursive `ContentRef` sentinel keys
`blob` and `size`. The extra `content_type` field keeps the ref
self-describing for validation and future migration. It also lets the existing
GC collector pattern recognize the object as a blob reference instead of
requiring a separate manifest-only retention database.

The transform applies to these manifest slots:

- `chunks[].hash`, with `content_type` defaulting to the manifest
  `content_type`
- `coalesced.hash`, when `coalesced.kind == "single_blob"`
- `coalesced.segments[].hash`, when `coalesced.kind == "segment_manifest"`

Do not transform `schema.hash` in this PR. In #2658 it is a schema fingerprint
computed from serialized schema bytes, but those schema bytes are not stored as
a separate CAS blob. It should remain a string validation hash until a later
change actually writes a schema blob.

The runtime/render shape keeps `hash` as a string. The saved form is only for
`.ipynb` JSON and only at the save/load boundary. Frontend and Sift renderer
code should not need to handle the durable shape in normal live output state.

## Save Transform (Implemented)

`resolve_data_bundle()` keeps its existing single-blob behavior for direct
Arrow IPC and parquet MIME entries. For
`application/vnd.nteract.arrow-stream-manifest+json`, it parses the manifest
JSON and walks known manifest ref slots
(`crates/runtimed/src/output_store.rs:1351`).

For each slot, save:

1. Requires a string `hash`.
2. Determines the expected content type from the slot.
3. Determines `size` from the slot when present, or from blob metadata if the
   slot omits it.
4. Verifies the hash exists in the blob store before writing the durable ref.
5. Replaces the string hash with `{ blob, size, content_type }`.

If a referenced blob is missing, save returns an error so the save call
surfaces the same "output could not be resolved" failure it uses for missing
blobs. The transform preserves all non-ref manifest fields: row counts,
record-batch counts, summary, completion state, abort state, encoding, table
hints, and unknown future fields.

## Load Transform (Implemented)

`convert_data_bundle()` keeps its existing top-level
`application/vnd.nteract.blob-ref+json` handling. For
`application/vnd.nteract.arrow-stream-manifest+json`, it parses the JSON
manifest and reverses known durable ref slots
(`crates/runtimed/src/output_store.rs:1201`).

For each durable slot, load:

1. Requires `{ blob: string, size: number }`.
2. Preserves or restores `content_type`.
3. Checks that the blob exists in the local blob store.
4. Converts back to runtime shape with `hash: blob`, `size`, and
   `content_type`.

If the blob is missing, load keeps the manifest structurally intact but marks
it unusable: drops only the manifest MIME from the loaded data bundle and
preserves fallback siblings such as `text/plain` / `text/llm+plain`. A later
renderer UX pass can add a manifest-level diagnostic field.

## GC Contract (Active Rooms: Implemented)

Retention has two separate cases:

1. **Active rooms (implemented).** RuntimeStateDoc outputs exist in memory. The
   GC walker inspects those output manifests and collects Arrow manifest chunk
   hashes nested inside JSON payloads (`crates/runtimed/src/daemon.rs:5157-5187`).
   `arrow_manifest_blob_hash` extracts manifest blob hashes from outputs, then
   `collect_arrow_manifest_blob_hashes` resolves each manifest and walks its
   chunk/coalesced refs.

2. **Closed file-backed rooms (open gap).** RuntimeStateDoc outputs are not
   persisted into `NotebookDoc`. Saved `.ipynb` files contain output JSON, but
   the GC walker scans active rooms, comm state, notebook-doc persisted
   `.automerge` files, and execution records — not arbitrary saved `.ipynb`
   files for output blob refs.

The durable JSON shape helps because `{ blob, size, content_type }` is
self-describing and can be collected recursively once inside a structure the
daemon scans. Active-room GC is manifest-aware; closed-room GC needs a
notebook-owned output asset index for stronger retention than the existing
orphan grace period.

The recommended shape is a dedicated output asset index, not an overload of
markdown `resolved_assets`. Index keys should be stable enough to replace on
each successful save, for example:

```text
outputs/<cell_id>/<output_id>/<mime>/<slot>
```

Values are blob hashes. The index is for retention only; renderers continue
reading normal output manifests.

## Test Coverage (Implemented)

Tests added with the implementation:

- `resolve_manifest` saves an Arrow stream manifest with two chunks using
  durable nested refs, not plain string hashes.
- `create_manifest` loads that saved shape back to runtime shape with string
  `hash` fields and renderer-usable chunk metadata.
- The transform preserves `summary`, `complete`, `row_count`,
  `record_batch_count`, and unknown manifest fields.
- Missing chunk blob on save is an error, not silent partial output.
- Missing chunk blob on load drops the Arrow manifest MIME and preserves
  fallback text siblings.
- Recursive blob collection finds manifest `chunks` and `coalesced` refs in
  active rooms.
- `schema.hash` stays a plain string fingerprint and is not treated as a blob
  ref.
- A characterization test documents that closed file-backed rooms need an
  output asset index for GC-safe saved output blobs after RuntimeStateDoc
  outputs disappear.
- Existing direct Arrow IPC/parquet blob-ref save/load tests keep passing.

## Non-Goals

- No virtual scroll cap work.
- No direct daemon `PutBlob` / `PutBlobChunk` protocol.
- No coalesced artifact writer.
- No viewport-driven chunk fetching.
- No Sift UI changes beyond what tests require.
- No attempt to make saved notebooks portable across machines without copying
  the nteract blob store.

## Remaining Work

Save/load transforms, active-room GC collection, and characterization coverage
have landed. The remaining closed-room retention gap is the notebook-owned
output asset index. No code path should imply closed-room output blobs are
protected unless that index exists.
