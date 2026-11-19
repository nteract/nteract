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

The demo declares a pinned module entry and one file alias in `data`. The
[entry](activity.mjs) reads `model.get("activity")`, an Arrow table the Page
decodes from the Parquet file with Sift, and charts the first project's latest
28 days. The line under the chart reports the archive's row count, which the
demo checks.

The parent fetches the immutable Page asset once, decodes it, and transfers a
copy of the Arrow stream into the frame. The view can still
`import activity from "data/activity"` for the file itself: the parent opens
the asset with HEAD, and a separate message port per binding serves
`read(offset, length, signal)`. Each HTTP request goes through the existing
Page access check and asks storage for one range. Replacing the view closes
its ports and aborts pending reads. The existing Page upload limit is 5 MiB.

### Page12 on lab2

The editor at `page12.runtimed.run` uses the Page12 celld profile, Anaconda sign-in
and its own storage prefix. Its frame at `page12-output.runtimed.run` runs a
separate loopback-only Node service, `page12-output.service`, with a dynamic
user and no Pages credentials. The same dedicated tunnel routes both names.

Build the output service from `apps/pages` after the Pages build:

```sh
node scripts/widget-catalog/serve.mjs --build-only
node_modules/.bin/esbuild scripts/widget-catalog/hosted.mjs --platform=node --target=node20 --format=esm --bundle --outfile=.output-dist/hosted.mjs
```

Copy `.output-dist/hosted.mjs` and the printed revision's directory under
`.output-dist/catalog` to the same layout in `/opt/nteract-page12-output` on
lab2. Retain earlier catalog revisions for Pages that pin them. Run the bundled
entry with `/usr/bin/node` and the arguments
`/opt/nteract-page12-output/catalog REVISION https://page12-output.runtimed.run 9485`.
The editor installer checks the frame and its exact catalog pin before installing.
Use the standard `prepare`, `upload`, `install`, `provision`, `publish` sequence
in the Pages deployment guide with `--target page12`.
