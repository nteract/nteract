# Live Notebook Projection Policy

**Status:** Draft

## Context

nteract hosts increasingly share the same notebook surfaces while connecting to
different sources of truth:

- desktop uses a local daemon and a live `SyncEngine`;
- cloud can render pinned snapshots and then attach to a hosted room;
- Elements and tests mount shared notebook shells with fixture or scenario data.

The shared React surface reads stable notebook, execution, output, runtime, and
pool stores. Those stores are intentionally narrower than a fully materialized
notebook view. A full materialization is still useful for bootstrap and
structural changes, but it is too expensive for hot runtime traffic. Output
heavy notebooks can produce frequent runtime-state, execution, and output
changes without changing cell order or source.

The projection rule needs to be explicit so host adapters do not silently drift
back to "serialize and resolve the whole notebook" for every live update.

## Decision

Live hosts should treat full notebook materialization as a bounded fallback, not
the default projection path.

Full materialization is appropriate when:

- a notebook first becomes interactive;
- a pinned cloud snapshot is rendered;
- the cell list has structural changes such as add, remove, or reorder;
- a changeset is missing or marks a field that cannot be projected through a
  narrow accessor.

Runtime-state, execution-view, output-id, pool-state, presence, and broadcast
updates must project through stable narrow stores. They should not re-read,
re-resolve, or replace the entire cell list.

Cell chrome updates may update the cell store for the touched cells only when
the changeset can be classified incrementally. Output-only changes should update
the output store and leave the cell store stable.

Host-specific blob access is a projection dependency, not a reason to fork the
projection semantics. Shared projection helpers may accept a host-provided blob
resolver so desktop can use the daemon blob port while cloud can use an
authenticated HTTP/R2 resolver.

## Implementation Status, 2026-06-07

The shared desktop bridge already follows the intended path: it consumes
`SyncEngine.cellChanges$` changesets and applies narrow cell/output/runtime
store updates where possible.

The hosted live room path now follows the same steady-state rule. Its cloud
session subscribes to `SyncEngine.cellChanges$` through a serialized
subscription helper and passes each `CellChangeset` into the shared
`materializeChangeset` projection path with a cloud-provided blob resolver. Full
live-cell materialization remains for bootstrap and fallback cases, while
routine source, metadata, execution, and output updates flow through the same
narrow stores as desktop. The cleanup item is marked complete in
the retired cleanup punchlist as `LNP-1` (done in #3491).

## Consequences

The desired steady-state cost is proportional to the update:

- runtime/execution changes update runtime and execution stores;
- output payload changes update only changed output ids;
- source or metadata edits update only touched cell records;
- structural changes still pay the full materialization cost.

This preserves iframe stability, output subscriptions, and rail/view-model
subscriptions for both desktop and cloud. It also gives performance reviews a
clear failure mode: a live runtime/output event that calls full notebook
materialization is a regression unless it is explicitly classified as a
fallback.

## Non-Goals

This ADR does not require every host to implement all incremental paths at once.
It records the target policy and fallback boundaries. Hosts may temporarily keep
full cell materialization for structural or unclassified notebook changes while
moving runtime/output hot paths to narrow projections.

This ADR also does not change the cell execution pipeline, output transport, or
runtime control-plane ordering invariants. Those remain governed by
[Cell Execution Pipeline and Control-Plane Separation](execution-pipeline.md).
