# Embedding Sift

`@nteract/sift` is a browser table viewer with compiled JavaScript, CSS, TypeScript
interfaces, and a matching WebAssembly decoder. It does not require a notebook,
kernel, daemon, Tauri, Electron, or an nteract runtime connection. React and React
DOM are required even for the imperative API because column controls use React.

## Install and assets

```sh
npm install --save-exact @nteract/sift react react-dom
```

Pin an exact version. Stable nteract releases publish `@nteract/sift` to npm's
`latest` tag; nightly releases publish `<version>-nightly.<run ID>` to `nightly`
for hosts that track main between stables. `@nteract/sift-csv` follows the same
channels with its own version. Both carry npm provenance from the nteract
release workflow. Hosts that vendored a packed tarball can switch to the
registry package: it is the same `pnpm pack` output, with the same exports,
`lib/` layout, and `lib/THIRD_PARTY_NOTICES.md`.

```tsx
import { SiftTable, setWasmUrl } from '@nteract/sift'
import '@nteract/sift/style.css'
// Vite example: emit the packaged binary through the host's asset pipeline.
import wasmUrl from '@nteract/sift/sift.wasm?url'

setWasmUrl(wasmUrl) // Configure once, before the first binary table loads.
```

Other bundlers can copy `@nteract/sift/sift.wasm` into their local assets and pass
its served URL to `setWasmUrl`. Without an override, the shipped wasm-bindgen glue
resolves `sift_wasm_bg.wasm` relative to itself; preserve that layout when serving
unbundled modules. Serve the binary with `application/wasm`. Keep the JavaScript
and WASM from the same package version. No CDN or data upload is required.

The host owns file access and its existing sandbox/CSP policy. In an Electron
app, read selected files through the approved main/preload bridge and pass text
or bytes to the renderer; Sift does not need Node integration or filesystem
access. The package's URL API explicitly fetches URLs supplied by the host.

## Local CSV and TSV

CSV parsing is a separate package, `@nteract/sift-csv`, so apps that only open
Parquet or Arrow do not carry it. It converts text or bytes to an Arrow IPC
stream that `loadTableFile` accepts:

```tsx
import { csvToArrowIpc } from '@nteract/sift-csv'
import { loadTableFile, SiftTable } from '@nteract/sift'

const load = useCallback(async () => {
  const ipc = await csvToArrowIpc(text, { delimiter: '\t' })
  return loadTableFile(ipc, { format: 'arrow-ipc' })
}, [text])

<SiftTable source={{ kind: 'loader', load }} style={{ height: 600 }} />
```

Type inference reads the whole file. Booleans, Int64, Float64 (including
exponents), ISO dates, and ISO timestamps are detected; a column with mixed
shapes stays text. Empty fields are null in every type. Malformed quoting and
ragged rows reject with the reason; nothing is truncated or sampled. The host
owns text decoding and delimiter choice; there is no guessing. Defaults are
16 MiB of input, 100,000 rows, and 256 columns, each an option. See the
package README for the WASM asset setup.

## Local Parquet and Arrow

```ts
import { loadTableFile, createTable } from '@nteract/sift'

const data = await loadTableFile(bytes) // Uint8Array; detects Parquet magic.
const engine = createTable(container, data)
// When the document closes or changes:
engine.destroy() // Also disposes the data's WASM store.
```

For React, use a memoized loader returning fresh data for every invocation.
This also supports React StrictMode's setup/cleanup replay:

```tsx
import { useCallback } from 'react'
import { loadTableFile, SiftTable } from '@nteract/sift'

function ParquetView({ bytes }: { bytes: Uint8Array }) {
  const load = useCallback(() => loadTableFile(bytes), [bytes])
  return <SiftTable source={{ kind: 'loader', load }} style={{ height: 600 }} />
}
```

Keep the bytes snapshot stable until the file changes. Do not capture and return
one previously loaded disposable table from the callback.

`loadTableFile` supports Parquet and uncompressed Arrow IPC streams. The optional
`format` is `'parquet'` or `'arrow-ipc'`. CSV and TSV go through `@nteract/sift-csv`. Arrow file
containers and compressed IPC streams are not supported by this path.

