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
paging or sampled preview.

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
limit), the rows already loaded stay on screen, the streaming indicator
settles, Sift shows the error, and `onLoadError` fires.

Only Parquet can be read this way. A `ByteSource` with `format: 'arrow-ipc'` is
read whole and goes through the bytes path with its `maxBytes` check.

`onLoadError` fires for `loader`, `url`, `byte-source`, and manifest sources
when a load fails, with the same `Error` Sift renders in its error state.

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
different loading behavior and do not inherit `loadTableFile` admission limits:
a Parquet URL streams row groups through the same loader as `byte-source`, with
the limits set to their maxima. A schema-only Parquet URL mounts an empty table.
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
  --sift-font-family: Inter, system-ui, sans-serif;
  --sift-radius-base: 0.5rem;
}
```

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
