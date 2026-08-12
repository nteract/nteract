# Arrow Bounded Head and Progressive Fetch

**Status:** Steps 1 and 2 implemented, 2026-07-28. The bounded head and
append-only manifest growth landed together; the pull channel in step 3 remains
open pending a handle-retention decision.

## Objective

The automatic Arrow repr path serialized and transferred entire tables with no
ceiling anywhere. Displaying a 1.63 GB Hugging Face dataset materialized every
byte in the kernel, in the blob store, and in the browser.

`arrow-native-outputs.md` already specifies the intended behavior:

> Large eager dataframes should emit `df.head(n)` as the first Arrow IPC chunk,
> where `n` is chosen by byte budget, then continue producing chunks after the
> first display is visible.

The producer implemented the "emit chunks" half and skipped the budget. This
memo records closing that gap, and separates it from the demand-driven fetch
question that `arrow-manifest-durable-storage-design.md` lists as an open gap.

## Reproduction

```python
from datasets import load_dataset
ds = load_dataset("moonshotai/PerceptionBench")
ds["train"]     # 3000 rows, 1.63 GB of image bytes
```

Observed: ~200 chunk blobs written, all fetched by the renderer. Kernel peak
RSS 4.66 GB. The notebook document itself stays clean, so the cost is entirely
in transfer and in the WASM store.

## The Defects

### The kernel had no total ceiling

`_emit_arrow_stream` drained the whole chunk iterator:

```python
chunks = list(
    iter_arrow_stream_chunks(
        source,
        max_chunk_bytes=min(DEFAULT_ARROW_CHUNK_BYTES, _MAX_PAYLOAD_BYTES),
    )
)
```

`max_chunk_bytes` bounded each chunk, not the total. `DEFAULT_ARROW_CHUNK_BYTES`
is 8 MiB and `_MAX_PAYLOAD_BYTES` is 90 MiB, so the `min()` always returned
8 MiB and the payload cap never constrained anything on this path.

`_dataset_mimebundle` (`_bootstrap.py:203`) reaches `ds.data.table` and hands
the full table to that function, so Hugging Face datasets take the same
unbounded path as any `pa.Table`.

The manifest reports `complete: true` and `sampled: false`, which is accurate
but only because nothing ever samples.

### The renderer had no ceiling either

The load effect appended every remaining chunk after first paint:

```ts
for (let i = 1; i < chunks.length; i++) {
  const bytes = await readChunkBytes(fetchChunkResult(chunks[i], i));
  mod.append_arrow_stream_chunk(handle, bytes);
}
```

No viewport check and no budget. The `yield` kept the UI responsive but did
not bound the work.

### Manifest growth was quadratic

`arrowStreamManifestKey` folded every chunk URL and row count into the key, and
the load effect depended on that key. Any manifest that grew by one chunk
produced a new key, which tore the effect down, called
`create_arrow_stream_store()` fresh, and refetched chunks `0..n`.

Growing a manifest to N chunks therefore cost O(N²) fetches and O(N²) WASM
appends. `display_arrow_stream` was correct on the producer side, but wiring it
to the automatic path in that state would have made large tables slower, not
faster. This was the blocking defect for anything incremental, push or pull.

### Display ids are available to the automatic path

`_progressive.py:96` records that IPython MIME formatters cannot mint their own
display ids. That is true of formatters, and it is no longer the binding
constraint, because the launcher owns the kernel stack:

```
NteractKernelApp -> NteractKernel -> NteractShell -> NteractShellDisplayHook
```

`NteractShellDisplayHook.finish_displayhook` (`app.py:209`) runs a hook chain
over the fully assembled message before `session.send`. A hook at that seat can
read `content.data`, and can stamp `content.transient.display_id`. The formatter
does not need to mint the id; the hook does it on the formatter's behalf, using
the same seat `_buffer_hook` already occupies for buffer attachment.

That makes progressive display available to bare last-expression reprs, not just
to the explicit `display_arrow_stream` helper.

## What Landed

### Step 1: Bounded head with an honest manifest

`_emit_arrow_stream` takes a total byte budget alongside the existing per-chunk
size and stops draining the iterator when the budget is spent.

