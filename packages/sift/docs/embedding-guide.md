# Embedding Sift

`@nteract/sift` is a browser table viewer with compiled JavaScript, CSS, TypeScript
interfaces, and a matching WebAssembly decoder. It does not require a notebook,
kernel, daemon, Tauri, Electron, or an nteract runtime connection. React and React
DOM are required even for the imperative API because column controls use React.

## Install and assets

```sh
npm install @nteract/sift react react-dom
```

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

```tsx
import { parseCsv, SiftTable } from '@nteract/sift'

const data = parseCsv(csvText)
// For TSV: parseCsv(tsvText, { delimiter: '\t' })

<SiftTable data={data} style={{ height: 600 }} />
```

Parse once when the file snapshot changes, not on every React render. The host
owns text decoding: for UTF-8 files, use `new TextDecoder('utf-8', { fatal: true })`
so invalid byte sequences become an actionable error. A leading BOM is accepted.
There is no encoding or delimiter guessing. Delimiters are comma (default), tab,
semicolon, and pipe.

The first record supplies column names; blank and duplicate names are made
unique. Quoted delimiters, escaped quotes, and multiline fields are supported.
Malformed quoting and inconsistent record widths throw an error. Empty unquoted
fields become null; quoted empty fields stay empty strings. Literal `NA`, `null`,
and similar strings are preserved. Nulls are excluded from categorical counts
and never match the empty-string category. Selecting that category matches only
quoted empty strings; excluding it retains null rows. Category percentages use
all rows in the current selection as their denominator, including null rows.

A final line ending terminates the preceding record. Additional blank records
are preserved: in a one-column file each is a null row; in a wider file each
fails the record-width check. Automatically skipping blank records is an open
format-policy decision because it could silently remove valid null rows.

Default inference examines every loaded value in a column. Conservative numbers
and lowercase `true`/`false` become numeric/boolean columns; dates, leading-zero
identifiers, and unsafe integers stay text. Original spellings remain available
for display, but numeric comparisons use JavaScript numbers and can approximate
exact decimals. Use `{ typing: 'text' }` to keep every non-null field as text.

The default limits are 16 MiB of UTF-8 text, 100,000 data rows, 256 columns, and
1,000,000 cells. Override `maxBytes`, `maxRows`, `maxColumns`, and `maxCells`
explicitly when the host can support larger files. Over-limit input fails; it is
never silently truncated. Reject oversized files before reading them as well.

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
`format` is `'parquet'` or `'arrow-ipc'`. CSV/TSV should use `parseCsv`. Arrow file
containers and compressed IPC streams are not supported by this path.

Binary input defaults to 16 MiB, 100,000 rows, 256 columns, and a 128 MiB decoded
memory guardrail (`maxBytes`, `maxRows`, `maxColumns`, `maxDecodedBytes`). Parquet
checks footer metadata before decoding using an estimate of twice the
uncompressed page bytes plus 16 bytes per leaf value, summed across all row
groups. That conservative estimate can reject compact, wide tables whose actual
Arrow allocation would be smaller: 100,000 rows across 84 boolean columns already
exceed the default guard from the per-value allowance alone. The row, column,
input-byte, and decoded-byte limits are independent ceilings, not a promise that
every file below the first three will load. Retained Arrow allocations are also
checked after each decoded batch. These are admission limits, not a process
memory sandbox: dictionaries, decoder batches, summaries, copies, and temporary
allocations add memory. Raising `maxDecodedBytes` relaxes both the Parquet estimate
and retained-allocation checks; hosts should do so only with an appropriate
memory budget.

This API materializes a complete file. Virtual scrolling bounds rendered DOM,
not the loaded dataset. Sorting, filtering, and summaries cover all accepted
rows. There is no disk paging or sampled preview. Larger files need a separate
bounded-preview or query architecture with explicit operation scope.

After filtering, binary numeric ratio bars retain the unfiltered file's two-value
baseline; nearby counts and null statistics describe the filtered rows.

Arrow/Parquet schemas and nulls are retained in WASM. Lists, structs, and map-like
values may display as text; known image structures have dedicated rendering.
Nested values do not become editable sub-tables, and a formatted nested column's
ordering/filtering is not a nested query language. Do not assume all nested types
have numeric or categorical semantics identical to primitive columns.

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
different loading behavior and do not inherit `loadTableFile` admission limits.
A sampled Arrow manifest must include its `summary.sampled` and included/total
row metadata; its sorting, filtering, and summaries cover only the supplied rows.

## Interaction and appearance

```ts
engine.setSort('age', 'desc')
engine.setFilter(0, { kind: 'range', min: 18, max: 65 })
engine.clearAllFilters()
const state = engine.getState()
```

The container needs a defined height. The table supplies keyboard navigation and
ARIA grid semantics; give the surrounding file view an accessible title, expose
loading/errors to assistive technology, and keep keyboard focus predictable when
switching modes. Test the host's narrow view and keyboard paths.

`style.css` is compiled: consumers do not need Tailwind or nteract source files.
It includes shared base styles and design-token defaults, so load it before host
theme overrides or use an existing isolated document boundary. Set
`data-theme="dark"`/`"light"` explicitly on the root; OS theme preference is not
a separate automatic mode. `data-color-theme="cream"` selects the optional cream
palette. Override `--sift-bg`, `--sift-panel`, `--sift-ink`, `--sift-muted`,
`--sift-rule`, and `--sift-accent` to match the host. Popovers render in portals;
theme tokens should be available at their document root too.

## Build and verify a local package

From the nteract repository root:

```sh
pnpm install --frozen-lockfile
cargo xtask wasm sift --skip-renderer-plugins
pnpm --dir packages/sift test:package
# Optional: production consumer smoke (install with pnpm exec playwright install chromium).
pnpm --dir packages/sift exec node scripts/test-package.mjs --browser
pnpm --dir packages/sift pack --pack-destination /tmp/sift-package
```

`test:package` builds the library, packs it, extracts it outside the workspace,
checks its public declarations and dependency boundary, and tests the shipped
WASM glue/binary against synthetic Arrow data. With `--browser`, it builds and
previews a production consumer in Chromium, testing both explicit and default
WASM asset URLs. It reuses installed public
dependencies without registry requests. `prepack` rejects missing built assets,
checks every current runtime method against the actual WASM and JavaScript
exports, and instantiates the pair to reject incompatible glue/binary imports.
The resulting tarball can be installed via its local path; nothing is published.

`build:lib` also writes `lib/THIRD_PARTY_NOTICES.md`. It lists the Rust crates
and C sources that `cargo tree` reports for the WASM build and the npm packages
the bundle inlines, with their license texts and NOTICE files. Ship it with any
host app that redistributes Sift. A dependency under a license the generator
doesn't recognize, without its license text, or with unreviewed native sources
fails the build until the generator learns it.
