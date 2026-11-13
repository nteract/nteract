import { celldCborPlugin } from "./celld-cbor.mjs";
import { AUTH_D1, USAGE_D1 } from "./deployment/profiles.mjs";
import { workerShape } from "./worker-shape.mjs";
import { mermaidSource } from "./browser-mermaid.mjs";
import { siftWasmPath } from "./browser-sift.mjs";
import { formatsByType } from "../model/document-types.mjs";
import { sourceFingerprint, writeBuildReceipt } from "./source-fingerprint.mjs";
import { releaseFilesOf } from "./stage-artifacts.mjs";
import {
  VIEWER_ASSETS,
  VIEWER_CSP,
  chartWorkerChunk,
  hashedAssetPath,
  headersFile,
  publicUrl,
  chartChunk,
  shellAssetDefine,
  stylesCovered,
  viewerAsset,
  viewerBuildOptions,
  viewerSplit,
  withHashedAssets,
  withInlineFavicon,
  withModulePreloads,
  withProductName,
} from "./viewer-chunks.mjs";
import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const dist = path.join(app, "dist");
const expectedFingerprint = sourceFingerprint(app).sha256;
// The Worker and viewer embed the same build id; shared/build-identity.mjs
// reads it. Keep the length aligned with writeBuildReceipt's build_id.
const buildDefine = { __PAGES_BUILD__: JSON.stringify(expectedFingerprint.slice(0, 12)) };
// A failed in-place build must not leave an older receipt beside mixed outputs.
await rm(path.join(dist, "build-receipt.json"), { force: true });
await mkdir(path.join(dist, "public"), { recursive: true });
// Hashed names change with their contents; drop the previous build's files.
// public/ then serves only this build's shell, never a file under its source
// name.
await rm(path.join(dist, "public/chunks"), { recursive: true, force: true });
for (const name of await readdir(path.join(dist, "public")))
  if (viewerAsset(`public/${name}`) || VIEWER_ASSETS.includes(name))
    await rm(path.join(dist, "public", name));

// Source name → hashed dist path for each shell asset (VIEWER_ASSETS).
const assets = {};
async function writeAsset(name, bytes) {
  assets[name] = hashedAssetPath(name, bytes);
  await writeFile(path.join(dist, assets[name]), bytes);
}
const firstOutput = ({ outputFiles }) => outputFiles[0].contents;

await writeAsset(
  "theme.js",
  firstOutput(
    await build({
      entryPoints: [path.join(app, "viewer/theme-bootstrap.mjs")],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
      outfile: path.join(dist, "public/theme.js"),
      write: false,
    }),
  ),
);
await writeAsset(
  "mermaid.js",
  firstOutput(
    await build({
      entryPoints: [mermaidSource(app)],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      tsconfig: path.join(app, "tsconfig.json"),
      outfile: path.join(dist, "public/mermaid.js"),
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
    }),
  ),
);
await writeAsset(
  "automerge.wasm",
  await readFile(require.resolve("@automerge/automerge/automerge.wasm")),
);
// Sift's WASM loads only when a Page shows a Parquet dataframe (viewer/sift-table.jsx).
await writeAsset("sift.wasm", await readFile(siftWasmPath(app)));