The manifest states what it did. The producer sets `complete: true` because the
one-shot manifest is final, alongside `sampled: true`,
`sample_strategy: "head"`, and a truthful `total_rows` against a smaller
`included_rows`. Consumers use the summary to explain the cap separately from
their manifest-loading state.

`complete` belongs to manifest lifecycle, while `sampled` describes dataset
coverage. A source that cannot report its length, such as an unbounded
`RecordBatchReader`, produces a terminal sampled manifest whose `total_rows`
equals `included_rows` as a lower bound. Learning the true total would mean
draining the stream, which is the cost this work exists to avoid. Recorded in
`adr/arrow-c-stream-output-protocol.md`.

The size rule is a clamp, not a plain budget. Measured row sizes span roughly
four orders of magnitude:

| Shape | Rows | Bytes/row | Rows at 8 MB | Rows at 64 MB |
| --- | --- | --- | --- | --- |
| PerceptionBench (images) | 3,000 | 542 KB | 15 | 123 |
| Text (~230 B rows) | 50,000 | 240 B | 34,952 | all 50,000 |
| Skinny numeric (8x int64) | 100,000 | 64 B | all 100,000 | all 100,000 |

A single byte budget serves neither end. At 8 MiB the image dataset yields 15
rows, which is not a screenful. At 64 MiB the skinny table ships millions of
rows nobody asked for. So:

```
rows = clamp(byte_budget / bytes_per_row, MIN_ROWS, MAX_ROWS)
```

With `MIN_ROWS = 100`, `byte_budget = 16 MiB`, and `MAX_ROWS = 50_000`, images
clamp up to 100 rows and both text and skinny clamp down to 50,000.

The Hugging Face `Dataset` adapter reads a small logical Arrow probe, estimates
the head, then widens the logical prefix geometrically and remeasures before
each next step. This preserves selected/shuffled row order without leaping from
eight rows straight to `MAX_ROWS` on one optimistic estimate. The final Arrow
serializer remeasures the result, so iterative probing reduces intermediate
materialization risk rather than replacing the existing payload ceilings.

`MIN_ROWS` makes the byte budget soft, so it needs a hard ceiling above it or a
5 MB/row video dataset would send 500 MB to honor the floor. `_MAX_PAYLOAD_BYTES`
is already declared at 90 MiB and currently unreachable; this is the job it was
written for. When the floor exceeds it, the slice shrinks below `MIN_ROWS`.

`MAX_ROWS` is not a byte concern. Sift's scroll spacer hits browser
element-height limits on million-row tables (`arrow-native-outputs.md`), so the
renderer should not receive unbounded rows even when they are cheap.

The renderer distinguishes "still arriving" from "capped here" using
`complete`, and surfaces the independent sampling state from `summary` in the
footer. A terminal capped head removes the streaming runner and says "Showing
first …" with either a known total or "total unknown." It does not call the
rows a sample, because a head preserves source order and is not statistically
representative. The footer also states that table tools operate on shown rows.

This trades a stability win for a capability regression: previously you
eventually got all 3000 rows, and now you get the head with no path to more.
`display_arrow_stream` is the explicit full-fidelity path until step 3 lands.

### Step 2: Append-only manifest growth

An incoming manifest that extends the previous one keeps the WASM store and
appends only the new chunks, rather than replacing it. `extendsStore` accepts an
update when the head chunk matches and the already-appended chunks are a prefix
of the new list; anything else rebuilds.

`appendRemainingChunks` resumes from `store.chunkKeys.length`, which grows only
after a successful append, so a run cancelled mid-flight leaves an accurate
resume point.

Value-keying already works and is covered: `react.test.tsx` asserts that a new
manifest object with identical content does not reload. The uncovered case is
extension, and a probe that grows a manifest one chunk at a time measures the
cost:

| Chunks in manifest | Stores created | Total appends | Total fetches |
| --- | --- | --- | --- |
| 1 | 1 | 1 | 1 |
| 4 | 4 | 10 | 10 |
| 5 | 5 | 15 | 15 |

