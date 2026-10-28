# Sift Electron harness

A dev-only Electron app that runs `@nteract/sift` the way Kilo Desktop (KD)
does, so Sift's data worker can be checked under KD's real renderer policy.
It is never packaged or published.

It reproduces the parts of KD that decide whether Sift works:

- **A custom standard scheme.** `harness://app` and `harness://embedded`, both
  registered privileged (`standard`, `secure`, `supportFetchAPI`,
  `corsEnabled`, `stream`) before `app.whenReady()`, both serving
  `dist/renderer` with KD's MIME table and path check.
- **KD's two CSP strings, verbatim** (`src/main/csp.ts`), copied from
  `apps/desktop/src/main/platform/ElectronProtocol.ts` on agentic-desktop
  `origin/main`:
  - app origin (`createContentSecurityPolicy`): `script-src 'self'
    'wasm-unsafe-eval'` and **no `worker-src`**, so workers fall back to
    `script-src`. Same-origin module workers load; `blob:` workers do not.
  - embedded origin (`createEmbeddedContentSecurityPolicy`): adds
    `worker-src 'self' blob:`.
- **Ranged reads over IPC.** `readRange({ path, offset, length,
  expectedRevision })` in the main process (≤ 16 MiB, stat revision checked
  before and after each read) and a renderer `ByteSource` with the same shape
  as KD's `createRangeByteSource` (agentic-desktop
  `origin/feat/files-parquet-preview`, `plugins/files/src/web/files/table-viewer/`).
  The window is sandboxed and context-isolated; the preload exposes
  `openFile`, `stat`, and `readRange` and nothing else.
- **The built library.** `@nteract/sift` resolves to `packages/sift/lib`
  through its `publishConfig.exports`, the artifact KD installs from npm, and
  the WASM URL comes from `@nteract/sift/sift.wasm?url` as in KD.

What it is not: KD's dev-server proxy, plugin schemes, embedded-host routes,
iframe embedding, or the Files UI. The embedded origin is loaded as a
top-level window, not inside a frame.

