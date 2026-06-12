# Arrow Manifest Durable Storage Design

**Status:** Exploration.

## Objective

PR #2658 made Arrow stream manifests renderable and added complete multi-chunk
automatic `pyarrow.Table` output for oversized tables. This follow-up defines
and tests the saved-notebook durability contract for those manifests.

The goal is not to build direct daemon upload, coalesced artifacts, or
viewport-driven fetch. The goal is to make it unambiguous how an Arrow stream
manifest survives save, close, blob GC, and reopen when the chunk bytes already
exist in the daemon blob store.

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

## Save Transform

`resolve_data_bundle()` should keep its existing single-blob behavior for
direct Arrow IPC and parquet MIME entries. For
`application/vnd.nteract.arrow-stream-manifest+json`, it should parse the
manifest JSON and walk only the known manifest ref slots.

For each slot, save should:

1. Require a string `hash`.
2. Determine the expected content type from the slot.
3. Determine `size` from the slot when present, or from blob metadata if the
   slot omits it.
4. Verify the hash exists in the blob store before writing the durable ref.
5. Replace the string hash with `{ blob, size, content_type }`.

If a referenced blob is missing, save should not silently produce a durable
manifest that looks complete. The smallest acceptable behavior for this first
PR is to return an error from `resolve_manifest()` so the save call can surface
the same class of "output could not be resolved" failure it already uses for
missing blobs. A future UX pass can add a more specific user-facing diagnostic.

The transform must preserve all non-ref manifest fields exactly: row counts,
record-batch counts, summary, completion state, abort state, encoding, table
hints, and unknown future fields.

## Load Transform

`convert_data_bundle()` should keep its existing top-level
`application/vnd.nteract.blob-ref+json` handling. For
`application/vnd.nteract.arrow-stream-manifest+json`, it should parse the JSON
manifest and reverse only the known durable ref slots.

For each durable slot, load should:

1. Require `{ blob: string, size: number }`.
2. Preserve or restore `content_type`.
3. Check that the blob exists in the local blob store.
4. Convert back to runtime shape with `hash: blob`, `size`, and
   `content_type`.

If the blob is missing, load should keep the manifest structurally intact but
mark the manifest as unusable rather than pretending the table is complete. For
the test-focused PR, use the existing safe fallback behavior: drop only the
manifest MIME from the loaded data bundle and preserve fallback siblings such
as `text/plain` / `text/llm+plain`. A later renderer UX pass can replace that
with a manifest-level diagnostic field. Silent fallback to a partial table is
not acceptable.

## GC Contract

The awkward part is retention. It has two separate cases:

1. **Active rooms.** RuntimeStateDoc outputs exist in memory. The GC walker can
   inspect those output manifests, but Arrow manifest chunk hashes are nested
   inside JSON payloads rather than top-level `ContentRef::Blob` fields.
2. **Closed file-backed rooms.** RuntimeStateDoc outputs are not persisted into
   `NotebookDoc`. Saved `.ipynb` files contain output JSON, but the current GC
   walker scans active rooms, comm state, notebook-doc persisted `.automerge`
   files, and execution records. It does not generally scan arbitrary saved
   `.ipynb` files for output blob refs.

The durable JSON shape helps because `{ blob, size, content_type }` is
self-describing and can be collected recursively once it is inside a structure
the daemon actually scans. It does not, by itself, make closed file-backed
notebook outputs GC-safe forever.

The first implementation should therefore make two contracts explicit:

- Active-room GC must be manifest-aware enough to collect live
  `chunks[].hash` / `coalesced.*.hash` refs from selected Arrow manifest MIME
  payloads. If the manifest JSON itself is blob-backed, the collector either
  needs blob-store access to resolve it, or an already-derived asset list.
- Closed-room GC needs a notebook-owned output asset index if we want stronger
  retention than the existing orphan grace period. The index should be written
  at save time from the resolved `.ipynb` outputs and stored in a document-owned
  structure GC already scans, or in a new persisted sidecar with equivalent
  retention semantics.

The recommended long-term shape is a dedicated output asset index, not an
overload of markdown `resolved_assets`. The index keys can be opaque but should
be stable enough to replace on each successful save, for example:

```text
outputs/<cell_id>/<output_id>/<mime>/<slot>
```

The values are blob hashes. The index is for retention only; renderers should
continue reading normal output manifests.

The focused tests should cover both paths without pretending the second path is
already solved:

1. A runtime output manifest with a selected Arrow manifest MIME contributes
   its nested chunk/coalesced blob refs to active-room GC collection.
2. A characterization test documents that persisted NotebookDoc files do not
   currently retain RuntimeStateDoc outputs after eviction. That test should
   justify the output asset index rather than hiding the gap.
3. A helper-level test proves recursive collection can find durable nested refs
   once they are present in a scanned persisted structure.

## Focused Tests

Add tests before changing broad behavior:

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
  both direct runtime shape and saved durable shape where applicable.
- `schema.hash` stays a plain string fingerprint and is not treated as a blob
  ref until schema bytes are actually stored.
- A characterization test shows closed file-backed rooms need an output asset
  index for GC-safe saved output blobs after RuntimeStateDoc outputs disappear.
- Existing direct Arrow IPC/parquet blob-ref save/load tests keep passing.

## Non-Goals

- No virtual scroll cap work.
- No direct daemon `PutBlob` / `PutBlobChunk` protocol.
- No coalesced artifact writer.
- No viewport-driven chunk fetching.
- No Sift UI changes beyond what tests require.
- No attempt to make saved notebooks portable across machines without copying
  the nteract blob store.

## PR Split

The first implementation PR should land the save/load transforms, active-room
GC collection, and characterization tests. It should not add the output asset
index yet. That keeps the first PR focused on the manifest storage contract
and makes the remaining closed-room retention gap explicit.

The next PR should add the notebook-owned output asset index and move the
characterization test from "documented gap" to "protected after save." No code
path should imply closed-room output blobs are protected unless that index
exists.
