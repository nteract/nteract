import { celldCborPlugin } from "./celld-cbor.mjs";
import { browserMermaidPlugin, mermaidSource } from "./browser-mermaid.mjs";
import { browserWasmPlugin } from "./browser-wasm.mjs";
import { sourceFingerprint, writeBuildReceipt } from "./source-fingerprint.mjs";
import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const dist = path.join(app, "dist");
const expectedFingerprint = sourceFingerprint(app).sha256;
// A failed in-place build must not leave an older receipt beside mixed outputs.
await rm(path.join(dist, "build-receipt.json"), { force: true });
await mkdir(path.join(dist, "public"), { recursive: true });
for (const [module, name] of [
  ["@automerge/automerge/automerge.wasm", "automerge"],
  ["@automerge/subduction/wasm", "subduction"],
])
  await copyFile(require.resolve(module), path.join(dist, "public", `${name}.wasm`));

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
await build({
  entryPoints: [path.join(app, "viewer/theme-bootstrap.mjs")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: path.join(dist, "public/theme.js"),
});
await build({
  entryPoints: [path.join(app, "viewer/main.jsx")],
  // Shared UI source lives outside this npm workspace. Resolve one React
  // instance for both the Page shell and shared components.
  alias: Object.fromEntries(
    ["react", "react-dom", "lucide-react"].map((name) => [
      name,
      path.dirname(require.resolve(`${name}/package.json`)),
    ]),
  ),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  tsconfig: path.join(app, "tsconfig.json"),
  outfile: path.join(dist, "public/app.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [browserMermaidPlugin(app), browserWasmPlugin(app)],
});
await build({
  entryPoints: [mermaidSource(app)],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  tsconfig: path.join(app, "tsconfig.json"),
  outfile: path.join(dist, "public/mermaid.js"),
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile(path.join(app, "viewer/connect-agent.js"), path.join(dist, "public/connect.js"));
await copyFile(path.join(app, "viewer/index.html"), path.join(dist, "public/index.html"));
await writeFile(
  path.join(dist, "public/_headers"),
  "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\n",
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
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["Page", "Catalog"] },
        { tag: "v2", new_sqlite_classes: ["PageRecords"] },
      ],
      d1_databases: [
        { binding: "DB", database_name: "pages-next-auth", database_id: "pages-next-auth" },
      ],
      // celld scopes this bucket beneath the deployment's fleet prefix.
      r2_buckets: [{ binding: "PAGES_ASSETS", bucket_name: "pages-images" }],
      vars: { NOTEBOOK_CLOUD_OIDC_FLOW: "server" },
    },
    null,
    2,
  ),
);
writeBuildReceipt(app, { expectedFingerprint });
console.log("Built native Pages Worker, WASM and viewer into pages/dist.");