Binary input defaults to 16 MiB, 100,000 rows, 256 columns, and 128 MiB of
retained Arrow memory (`maxBytes`, `maxRows`, `maxColumns`, `maxDecodedBytes`).
Rows and columns are checked from file metadata before decoding. Retained memory
is checked after each decoded batch, and the decoder can allocate one batch past
the limit before that check runs. These limits are meant for files you chose to
open, not a sandbox for hostile input: a crafted Parquet file can make one batch
large. If you load untrusted files, do it in a Worker you can terminate.

This API loads a complete file. Virtual scrolling bounds rendered DOM, not the
dataset: sorting, filtering, and summaries cover every accepted row. There is no
paging or sampled preview. Byte-range Parquet can load a bounded leading
prefix instead; see [Bounded previews](#bounded-previews).

Lists, structs, and maps display as text. Known image structures have dedicated
rendering.

## Parquet by byte range

For Parquet files you would rather not read into memory, give Sift a
`ByteSource` instead of bytes. Sift reads the footer, then fetches each row
group's column chunks as it decodes them; the whole file is never buffered in
JS or WASM memory.

```ts
import type { ByteSource } from '@nteract/sift'

const source: ByteSource = {
  byteLength: stat.size,
  // Resolve with exactly `length` bytes. The signal aborts when Sift no
  // longer needs them (unmount, source change).
  read: (offset, length, signal) => files.readRange(path, offset, length, { signal }),
}
```

Back `read` with whatever the host already trusts: a file handle behind an
IPC bridge, or a URL that honors HTTP `Range`. Return a transferable
`Uint8Array`; avoid base64.

Two ways to use it:

```tsx
// Complete or error, like loadTableFile(bytes). Resolves after every row group.
// This path passes no AbortSignal to `read`.
const data = await loadTableFile(source)

// Progressive: the table mounts after the first row group and the rest stream
// in behind the streaming indicator. Memoize `source`; a new identity reloads
// and aborts the previous source's reads.
<SiftTable source={{ kind: 'byte-source', source }} onLoadError={report} />
```

The footer must carry the `PAR1` magic; anything else is rejected after a
single read of the file tail. `maxRows`, `maxColumns`, and `maxDecodedBytes`
apply as for bytes, from the footer and cumulatively as row groups append.
`maxBytes` does not: the file length is not the cap, retained memory is. A file
whose decoded rows exceed `maxDecodedBytes` still fails; raise the limit for
hosts with memory to spare. Rows become resident as their row group loads and
stay resident, so sort, filter, and summaries cover every loaded row.

What `maxDecodedBytes` bounds is retained Arrow memory, checked after each
decoded batch. Two guards keep transient memory near it: a footer longer than
the limit is rejected before it is read, and a row group whose compressed or
footer-declared size exceeds the remaining budget is rejected before it is
fetched. One row group's compressed bytes still pass through JS and WASM
memory while it decodes. Files with column chunks past 4 GiB are rejected at
open; the WASM reader cannot address them.

If a row group fails after the table has mounted (a read error, the decoded
limit), the rows already loaded stay on screen and usable. Sift does not show
its blocking error box. Instead its footer reads "Stopped loading: <message> ·
Showing loaded rows" and the status indicator turns to a warning mark whose
tooltip names the failure. `onLoadError` still fires, so the host can log it.
A failure before mount shows the error box as usual. To tell the two apart,
check whether the `engine-mounted` milestone arrived for this load. The next
source to load clears the notice. A Parquet `url` streams through the same
loader and behaves the same way.

### Bounded previews

To open files of any size and show the leading rows, set `overflow: 'truncate'`.
Rows and decoded bytes become a budget instead of an admission check:

```tsx
<SiftTable
  source={{
    kind: 'byte-source',
    source,
    limits: { maxRows: 1_000_000, maxDecodedBytes: 512 * 1024 * 1024 },
    overflow: 'truncate',
  }}
  onLoadMilestone={(m) => {
    if (m.phase === 'streaming-complete' && m.truncated) {
      console.log(`Showing first ${m.rowCount} of ${m.totalRowCount} rows`)
    }
  }}
/>

// loadTableFile accepts the same option for a ByteSource.
const data = await loadTableFile(source, { maxRows: 100_000, overflow: 'truncate' })
```

- The footer is not rejected for its total row count. `maxColumns` and the
  footer-size check still reject, and so does a file where one row's
  fixed-width columns alone exceed `maxDecodedBytes`.
- Row groups decode in 256-row batches. Loading stops at exactly `maxRows`,
  at the rows whose fixed-width values fit what is left of the budget, or
  before the first batch that would take retained memory past
  `maxDecodedBytes`. Once the budget is spent, later row groups are never
  read.
- A row group whose compressed column chunks exceed `maxDecodedBytes` fails
  before it is fetched, and gaps between chunks are fetched only while the
  request stays within that size. If the budget cannot hold even the first
  batch, the load fails: there is nothing to preview.
- String and binary view columns are copied out of the decoded pages, so
  retained memory is what the budget counts.
- The `streaming-complete` milestone carries `rowCount` (loaded rows),
  `totalRowCount` (footer rows), and `truncated`. When truncated, Sift's footer
  shows "Showing first N of M rows" and the status tooltip reads "Preview
  loaded". Sorting, filtering, and summaries cover only the loaded rows.

The default for `byte-source` and `loadTableFile`, `overflow: 'error'`, keeps
the behavior described above; a Parquet `url` source defaults to `'truncate'`
(see below). Only streaming Parquet honors `overflow`; in-memory buffers and
Arrow IPC still fail on overflow.

The budget is a loading guardrail, like the other limits, not isolation from
hostile files. Page decompression and one decoder batch allocate before a
batch is measured. Load untrusted files in a Worker you can terminate.

### Load more on demand

A truncating load can also stop early on purpose. `autoLoad` sets a soft budget
below `limits`: Sift loads row groups until the committed rows or decoded bytes
reach it, then pauses with the rows loaded so far and lets the user ask for
more.

```tsx
<SiftTable
  source={{
    kind: 'byte-source',
    source,
    limits: { maxRows: 5_000_000, maxDecodedBytes: 1024 * 1024 * 1024 },
    overflow: 'truncate',
    autoLoad: { rows: 100_000, decodedBytes: 64 * 1024 * 1024, trigger: 'scroll' },
  }}
/>
```

- `autoLoad` needs `overflow: 'truncate'`; with `'error'` the source is
  rejected before anything is read. It applies to `byte-source` and to Parquet
  behind a `url` source. `rows` and `decodedBytes` are each optional; the pause
  comes at whichever is reached first.
- At a pause the table is at rest: the status indicator settles, casts are
  allowed again, and the footer reads "Showing first N of M rows" with a
  `Load more` button (`.sift-load-more`). Each press extends the soft budget by
  the same `rows` and `decodedBytes` and loads until it is reached again, the
  hard budget is spent, or the file ends. While a resume is in flight the button
  reads "Loading…" and is disabled. With `trigger: 'scroll'`, scrolling within
  the overscan of the last loaded row also resumes; the button stays.
- Milestones: a pause emits `streaming-complete` with `truncated: true` and
  `resumable: true`, so hosts that clear their loading state on
  `streaming-complete` keep doing so. A resume emits `streaming-resumed` with
  `rowCount`, then the usual `chunk-appended` milestones, then
  `streaming-complete` again: `resumable: true` for another pause, or
  `resumable: false` once the file finished or the hard budget cut it, with
  `truncated` meaning what it means for any truncating load.
- `TableData.coverage` reports `truncated: true` and `resumable: true` while
  paused, and `resumable: false` once the load finished. Summaries, sort, and
  filters cover the loaded rows throughout.
- Unmounting or changing the source while paused closes the footer and aborts a
  resume in flight, as for any streaming load.

Only Parquet can be read this way. A `ByteSource` with `format: 'arrow-ipc'` is
read whole and goes through the bytes path with its `maxBytes` check.

`onLoadError` fires for `loader`, `url`, `byte-source`, and manifest sources
when a load fails, with the same `Error` Sift shows. For streaming Parquet it
may arrive after rows mounted; see above.

### What the numbers cover

A table loaded from a file carries three pieces of provenance:

- `TableData.coverage` says how much of the dataset is resident: `loadedRows`,
  `totalRows` (with its own scope, precision, and source), the file's
  `rowGroups`, and `truncated`. `loadTableFile` sets it on every path, so a
  caller of `loadTableFile(source, { overflow: 'truncate' })` reads
  `data.coverage.truncated` to learn the result was cut. Absent means every row
  is resident.
- `TableData.datasetStats` holds one `ColumnFileStats` per column, read from
  the Parquet footer at open and never changed: a whole-file null count when
  every row group recorded one, min/max when every row group had usable bounds,
  and flags for inexact (truncated string) bounds and infinite values. Columns
  without usable footer statistics are `null`.
- Each non-null `ColumnSummary` has `scope`, which labels every metric
  separately. `scope.distribution` covers the histogram bins, category bars,
  and true/false counts; it is always computed over loaded rows and says
  `dataset` only when every row is resident. `scope.range` and
  `scope.nullCount` come from footer metadata when the footer has them, and
  then describe the whole file; otherwise they describe loaded rows.
  `scope.distinctCount` is always over loaded rows. A cast column ignores its
  footer entry, since that entry describes the stored type.

The header renders these as text. The histogram and its brush domain stay over
loaded rows. When the file has more rows than are loaded, a numeric or timestamp
header adds a line with the whole-file bounds ("0 – 100 · whole file", with "≈"
when the bounds are inexact), the null percentage names its scope ("20% null ·
whole file" or "20% null · loaded rows"), the category popover keeps its "Search
N values…" and "All" controls and adds a note "Values from loaded rows · N of M"
that both controls reference through `aria-describedby`, and a boolean column keeps its loaded-rows bar
and shows whole-file nulls on a separate line. Captions carry `data-scope` and
`data-precision` attributes. `TableEngineState.loadedCount` reports resident
rows alongside `totalCount`, which keeps its current meaning.

## Query sessions

When the data lives behind a database, a scan service, or anything that can
answer a filter without shipping the whole table, the host implements
`TableQuerySession` and hands it to a `query-session` source. Sift sends a
`TableQuery` and receives one bounded Arrow IPC stream; it loads that stream
through the same resident path as a file and records that the rows already
satisfy the query. It does not filter them again, and the footer and pills
describe the committed query rather than a local one.

```tsx
import type { TableQuerySession } from '@nteract/sift'

const session: TableQuerySession = {
  capabilities: {
    filters: { price: ['between'], category: ['in', 'not_in', 'is_null'] },
    sort: [],
    casts: [],
    counts: ['exact'],
    compound: ['or'], // for Sift's category exclusion, or(is_null, not_in)
  },
  async query(q, ctx) {
    // Compile q.filters to your dialect with bound parameters, run it with
    // ctx.signal and ctx.budget, and return one uncompressed IPC stream.
    return { ipc, returnedRows, matchedCount: { kind: 'exact', value }, continuation: { kind: 'more' } }
  },
  async count(q, mode, ctx) { /* COUNT(*) or an estimate */ },
  async close() { /* release the connection */ },
}

<SiftTable source={{ kind: 'query-session', session, headRows: 10_000 }} />
```

The contract (`src/query.ts`):

- `TableQuery` is `casts`, `filters` (top-level AND of `FilterPredicate`), and
  `sort`. The vocabulary is the same name-addressed predicate tree that
  `engineStateToExplorerState` produces; SQL and pandas text are exports, not the
  wire format. The host owns the SQL dialect, the trusted base relation, the
  connection, credentials, and placement. Sift never receives SQL text.
- `capabilities` says what the provider can run: leaf ops per column, sortable
  columns, casts, which count kinds it offers, and which compound predicates it
  accepts. `supportsQuery(caps, q)` checks a query against it and returns the
  reason when something is missing. A provider still validates the whole query
  and refuses what it cannot run; it never narrows a result silently.
- `query` takes a `window` of `{ mode: 'head', limit }` and returns a
  `QueryPage`: the IPC stream (schema-only when empty), `returnedRows`,
  `matchedCount` (a `Count`: exact, estimate, lower bound, or unknown, always for
  the query, never the base relation), and a `continuation` that says whether
  more rows matched. `RequestContext` carries a `requestId`, an `AbortSignal`,
  and a byte budget. Sift aborts a request when a newer query supersedes it or
  the source unmounts; a late answer is dropped and its store freed.
- `count` is separate so first paint never waits on `COUNT(*)`. Sift asks for a
  `'cheap'` count when the page's `matchedCount` is `unknown` and the provider
  lists a count kind.

What the user sees:

- The footer's primary line is the whole-dataset count with the shown rows:
  "N whole-dataset matches · K rows shown", "≈N whole-dataset matches ·
  Estimated · K rows shown", "≥N …", or "Counting whole-dataset matches… · K
  rows shown" while the count is pending. A query with no filters says "rows in
  whole dataset" instead of "matches".
- Committed filters render as pills with `.sift-filter-pill--committed` and the
  title "Applied to the whole dataset". Clearing one does not touch the resident
  rows; it runs the reduced query against the source. Removing a filter must
  query the source, not the already-filtered result, or the rows it hid could
  never come back.
- Brushes and category clicks stay local, over the shown rows, exactly as for a
  truncated file: the footer adds "J of K shown rows · Filters use shown rows"
  and the summaries recompute over the resident rows. When local filters exist,
  the footer offers "Apply filters to whole dataset" (`.sift-apply-query`). It
  commits the committed filters plus the local ones as one `TableQuery` against
  the source and replaces the resident rows with the new head; it does not layer
  on the previous result or union rows. While the query runs the button reads
  "Querying…" and the old rows stay visible. If the merged query is outside
  `capabilities`, the button is disabled with the reason as its title.
- `onQueryStateChange` reports each generation (`pending`, `committedQuery`,
  `resultCount`); `onChange` keeps reporting the local state, and
  `TableEngineState` gains `committedQuery` and `resultCount`.
  `engineStateToExplorerState` carries them as `committedQuery` and `counts`;
  its existing fields keep meaning resident rows.

What stays local in this version: sort (the head is sorted in the browser, so
it orders the shown rows, not the whole result), casts (they apply to the
resident rows and are not part of `committedQuery`), and summaries (computed
over the shown rows; the interface has no summary request yet). `limits` bounds
decoded memory and columns per result; `headRows` is the row limit, 10,000 by
default. Only the head window exists: there is no paging or windowing past it.

For the imperative API the same ownership is available directly:
`engine.replaceData(data, { committedQuery })` swaps in rows that satisfy a
query without re-applying local filters or sort, `engine.setResultCount(count)`
sets the footer count, and `onCommittedQueryChange` in `createTable` options
receives the reduced query when a committed pill is cleared.

## Windowed data (experimental)

`createTable` also accepts a `WindowedTableData`: a source whose cells,
permutation, filtered summaries, and image bytes arrive asynchronously. The
data side owns the filter-and-sort permutation and answers `setQuery` with the
filtered count and summaries, `requestWindow(viewStart, viewEnd, generation)`
with the data rows and cells for a span of view positions, and `requestImage`
with one cell's bytes; it pushes `rows-appended` and `streaming-done` through
`subscribe`. The engine shows skeleton placeholders (`.sift-cell-skeleton`,
rows carry `.sift-row-placeholder`, the grid `aria-busy="true"`) for view rows
whose cells have not landed, drops any answer tagged with a stale generation,
and reports `pending: true` in `TableEngineState` while a query is in flight.
Geometry stays dense: `rowCount` is a resident row count. `head` holds cells
for data rows `[0, headRows)` in identity order, whatever the current query; the
engine paints from it only when no sort or filter is active, and ignores a head
whose `dataRows` are not `0, 1, 2, …`. A data side that rewrites cell strings
(cast, undo) refreshes `head` the same way.

What is painted stays painted. A `rows-appended` push under the identity
permutation extends the map in place and calls `onChange` with the new
`totalCount` and `filteredCount`; under a sort or filter it re-queries, and
the answer is held until the window covering the visible span arrives, then
both commit in one frame under the scroll anchor (`onChange` fires when the
answer arrives). The scroll anchor is the row under the header's bottom edge:
landing windows, appends, and commits keep that row at the same screen
position; `scrollTop` changes only by row height measured above it. A user's
own sort or filter shows placeholders at once (the viewport returns to the
top), and a refused query puts the delivered cells back. A
`{ type: "error", fatal: true }` event
sets `TableEngineState.dataFailed`: the rows on screen stay, and sort, filter,
and cast controls are disabled with the title "Data source stopped; table tools
are unavailable".

`createResidentWindowedData(tableData)` adapts a loaded `TableData` to this
shape on the main thread. It exists to exercise the mode and is the contract a
worker-backed data side will implement over a `MessagePort`; it is not faster
than resident mode. `byte-source` and Parquet `url` sources take
`windowed: true` to mount through it, with the same milestones as today. Off
by default. Lists render as text in this mode, and casts and summaries go
through the data side.

## Running the data side in a worker (experimental)

`worker: true` on a `byte-source` moves decoding and the table store into a
dedicated worker. The worker is the resident windowed adapter behind a
`MessagePort`: it owns the WASM module, the Parquet file, the permutation, and
the summaries, and answers the engine's windows over messages. The main thread
keeps the engine, the host's `ByteSource`, and the rows it has already been
shown.

The library ships the worker bundle as `@nteract/sift/worker` but not the
spawn. Register one before mounting:

```ts
import { setWorkerFactory } from '@nteract/sift'

// Same-origin module worker (Desktop, a browser page you control).
setWorkerFactory(
  () => new Worker(new URL('@nteract/sift/worker', import.meta.url), { type: 'module' }),
)

<SiftTable source={{ kind: 'byte-source', source, overflow: 'truncate', worker: true }} />
```

With no factory the source fails at validation with a visible error. Sift does
not fall back to the main thread: a file that needs the worker's containment
must not run without it. A factory that throws (a CSP or sandbox
`SecurityError`, for example) takes the same path as any other load error:
Sift's error state shows "Worker factory threw: …" and `onLoadError` fires; it
does not reach your error boundary. The notebook output frame has an opaque origin and
cannot load a same-origin module worker; a blob-URL worker build for it is a
follow-up and that host is not covered yet.

Reads are relayed: the worker asks for a byte range, the main thread calls
`source.read` and transfers the copy. `setWasmUrl` state is forwarded in the
`open` message, so configure it before mounting as today.

What the worker contains: WASM traps, decoder hangs, and retained memory. A trap
(including the allocation cap below) ends that worker: Sift terminates it,
keeps the rows already loaded, shows "Stopped loading: row group N exceeded the
worker memory limit … · Showing loaded rows" in the footer, and fires
`onLoadError`. Rows not yet shown stay as placeholders; a respawn with
row-group quarantine is a follow-up. What it does not contain: the renderer
process's memory (a dedicated worker lives in it) and the host's own I/O. The
allocation cap is what bounds memory: the worker calls `set_allocation_cap`
with `allocationCap` (default `2 × maxDecodedBytes`) before loading, so a
decompression bomb traps in Rust before the process pays for it. Between row
groups the host also compares live heap bytes against the cap and stops a load
that has already exceeded it.

After a trap the table keeps its rows, but sort, filter, and cast are disabled
(`getState().dataFailed` is `true`). A host calling `createWorkerWindowedData`
directly gets a `WorkerDataError` with `code: "terminated"` from every pending
and later request; other codes are `factory`, `open`, `aborted`, and `closed`
(after `dispose()`). A failed or aborted open terminates its worker.

A failure that is not a trap, such as a `source.read` rejection for a later row
group, stops loading without ending the worker. The footer shows "Stopped
loading: <message> · Showing loaded rows", `onLoadError` fires, and the rows
already loaded keep their sort, filter, and cast tools.

With `overflow: 'truncate'`, a load the budget stops early shows the same
"Showing first N of M rows · Table tools use shown rows" notice as the
main-thread loader, and the `streaming-complete` milestone carries `rowCount`,
`totalRowCount`, and `truncated`.

Not in this version: `autoLoad` pause/resume in the worker (it loads to the
hard budget), `url` and manifest sources, a request-latency watchdog, and
respawn.

## Lifecycle and host controls

A `TableData` instance returned by `loadTableFile` owns one WASM store. The React
loader source creates a fresh store for each setup and discards stale completions;
the mounted engine disposes the store on teardown. Avoid passing preloaded binary
data directly to the React `data` prop, because effect replay would reuse a freed
store. For the imperative API, pass each result to one `createTable` instance. If
an imperative load is stale or never mounted, call `data.dispose?.()`, using an
activation token to recognize results completed after switching or closing files.
Reopen/reload creates fresh data. Do not share disposable data between tables.

Sift is a read-only exploration surface. Sorting, filtering, and type casts do
not rewrite the file. Keep editor text and dirty state in the host; a viewer/editor
toggle should derive its preview from the current text buffer and preserve edits
on parse errors or mode changes. Save, Save As/export, reveal-in-folder, file
watching, dirty-file conflict handling, and loading/error messages remain host
responsibilities. Parquet can use a view-only mode.

For already hosted data, `<SiftTable url="/data.arrow" />` and
`<SiftTable url="/data.parquet" />` remain available. The URL/manifest paths have
their own loading behavior. A Parquet URL is downloaded whole, then streams row
groups through the same loader as `byte-source`, with the same budget and
preview footer. Its defaults are `URL_PARQUET_LIMITS` (1,000,000 rows, 512 MiB
of decoded memory, 256 columns) and `overflow: 'truncate'`, so a file past the
budget shows its leading rows and the footer reads "Showing first N of M rows".
The `streaming-complete` milestone carries `rowCount`, `totalRowCount`, and
`truncated`, and the mounted data carries `coverage`, as for `byte-source`.
Override either on the source:

```tsx
<SiftTable
  source={{
    kind: 'url',
    url: '/data.parquet',
    limits: { maxRows: 5_000_000, maxDecodedBytes: 2 * 1024 * 1024 * 1024 },
    overflow: 'error', // fail instead of truncating
  }}
/>
```

The download itself is not bounded; the budget bounds decoded memory. Arrow IPC
over a URL is read whole and ignores `limits` and `overflow`. A schema-only
Parquet URL mounts an empty table. A sampled Arrow manifest must include its
`summary.sampled` and included/total row metadata; its sorting, filtering, and
summaries cover only the supplied rows.

## Interaction and appearance

```ts
engine.setSort('age', 'desc')
engine.setFilter(0, { kind: 'range', min: 18, max: 65 })
engine.clearAllFilters()
const state = engine.getState()
```

The container needs a defined height. The table supplies keyboard navigation and
ARIA grid semantics.

## Styling

`style.css` is compiled and self-contained. It writes nothing to `:root`,
`html`, or `body` and ships no document-wide CSS reset, so it can load into a host document
next to the host's own stylesheet. Every rule is keyed on `.sift-root`, which
Sift puts on the table container and on each element it appends to `<body>`
(popovers, the column menu, the row detail sheet, the image viewer).

Dark mode follows the host: put `.dark` or `data-theme="dark"` on `<html>` or
`<body>`, so body-mounted overlays receive the same theme.

Sift reads eight colors, a font, and a radius. Set them on `<html>` or `<body>`. A table-local wrapper does not theme overlays
that are portaled to `<body>`:

```css
:root {
  --sift-color-bg: #fff;        /* table background */
  --sift-color-panel: #fff;     /* header, popovers, menus, sheets */
  --sift-color-ink: #111;       /* text */
  --sift-color-muted: #666;     /* secondary text, null markers */
  --sift-color-rule: #e5e5e5;   /* borders and grid lines */
  --sift-color-accent: #2563eb; /* histogram bars, selection, focus ring */
  --sift-color-true: #22c55e;   /* boolean true */
  --sift-color-false: #ef4444;  /* boolean false */
  --sift-font-family: Inter, "Helvetica Neue", "Segoe UI", Arial, sans-serif;
  --sift-radius-base: 0.5rem;
}
```

Row heights are computed from text measured in the cell's font, read from the
DOM when the table mounts. Set `--sift-font-family` before creating the table.
Lead with a named family such as `Inter` or `"Helvetica Neue"`: on macOS,
`system-ui` measures a little differently in canvas than it paints, so an
occasional row can come out a line short or tall.

Every other color (row stripes, scrollbars, badges, skeletons) is derived from
these with `color-mix()`, so they follow light and dark automatically.

The neutrals fall back to the shadcn token names when the host defines them:
`--background`, `--card`, `--foreground`, `--muted-foreground`, `--border`, and
`--radius`. A shadcn app gets Sift in its own palette without setting anything.
Accent and boolean colors keep Sift's defaults unless set, since a shadcn
`--primary` is a button color and often near-black.

## Notices

`lib/THIRD_PARTY_NOTICES.md` lists the Rust crates compiled into the WASM with
their license texts and NOTICE files. Ship it with any app that redistributes
Sift. The JavaScript in `lib/` is first-party; every npm dependency is
installed by the host under its own license. Building and
verifying the package from source is covered in `packages/sift/AGENTS.md` in
the nteract repository.
