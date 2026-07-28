# Arrow Bounded Head and Progressive Fetch

**Status:** Proposed, 2026-07-28. Scoping for the automatic Arrow repr path.
Steps 1 and 2 are specified; the pull channel in step 3 is deliberately left
open.

## Objective

The automatic Arrow repr path serializes and transfers entire tables with no
ceiling anywhere. Displaying a 1.63 GB Hugging Face dataset materializes every
byte in the kernel, in the blob store, and in the browser.

`arrow-native-outputs.md` already specifies the intended behavior:

> Large eager dataframes should emit `df.head(n)` as the first Arrow IPC chunk,
> where `n` is chosen by byte budget, then continue producing chunks after the
> first display is visible.

The producer implemented the "emit chunks" half and skipped the budget. This
memo covers closing that gap, and separates it from the demand-driven fetch
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

## Current State

### The kernel has no total ceiling

`_bootstrap.py:240`:

```python
chunks = list(
    iter_arrow_stream_chunks(
        source,
        max_chunk_bytes=min(DEFAULT_ARROW_CHUNK_BYTES, _MAX_PAYLOAD_BYTES),
    )
)
```

`max_chunk_bytes` bounds each chunk, not the total. `DEFAULT_ARROW_CHUNK_BYTES`
is 8 MiB and `_MAX_PAYLOAD_BYTES` is 90 MiB, so the `min()` always returns
8 MiB and the payload cap never constrains anything on this path. The `list()`
then drains the whole iterator.

`_dataset_mimebundle` (`_bootstrap.py:203`) reaches `ds.data.table` and hands
the full table to that function, so Hugging Face datasets take the same
unbounded path as any `pa.Table`.

The manifest reports `complete: true` and `sampled: false`, which is accurate
but only because nothing ever samples.

### The renderer has no ceiling either

`react.tsx:531` appends every remaining chunk after first paint:

```ts
for (let i = 1; i < chunks.length; i++) {
  const bytes = await readChunkBytes(fetchChunkResult(chunks[i], i));
  mod.append_arrow_stream_chunk(handle, bytes);
}
```

No viewport check and no budget. The `yield` on line 533 keeps the UI
responsive but does not bound the work.

### Manifest growth is quadratic

`arrowStreamManifestKey` (`react.tsx:91`) folds every chunk URL and row count
into the key, and the load effect depends on that key. Any manifest that grows
by one chunk produces a new key, which tears the effect down, calls
`create_arrow_stream_store()` fresh, and refetches chunks `0..n`.

Growing a manifest to N chunks therefore costs O(N²) fetches and O(N²) WASM
appends. `display_arrow_stream` is correct on the producer side, but wiring it
to the automatic path in this state would make large tables slower, not faster.
This is the blocking defect for anything incremental, push or pull.

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

## Proposal

### Step 1: Bounded head with an honest manifest

Give `_emit_arrow_stream` a total byte budget alongside the existing per-chunk
size. Stop draining the iterator when the budget is spent.

The manifest must state what it did. `_summary_hints` in `_progressive.py`
already computes the right shape, so the producer sets `complete: false`,
`sampled: true`, `sample_strategy: "head"`, and a truthful `total_rows` against
a smaller `included_rows`. Consumers that already read `summary` need no change.

Byte budget rather than row count. A 200-row slice of a text dataset is
kilobytes; 200 rows of PerceptionBench is over 80 MB. The slice should shrink
until it fits the budget.

The renderer surfaces the cap rather than implying the table ended. `complete:
false` already flows to `setStreamingDone`, so the footer needs to distinguish
"still arriving" from "capped here".

Shipped alone this trades a stability win for a capability regression: today you
eventually get all 3000 rows, and afterward you get the head with no path to
more. Step 1 therefore lands with `display_arrow_stream` documented as the
explicit full-fidelity path.

### Step 2: Append-only manifest growth

Detect that an incoming manifest extends the previous one instead of replacing
it. When chunks `0..k` are unchanged and `k+1..n` are new, keep the WASM store
and append only the new chunks.

Key the effect on identity plus count rather than on every chunk hash. Retain
the full-hash comparison as the correctness check that decides append versus
rebuild, so a genuinely different manifest still rebuilds.

This removes the O(N²) behavior and is a prerequisite for step 3. It is
self-contained in `packages/sift` and testable without a kernel.

With steps 1 and 2 in place, the producer can raise the initial budget and push
follow-on chunks after first paint, which is the behavior
`arrow-native-outputs.md` specified.

### Step 3: Demand-driven fetch

Left open. The shape is understood but the retention policy is not settled.

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
materialized head rather than appear broken. Whether the manifest should
distinguish "this is all there is" from "this is all that is reachable right
now" is the question to settle before the shape is fixed.

## Consequences

- Large automatic reprs stop transferring unbounded bytes.
- The `sampled` and `complete` fields start carrying real information.
- Progressive display becomes available to bare last-expression reprs.
- `_MAX_PAYLOAD_BYTES` becomes load-bearing instead of dead.
- Steps 1 and 2 each fix a defect independently and can land separately.

## Open Questions

1. Default budget. 90 MiB matches the existing constant but is large for a
   first paint. A smaller initial budget with push-driven follow-on chunks may
   serve better once step 2 lands.
2. Whether `complete: false` alone is enough for the renderer to distinguish a
   capped table from one still receiving chunks, or whether the summary needs an
   explicit reason.
3. `dx` naming. `DX_MAX_PAYLOAD_BYTES` and the `nteract.dx.*` comm namespace
   predate the launcher owning this path. Worth deciding whether new surface
   inherits that prefix or takes a launcher-native name.
4. Step 3 retention, per above.
