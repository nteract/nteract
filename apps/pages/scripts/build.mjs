import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(app, "../..");
const require = createRequire(import.meta.url);
const result = spawnSync(
  "cargo",
  ["build", "-p", "nteract-markdown-wasm", "--target", "wasm32-unknown-unknown", "--release"],
  { cwd: root, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir(path.join(app, "dist/public"), { recursive: true });
await copyFile(
  path.join(root, "target/wasm32-unknown-unknown/release/nteract_markdown_wasm.wasm"),
  path.join(app, "dist/public/markdown.wasm"),
);
await copyFile(
  require.resolve("@automerge/automerge/automerge.wasm"),
  path.join(app, "dist/automerge.wasm"),
);
await build({
  stdin: {
    contents:
      'import { initializeWasm } from "@automerge/automerge/slim"; import wasm from "./automerge.wasm"; await initializeWasm(wasm); export { default, PagesWorkspace } from "./src/worker.ts";',
    resolveDir: app,
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["./automerge.wasm", "node:*"],
  outfile: path.join(app, "dist/index.js"),
});
await build({
  entryPoints: [path.join(app, "viewer/main.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: path.join(app, "dist/public/app.js"),
  tsconfig: path.join(app, "tsconfig.json"),
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(app, "dist/public/index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages · nteract</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
);
await writeFile(
  path.join(app, "dist/public/_headers"),
  "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\n",
);
await writeFile(
  path.join(app, "dist/wrangler.json"),
  JSON.stringify(
    {
      name: "nteract-pages",
      main: "index.js",
      no_bundle: true,
      compatibility_date: "2026-01-01",
      assets: {
        directory: "public",
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: true,
      },
      durable_objects: { bindings: [{ name: "PAGES_WORKSPACES", class_name: "PagesWorkspace" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["PagesWorkspace"] }],
      d1_databases: [{ binding: "DB", database_name: "pages-auth", database_id: "pages-auth" }],
      vars: { NOTEBOOK_CLOUD_OIDC_FLOW: "server" },
    },
    null,
    2,
  ),
);
console.log("Built Pages into apps/pages/dist (Worker, WASM, and viewer).");
