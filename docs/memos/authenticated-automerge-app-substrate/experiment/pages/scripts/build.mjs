import { celldCborPlugin } from "./celld-cbor.mjs";
import { browserMermaidPlugin, mermaidSource } from "./browser-mermaid.mjs";
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
  entryPoints: [path.join(app, "viewer/main.jsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  tsconfig: path.join(app, "tsconfig.json"),
  outfile: path.join(dist, "public/app.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    browserMermaidPlugin(app),
    {
      name: "browser-wasm",
      setup(b) {
        b.onResolve({ filter: /^@automerge\/(automerge|subduction)$/ }, (args) => ({
          path: args.path,
          namespace: "wasm-entry",
        }));
        b.onLoad({ filter: /.*/, namespace: "wasm-entry" }, (args) => ({
          contents: args.path.endsWith("/subduction")
            ? 'import init from "@automerge/subduction/slim"; await init({module_or_path: "/subduction.wasm"}); export * from "@automerge/subduction/slim";'
            : 'import {initializeWasm} from "@automerge/automerge/slim"; await initializeWasm(fetch("/automerge.wasm")); export * from "@automerge/automerge/slim";',
          resolveDir: app,
          loader: "js",
        }));
      },
    },
  ],
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
await writeFile(
  path.join(dist, "public/index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages · nteract</title><link rel="stylesheet" href="/app.css"><link rel="describedby" type="text/plain" href="/llms.txt"></head><body><div id="root"><main class="welcome"><h1>Pages</h1><p>Realtime documents for people and agents.</p><p>Opening the editor…</p><p>For agents, read <a href="/llms.txt">the API and authentication guide</a>. Use an Anaconda API key with <code>Authorization: Bearer &lt;key&gt;</code> for <code>/mcp</code> or <code>/api/tools</code>.</p><noscript>Enable JavaScript to use the editor, or use the API guide above.</noscript></main></div><script type="module" src="/app.js"></script></body></html>',
);
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
      vars: { NOTEBOOK_CLOUD_OIDC_FLOW: "server" },
    },
    null,
    2,
  ),
);
writeBuildReceipt(app, { expectedFingerprint });
console.log("Built native Pages Worker, WASM and viewer into pages/dist.");