Appends follow `N(N+1)/2`. A 200-chunk manifest costs 200 stores and 20,100
fetches. The resolution layer is correct about identity and wrong about
extension: it treats "one more chunk" as "a different table".

This removes the O(N²) behavior and is a prerequisite for step 3.

Store reuse across effect runs introduced three defects, all caught in review
and fixed: a store surviving a source switch and being appended to after
`replaceData` freed it, a chunk-fetch error that stayed on screen after a later
update recovered the stream, and column overrides silently dropped when they
changed alongside manifest growth.

Step 2 remains useful for the explicit `display_arrow_stream` helper and for a
future source-backed continuation path. Automatic reprs do not use it to push
the rest of a dataframe after first paint: that would defer the original
unbounded materialization instead of preventing it.

### Step 3: Explicit continuation and predicate-aware fetch

Not implemented. Append-only manifests provide the renderer mechanism, but a
product-safe continuation requires a session capability for the live source.
The durable output remains the bounded preview; the capability is optional and
expires with the kernel/output session.

The transport question is answered by existing precedent. `NteractKernel`
already extends `msg_types` with `nteract_bokeh_patch_request` and friends
(`app.py:240`), each with a handler method on the kernel and a matching
`nteract_bokeh_close_request` for teardown. A slice request would take the same
form. The reserved `nteract.dx.*` comm namespace (`dx_blob_comm.rs`) is the
alternative, and its tests already name `nteract.dx.query` and
`nteract.dx.stream`.

The unresolved part is what a handle's lifetime is tied to. `BokehSessionRegistry`
(`_bokeh_session.py:371`) holds strong references in a plain dict and relies on
the frontend to send an explicit close. That precedent suggests tying a table
handle to the lifetime of the output in the UI rather than to the lifetime of
the Python variable. Rebinding `df` would not invalidate a view the user is
still scrolling, and closing the notebook or clearing the cell would release it.
No user-facing pin API is implied by that model.

The genuine tension is that a pull handle is session-scoped while the manifest
is content-addressed and durable by design. A saved notebook carries chunk
hashes that outlive the kernel, so a reopened notebook has to degrade to the
materialized head rather than appear broken.

There are two materially different continuation levels:

1. **Bounded range continuation.** An explicit action requests the next
   byte-bounded logical range and appends it. Existing sorts, filters, and
   summaries still describe loaded rows only. This is useful but is not
   predicate pushdown.
2. **Predicate-aware exploration.** Sift sends a typed filter/sort projection
   to the source handle; the kernel evaluates it against a stable source
   snapshot and returns a bounded result window plus whatever total it can
   compute cheaply. A predicate change may first narrow the loaded rows locally,
   then request enough matching rows to refill the viewport. Scanning a large
   source must remain cancellable and must not silently materialize all matches.

The second level needs an adapter contract rather than JavaScript predicates:
Arrow compute can cover a common subset, while pandas, Polars, Hugging Face
Datasets, lazy frames, and single-pass readers differ in pushdown and replay
capabilities. Until that contract exists, table tools remain explicitly scoped
to shown rows.

## Consequences

- Large automatic reprs no longer transfer unbounded bytes.
- The `sampled` and `complete` fields carry real information.
- `_MAX_PAYLOAD_BYTES` is load-bearing instead of dead.
- Automatic dataframe output is a terminal, durable preview; it never starts an
  unbounded background continuation.
- Progressive display is now available to bare last-expression reprs, since
  `NteractShellDisplayHook` can stamp a `display_id` on the formatter's behalf.
  Nothing wires that up yet.

## Open Questions

1. The `nteract.dx.*` comm namespace predates the launcher owning this path.
   New launcher config uses `NTERACT_ARROW_REPR_*`; whether the reserved comm
   namespace should follow is open, and renaming it carries a compatibility
   cost the new env vars did not.
2. Step 3 handle retention, predicate vocabulary, adapter capabilities, and
   cancellation, per above.
3. Whether `MIN_ROWS`, `byte_budget`, and `MAX_ROWS` should be configurable per
   host. Hosted viewers pay real network cost for a budget that is nearly free
   on a desktop loopback blob server.
