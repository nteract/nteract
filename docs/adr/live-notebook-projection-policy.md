# Live Notebook Projection Policy

**Status:** Draft, 2026-06-07. Desktop and hosted cloud both align on
incremental `SyncEngine.cellChanges$` projection for steady-state updates; full
materialization remains for bootstrap and fallback paths.

## Context

nteract hosts share the same notebook surfaces while connecting to different
sources of truth:

- desktop uses a local daemon and a live `SyncEngine`;
- cloud renders pinned snapshots and then attaches to a hosted room;
- Elements and tests mount shared notebook shells with fixture or scenario data.

The shared React surface reads narrow notebook, execution, output, runtime, and
pool stores rather than a full materialized view. Full materialization fits
bootstrap and structural changes, but it is too expensive for hot runtime
traffic. Output-heavy notebooks emit frequent runtime, execution, and output
updates without changing cell order or source.

This policy makes the projection boundary explicit so host adapters do not drift
back to re-serializing the whole notebook on every live update.

## Decision

Live hosts treat full notebook materialization as a bounded fallback, not the
default projection path.

Full materialization applies when:

- a notebook first becomes interactive;
- a pinned cloud snapshot renders;
- the cell list has structural changes (add, remove, or reorder);
- a changeset is missing or marks a field that narrow accessors cannot project.

Runtime-state, execution-view, output-id, pool-state, presence, and broadcast
updates must project through stable narrow stores. They must not re-read,
re-resolve, or replace the entire cell list.

Cell chrome updates may update only touched cells in the cell store when the
changeset classifies incrementally. Output-only changes update the output store
and leave the cell store untouched.

Host-specific blob access is a projection dependency, not a reason to fork
projection semantics. Shared projection helpers accept a host-provided blob
resolver: desktop uses the daemon blob port, and cloud uses an authenticated
HTTP/R2 resolver.

## Implementation Status, 2026-06-07

The desktop bridge consumes `SyncEngine.cellChanges$` changesets and applies
narrow cell, output, and runtime store updates where possible.

The hosted live room path follows the same steady-state rule. Cloud subscribes
to `SyncEngine.cellChanges$` through a serialized subscription helper and feeds
each `CellChangeset` into the shared `materializeChangeset` path with a
cloud-provided blob resolver. Full materialization handles bootstrap and
fallback cases; routine source, metadata, execution, and output updates use the
same narrow stores as desktop.

## Consequences

Steady-state cost scales with the update:

- runtime and execution changes update runtime and execution stores;
- output payload changes update only changed output ids;
- source or metadata edits update only touched cell records;
- structural changes still pay full materialization cost.

This preserves iframe stability, output subscriptions, and rail/view-model
subscriptions across desktop and cloud. It also defines a clear performance
regression rule: any live runtime or output event that triggers full
materialization is a regression unless explicitly classified as a fallback.

## Non-Goals

Hosts do not have to implement every incremental path at once. They may keep
full cell materialization for structural or unclassified notebook changes while
moving runtime and output hot paths to narrow projections.

This ADR does not change the cell execution pipeline, output transport, or
runtime control-plane ordering invariants. Those remain governed by
[Cell Execution Pipeline and Control-Plane Separation](execution-pipeline.md).
