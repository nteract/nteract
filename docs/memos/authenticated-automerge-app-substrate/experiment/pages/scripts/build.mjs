import { celldCborPlugin } from "./celld-cbor.mjs";
import { AUTH_D1 } from "./deployment/profiles.mjs";
import { mermaidSource } from "./browser-mermaid.mjs";
import { sourceFingerprint, writeBuildReceipt } from "./source-fingerprint.mjs";
import {
  VIEWER_ASSETS,
  hashedAssetPath,
  headersFile,
  publicUrl,
  shellAssetDefine,
  stylesCovered,
  viewerAsset,
  viewerBuildOptions,
  viewerSplit,
  withHashedAssets,
  withInlineFavicon,
  withModulePreloads,
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
for (const [module, name] of [
  ["@automerge/automerge/automerge.wasm", "automerge.wasm"],
  ["@automerge/subduction/wasm", "subduction.wasm"],
])
  await writeAsset(name, await readFile(require.resolve(module)));

const viewer = await build(
  viewerBuildOptions(
    app,
    dist,
    buildDefine,
    Object.fromEntries(
      ["mermaid.js", "automerge.wasm", "subduction.wasm"].map((name) => [
        name,
        publicUrl(assets[name]),
      ]),
    ),
  ),
);
const { chunks: viewerChunks, preloads, styles } = viewerSplit(viewer.metafile);
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
          const absolute = path.resolve(args.resolveDir, args.path);
          const name = absolute.includes("subduction") ? "subduction.wasm" : "automerge.wasm";
          await copyFile(absolute, path.join(dist, name));
          return { path: `./${name}`, external: true };
        });
      },
    },
  ],
});
await copyFile(path.join(app, "viewer/connect-agent.js"), path.join(dist, "public/connect.js"));
await writeFile(
  path.join(dist, "public/index.html"),
  withInlineFavicon(
    withHashedAssets(
      withModulePreloads(await readFile(path.join(app, "viewer/index.html"), "utf8"), preloads),
      assets,
    ),
  ),
);
await writeFile(
  path.join(dist, "public/_headers"),
  headersFile(
    [
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: same-origin",
      "Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ],
    [...viewerChunks, ...Object.values(assets)],
  ),
);
await writeFile(
  path.join(dist, "wrangler.json"),
  JSON.stringify(
    {
      name: "nteract-pages-next",
      main: "index.js",
      no_bundle: true,
      compatibility_date: "2026-10-01",
      assets: {
        directory: "public",
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: true,
      },
      durable_objects: {
        bindings: [
          { name: "PAGES", class_name: "Page" },
          { name: "CATALOGS", class_name: "Catalog" },
          { name: "PAGE_RECORDS", class_name: "PageRecords" },
          // Projects keep the Space class: the class name is the storage identity for
          // Projects, and celld 0.6.3 refuses renamed_classes migrations.
          { name: "PROJECTS", class_name: "Space" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["Page", "Catalog"] },
        { tag: "v2", new_sqlite_classes: ["PageRecords"] },
        { tag: "v3", new_sqlite_classes: ["Space"] },
      ],
      d1_databases: [
        {
          binding: AUTH_D1.binding,
          database_name: AUTH_D1.database_name,
          database_id: AUTH_D1.database_id,
        },
      ],
      // celld scopes this bucket beneath the deployment's fleet prefix.
      r2_buckets: [{ binding: "PAGES_ASSETS", bucket_name: "pages-images" }],
      vars: { NOTEBOOK_CLOUD_OIDC_FLOW: "server" },
    },
    null,
    2,
  ),
);
writeBuildReceipt(app, {
  expectedFingerprint,
  viewerChunks,
  viewerAssets: Object.values(assets),
});
console.log("Built native Pages Worker, WASM and viewer into pages/dist.");