// The chart Worker runs Vega off the page's thread (viewer/vega-chart.mjs). A
// classic script with nothing shared, so it loads in every engine under
// `script-src 'self'`; written as one more hashed chunk.
const chartWorkerBytes = firstOutput(
  await build({
    entryPoints: [path.join(app, "viewer/chart-worker.mjs")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    tsconfig: path.join(app, "tsconfig.json"),
    outfile: path.join(dist, "public/chunks/chart-worker.js"),
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
  }),
);
const chartWorker = chartWorkerChunk(chartWorkerBytes);
await mkdir(path.join(dist, "public/chunks"), { recursive: true });
await writeFile(path.join(dist, chartWorker), chartWorkerBytes);

const viewer = await build(
  viewerBuildOptions(
    app,
    dist,
    { ...buildDefine, __PAGES_CHART_WORKER_URL__: JSON.stringify(publicUrl(chartWorker)) },
    Object.fromEntries(
      ["mermaid.js", "automerge.wasm", "sift.wasm"].map((name) => [name, publicUrl(assets[name])]),
    ),
  ),
);
const split = viewerSplit(viewer.metafile);
const viewerChunks = [...split.chunks, chartWorker].sort();
const { preloads, styles } = split;
// A view's chart code loads only when a chart nears the viewport, and Vega
// itself only in the Worker.
const chart = chartChunk(viewer.metafile);
const kib = (file) => `${(viewer.metafile.outputs[file].bytes / 1024).toFixed(1)} KiB`;
console.log(
  `Viewer: app.js ${kib("public/app.js")}, editor ${kib(chart.editor)}, chart ${chart.chunk} ${kib(chart.chunk)}, ` +
    `chart Worker ${chartWorker} ${(chartWorkerBytes.byteLength / 1024).toFixed(1)} KiB`,
);
// esbuild also writes CSS for the lazily loaded chunk. app.css already holds
// those rules, in the order the shell imports them, so nothing loads it.
const appStyles = await readFile(path.join(dist, "public/app.css"), "utf8");
for (const file of styles) {
  if (!stylesCovered(await readFile(path.join(dist, file), "utf8"), appStyles))
    throw new Error(`app.css is missing rules from ${file}; import that CSS from main.jsx`);
  await rm(path.join(dist, file));
}
// No chunk imports app.js or app.css; only index.html and the Worker's own
// pages name them. They take their hashed names once the viewer is built.
for (const name of ["app.js", "app.css"]) {
  const file = path.join(dist, "public", name);
  await writeAsset(name, await readFile(file));
  await rm(file);
}

await build({
  entryPoints: [path.join(app, "worker/index.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd"],
  tsconfig: path.join(app, "tsconfig.json"),
  external: ["node:*"],
  outfile: path.join(dist, "index.js"),
  // The Worker's own pages (/connect, OAuth) load the hashed theme and styles.
  define: { ...buildDefine, ...shellAssetDefine(Object.values(assets)) },
  plugins: [
    celldCborPlugin(),
    {
      name: "compiled-wasm",
      setup(b) {
        b.onResolve({ filter: /\.wasm$/ }, async (args) => {
          await copyFile(
            path.resolve(args.resolveDir, args.path),
            path.join(dist, "automerge.wasm"),
          );
          return { path: "./automerge.wasm", external: true };
        });
      },
    },
  ],
});
await copyFile(path.join(app, "viewer/connect-agent.js"), path.join(dist, "public/connect.js"));
await writeFile(
  path.join(dist, "public/index.html"),
  withProductName(
    withInlineFavicon(
      withHashedAssets(
        withModulePreloads(await readFile(path.join(app, "viewer/index.html"), "utf8"), preloads),
        assets,
      ),
    ),
  ),
);
await writeFile(
  path.join(dist, "public/_headers"),
  headersFile(
    [
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: same-origin",
      `Content-Security-Policy: ${VIEWER_CSP}`,
    ],
    [...viewerChunks, ...Object.values(assets)],
  ),
);
// The installer hashes this file's bytes and restarts celld when they change
// (scripts/deployment/activation.mjs), so the key order is part of the output.
const { triggers, vars, ...shape } = workerShape();
await writeFile(
  path.join(dist, "wrangler.json"),
  JSON.stringify(
    {
      name: "nteract-pages-next",
      main: "index.js",
      ...shape,
      d1_databases: [
        {
          binding: AUTH_D1.binding,
          database_name: AUTH_D1.database_name,
          database_id: AUTH_D1.database_id,
        },
        USAGE_D1,
      ],
      triggers,
      // celld scopes this bucket beneath the deployment's fleet prefix.
      r2_buckets: [{ binding: "PAGES_ASSETS", bucket_name: "pages-images" }],
      vars,
    },
    null,
    2,
  ),
);
writeBuildReceipt(app, {
  expectedFingerprint,
  viewerChunks,
  viewerAssets: Object.values(assets),
  releaseFiles: releaseFilesOf(viewerChunks, Object.values(assets)),
  documentFormats: formatsByType(),
});
console.log("Built native Pages Worker, WASM and viewer into dist.");