## Running

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/sift build:lib          # lib/ the harness consumes
pnpm --dir apps/sift-electron-harness dev -- /path/to/file.parquet
pnpm --dir apps/sift-electron-harness dev -- /path/to/file.parquet --worker=0 --autoLoad=manual
pnpm --dir apps/sift-electron-harness test:e2e
```

Flags (`src/main/main.ts`): `--worker=0|1`, `--autoLoad=scroll|manual|off`,
`--cap=<bytes>`, `--maxDecoded=<bytes>`, `--origin=app|embedded`,
`--spawn=module|blob`, `--readDelayMs=<ms>`. Without a file the window shows
an open button.

**The Electron binary is installed explicitly.** `pnpm-workspace.yaml` keeps
electron off `allowBuilds`, so `pnpm install` never runs its postinstall or
downloads anything. `predev` and `pretest:e2e` run
`scripts/install-electron.mjs`, which runs `electron/install.js` only when
`node_modules/electron/path.txt` is missing, then build the app.

**Fixtures are generated, not committed.** The e2e runs
`uv run --no-project --with pyarrow python e2e/fixtures/make-parquet.py .cache`
once: a 4-row file and a 78 MB file of 96 row groups × 1,024 rows (id,
boolean, float, UTC timestamp, wrapped random base64 text). Without `uv` the
suite skips. `HARNESS_MEASURE=1` adds the `allocationCap` sweep below.

## e2e

| # | Check | Asserts |
|---|---|---|
| 1 | Module worker, app origin | table mounts, rows paint, worker `spawned`, `.wasm` served as `application/wasm`, no CSP console errors, `securitypolicyviolation` events, or page errors |
| 2 | `blob:` worker, app origin | refused with a `worker-src blob` violation; Sift through a blob shim shows "Sift worker failed to start; the host's Content-Security-Policy may block this worker URL (…)" |
| 3 | Embedded origin | as 1; a raw `blob:` worker runs; Sift through a blob shim mounts |
| 4 | `autoLoad` scroll, worker | the worker pauses at 64 MiB with "Showing first N of 98,304 rows" and `Load more`; scrolling near the end emits `streaming-resumed` and loads the rest; the row under the header holds (±1) during the resumed appends |
| 4b | `autoLoad` scroll, main thread | the same on the main-thread loader; the anchor row holds (±1), `scrollTop` may move to hold it |
| 5 | `allocationCap` trap | `cap=8000000`: "Stopped loading: row group N exceeded the worker memory limit …", worker `terminated`, `dataFailed`, rows stay, no page error |
| 6 | Revision conflict | file touched mid-load: "The file changed on disk while the table was loading.", worker stays up, `dataFailed` false, rows stay |

## Findings

Electron 45.0.0 (Chromium 156), Sift 0.6.0 `lib/`.

- **The documented spawn resolves.** `new Worker(new URL("@nteract/sift/worker",
  import.meta.url), { type: "module" })` builds and runs. Vite emits
  `assets/worker-<hash>.js` and rewrites the URL relative to the bundle. It
  needs `worker.format: "es"`: the worker bundle code-splits the WASM glue.
  `@nteract/sift/worker?worker&url` resolves to the same asset.
- **No `worker-src` is needed for the module worker.** The app policy
  (`script-src 'self' 'wasm-unsafe-eval'`, no `worker-src`) runs it with no
  violations and no console warnings.
- **`'wasm-unsafe-eval'` is required in the worker.** The worker script's own
  response carries the app CSP, and the worker instantiates the WASM. With it
  removed, the load fails: "WebAssembly.instantiateStreaming(): Compiling or
  instantiating WebAssembly module violates the following Content Security
  policy directive …".
- **Scheme needs.** `.wasm` must be served as `application/wasm` (streaming
  compilation) and `.js` as `text/javascript`; KD's MIME table already does
  both. The Vite bundle emits `crossorigin` script tags, which KD's
  `corsEnabled` privilege covers. Node's `URL` reports `origin: "null"` for
  custom schemes, so an IPC sender check must compare
  `protocol + "//" + host`.
- **A blocked `blob:` worker does not throw.** Chromium returns from
  `new Worker(blob:…)`, logs "Creating a worker from 'blob:…' violates …
  Note that 'worker-src' was not explicitly set, so 'script-src' is used as a
  fallback", and fires `error`. Sift's factory therefore never sees a
  `SecurityError`. Sift treats an `error` before the worker's first reply as a
  failed start: "Sift worker failed to start; the host's
  Content-Security-Policy may block this worker URL (…)". A worker that dies
  after answering still reports "Sift worker terminated: …". Under the
  embedded policy a one-line module shim (`import "<worker asset URL>"` at a
  `blob:` URL) runs Sift fine.
- **`autoLoad` pauses the worker.** The worker stops at the soft budget, waits
  for `resume`, and the footer `Load more` and the scroll trigger work as on
  the main thread. Both loaders hold the row under the header during resumed
  appends. On the main-thread loader each append's render measures overscan
  rows above the viewport for the first time; the engine re-applies the scroll
  anchor after that relayout. Without it, `scrollTop` stays fixed and the row
  under the header drifts (23 rows on this fixture; test 4b).
- **A 2 × `maxDecodedBytes` `allocationCap` traps falsely at the budget
  edge.** At a 64 MiB decoded budget on the 78 MB fixture (worker,
  `overflow: "truncate"`):

  | cap | result |
  |---|---|
  | 1.0× – 1.5× | trap at row group 40 – 60 |
  | 2.0× | trap at row group 80; 81,920 rows; worker dead, tools disabled |
  | 2.25×, 2.5× (default), 3×, 4× | clean truncated preview, 83,456 rows |

  Post-group live heap peaks at 1.01× the budget; each trap fires when live
  heap is about half the cap, so decoding a row group transiently needs about
  2× the retained heap. Sift's default is 2.5 × `maxDecodedBytes`, so the
  budget, not the cap, ends a large preview. The harness renderer leaves that
  default in force unless `?cap=` overrides it, so the shipped default is what
  the e2e runs exercise (512 MiB default budget, so no trap on the fixture).
- **No console warnings** from the renderer page in any passing run.
