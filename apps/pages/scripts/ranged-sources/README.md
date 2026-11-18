# Local module views with ranged Page sources

Run from `apps/pages` after the Pages setup and build. Start the catalog, then
the Page server in another terminal. Each worktree has its own celld storage.

```sh
PAGES_CATALOG_PORT=9447 node scripts/widget-catalog/serve.mjs
PAGES_E2E_ONLY=true PAGES_PORT=9917 PAGES_OUTPUT_FRAME_URL=http://127.0.0.1:9447/frame/v2/ npm run dev
```

Generate the synthetic fixture and exercise the view in Chromium.

```sh
uv run scripts/ranged-sources/fixture.py /tmp/pages-ranged-activity.parquet
node scripts/ranged-sources/demo.mjs /tmp/pages-ranged-activity.parquet
```

The demo declares a pinned module entry and one file in `spec.files`. The
[entry](activity.mjs) imports `data/activity` and gives its Sift-compatible
ByteSource to the Parquet reader. Sift reads the footer and the first row
group for a bounded preview. The chart reports transferred Parquet bytes,
excluding code and WASM. The demo checks that count against 206 responses.

The parent opens the immutable Page asset with HEAD. A separate message port
per binding serves `read(offset, length, signal)`. Each HTTP request goes
through the existing Page access check and asks storage for one range. Entry
code sees the size and the requested bytes. Replacing the view closes its
ports and aborts pending reads. The existing Page upload limit is 5 MiB.
