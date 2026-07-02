# Runtime Output Optimization Plan

**Status:** Measurement / plan, 2026-05-25. This is not an ADR; it is the
optimization sequence behind the output-related ADRs and measurements.

Runtime output performance has two different problems:

- **Hot-path duplication**: repeated output scans, manifest decoding, sorting,
  snapshot reads, and frontend store invalidation around the existing flat
  output model.
- **Document amplification**: ordinary bursts still become one RuntimeStateDoc
  output entry per kernel output, so Automerge sync bytes scale with output
  count even when the IOPub reader is no longer blocked.

The first category is mergeable without changing protocol shape. The second
category likely needs blob-backed output segments, but only after every public
reader has a flat projection/resolution layer.

## Decision 1: Public output APIs stay flat

Existing clients must continue to observe normal output manifests through:

- `RuntimeStateDoc::get_outputs`, `get_all_outputs`, `get_execution`, and
  `read_state`
- runtimed-wasm `outputIdChanges`
- TypeScript output stores
- MCP and Python execution results
- `.ipynb` save/export
- display-id update paths
- widget OutputModel replay

An `output_segment` record is an internal storage record, not a public output.
Do not enable a production segment writer until unresolved segment records are
hidden from all of those consumers.

This rejects a visible "VStack" or manifest-batch protocol as the first
production step. Batching can be the internal storage representation, but the
client contract remains ordered flat outputs until we intentionally version a
new consumer protocol.

## Decision 2: Optimize duplicated flat-path work first

Keep the manifest shape unchanged while removing known repeated work:

1. ✅ **Done (a2bfef02).** Exact output lookup by `(execution_id, output_id)`
   via `get_display_index_entries` and `get_output`
   (`crates/runtimed/src/output_prep.rs:316-329`). Display updates no longer
   sort and scan every output in the execution.
2. **Open.** Cached or indexed output ordering metadata so append/upsert paths
   do not recompute order by decoding all manifests.
3. ✅ **Done (614ec946, 3c18ce8f).** Targeted RuntimeStateDoc readers for
   runtime-agent queue and comm handling. Measured via `doc.get_comms()` and
   `doc.get_queued_executions()`
   (`crates/runtimed/src/output_commit_measure.rs:345-348`). State-sync
   bookkeeping no longer materializes every flat output when it only needs
   queued execution metadata or widget comm state.
4. **Open.** WASM-side output-id indexing so runtime sync handling does not
   repeatedly read the full runtime state just to derive output deltas.
5. ✅ **Done (038caec2).** Removed the dormant frontend optimistic
   `update_display_data` overlay. RuntimeStateDoc changesets carry display
   updates to the output store.
6. ✅ **Done.** In-place WASM output-id diff snapshots
   (`crates/runtimed-wasm/src/lib.rs:2908-2910`). Runtime sync compares the
   flat output set without cloning every unchanged manifest into a fresh
   snapshot on each frame.
7. **Partially done.** Frontend output materialization cleanup. Runtime outputs
   flow through the output store; tail pinning and derived views remain active
   work.

Each item should include a small benchmark or stress case proving the
eliminated work.

## Decision 3: Segment storage needs projection before writing

The measured blob-backed segment model reduces Automerge traffic by storing
ordered child manifests in blobs and putting one segment reference per chunk in
RuntimeStateDoc. That model is promising, but production needs these layers
first:

1. A shared output segment schema and resolver.
2. Resolver support in MCP/Python/save paths that expands segments to flat
   child outputs.
3. Frontend and WASM projection support so `outputIdChanges` carries child
   output ids and manifests, not segment placeholders.
4. Display update semantics for segmented outputs, or a writer rule that keeps
   display-id-addressable outputs flat.
5. Widget OutputModel semantics, or a writer rule that keeps widget-captured
   outputs flat.

The first production writer should be conservative: segment only append-only
ordinary outputs with no `display_id` and no widget capture until replacement
semantics are explicitly handled.

## Decision 4: Kernel-side easing is semantic

Producer-side optimization is useful, but it cannot be a blanket coalescer:

- stdout/stderr buffering can be tuned because stream output is append-only
  text.
- `update_display_data` can be coalesced by `display_id` because the Jupyter
  protocol describes it as replacing prior display state.
- ordinary `display_data`, `execute_result`, `error`, and arbitrary comm events
  are durable semantic events and must not be collapsed transparently.

Any runtime-controlled kernel buffering should be explicit nteract API surface,
with a final flush before terminal execution state.

## Measurement Contract

Benchmarks should cover N=100, 500, and 1000 for:

- raw IOPub display bursts
- current flat RuntimeStateDoc output commits
- optimized flat-path commits
- future segmented storage with flat projection

Success means preserving ordinary display count and order, preserving final
display-id state before execution completion, keeping interrupts responsive, and
showing both local CPU/work reduction and RuntimeStateDoc sync-byte impact.
