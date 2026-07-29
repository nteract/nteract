# Large Cell Payloads

**Status:** Renderer sniff implemented, 2026-07-29. Problem framing and layer
analysis for cells whose contents dwarf the table around them. Transport
laziness remains open pending the fetch-amplification question below.

## Objective

A table cell can be larger than most tables. Displaying
`moonshotai/PerceptionBench` renders a wall of base64 and hangs the app, because
every `image` cell holds a 43 KB `data:image/jpeg;base64,...` string that Sift
classifies as text.

The bounded head in `arrow-bounded-head-and-progressive-fetch.md` capped how
many rows cross the wire. It said nothing about a single column being nearly all
of the payload, or about what happens when the renderer treats that column as
prose.

## What the user is owed

The reader wants a table they can work with, and once images render they will
expect to see them. Faithfully reproducing a base64 string in a cell serves
nobody. The same is true of the agent reading the text projection: a truncated
marker is more useful than 43 KB of base64 that will never be read.

That reordering matters, because it makes truncation and substitution
acceptable in places where fidelity would normally win.

## Diagnosis

`PerceptionBench` declares `image` as `List(Value('string'))`, not the HF `Image`
feature. Each cell is a list of one data-URI string.

`is_image_like_data_type` (`crates/sift-wasm/src/store.rs:108`) matches only
`Struct{bytes,path}` or a list of that struct:

```rust
let has_bytes = fields.iter().any(|f| f.name() == "bytes" && is_binary_data_type(f.data_type()));
let has_path = fields.iter().any(|f| f.name() == "path");
has_bytes && has_path
```

`List<Utf8>` never matches, so the column takes the text path. This is a gap
rather than a regression: data-URI strings were never handled. A dataset using
the proper `Image` feature still renders correctly.

The notebook document is not implicated. All three MIME values total about 4 KB,
so the doc carries hashes and a short summary while the bytes ride blob refs.

## What is already lazy

Cell rendering is. `packages/sift/src/wasm-table-data.ts:126` reads image bytes
on demand rather than through the prefetched viewport cache, with a comment
noting that copying every visible image into a JS array would dwarf the rest of
the viewport.

Transport is not. Image bytes sit inline in the Arrow stream, so they cross
kernel to CAS to browser whether or not anyone scrolls to that row.

That split is the whole design space. Each candidate layer fixes a different
half.

## Layers

### Renderer sniff, implemented

Detect data-URI strings by value once batches land, decode base64 on read, serve
through the existing `get_cell_image_bytes_at` path.

Reaches every source Sift renders: kernel tables, Parquet opened by URL, saved
notebooks, the hosted viewer. Needs no protocol change. Fixes the hang, because
`wasm-table-data.ts` returns `""` for image columns and the huge strings leave
the layout path.

Detection samples up to 32 leading non-null values per candidate column and
reads 64 bytes of each. It requires every sampled value to match, because the
failure modes are asymmetric: a false positive renders prose as blank cells,
while a false negative leaves a column as the text it already was.

Type alone cannot decide this. `List<Utf8>` is how several HuggingFace datasets
carry images and equally how they carry prose, so classification has to run
after batches exist rather than from the schema.

Leaves base64 on the wire, carrying about 33% inflation over raw bytes.

### Producer rewrite

Detect during serialization and rewrite `List<Utf8>` data URIs into
`List<Struct{bytes,path}>` so they land on the existing struct path.

Removes the base64 inflation and needs no renderer change. But it only helps
kernel-sourced tables, the bytes stay inline, and it rewrites the shape of what
the user asked to see. A half-measure that buys 25% and no laziness.

### Per-cell blob refs

The cell carries a hash; the renderer resolves it the way it already resolves
chunk URLs. The table stops carrying large values at all.

The manifest already has the slot. `blobs[]` sits alongside `chunks[]` and
`coalesced`, and the publish path walks it (`crates/runt-publish/src/lib.rs`),
as do the hosted snapshot and cloud viewer ref collectors. It is undocumented in
the chunk-manifest ADR, which is worth fixing, but per-cell refs would be
filling an existing seam rather than extending the format.

This needs no new Python-to-daemon channel. The pieces exist:

- `pending_buffers()` plus the buffer hook already move arbitrary bytes from
  Python into CAS.
- `output_store::preflight_ref_buffers` hash-verifies and commits them, and is
  live from `jupyter_kernel.rs` and `output_committer.rs`.
- ADR Decision 2 already defines a multi-ref envelope, so one output can carry
  many blobs.
- Refs are host-neutral hashes by ADR Decision 1, so desktop resolves to the
  local daemon blob server and hosted to artifact storage.

`nteract.dx.blob` stays reserved and unimplemented, and its comment is accurate:
the comm target is unused because bytes ride IOPub buffers instead. A direct
channel is still wanted for pull, where the frontend asks the kernel for more
rows, but push-side extraction does not block on it.

## The tension worth naming

The table is already batched into a handful of chunk blobs. Per-cell refs could
turn one fetch into hundreds, trading a payload problem for a request problem.

Range requests are not an option: neither the desktop daemon nor the cloud blob
path serves them today. That leaves packing cell values into a small number of
side-car blobs with an offset index, addressed through `blobs[]`. Row-local
packs around a couple of MiB are the shape worth measuring first.

The appealing property of the current design is that content separates cleanly
and renders in logical chunks, so a coalescing scheme should preserve that
rather than fight it.

## Beyond images

The trigger should be size, not type. A cell holding 43 KB of prose is the same
problem as one holding 43 KB of base64: it bloats transport and it is unreadable
in a table cell either way.

Two mechanisms, and they are not alternatives:

- **Truncate for display.** Past a threshold a cell shows a prefix and a marker.
  Cheap, works everywhere, and matches what the reader actually wants.
- **Blob the full value.** The untruncated content stays addressable so the user
  can open or copy it, without riding in the table.

Truncation alone loses data the user may want. Blobbing alone still renders an
unusable wall unless the cell also truncates. Together they give a readable
table over addressable content.

Text carries a constraint images do not: sorting and filtering cannot operate on
a hash or a preview. A blobbed text column needs explicit materialization
semantics before it can be sorted or filtered, which argues for a higher
threshold on text than on binary. Roughly 64 KiB for images and binary against
256 KiB for text is a reasonable starting split.

## Consequences

- Large automatic reprs stop hanging the app on data-URI columns.
- The renderer stops depending on producers to declare rich types, since
  detection becomes value-based.
- Transport laziness stays unsolved until per-cell refs land.
- Size thresholds become a shared concept across images and text, with
  different cutoffs for each.

## Open Questions

1. Fetch amplification. Whether per-cell refs need coalescing before they are
   worth shipping, and what the measured crossover is. This is the question
   gating the whole transport half.
2. Where the size thresholds sit, and whether one number serves both the
   truncate-for-display and blob-the-value decisions given text and binary want
   different cutoffs.
3. Materialization semantics for sorting and filtering a blobbed text column.
4. Whether blob extraction is automatic or opt-in, given it rewrites what the
   user asked to display.
5. GC reachability for per-cell blobs, which active-room GC does not walk today.
6. Whether Sift's WASM work belongs in a worker inside the isolated frame. The
   frame omits `allow-same-origin` for security (`frame-config.ts:14`), which
   says nothing about scheduling, so a large table can still block the thread
   that renders it.
