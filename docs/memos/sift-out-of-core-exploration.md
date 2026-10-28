# Sift Out-of-Core Exploration: Worker Data Side and Pushdown Queries

**Status:** Draft memo, 2026-10-27. Design proposal for
[issue #4497](https://github.com/nteract/nteract/issues/4497). Nothing here is
implemented. Stage 0 ([#4496](https://github.com/nteract/nteract/pull/4496)) is
open; [#4442](https://github.com/nteract/nteract/pull/4442) is merged.

Neighbors:

- [arrow-bounded-head-and-progressive-fetch.md](arrow-bounded-head-and-progressive-fetch.md):
  the notebook-side bounded head. Its unimplemented step 3 (predicate-aware
  fetch from a live kernel) is one provider under this design.
- [arrow-c-stream-output-protocol.md](../adr/arrow-c-stream-output-protocol.md):
  Arrow IPC stream framing that provider results reuse.
- [output-frame-security.md](../adr/output-frame-security.md): the notebook
  output frame Sift runs in; constrains how a worker can be spawned.
- `packages/sift/AGENTS.md` and `packages/sift/docs/embedding-guide.md`.

## Objective

Sift should open an arbitrary Parquet file and feel immediate: first rows on
screen at once, more on demand, and whole-file filter, sort and summaries when
the user asks for them. The same view should sit over SQL query results. Every
number on screen must say what it covers.

The issue proposes one engine change (an async data side) that enables three
things: a worker, paging past memory, and pushdown. This memo evaluates that
against the code and arrives at a different decomposition and order.

## Method

Six independent source-grounded reviews, each on a different model family and
each with one lens (engine protocol, Rust/Parquet, provider contract, staging
and compatibility, worker and security, UX scope). Every claim cited below was
re-verified against the checkout at `6c75c3bf5` and #4496 at `e512187ab`.
Parquet crate citations are `parquet 54.3.1`, the version in `Cargo.lock`.

## What the code says

### The view, not the data side, is O(rowCount)

`createTable` allocates two `Float64Array`s and an `Int32Array` sized to
`rowCount` at mount (`packages/sift/src/table.ts:282-286`). `applyFilterAndSort`
builds a JS `number[]` of every row even with no filter (`table.ts:617-631`).
`rebuildPositions` is an O(filteredCount) prefix sum run on every frame that
lazily prepares a row (`table.ts:472-479`, `1607-1609`). The crossfilter path
allocates a `Uint8Array(rowCount)` mask per filter change and hands it to WASM
(`table.ts:2392-2396`).

A windowed `TableData` with `rowCount = 120M` cannot mount regardless of where
the WASM store lives. Moving the store to a worker does not make Sift
out-of-core. Sparse geometry does, and that is a view rewrite.

### The async cut is already half-made

`prefetchViewport` (`packages/sift/src/wasm-table-data.ts:94-129`) takes a
batch of row ids, makes one WASM call (`store_viewport_cells`), and fills a JS
cache that `getCell`/`getCellRaw` read synchronously. The response is a plain
object of display strings, f64s and null flags. It is a window RPC in
everything but latency. The engine calls it once per frame
(`table.ts:1569-1576`).

Of the eleven `TableData` members, only `getCell`/`getCellRaw` are hot and they
are cache reads. The four that cannot cross a thread boundary are the ones that
move O(N) arrays: `sortColumn` (N indices), `filterRows` (match indices),
`recomputeFilteredSummaries` (N-byte mask), and the implicit `rowCount`-sized
geometry. The cut goes around those, not around `getCell`.

### Pushed-down results already have a landing path

`react.tsx` consumes Arrow IPC streams through `append_arrow_stream_chunk` and
`replaceData` (`react.tsx:761-836`; `store.rs:936`). A provider that answers a
query with a bounded Arrow IPC stream is exactly what the manifest source
consumes today. Whole-file Parquet filter and bounded ADBC results are the same
shape: query in, bounded resident set out. Neither needs placeholders.

What that path lacks is query ownership. `replaceData` reapplies the current
filters and sort unless told to reset them (`table.ts:2121-2135`,
`preserveStateFor`). Swapping in a pushed-down result would re-evaluate the
same predicates locally; passing `resetFilters` also wipes the filter UI. There
is no "keep the controls, skip local evaluation" mode. The engine needs to
separate the committed source query from the local resident filter.

### Isolation is a promise the code cannot keep

The embedding guide tells hosts to load untrusted files "in a Worker you can
terminate" (`docs/embedding-guide.md:105`). A host cannot. The WASM module is a
module-level singleton with no reset after a trap (`predicate.ts:151-188`), and
a `TableData` handle cannot cross realms. One hostile file disables every Sift
table in the frame. The comment at `store.rs:451-452` says a poisoned store lock
recovers; `parquet_file.rs:381-383` already says it does not on wasm32, where
panics abort.

A trap is reachable from `parquet_open` before any budget check: parquet
54.3.1 `assert_eq!`s on INT96 statistics longer than 12 bytes
(`file/statistics.rs:217`). Only Sift can provide the worker, and it must be
re-spawnable.

No build sets a WASM memory maximum (`crates/sift-wasm/Cargo.toml`,
`.cargo/config.toml`, the xtask `wasm-pack` invocation). A worker contains
traps and hangs; it does not contain memory exhaustion without a cap.

### Footer statistics are not exact at this crate version

`from_thrift` turns a missing `null_count` into `Some(0)`
(`parquet-54.3.1/src/file/statistics.rs:132`, with an upstream TODO). The
59.x line keeps the `Option`. "Exact whole-file null counts from the footer"
needs a crate bump or a raw read of the thrift `FileMetaData`. String bounds
may be truncated. Float bounds may be ±Inf while store histograms drop
non-finite values (`store.rs:1490`). Deprecated `min`/`max` on binary and
unsigned columns used the wrong sort order (PARQUET-686). Every footer number
needs three-state provenance, not a boolean.

### Defects found on the way

Independent of this design and worth fixing first:

| Defect | Evidence |
|---|---|
| Decimal columns classify as `numeric` but `get_f64_value` has no Decimal arm, so they get no histogram and a range filter excludes every row | `store.rs:96-97`, `store.rs:2626-2709`; scaling exists in `parquet_summary.rs:311-334` |
| Files with any column chunk past 4 GiB are rejected at open on wasm32 ("files of any size" in #4496 is false there) | `parquet_file.rs:103-107`, `:216`; parquet `serialized_reader.rs:621` narrows to `usize`. Fix: rebase chunk offsets per row group via `ColumnChunkMetaData::into_builder()` |
| `cast_column` rewrites batches but never updates `store.schema`; an append after a cast mixes types across batches and `sort`'s `concat` fails. Only the "no casts while streaming" guard hides it | `store.rs:2481-2487`, `:523-526`; `table.ts:2668` |
| `NumericColumnSummary.nullCount` and `TimestampColumnSummary.nullCount` exist but are never populated | `table.ts:43,74`; `wasm-summaries.ts:58-88` |
| `loadTableFile(..., { overflow: "truncate" })` returns `Promise<TableData>` with no way to learn the result was truncated | `e512187ab:packages/sift/src/file-data.ts` |
| The `url` source's Parquet branch runs with limits at their `u32` maxima, so a ~4 GiB row group passes admission and is buffered whole | `embedding-guide.md:194-197`, `file-data.ts:42` |
| `.sift-preview-scope` ("Table tools use shown rows") is hidden below 700px, exactly where space is scarce | `library.css:1139-1142` (#4496) |
| `tests/e2e/cast-during-streaming.spec.ts` is outside `testDir: "./e2e"` and skips its main assertion if loading finishes first | `playwright.config.ts:4` |
| The store lock-poisoning comment is wrong for wasm32 | `store.rs:451-452` vs `parquet_file.rs:381-383` |

## Architecture

Three layers, with the boundaries where the code already wants them:

```
┌─────────────────────────────────────────────────────────────┐
│ View (main thread)                                          │
│ DOM, geometry, pooled rows, controls, footer, getState()    │
│ Owns: committed query, generation, resident window cache    │
└──────────────┬──────────────────────────────┬───────────────┘
               │ requestWindow / setQuery     │ events
┌──────────────┴──────────────────────────────┴───────────────┐
│ Data side (main thread adapter, or worker)                  │
│ Analysis store (dense, resident): sort, filter, crossfilter,│
│ summaries over an honest scope                              │
│ Window cache (sparse, LRU): cells for rows past the budget  │
│ Owns: permutation, filter mask, both summary snapshots      │
└──────────────┬──────────────────────────────────────────────┘
               │ open / read(offset,len) / query(TableQuery)
┌──────────────┴──────────────────────────────────────────────┐
│ Sources                                                     │
│ ByteSource (host; exact bytes, never filtered)              │
│ Bounded scanner: Parquet pruning + projected decode         │
│ Query session: ADBC, kernel, DuckDB (host-executed)         │
└─────────────────────────────────────────────────────────────┘
```

Rules:

1. `TableData`, `createTable`, `loadTableFile`, `SiftTable` and their
   synchronous semantics stay as documented. The resident path remains the
   default and instantiates no worker. New behavior arrives through new types
   and opt-in source options, never by changing an existing export's return
   type or the meaning of `rowCount`.
2. The data side owns every O(N) structure. The view sends filter specs and
   window ranges; it receives counts, summaries and cells.
3. Two stores, not one. The analysis store stays dense so every existing
   kernel (sort, filter, histograms, masks) works unchanged over a resident set
   with a nameable scope ("loaded rows" or "matches in file"). The window cache
   is a separate sparse LRU keyed by `(row_group, batch)` that serves only
   `getCell`. Mixing them breaks `resolve_row`, sort permutations, filtered
   masks, cast originals and image refinement (`store.rs:58-69`, `1958-1975`,
   `1674-1802`, `2264-2358`, `259`).
4. Casts are query projections, not store mutations. A cast lives in the
   committed query, applies at decode into either store, and survives any
   replacement of the resident set.
5. Byte acquisition, bounded materialization and query sessions are separate
   concerns. `ByteSource` returns exact bytes. The Parquet scanner is a smarter
   loader above it that produces a bounded resident result. A query session
   (ADBC, kernel) owns snapshots, cancellation and counts. Do not build a
   miniature database so the Parquet column of the capability table looks like
   the SQL column.

### Transport

Structured clone with transfer lists. Grounds: what crosses the view boundary
is display strings (`store_viewport_cells`), not Arrow; a window is ~100 rows ×
columns ≈ 50 KB; typed arrays and ingest bytes transfer zero-copy.
`SharedArrayBuffer` needs COOP/COEP, which nothing sets, which the notebook
frame cannot set (it loads renderer assets from CDNs and runs with an opaque
origin), which GitHub Pages cannot set, and which would buy nothing because
sift-wasm has no threads. All six reviews reached this independently.

### Spawning

One data-side implementation, two factories, chosen by the host through a
`setWorkerFactory(() => Worker)` hook:

| Host | Constraint | Factory |
|---|---|---|
| Notebook output frame | Sandboxed without `allow-same-origin`, so the origin is opaque and a URL worker throws. `FRAME_CSP` allows `worker-src 'self' blob:`. The plugin is eval-loaded CJS | Inline blob worker bundled into the plugin string |
| Kilo Desktop Files | Production CSP has no `worker-src`; falls back to `script-src 'self'`, which blocks `blob:` | Same-origin module worker served from the app scheme |
| Vite/browser app, GitHub Pages | Same-origin | Module worker via `new Worker(new URL(...), { type: "module" })` |

Never fall back silently to main-thread decoding when a host opted into the
worker for untrusted input.

### Containment and recovery

Document the worker as fault containment for traps, hangs and retained memory.
It is not a sandbox against renderer-process memory exhaustion unless capped,
and it does nothing for the host's I/O (the `ByteSource` read runs on the host;
`row_group_ranges` already rejects over-budget groups before fetch,
`parquet_file.rs:337-346`).

Three mechanisms, each for a different job:

1. A Rust allocation cap: a `#[global_allocator]` wrapper that returns null past
   a host-set limit (`set_allocation_cap(bytes)`). The only thing that stops a
   decompression bomb before the renderer pays for it.
2. `-C link-arg=--max-memory=N` from a `crates/sift-wasm/build.rs` as a fixed
   backstop. Not in `.cargo/config.toml`, which would also hit `runtimed-wasm`
   and `sift-csv-wasm`.
3. A main-side watchdog on request latency, scaled by work, for hangs. A
   blocked worker cannot heartbeat.

On `terminate()`: respawn, forward the WASM URL and fallback URL (main-realm
state, `predicate.ts:153-179`), re-open from cached tail bytes, reload row
groups before the failed one, quarantine the failed group, replay casts then
sort then filters from `getState()`, show the existing "Stopped loading: … ·
Showing loaded rows" footer. Cap respawns per source at two. Without the
quarantine, containment becomes a crash loop.

## Contracts

Sketches, not final shapes. The vocabulary for filters is the existing
name-addressed `FilterPredicate` tree (`filter-schema.ts:13-107`), which
`engineStateToExplorerState` already produces. Not `FilterSpecJson` (a
positional WASM ABI) and not SQL strings.

### Query and windows

```ts
type TableQuery = {
  casts: { column: string; to: ColumnType }[];       // applied before filters
  filters: FilterPredicate[];                          // top-level AND
  sort: SortEntry[];
};

type Count =
  | { kind: "exact"; value: number }
  | { kind: "estimate"; value: number; method?: string }
  | { kind: "lower-bound"; value: number }
  | { kind: "unknown" };

type WindowCells = {
  viewStart: number;
  dataRows: Uint32Array;        // identity for pooled rows, focus, detail sheet
  strings: string[];            // row-major; "" for null
  nulls: Uint8Array;
  numeric: Float64Array;
};

type WindowedTableData = {
  kind: "windowed";
  columns: Column[];
  rowCount: Count;              // rows in the current view (post-filter)
  loadedRowCount: number;       // rows resident for exact local work
  head: WindowCells;            // present at mount for fitColumnWidths
  requestWindow(viewStart: number, viewEnd: number, generation: number): Promise<WindowCells>;
  setQuery(query: TableQuery, signal: AbortSignal): Promise<QueryResult>;
  requestImage(dataRow: number, col: number): Promise<Uint8Array[] | null>;
  subscribe(listener: (event: DataEvent) => void): () => void;
  dispose(): void;
};

createTable(container, data: TableData | WindowedTableData, options?)
```

Every response carries `generation`; the view discards mismatches. At most one
`setQuery` is in flight; the view coalesces. Image cells need their own request
because they bypass the viewport cache today (`wasm-table-data.ts:143-158`).
`requestWindow` takes view positions, not data rows, because the permutation
lives on the data side.

### Query sessions (providers)

```ts
interface TableQuerySession {
  readonly capabilities: ProviderCapabilities;   // filter ops per column, sort, casts,
                                                 // counts, summaries, window modes, replay
  query(q: TableQuery & { window: WindowRequest }, ctx: RequestContext): Promise<QueryPage>;
  count(q: TableQuery, mode: "cheap" | "exact", ctx: RequestContext): Promise<Count>;
  summarize(q: TableQuery, requests: SummaryRequest[], ctx: RequestContext): Promise<SummaryFact[]>;
  close(): Promise<void>;
}
// QueryPage.ipc is one complete Arrow IPC stream (schema-only when empty).
// WindowRequest: head | cursor | keyset | offset (offset capped by capability).
// RequestContext: requestId, AbortSignal, budget { deadlineMs, maxIpcBytes, maxDecodedBytes }.
```

Positions:

- Results are Arrow IPC, not `ViewportCells`. IPC preserves decimals, Int64,
  nested values, images and metadata; the data side renders cells from it.
- `count` and `summarize` are separate from `query` so first paint never waits
  on `COUNT(*)` or a histogram.
- Capabilities gate controls, and `query` still validates the whole shape.
  Unsupported operations return a structured error, never a silently narrowed
  result. There is no implicit "run it locally on loaded rows" fallback under
  the same control state; the UI offers an explicit loaded-rows preview or
  disables the action with the reason.
- The host owns SQL dialect, the trusted base relation, connection, credentials
  and placement. Sift never receives SQL text from a renderer message.
- Row identity: Parquet uses the global row ordinal (free and stable). SQL uses
  a host-declared unique key for keyset, else a snapshot-bound cursor with
  ordinal identity for one generation. `OFFSET` is allowed only under a stable
  snapshot and deterministic total order, capped (proposed `maxOffset` 10,000,
  1,000 rows and 8 MiB per page). Deeper seeks are refused, not iterated.
- `predicateToSQL` stays a human-readable export. Driving a database needs a
  host-side compiler with typed bound parameters and a versioned semantic
  profile. Known gaps in the current exporter: `in([])` emits `IN ()`,
  `contains("%_")` emits an unescaped `LIKE`, timestamp brushes emit millisecond
  integers, and category labels are display strings not source scalars.
- Cancellation: `AbortSignal` at each hop bridges to `{cancel, requestId}`
  messages; the host registry calls `AdbcStatementCancel` (thread-safe under
  ADBC 1.1). Stale-result rejection by generation is mandatory even when cancel
  succeeds. Inside a WASM call the only cancel is `terminate()`.

### Scope on every metric

A single `scope` badge per summary cannot describe a loaded-row histogram with
a whole-file range and null count, and it would mix denominators: `NumericProfile`
derives null percentage from loaded bins plus `nullCount`
(`sparkline.tsx:654-671`), and `BooleanRatioBar` folds nulls into one total
(`sparkline.tsx:1016-1065`). Scope attaches per metric:

```ts
type Coverage = {
  scope: "loaded" | "dataset";
  precision: "exact" | "estimated" | "lower-bound";
  source: "resident" | "metadata" | "query";
};
type ScopedValue<T> = Coverage & { value: T };

type SummaryScope = {
  rows: { loaded: number; dataset?: ScopedValue<number> };
  distribution: Coverage;                              // bins, categories, true/false
  range?: ScopedValue<{ min: number; max: number }>;
  nullCount?: ScopedValue<number>;
  distinctCount?: ScopedValue<number>;
};
// optional `scope?: SummaryScope` on each non-null ColumnSummary; absent means
// all-loaded / exact / resident.
```

Footer statistics are computed once at open (before `finish()` drops the
metadata, `parquet-file.ts:316-322`) and kept immutable on `TableData`; the
summary adapter merges them into `scope` on every rebuild, since
`updateWasmSummaries` replaces the whole `columnSummaries` array on each append
(`wasm-summaries.ts:18`). A cast hides footer stats for that column; they
describe the original type.

Rendering rules: re-bin resident values over the dataset range rather than
stretching loaded bins; label the distribution "Loaded rows · exact" and the
range "0 – 100 · whole file"; render dataset nulls as a separate line with the
dataset denominator; keep categorical bars and the filter popover loaded-scope
("Search N loaded values…", "All loaded"); never admit unseen dataset values to
the checkbox domain. When every metric shares one coverage, collapse to one
caption.

### Footer states

One engine-owned footer view model. React renders it; it does not patch the
status dot separately as #4496's wrapper does (`e512187ab:react.tsx:557-611`).

| State | String |
|---|---|
| Loading, known total | Loading N of M rows… · Tools use loaded rows |
| Fully resident | N rows · Whole dataset · Exact |
| Fully resident, filtered | N of M rows · Whole dataset · Exact |
| Truncated head | Showing first N of M rows · Tools use shown rows |
| Filter over shown rows | N of L shown rows · Filters use shown rows |
| Whole-file scan running | Scanning whole file… · X of Y row groups · [Cancel] |
| Pushed-down result, exact count | N whole-dataset matches · K rows shown |
| Pushed-down result, estimate | ≈N whole-dataset matches · Estimated · K rows shown |
| Count pending | Counting whole-dataset matches… · K rows shown |

During a scan or query the previous rows and their captions stay; only the
activity changes. On narrow screens drop the K clause before dropping the
scope words.

### Crossfilter then apply

Brushing stays synchronous over the resident set. After a brush commits, one
action appears beside the filter pills, "Apply filters to whole dataset", only
when the provider declares the capability. Apply commits the full predicate set
as one `TableQuery` against the original snapshot and replaces the resident
generation. It does not layer on the previous result and does not union rows.
The pills survive; pixel brush rectangles do not. The old histogram stays
visible, non-interactive and labeled "previous result" until the new summaries
land with their actual coverage. Removing a filter queries the source snapshot,
not the already-filtered result; otherwise cleared rows cannot come back.

### Placeholders

A placeholder is a real pooled row with one skeleton bar per cell and
`aria-busy` on the grid. It carries no cell text: `""` already means null. The
existing `!cache → LINE_HEIGHT + CELL_PAD_V` branch (`table.ts:357`) is the
36 px estimate; image columns estimate 80 px. When a window resolves, run the
existing scroll-anchor path (`markHeightsDirty(true)` → `captureScrollAnchor` →
`restoreScrollAnchor`, `table.ts:526-571`) so the anchored row stays put as
estimates become measurements. Window arrival must not go through
`replaceData`, which clears caches and resets scroll (`table.ts:2205-2232`).

## Staged plan

The issue's order was 1 → 2 → 3 → 4 with stage 2 on the main thread and stage
3 as one step. Four of six reviews rejected a main-thread whole-file scan (a
synchronous `parquet_append_row_group` per row group with a `setTimeout(0)`
between, `react.tsx:347`, over gigabytes of possibly hostile input). All six
separated "worker" from "paging". Three put bounded ADBC before paging because
it rides the existing result path and forces the contract to be honest.

Every stage below is a minor release of `@nteract/sift`.

| Stage | Delivers | Public surface | Gate |
|---|---|---|---|
| 0 | Bounded head preview | `overflow: "truncate"` (#4496) | merged |
| 1 | Honest summaries and decode fixes | `Coverage`, `ScopedValue`, `SummaryScope`, `TableData.datasetStats?`, `TableData.coverage?` (truncation observable from `loadTableFile`); `parquet_file_column_stats`, `store_null_counts` | Golden fixtures from pyarrow, polars, DuckDB, parquet-java: no stats, missing null counts, deprecated min/max, all-null, ±Inf, >4 GiB offsets. A mixed-summary e2e asserting loaded distribution + whole-file range + dataset null % |
| 1b | Load more on demand, up to a hard budget | `limits.autoRows`/`autoDecodedBytes` (soft) alongside the existing hard limits; a footer "Load more" affordance; scroll-near-end trigger as a host option | Dense geometry unchanged; respects the hard budget; Desktop milestones (`engine-mounted`, `complete`, `streaming-complete`) keep their meaning |
| 2 | Query contract and async shell, main thread | `TableQuery`, `Count`, `WindowCells`, `WindowedTableData`, `QueryResult`, `DataEvent`; `createTable` accepts the union; `TableEngineState.pending?`, `loadedCount?`; separate committed-query vs resident-filter ownership in the engine | Resident adapter passes the existing `table.test.ts` semantics through a delayed harness. Out-of-order `setQuery` responses never paint. `replaceData` of a provider result does not re-filter |
| 3 | Worker data side, dense geometry | `setWorkerFactory`, `worker?: SiftWorkerOptions` on `byte-source`; allocation cap + `--max-memory`; `ByteSource` read relay; respawn with quarantine; module and inline worker builds under `./worker` exports | Packed artifact starts in the real notebook frame (blob) and packaged Electron (module). Default sources create zero workers. Terminate-and-recover e2e. `test-package.mjs` verifies worker assets and forbids relative/dynamic imports in the inline bundle |
| 4a | Parquet scan provider (in the worker) | `{ kind: "parquet-scan" }` source or `query` on `byte-source`; progress events | Differential tests vs a fully resident reference: matches only in the last group, better top-K only in the last group, zero matches, budget overflow with an exact count |
| 4b | Bounded query sessions (ADBC, kernel) | `TableQuerySession`, `ProviderCapabilities`, `QueryPage`, `SummaryFact`; `{ kind: "query-session" }` source; `onQueryStateChange` | Provider conformance suite against a fake provider before any live ADBC: empty sets, nulls, null-retaining exclusion, wildcards, Int64 > 2^53, decimals, timestamps with units, duplicate sort keys, late pages, cancel during execute, unknown counts, offset-cap refusal |
| 5 | Sparse geometry and window cache | No new exports; `WindowedTableData.rowCount` may exceed resident capacity | Scroll to a distant window of a file far larger than the budget with bounded view allocations, measured in the packed artifact in a real host |

4a and 4b are independent tracks after 2 and 3. 4b does not need the worker:
the host executes the query and the bounded IPC result loads through
`load_ipc_bounded` on the main thread. 4a needs the worker because it decodes
every unpruned row group of an untrusted file.

Stage 5 is last and highest-risk. It rewrites `rowHeights`/`rowPositions` to
estimate + sparse measured offsets, `rowAtOffset` to a two-regime lookup, and
`viewIndices` to window-only. The `scrollScale` affine map (`table.ts:481-506`)
already handles virtual heights above the browser cap. Gate the sparse path on
`rowCount > residentCapacity` so small tables never take it.

### Stage 1 Rust details

Per top-level column, from footer statistics only, no byte reads:

- Use `StatisticsConverter` (`arrow_reader/statistics.rs:1188`) for typed
  mins, maxes and null counts per row group. It maps every scalar type Sift
  shows and yields null for INT96 and nested types, which is correct.
- A row group's bounds are usable only when statistics are present, the
  physical type is not INT96, the column order is defined, and not (unsigned
  or binary sort order with deprecated `min`/`max`). Bounds are complete only
  when every group is usable, all-null, or empty. String bounds are exact only
  when `min_is_exact`/`max_is_exact` hold.
- Null counts are trusted only when the raw thrift field was present. At
  54.3.1 that means decoding `parquet::format::FileMetaData` from the same
  tail bytes, or bumping the crate. A REQUIRED leaf has null count 0 exactly.
- Convert to the store's units (`get_f64_value`'s millisecond convention for
  temporal types, `store.rs:2678-2697`) so pruning and local filters agree.
- Fix `get_f64_value` for Decimal128/256 first, or footer stats will be the
  only min/max decimals ever get and pruning will disagree with the local
  filter.

### Stage 4a scan details

- Only `range`, `boolean`, and `set` on string columns prune on stats.
  `not_in` keeps nulls (`store.rs:2589-2592`) and effectively never prunes.
  `set` on non-string columns compares display strings
  (`store.rs:1088-1093`) and must not prune.
- Two phases per surviving group: decode predicate columns only
  (`ProjectionMask::roots`), evaluate into a `BooleanArray`, build a
  `RowSelection`; if zero matches skip the group; else fetch the remaining
  leaves and decode with `with_row_selection`. On a wide table with a narrow
  predicate this reads a few percent of the bytes. Compact Utf8View arrays
  after filtering or the ledger charges whole pages for a few matches.
- Split `ParquetFile` (footer only) from a per-target load ledger (`usage`,
  `appended`, budget). Today all four sit on the file
  (`parquet_file.rs:35-46`), so a file can feed one store, once; a scan that
  reuses the head's file handle is rejected by `appended[index]`.
- When matches exceed the budget, stop phase B but keep phase A running in
  count-only mode. The exact match total costs predicate columns alone. Report
  "first N of M matches", never "exact" for an early stop.
- Top-K: order groups by the sort bound, keep a K-heap over the sort column,
  skip groups that cannot beat the Kth value. Arrow sorts NaN above +Inf and
  the writer omits NaN from stats, so either treat NaN as null in pushed-down
  sorts or do not prune float columns by `max`.
- Page index is a later optimization behind two exports
  (`parquet_page_index_range`, `parquet_load_page_index`). pyarrow does not
  write one by default; plan for row groups.

## Resolved questions

| Question | Position |
|---|---|
| Transport | Structured clone + transfer. No `SharedArrayBuffer`. |
| Protocol shape | Window RPC + generation-tagged push. Sort permutations and filter masks live on the data side only. |
| Row identity | Parquet: global row ordinal. SQL: host-declared key for keyset, else snapshot cursor with per-generation ordinals. `OFFSET` capped under a stable snapshot. Sift's own identity already resets on replacement (`table.ts:2205-2206`), so it needs window-stable identity for one generation, not persistent keys. |
| Counts | Discriminated `exact | estimate | lower-bound | unknown`. No count before first paint. Unknown renders as "Counting…", never as the loaded total. |
| Casts | Query projections applied at decode. Survive replacement. Undo re-executes. An unsupported cast stays a loaded-only display transform and disables dependent whole-dataset actions. |
| Granularity | Row groups. Page index optional, invisible to the protocol. |
| Cancellation | `AbortSignal` → request-id cancel at each hop → provider (`AdbcStatementCancel`, `ByteSource` signal). Between row groups by flag; inside a WASM call by `terminate()`. Generation checks regardless. |
| Hostile files | The re-spawnable worker is the isolation boundary the guide promises, for traps, hangs and retained memory. With an allocation cap it also bounds memory. It is not a security sandbox and does not bound host I/O. |
| Where ADBC runs | Host. Sift defines the session contract and the Arrow IPC result format. |

## Rejected alternatives

- **Async `getCell`.** Makes every custom `TableData` implementer break, and
  does not touch the O(N) geometry that actually blocks out-of-core.
- **One `DataStore` holding a sparse LRU of row groups.** Breaks every
  row-indexed kernel. Two stores instead.
- **Main-thread whole-file scan.** Many 100 ms+ stalls on hostile input with
  no preemption. The scan runs in the worker.
- **SQL strings as the pushdown wire format.** The exporter has correctness
  gaps and no type binding; the renderer must never originate SQL.
- **Providers are SQL-only.** The notebook kernel adapter needs typed
  projections over Arrow compute, pandas and Polars
  (`arrow-bounded-head-and-progressive-fetch.md:249-260`). One relational
  contract with declared capabilities covers both.
- **`SharedArrayBuffer` for the worker.** Needs cross-origin isolation no
  host provides, for a payload that is strings.
- **Relabeling `TableData.rowCount` as the dataset total.** A semantic break
  for every host that sizes containers from it (`table.ts:2825-2829`).

## Open items

- Whether to bump `parquet` to a line that keeps `null_count` as `Option` and
  returns an error for over-long INT96 statistics, or to decode the raw
  footer thrift at 54.3.1. The bump is cleaner; the blast radius across the
  workspace is unmeasured.
- The exact `maxOffset`, page row and byte caps for query sessions are
  proposals, not measurements.
- Whether `1b`'s scroll-near-end trigger should be on by default for Desktop
  Files, where the hard budget is already 1M rows / 512 MiB.
- Kernel-side query sessions need handle retention beyond this package
  (`arrow-bounded-head-and-progressive-fetch.md:215-241`).
